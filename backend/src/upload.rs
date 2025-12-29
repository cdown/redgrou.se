use crate::db::DbPools;
use axum::body::Bytes;
use axum::extract::{multipart::Field, Extension, Multipart, Path, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::Json;
use csv_async::AsyncReaderBuilder;
use futures::{Stream, StreamExt, TryStreamExt};
use sha2::{Digest, Sha256};
use std::fmt;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Instant;
use subtle::ConstantTimeEq;
use tokio_util::io::StreamReader;
use tracing::{error, info};
use uuid::Uuid;

use crate::db::{self, DbQueryError};
use crate::error::ApiError;
use crate::limits::{UploadLimitError, UploadUsageTracker};
use crate::pipeline::{CsvParser, DbSink, Geocoder, ParsedSighting, BATCH_SIZE};
use crate::proto::{pb, Proto};
use crate::sightings::invalidate_name_index_cache;
use crate::tiles::invalidate_upload_cache;
use crate::zip_extract;
use serde::Deserialize;
use sqlx::Row;

pub const MAX_UPLOAD_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_UPLOAD_BODY_BYTES: usize = MAX_UPLOAD_BYTES + (2 * 1024 * 1024); // allow multipart overhead
const UPLOAD_LIMIT_MB: usize = MAX_UPLOAD_BYTES / (1024 * 1024);
const MAX_DISPLAY_NAME_LENGTH: usize = 128;
const INITIAL_DATA_VERSION: i64 = 1;

// No salt needed: tokens are 122-bit random UUIDs, not user-chosen passwords.
// Salting prevents rainbow table attacks on low-entropy secrets, but rainbow
// tables for random UUIDs don't exist and never will (2^122 entries).
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn verify_token(token: &str, stored_hash: &str) -> bool {
    let computed_hash = hash_token(token);
    // Constant-time comparison to prevent timing attacks
    computed_hash
        .as_bytes()
        .ct_eq(stored_hash.as_bytes())
        .into()
}

#[derive(Debug)]
struct UploadSizeExceeded;

impl fmt::Display for UploadSizeExceeded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "CSV exceeds {UPLOAD_LIMIT_MB} MB upload limit")
    }
}

impl std::error::Error for UploadSizeExceeded {}

struct SizeLimitedStream<S> {
    inner: S,
    max: usize,
    received: usize,
    limit_hit: bool,
}

impl<S> SizeLimitedStream<S> {
    const fn new(inner: S, max: usize) -> Self {
        Self {
            inner,
            max,
            received: 0,
            limit_hit: false,
        }
    }
}

impl<S> Stream for SizeLimitedStream<S>
where
    S: Stream<Item = Result<Bytes, io::Error>> + Unpin + Send,
{
    type Item = Result<Bytes, io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.limit_hit {
            return Poll::Ready(None);
        }

        match Pin::new(&mut self.inner).poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                self.received += chunk.len();
                if self.received > self.max {
                    self.limit_hit = true;
                    return Poll::Ready(Some(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        UploadSizeExceeded,
                    ))));
                }
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(err))) => Poll::Ready(Some(Err(err))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

fn map_csv_error(err: csv_async::Error, log_context: &str, client_message: &str) -> ApiError {
    if let Some(limit_failure) = size_limit_failure(&err) {
        return limit_failure;
    }

    error!("{}: {}", log_context, err);
    ApiError::bad_request(client_message)
}

fn size_limit_failure(err: &csv_async::Error) -> Option<ApiError> {
    if let csv_async::ErrorKind::Io(io_err) = err.kind() {
        if io_err
            .get_ref()
            .and_then(|inner| inner.downcast_ref::<UploadSizeExceeded>())
            .is_some()
        {
            return Some(ApiError::bad_request(format!(
                "CSV exceeds {UPLOAD_LIMIT_MB} MB upload limit"
            )));
        }
    }

    None
}

fn map_quota_error(err: UploadLimitError) -> ApiError {
    match err {
        UploadLimitError::SightingsQuotaExceeded { .. } => ApiError::too_many_requests(
            "Daily sighting quota reached (100000 rows). Please wait before uploading again.",
        ),
        UploadLimitError::WriterBudgetExceeded { .. } => {
            ApiError::service_unavailable("Upload writer is busy, please retry")
        }
        UploadLimitError::ActiveUpload | UploadLimitError::RateLimited => {
            ApiError::too_many_requests("Too many uploads, please wait")
        }
    }
}

async fn ingest_csv_field(
    field: Field<'_>,
    pool: &sqlx::SqlitePool,
    upload_id: &str,
    writer_tracker: &UploadUsageTracker,
) -> Result<usize, ApiError> {
    let stream = field
        .into_stream()
        .map(|result| result.map_err(io::Error::other));
    let limited_stream = SizeLimitedStream::new(stream, MAX_UPLOAD_BYTES);
    let reader = StreamReader::new(limited_stream);
    read_csv(reader, pool, upload_id, writer_tracker).await
}

async fn ingest_field(
    field: Field<'_>,
    pool: &sqlx::SqlitePool,
    upload_id: &str,
    writer_tracker: &UploadUsageTracker,
) -> Result<(usize, String), ApiError> {
    let filename = field
        .file_name()
        .map_or_else(|| "unknown".to_string(), ToString::to_string);

    if is_zip_file(&filename) {
        let stream = field
            .into_stream()
            .map(|result| result.map_err(io::Error::other));

        let mut size_tracker = 0u64;
        let chunks: Vec<Bytes> = stream
            .map(|result| {
                result.map(|chunk| {
                    size_tracker += chunk.len() as u64;
                    if size_tracker > MAX_UPLOAD_BYTES as u64 {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            UploadSizeExceeded,
                        ));
                    }
                    Ok(chunk)
                })
            })
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| ApiError::bad_request(format!("Failed to read upload: {}", e)))?
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| {
                ApiError::bad_request(format!("ZIP exceeds {UPLOAD_LIMIT_MB} MB upload limit"))
            })?;

        let combined = chunks
            .iter()
            .flat_map(|c| c.iter().copied())
            .collect::<Vec<u8>>();
        let cursor = io::Cursor::new(combined);
        let extracted = zip_extract::extract_csv_from_zip(cursor, size_tracker).await?;

        let csv_reader = io::Cursor::new(extracted.data);
        let rows = read_csv(csv_reader, pool, upload_id, writer_tracker).await?;
        Ok((rows, extracted.filename))
    } else if is_csv_file(&filename) {
        let rows = ingest_csv_field(field, pool, upload_id, writer_tracker).await?;
        Ok((rows, filename))
    } else {
        Err(ApiError::bad_request("File must be a CSV or ZIP file"))
    }
}

async fn read_csv<R>(
    reader: R,
    pool: &sqlx::SqlitePool,
    upload_id: &str,
    writer_tracker: &UploadUsageTracker,
) -> Result<usize, ApiError>
where
    R: tokio::io::AsyncRead + Unpin + Send,
{
    let mut csv_reader = AsyncReaderBuilder::new()
        .has_headers(true)
        .create_reader(reader);

    let headers = csv_reader
        .headers()
        .await
        .map_err(|err| map_csv_error(err, "Failed to read CSV headers", "Invalid CSV headers"))?;

    let mut parser = CsvParser::new(headers)?;
    let geocoder = Geocoder::new();
    let mut sink = DbSink::new(upload_id.to_string());
    let mut pending_rows: Vec<ParsedSighting> = Vec::new();
    let mut record = csv_async::ByteRecord::new();

    while csv_reader
        .read_byte_record(&mut record)
        .await
        .map_err(|err| map_csv_error(err, "Failed to read CSV row", "Invalid CSV data"))?
    {
        if let Some(parsed) = parser.parse_row(&record)? {
            writer_tracker
                .reserve_sightings(1)
                .await
                .map_err(map_quota_error)?;
            pending_rows.push(parsed);

            if pending_rows.len() >= BATCH_SIZE {
                process_pending_rows(
                    &mut sink,
                    pool,
                    &geocoder,
                    &mut pending_rows,
                    writer_tracker,
                )
                .await?;
            }
        }
    }

    process_pending_rows(
        &mut sink,
        pool,
        &geocoder,
        &mut pending_rows,
        writer_tracker,
    )
    .await?;
    flush_with_tracking(&mut sink, pool, writer_tracker).await?;

    Ok(sink.total_rows())
}

async fn process_pending_rows(
    sink: &mut DbSink,
    pool: &sqlx::SqlitePool,
    geocoder: &Geocoder,
    pending_rows: &mut Vec<ParsedSighting>,
    writer_tracker: &UploadUsageTracker,
) -> Result<(), ApiError> {
    if pending_rows.is_empty() {
        return Ok(());
    }

    let batch = std::mem::take(pending_rows);
    let processed = geocoder.geocode_batch(batch).await?;

    for sighting in processed {
        if sink.needs_flush() {
            flush_with_tracking(sink, pool, writer_tracker).await?;
        }
        sink.add(sighting)?;
    }

    Ok(())
}

async fn flush_with_tracking(
    sink: &mut DbSink,
    pool: &sqlx::SqlitePool,
    writer_tracker: &UploadUsageTracker,
) -> Result<(), ApiError> {
    let start = Instant::now();
    sink.flush(pool).await?;
    writer_tracker.record_writer_usage(start.elapsed()).await;
    Ok(())
}

async fn compute_grid_cell_visibility(
    pool: &sqlx::SqlitePool,
    upload_id_blob: &[u8],
) -> Result<(), DbQueryError> {
    let mut tx = db::query_with_timeout(pool.begin()).await?;

    compute_grid_cell_visibility_tx(&mut tx, upload_id_blob).await?;

    db::query_with_timeout(tx.commit()).await?;

    Ok(())
}

async fn compute_grid_cell_visibility_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    upload_id_blob: &[u8],
) -> Result<(), DbQueryError> {
    // Ensure at least one sighting per 1-degree grid cell is visible. Basically the logic is:
    //
    // 1. Partitions data into grid cells
    // 2. Select the best sighting per cell (ordered by vis_rank ASC)
    //
    // This ensures isolated sightings in remote locations remain visible at low zoom levels, like
    // Tonia's Newark sighting.
    db::query_with_timeout(
        sqlx::query(
            "UPDATE sightings SET vis_rank = 0 WHERE id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (PARTITION BY CAST(latitude AS INTEGER), CAST(longitude AS INTEGER) ORDER BY vis_rank ASC) as rn
                    FROM sightings WHERE upload_id = ?
                ) WHERE rn = 1
            )"
        )
            .bind(upload_id_blob)
            .execute(&mut **tx),
    )
    .await?;

    Ok(())
}

pub async fn upload_csv(
    State(pools): State<DbPools>,
    Extension(writer_tracker): Extension<UploadUsageTracker>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    while let Ok(Some(field)) = multipart.next_field().await {
        let filename = field
            .file_name()
            .map_or_else(|| "unknown".to_string(), ToString::to_string);

        if !is_csv_or_zip_file(&filename) {
            continue;
        }

        let upload_uuid = Uuid::new_v4();
        let upload_id = upload_uuid.to_string();
        let upload_id_blob = upload_uuid.as_bytes();
        let edit_token = Uuid::new_v4().to_string();
        let edit_token_hash = hash_token(&edit_token);

        // Create upload record first (needed for foreign key in sightings)
        if let Err(e) = db::query_with_timeout(
            sqlx::query(
                "INSERT INTO uploads (id, filename, edit_token_hash, data_version) VALUES (?, ?, ?, ?)",
            )
            .bind(&upload_id_blob[..])
            .bind(&filename)
            .bind(&edit_token_hash)
            .bind(INITIAL_DATA_VERSION)
            .execute(pools.write()),
        )
        .await
        {
            return e
                .into_api_error("creating upload record", "Database error")
                .into_response();
        }

        let (total_rows, actual_filename) =
            match ingest_field(field, pools.write(), &upload_id, &writer_tracker).await {
                Ok(result) => result,
                Err(err) => {
                    if let Err(db_err) = db::query_with_timeout(
                        sqlx::query("DELETE FROM uploads WHERE id = ?")
                            .bind(&upload_id_blob[..])
                            .execute(pools.write()),
                    )
                    .await
                    {
                        db_err.log("deleting failed upload record");
                    }
                    return err.into_response();
                }
            };

        // Update filename if it was extracted from ZIP
        if actual_filename != filename {
            if let Err(e) = db::query_with_timeout(
                sqlx::query("UPDATE uploads SET filename = ? WHERE id = ?")
                    .bind(&actual_filename)
                    .bind(&upload_id_blob[..])
                    .execute(pools.write()),
            )
            .await
            {
                e.log("updating filename after ZIP extraction");
            }
        }

        let mut tx = match db::query_with_timeout(pools.write().begin()).await {
            Ok(tx) => tx,
            Err(e) => {
                return e
                    .into_api_error("starting upload metadata transaction", "Database error")
                    .into_response();
            }
        };

        if let Err(e) = db::query_with_timeout(
            sqlx::query("UPDATE uploads SET row_count = ? WHERE id = ?")
                .bind(i64::try_from(total_rows).unwrap_or(i64::MAX))
                .bind(&upload_id_blob[..])
                .execute(&mut *tx),
        )
        .await
        {
            return e
                .into_api_error("updating upload row_count", "Database error")
                .into_response();
        }

        if let Err(e) = compute_grid_cell_visibility_tx(&mut tx, &upload_id_blob[..]).await {
            return e
                .into_api_error("computing grid cell visibility", "Database error")
                .into_response();
        }

        if let Err(e) = db::query_with_timeout(tx.commit()).await {
            return e
                .into_api_error("committing upload metadata transaction", "Database error")
                .into_response();
        }

        if let Err(e) =
            crate::bitmaps::compute_and_store_bitmaps(pools.write(), &upload_id_blob[..]).await
        {
            error!("Failed to compute tick bitmaps: {}", e.body.error);
        }

        info!(
            "Upload complete: {} rows from {} (upload_id: {})",
            total_rows, filename, upload_id
        );

        let response_title = default_display_name(&filename);

        return (
            axum::http::StatusCode::OK,
            Proto::new(pb::UploadResponse {
                upload_id,
                filename,
                row_count: i64::try_from(total_rows).unwrap_or(i64::MAX),
                edit_token,
                title: response_title,
                data_version: INITIAL_DATA_VERSION,
            }),
        )
            .into_response();
    }

    ApiError::bad_request("No CSV file found in upload").into_response()
}

fn is_csv_file(filename: &str) -> bool {
    std::path::Path::new(filename)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("csv"))
}

fn is_zip_file(filename: &str) -> bool {
    std::path::Path::new(filename)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
}

fn is_csv_or_zip_file(filename: &str) -> bool {
    is_csv_file(filename) || is_zip_file(filename)
}

fn extract_edit_token(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(ToString::to_string)
}

async fn verify_upload_access(
    pool: &sqlx::SqlitePool,
    upload_id: &str,
    token: &str,
) -> Result<bool, DbQueryError> {
    let upload_uuid = Uuid::parse_str(upload_id)
        .map_err(|_| DbQueryError::Sqlx(sqlx::Error::Decode("Invalid UUID format".into())))?;
    let upload_id_blob = upload_uuid.as_bytes();
    let hash = db::query_with_timeout(
        sqlx::query_scalar::<_, Option<String>>("SELECT edit_token_hash FROM uploads WHERE id = ?")
            .bind(&upload_id_blob[..])
            .fetch_optional(pool),
    )
    .await?;

    match hash {
        Some(Some(stored_hash)) => Ok(verify_token(token, &stored_hash)),
        Some(None) | None => Ok(false), // Upload exists but has no token (legacy) or doesn't exist
    }
}

async fn verify_edit_token(
    pool: &sqlx::SqlitePool,
    headers: &axum::http::HeaderMap,
    upload_id: &str,
) -> Result<(), axum::response::Response> {
    let Some(token) = extract_edit_token(headers) else {
        return Err(ApiError::unauthorised("Missing edit token").into_response());
    };

    match verify_upload_access(pool, upload_id, &token).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(ApiError::forbidden("Invalid edit token").into_response()),
        Err(e) => Err(e
            .into_api_error("verifying edit token", "Database error")
            .into_response()),
    }
}

#[derive(Deserialize)]
pub struct RenamePayload {
    display_name: Option<String>,
}

pub async fn rename_upload(
    State(pools): State<DbPools>,
    Path(upload_id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<RenamePayload>,
) -> impl IntoResponse {
    if let Err(response) = verify_edit_token(pools.read(), &headers, &upload_id).await {
        return response;
    }

    let upload_uuid = match Uuid::parse_str(&upload_id) {
        Ok(uuid) => uuid,
        Err(_) => {
            return ApiError::bad_request("Invalid upload_id format").into_response();
        }
    };
    let upload_id_blob = upload_uuid.as_bytes();

    let display_name = match normalise_display_name(payload.display_name) {
        Ok(name) => name,
        Err(err) => return err.into_response(),
    };

    if let Err(e) = db::query_with_timeout(
        sqlx::query(
            "UPDATE uploads SET display_name = ?, data_version = data_version + 1 WHERE id = ?",
        )
        .bind(&display_name)
        .bind(&upload_id_blob[..])
        .execute(pools.write()),
    )
    .await
    {
        return e
            .into_api_error("updating upload display name", "Database error")
            .into_response();
    }

    let metadata = match db::query_with_timeout(
        sqlx::query_as::<_, (String, i64, Option<String>, i64)>(
            "SELECT filename, row_count, display_name, data_version FROM uploads WHERE id = ?",
        )
        .bind(&upload_id_blob[..])
        .fetch_optional(pools.read()),
    )
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Upload not found").into_response(),
        Err(e) => {
            return e
                .into_api_error("loading upload metadata", "Database error")
                .into_response()
        }
    };

    let (filename, row_count, display_name, data_version) = metadata;
    let title = effective_display_name(display_name, &filename);

    Proto::new(pb::UploadMetadata {
        upload_id,
        filename,
        row_count,
        title,
        data_version,
    })
    .into_response()
}

pub async fn update_csv(
    State(pools): State<DbPools>,
    Path(upload_id): Path<String>,
    headers: axum::http::HeaderMap,
    Extension(writer_tracker): Extension<UploadUsageTracker>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    if let Err(response) = verify_edit_token(pools.read(), &headers, &upload_id).await {
        return response;
    }

    let upload_uuid = match Uuid::parse_str(&upload_id) {
        Ok(uuid) => uuid,
        Err(_) => {
            return ApiError::bad_request("Invalid upload_id format").into_response();
        }
    };
    let upload_id_blob = upload_uuid.as_bytes();

    while let Ok(Some(field)) = multipart.next_field().await {
        let filename = field
            .file_name()
            .map_or_else(|| "unknown".to_string(), ToString::to_string);

        if !is_csv_or_zip_file(&filename) {
            continue;
        }

        if let Err(e) = db::query_with_timeout(
            sqlx::query("DELETE FROM sightings WHERE upload_id = ?")
                .bind(&upload_id_blob[..])
                .execute(pools.write()),
        )
        .await
        {
            return e
                .into_api_error("deleting existing sightings", "Database error")
                .into_response();
        }

        let (total_rows, actual_filename) =
            match ingest_field(field, pools.write(), &upload_id, &writer_tracker).await {
                Ok(result) => result,
                Err(err) => return err.into_response(),
            };

        if let Err(e) = db::query_with_timeout(
            sqlx::query(
                "UPDATE uploads SET row_count = ?, filename = ?, data_version = data_version + 1 WHERE id = ?",
            )
            .bind(i64::try_from(total_rows).unwrap_or(i64::MAX))
            .bind(&actual_filename)
            .bind(&upload_id_blob[..])
            .execute(pools.write()),
        )
        .await
        {
            e.log("updating upload metadata after replace");
        }

        if let Err(e) = compute_grid_cell_visibility(pools.write(), &upload_id_blob[..]).await {
            e.log("computing grid cell visibility");
        }

        // Compute and store Roaring bitmaps for efficient tick filtering
        if let Err(e) =
            crate::bitmaps::compute_and_store_bitmaps(pools.write(), &upload_id_blob[..]).await
        {
            error!("Failed to compute tick bitmaps: {}", e.body.error);
        }

        invalidate_upload_cache(&upload_id).await;
        invalidate_name_index_cache(&upload_id);

        let data_version = match db::query_with_timeout(
            sqlx::query_scalar::<_, i64>("SELECT data_version FROM uploads WHERE id = ?")
                .bind(&upload_id_blob[..])
                .fetch_one(pools.read()),
        )
        .await
        {
            Ok(version) => version,
            Err(e) => {
                return e
                    .into_api_error("loading upload data_version", "Database error")
                    .into_response();
            }
        };

        info!(
            "Update complete: {} rows from {} (upload_id: {})",
            total_rows, filename, upload_id
        );

        let response_title = default_display_name(&filename);

        return (
            axum::http::StatusCode::OK,
            Proto::new(pb::UpdateResponse {
                upload_id,
                filename,
                row_count: i64::try_from(total_rows).unwrap_or(i64::MAX),
                title: response_title,
                data_version,
            }),
        )
            .into_response();
    }

    ApiError::bad_request("No CSV file found in upload").into_response()
}

pub async fn delete_upload(
    State(pools): State<DbPools>,
    Path(upload_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    if let Err(response) = verify_edit_token(pools.read(), &headers, &upload_id).await {
        return response;
    }

    let upload_uuid = match Uuid::parse_str(&upload_id) {
        Ok(uuid) => uuid,
        Err(_) => {
            return ApiError::bad_request("Invalid upload_id format").into_response();
        }
    };
    let upload_id_blob = upload_uuid.as_bytes();

    // CASCADE will delete associated sightings
    match db::query_with_timeout(
        sqlx::query("DELETE FROM uploads WHERE id = ?")
            .bind(&upload_id_blob[..])
            .execute(pools.write()),
    )
    .await
    {
        Ok(_) => {
            invalidate_upload_cache(&upload_id).await;
            invalidate_name_index_cache(&upload_id);

            info!("Deleted upload: {}", upload_id);
            (
                axum::http::StatusCode::OK,
                Proto::new(pb::DeleteResponse { deleted: true }),
            )
                .into_response()
        }
        Err(e) => e
            .into_api_error("deleting upload", "Database error")
            .into_response(),
    }
}

fn normalise_display_name(value: Option<String>) -> Result<String, ApiError> {
    let Some(raw) = value else {
        return Err(ApiError::bad_request("display_name is required"));
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request("Display name cannot be empty"));
    }
    if trimmed.chars().count() > MAX_DISPLAY_NAME_LENGTH {
        return Err(ApiError::bad_request(format!(
            "Display name must be at most {} characters",
            MAX_DISPLAY_NAME_LENGTH
        )));
    }
    Ok(trimmed.to_string())
}

pub(crate) fn default_display_name(filename: &str) -> String {
    if filename.len() > 4 && filename.to_ascii_lowercase().ends_with(".csv") {
        let trimmed = &filename[..filename.len() - 4];
        if trimmed.is_empty() {
            filename.to_string()
        } else {
            trimmed.to_string()
        }
    } else {
        filename.to_string()
    }
}

pub(crate) fn effective_display_name(stored: Option<String>, filename: &str) -> String {
    match stored {
        Some(name) => {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                default_display_name(filename)
            } else {
                trimmed.to_string()
            }
        }
        None => default_display_name(filename),
    }
}

pub async fn get_upload_data_version(
    pool: &sqlx::SqlitePool,
    upload_uuid: &Uuid,
) -> Result<i64, ApiError> {
    let version = db::query_with_timeout(
        sqlx::query_scalar::<_, i64>("SELECT data_version FROM uploads WHERE id = ?")
            .bind(&upload_uuid.as_bytes()[..])
            .fetch_optional(pool),
    )
    .await
    .map_err(|e| e.into_api_error("loading upload data_version", "Database error"))?
    .ok_or_else(|| ApiError::not_found("Upload not found"))?;

    Ok(version)
}

pub async fn delete_old_uploads(
    pool: &sqlx::SqlitePool,
    retention_days: i64,
) -> Result<usize, DbQueryError> {
    let cutoff_date = chrono::Utc::now()
        .checked_sub_signed(chrono::Duration::days(retention_days))
        .ok_or_else(|| {
            DbQueryError::Sqlx(sqlx::Error::Decode("Invalid retention period".into()))
        })?;
    let cutoff_str = cutoff_date.format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let rows = db::query_with_timeout(
        sqlx::query("SELECT id FROM uploads WHERE last_accessed_at < ?")
            .bind(&cutoff_str)
            .fetch_all(pool),
    )
    .await?;

    let mut deleted_count = 0;
    for row in rows {
        let id_blob: Vec<u8> = row.get("id");
        if let Ok(upload_uuid) = Uuid::from_slice(&id_blob) {
            let upload_id = upload_uuid.to_string();
            match db::query_with_timeout(
                sqlx::query("DELETE FROM uploads WHERE id = ?")
                    .bind(&id_blob[..])
                    .execute(pool),
            )
            .await
            {
                Ok(_) => {
                    invalidate_upload_cache(&upload_id).await;
                    invalidate_name_index_cache(&upload_id);
                    deleted_count += 1;
                    info!("Auto-deleted old upload: {}", upload_id);
                }
                Err(e) => {
                    error!("Failed to delete old upload {}: {:?}", upload_id, e);
                }
            }
        }
    }

    Ok(deleted_count)
}
