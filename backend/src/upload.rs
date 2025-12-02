use axum::body::Bytes;
use axum::extract::{multipart::Field, Multipart, Path, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::Json;
use country_boundaries::{CountryBoundaries, LatLon, BOUNDARIES_ODBL_360X180};
use csv_async::AsyncReaderBuilder;
use futures::{Stream, StreamExt, TryStreamExt};
use once_cell::sync::Lazy;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{Acquire, QueryBuilder, Sqlite, SqlitePool, Transaction};
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

// Initialised once to avoid reloading the dataset on every request.
// Uses point-in-polygon testing with OpenStreetMap boundaries data.
static BOUNDARIES: Lazy<CountryBoundaries> = Lazy::new(|| {
    info!("Initialising country boundaries");
    CountryBoundaries::from_reader(BOUNDARIES_ODBL_360X180)
        .expect("Failed to load country boundaries data")
});

const BATCH_SIZE: usize = 1000;
pub const MAX_UPLOAD_BYTES: usize = 200 * 1024 * 1024; // 200 MiB
pub const MAX_UPLOAD_BODY_BYTES: usize = MAX_UPLOAD_BYTES + (2 * 1024 * 1024); // allow multipart overhead
const UPLOAD_LIMIT_MB: usize = MAX_UPLOAD_BYTES / (1024 * 1024);

const COL_SIGHTING_ID: &str = "sightingId";
const COL_DATE: &str = "date";
const COL_LONGITUDE: &str = "longitude";
const COL_LATITUDE: &str = "latitude";
const COL_SCIENTIFIC_NAME: &str = "scientificName";
const COL_COMMON_NAME: &str = "commonName";
const COL_COUNT: &str = "count";
const MAX_UPLOAD_ROWS: usize = 250_000;
const MAX_CSV_COLUMNS: usize = 256;
const MAX_RECORD_BYTES: usize = 8 * 1024; // 8 KiB per record to prevent line bombs

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

fn validate_header_limits(headers: &csv_async::StringRecord) -> Result<(), ApiError> {
    let column_count = headers.len();
    if column_count > MAX_CSV_COLUMNS {
        return Err(ApiError::bad_request(format!(
            "CSV has {column_count} columns; maximum supported is {MAX_CSV_COLUMNS}"
        )));
    }
    Ok(())
}

fn enforce_record_limits(
    record: &csv_async::ByteRecord,
    row_number: usize,
) -> Result<(), ApiError> {
    if record.len() > MAX_CSV_COLUMNS {
        return Err(ApiError::bad_request(format!(
            "Row {} has {} columns; maximum supported is {}",
            row_number,
            record.len(),
            MAX_CSV_COLUMNS
        )));
    }

    let byte_len = record.as_slice().len();
    if byte_len > MAX_RECORD_BYTES {
        return Err(ApiError::bad_request(format!(
            "Row {row_number} exceeds {MAX_RECORD_BYTES} byte limit (row is {byte_len} bytes)"
        )));
    }

    Ok(())
}

struct SightingRow {
    sighting_uuid: String,
    common_name: String,
    scientific_name: Option<String>,
    count: i32,
    latitude: f64,
    longitude: f64,
    country_code: String,
    region_code: Option<String>,
    observed_at: String,
    year: i32,
}

#[derive(Default)]
struct ColumnMap {
    sighting_id: Option<usize>,
    date: Option<usize>,
    longitude: Option<usize>,
    latitude: Option<usize>,
    scientific_name: Option<usize>,
    common_name: Option<usize>,
    count: Option<usize>,
}

impl ColumnMap {
    fn from_headers(headers: &csv_async::StringRecord) -> Self {
        let mut map = Self::default();
        for (idx, header) in headers.iter().enumerate() {
            match header {
                COL_SIGHTING_ID => map.sighting_id = Some(idx),
                COL_DATE => map.date = Some(idx),
                COL_LONGITUDE => map.longitude = Some(idx),
                COL_LATITUDE => map.latitude = Some(idx),
                COL_SCIENTIFIC_NAME => map.scientific_name = Some(idx),
                COL_COMMON_NAME => map.common_name = Some(idx),
                COL_COUNT => map.count = Some(idx),
                _ => {}
            }
        }
        map
    }

    const fn is_valid(&self) -> bool {
        self.sighting_id.is_some()
            && self.date.is_some()
            && self.longitude.is_some()
            && self.latitude.is_some()
            && self.common_name.is_some()
    }
}

fn get_field(
    record: &csv_async::ByteRecord,
    idx: Option<usize>,
    field_name: &str,
    row_number: usize,
) -> Result<Option<String>, ApiError> {
    let Some(bytes) = idx.and_then(|i| record.get(i)) else {
        return Ok(None);
    };

    let value = std::str::from_utf8(bytes).map_err(|_| {
        ApiError::bad_request(format!(
            "Row {row_number} has invalid UTF-8 in column {field_name}"
        ))
    })?;

    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    Ok(Some(trimmed.to_string()))
}

fn extract_year(date_str: &str) -> i32 {
    // ISO 8601 format: 2020-02-14T09:34:18.584Z
    date_str.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0)
}

fn get_country_code(lat: f64, lon: f64) -> String {
    let Ok(latlon) = LatLon::new(lat, lon) else {
        return "XX".to_string();
    };

    let ids = BOUNDARIES.ids(latlon);
    // ids returns e.g. ["US-TX", "US"] or ["SG"] - we want the shortest (country) code
    ids.iter()
        .find(|id| !id.contains('-'))
        .or_else(|| ids.first())
        .map_or_else(|| "XX".to_string(), ToString::to_string)
}

fn get_region_code(lat: f64, lon: f64) -> Option<String> {
    let Ok(latlon) = LatLon::new(lat, lon) else {
        return None;
    };

    let ids = BOUNDARIES.ids(latlon);
    // ids returns e.g. ["US-TX", "US"] or ["SG"] - we want the code with a dash (region/subdivision)
    // If no subdivision exists (like Singapore), return None
    ids.iter()
        .find(|id| id.contains('-'))
        .map(ToString::to_string)
}

fn parse_row(
    record: &csv_async::ByteRecord,
    col_map: &ColumnMap,
    row_number: usize,
) -> Result<Option<SightingRow>, ApiError> {
    let Some(sighting_uuid) = get_field(record, col_map.sighting_id, COL_SIGHTING_ID, row_number)?
    else {
        return Ok(None);
    };
    let Some(common_name) = get_field(record, col_map.common_name, COL_COMMON_NAME, row_number)?
    else {
        return Ok(None);
    };
    let Some(observed_at) = get_field(record, col_map.date, COL_DATE, row_number)? else {
        return Ok(None);
    };

    let latitude = match get_field(record, col_map.latitude, COL_LATITUDE, row_number)? {
        Some(value) => match value.parse::<f64>() {
            Ok(parsed) => parsed,
            Err(_) => return Ok(None),
        },
        None => return Ok(None),
    };
    let longitude = match get_field(record, col_map.longitude, COL_LONGITUDE, row_number)? {
        Some(value) => match value.parse::<f64>() {
            Ok(parsed) => parsed,
            Err(_) => return Ok(None),
        },
        None => return Ok(None),
    };

    let country_code = get_country_code(latitude, longitude);
    let region_code = get_region_code(latitude, longitude);

    let count: i32 = get_field(record, col_map.count, COL_COUNT, row_number)?
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);

    let year = extract_year(&observed_at);

    Ok(Some(SightingRow {
        sighting_uuid,
        common_name,
        scientific_name: get_field(
            record,
            col_map.scientific_name,
            COL_SCIENTIFIC_NAME,
            row_number,
        )?,
        count,
        latitude,
        longitude,
        country_code,
        region_code,
        observed_at,
        year,
    }))
}

async fn insert_batch<'e, E>(
    executor: E,
    upload_id: &str,
    rows: &[SightingRow],
) -> Result<(), DbQueryError>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    if rows.is_empty() {
        return Ok(());
    }

    let mut query_builder = QueryBuilder::new(
        "INSERT INTO sightings (upload_id, sighting_uuid, common_name, scientific_name, count, latitude, longitude, country_code, region_code, observed_at, year) "
    );

    query_builder.push_values(rows, |mut b, row| {
        b.push_bind(upload_id)
            .push_bind(&row.sighting_uuid)
            .push_bind(&row.common_name)
            .push_bind(&row.scientific_name)
            .push_bind(row.count)
            .push_bind(row.latitude)
            .push_bind(row.longitude)
            .push_bind(&row.country_code)
            .push_bind(&row.region_code)
            .push_bind(&row.observed_at)
            .push_bind(row.year);
    });

    db::query_with_timeout(query_builder.build().execute(executor)).await?;
    Ok(())
}

async fn flush_batch(
    tx: &mut Transaction<'_, Sqlite>,
    upload_id: &str,
    batch: &mut Vec<SightingRow>,
    total_rows: &mut usize,
) -> Result<(), ApiError> {
    if batch.is_empty() {
        return Ok(());
    }

    let batch_len = batch.len();

    {
        let conn = tx.acquire().await.map_err(|e| {
            error!("Failed to acquire connection for batch insert: {}", e);
            ApiError::internal("Database error")
        })?;

        insert_batch(conn, upload_id, batch).await.map_err(|e| {
            e.into_api_error("inserting sightings batch", "Failed to insert sightings")
        })?;
    }

    *total_rows += batch_len;
    batch.clear();
    Ok(())
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

    validate_header_limits(headers)?;

    let col_map = ColumnMap::from_headers(headers);
    if !col_map.is_valid() {
        error!("CSV missing required columns");
        return Err(ApiError::bad_request(
            "CSV missing required columns (sightingId, date, longitude, latitude, commonName)",
        ));
    }

    let mut tx = db::query_with_timeout(pool.begin())
        .await
        .map_err(|e| e.into_api_error("starting upload transaction", "Database error"))?;

    let mut batch: Vec<SightingRow> = Vec::with_capacity(BATCH_SIZE);
    let mut total_rows = 0usize;
    let mut record = csv_async::ByteRecord::new();
    let mut row_number = 1usize;

    while csv_reader
        .read_byte_record(&mut record)
        .await
        .map_err(|err| map_csv_error(err, "Failed to read CSV row", "Invalid CSV data"))?
    {
        enforce_record_limits(&record, row_number)?;
        if let Some(row) = parse_row(&record, &col_map, row_number)? {
            batch.push(row);
            if total_rows + batch.len() > MAX_UPLOAD_ROWS {
                return Err(ApiError::bad_request(format!(
                    "CSV exceeds {MAX_UPLOAD_ROWS} row limit"
                )));
            }
            if batch.len() >= BATCH_SIZE {
                flush_batch(&mut tx, upload_id, &mut batch, &mut total_rows).await?;
            }
        }
        row_number += 1;
    }

    flush_batch(&mut tx, upload_id, &mut batch, &mut total_rows).await?;

    db::query_with_timeout(tx.commit())
        .await
        .map_err(|e| e.into_api_error("committing upload transaction", "Database error"))?;

    Ok(total_rows)
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

    Ok(())
}

pub async fn upload_csv(
    State(pool): State<SqlitePool>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let _ = &*BOUNDARIES;

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

    let _ = &*BOUNDARIES;

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
