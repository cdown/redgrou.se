use axum::body::Bytes;
use axum::extract::{multipart::Field, Multipart, Path, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::Json;
use csv_async::AsyncReaderBuilder;
use futures::{Stream, StreamExt, TryStreamExt};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::fmt;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use subtle::ConstantTimeEq;
use tokio_util::io::StreamReader;
use tracing::{error, info};
use ts_rs::TS;
use uuid::Uuid;

use crate::db::{self, DbQueryError};
use crate::error::ApiError;
use crate::pipeline::{CsvParser, DbSink, Geocoder, BATCH_SIZE};

pub const MAX_UPLOAD_BYTES: usize = 200 * 1024 * 1024; // 200 MiB
pub const MAX_UPLOAD_BODY_BYTES: usize = MAX_UPLOAD_BYTES + (2 * 1024 * 1024); // allow multipart overhead
const UPLOAD_LIMIT_MB: usize = MAX_UPLOAD_BYTES / (1024 * 1024);

#[derive(Serialize, TS)]
#[ts(export)]
pub struct UploadResponse {
    pub upload_id: String,
    pub filename: String,
    pub row_count: usize,
    pub edit_token: String,
}

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

async fn ingest_csv_field(
    field: Field<'_>,
    pool: &SqlitePool,
    upload_id: &str,
) -> Result<usize, ApiError> {
    let stream = field
        .into_stream()
        .map(|result| result.map_err(io::Error::other));
    let limited_stream = SizeLimitedStream::new(stream, MAX_UPLOAD_BYTES);
    let reader = StreamReader::new(limited_stream);
    read_csv(reader, pool, upload_id).await
}

async fn read_csv<R>(reader: R, pool: &SqlitePool, upload_id: &str) -> Result<usize, ApiError>
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

    // Initialize pipeline stages
    let mut parser = CsvParser::new(&headers)?;
    let geocoder = Geocoder::new();
    let mut sink = DbSink::new(upload_id.to_string());

    let mut tx = db::query_with_timeout(pool.begin())
        .await
        .map_err(|e| e.into_api_error("starting upload transaction", "Database error"))?;

    // Process rows in batches for geocoding (CPU-bound operation offloaded to blocking threads)
    // Manual loop is used instead of iterator chunks because:
    // 1. Async stream processing (read_byte_record is async)
    // 2. Per-row validation and error handling
    // 3. Geocoding batching requires collecting coordinates before async operation
    let mut pending_rows: Vec<crate::pipeline::ParsedSighting> = Vec::new();
    let mut record = csv_async::ByteRecord::new();

    while csv_reader
        .read_byte_record(&mut record)
        .await
        .map_err(|err| map_csv_error(err, "Failed to read CSV row", "Invalid CSV data"))?
    {
        if let Some(parsed) = parser.parse_row(&record)? {
            pending_rows.push(parsed);

            // Geocode in batches to avoid blocking the async runtime
            if pending_rows.len() >= BATCH_SIZE {
                let processed = geocoder.geocode_batch(pending_rows).await?;
                pending_rows = Vec::new();

                for sighting in processed {
                    // Check if we need to flush before adding
                    if sink.needs_flush() {
                        sink.flush(&mut tx).await?;
                    }
                    sink.add(sighting)?;
                }
            }
        }
    }

    // Process remaining pending rows
    if !pending_rows.is_empty() {
        let processed = geocoder.geocode_batch(pending_rows).await?;
        for sighting in processed {
            sink.add(sighting)?;
        }
    }

    // Flush any remaining rows
    sink.flush(&mut tx).await?;

    db::query_with_timeout(tx.commit())
        .await
        .map_err(|e| e.into_api_error("committing upload transaction", "Database error"))?;

    Ok(sink.total_rows())
}

// We compute lifer and year_tick ourselves rather than trusting the CSV.
// Birda data sometimes has these fields set incorrectly (e.g. lifers not marked as year ticks).
async fn compute_lifer_and_year_tick(
    pool: &SqlitePool,
    upload_id: &str,
) -> Result<(), DbQueryError> {
    // A lifer is the first sighting of a species (by common_name) ever within this upload
    db::query_with_timeout(
        sqlx::query(
            "UPDATE sightings SET lifer = 1 WHERE id IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY common_name ORDER BY observed_at) as rn
                FROM sightings WHERE upload_id = ?
            ) WHERE rn = 1
        )",
        )
        .bind(upload_id)
        .execute(pool),
    )
    .await?;

    // A year tick is the first sighting of a species in each year (lifers are also year ticks)
    db::query_with_timeout(
        sqlx::query(
        "UPDATE sightings SET year_tick = 1 WHERE id IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY common_name, year ORDER BY observed_at) as rn
                FROM sightings WHERE upload_id = ?
            ) WHERE rn = 1
        )"
        )
        .bind(upload_id)
        .execute(pool),
    )
    .await?;

    // Boost visibility of lifers and year ticks (rank 0 = highest priority)
    // This ensures 'important' sightings are seen even at world-view zoom levels
    db::query_with_timeout(
        sqlx::query("UPDATE sightings SET vis_rank = 0 WHERE upload_id = ? AND (lifer = 1 OR year_tick = 1)")
            .bind(upload_id)
            .execute(pool),
    )
    .await?;

    Ok(())
}

pub async fn upload_csv(
    State(pool): State<SqlitePool>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    while let Ok(Some(field)) = multipart.next_field().await {
        let filename = field
            .file_name()
            .map_or_else(|| "unknown.csv".to_string(), ToString::to_string);

        if !std::path::Path::new(&filename)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("csv"))
        {
            continue;
        }

        let upload_id = Uuid::new_v4().to_string();
        let edit_token = Uuid::new_v4().to_string();
        let edit_token_hash = hash_token(&edit_token);

        if let Err(e) = db::query_with_timeout(
            sqlx::query("INSERT INTO uploads (id, filename, edit_token_hash) VALUES (?, ?, ?)")
                .bind(&upload_id)
                .bind(&filename)
                .bind(&edit_token_hash)
                .execute(&pool),
        )
        .await
        {
            return e
                .into_api_error("creating upload record", "Database error")
                .into_response();
        }

        let total_rows = match ingest_csv_field(field, &pool, &upload_id).await {
            Ok(rows) => rows,
            Err(err) => {
                let _ = db::query_with_timeout(
                    sqlx::query("DELETE FROM uploads WHERE id = ?")
                        .bind(&upload_id)
                        .execute(&pool),
                )
                .await;
                return err.into_response();
            }
        };

        if let Err(e) = db::query_with_timeout(
            sqlx::query("UPDATE uploads SET row_count = ? WHERE id = ?")
                .bind(i64::try_from(total_rows).unwrap_or(i64::MAX))
                .bind(&upload_id)
                .execute(&pool),
        )
        .await
        {
            e.log("updating upload row_count");
        }

        if let Err(e) = compute_lifer_and_year_tick(&pool, &upload_id).await {
            e.log("computing lifer/year_tick flags");
        }

        info!(
            "Upload complete: {} rows from {} (upload_id: {})",
            total_rows, filename, upload_id
        );

        return (
            axum::http::StatusCode::OK,
            Json(UploadResponse {
                upload_id,
                filename,
                row_count: total_rows,
                edit_token,
            }),
        )
            .into_response();
    }

    ApiError::bad_request("No CSV file found in upload").into_response()
}

fn extract_edit_token(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(ToString::to_string)
}

async fn verify_upload_access(
    pool: &SqlitePool,
    upload_id: &str,
    token: &str,
) -> Result<bool, DbQueryError> {
    let hash = db::query_with_timeout(
        sqlx::query_scalar::<_, Option<String>>("SELECT edit_token_hash FROM uploads WHERE id = ?")
            .bind(upload_id)
            .fetch_optional(pool),
    )
    .await?;

    match hash {
        Some(Some(stored_hash)) => Ok(verify_token(token, &stored_hash)),
        Some(None) | None => Ok(false), // Upload exists but has no token (legacy) or doesn't exist
    }
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct UpdateResponse {
    pub upload_id: String,
    pub filename: String,
    pub row_count: usize,
}

pub async fn update_csv(
    State(pool): State<SqlitePool>,
    Path(upload_id): Path<String>,
    headers: axum::http::HeaderMap,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let Some(token) = extract_edit_token(&headers) else {
        return ApiError::unauthorised("Missing edit token").into_response();
    };

    match verify_upload_access(&pool, &upload_id, &token).await {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::forbidden("Invalid edit token").into_response();
        }
        Err(e) => {
            return e
                .into_api_error("verifying edit token", "Database error")
                .into_response();
        }
    }

    while let Ok(Some(field)) = multipart.next_field().await {
        let filename = field
            .file_name()
            .map_or_else(|| "unknown.csv".to_string(), ToString::to_string);

        if !std::path::Path::new(&filename)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("csv"))
        {
            continue;
        }

        // Delete existing sightings
        if let Err(e) = db::query_with_timeout(
            sqlx::query("DELETE FROM sightings WHERE upload_id = ?")
                .bind(&upload_id)
                .execute(&pool),
        )
        .await
        {
            return e
                .into_api_error("deleting existing sightings", "Database error")
                .into_response();
        }

        let total_rows = match ingest_csv_field(field, &pool, &upload_id).await {
            Ok(rows) => rows,
            Err(err) => return err.into_response(),
        };

        if let Err(e) = db::query_with_timeout(
            sqlx::query("UPDATE uploads SET row_count = ?, filename = ? WHERE id = ?")
                .bind(i64::try_from(total_rows).unwrap_or(i64::MAX))
                .bind(&filename)
                .bind(&upload_id)
                .execute(&pool),
        )
        .await
        {
            e.log("updating upload metadata after replace");
        }

        if let Err(e) = compute_lifer_and_year_tick(&pool, &upload_id).await {
            e.log("computing lifer/year_tick flags");
        }

        info!(
            "Update complete: {} rows from {} (upload_id: {})",
            total_rows, filename, upload_id
        );

        return (
            axum::http::StatusCode::OK,
            Json(UpdateResponse {
                upload_id,
                filename,
                row_count: total_rows,
            }),
        )
            .into_response();
    }

    ApiError::bad_request("No CSV file found in upload").into_response()
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct DeleteResponse {
    pub deleted: bool,
}

pub async fn delete_upload(
    State(pool): State<SqlitePool>,
    Path(upload_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let Some(token) = extract_edit_token(&headers) else {
        return ApiError::unauthorised("Missing edit token").into_response();
    };

    match verify_upload_access(&pool, &upload_id, &token).await {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::forbidden("Invalid edit token").into_response();
        }
        Err(e) => {
            return e
                .into_api_error("verifying edit token", "Database error")
                .into_response();
        }
    }

    // CASCADE will delete associated sightings
    match db::query_with_timeout(
        sqlx::query("DELETE FROM uploads WHERE id = ?")
            .bind(&upload_id)
            .execute(&pool),
    )
    .await
    {
        Ok(_) => {
            info!("Deleted upload: {}", upload_id);
            (
                axum::http::StatusCode::OK,
                Json(DeleteResponse { deleted: true }),
            )
                .into_response()
        }
        Err(e) => e
            .into_api_error("deleting upload", "Database error")
            .into_response(),
    }
}
