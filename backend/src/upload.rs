use axum::extract::{Multipart, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use once_cell::sync::Lazy;
use reverse_geocoder::ReverseGeocoder;
use serde::Serialize;
use sqlx::{QueryBuilder, SqlitePool};
use tracing::{error, info};
use uuid::Uuid;

// Initialised once to avoid reloading the ~2MB dataset on every request
static GEOCODER: Lazy<ReverseGeocoder> = Lazy::new(|| {
    info!("Initialising reverse geocoder");
    ReverseGeocoder::new()
});

const BATCH_SIZE: usize = 1000;

const COL_SIGHTING_ID: &str = "sightingId";
const COL_DATE: &str = "date";
const COL_LONGITUDE: &str = "longitude";
const COL_LATITUDE: &str = "latitude";
const COL_SCIENTIFIC_NAME: &str = "scientificName";
const COL_COMMON_NAME: &str = "commonName";
const COL_COUNT: &str = "count";
const COL_NOTE: &str = "note";
const COL_SESSION_TITLE: &str = "sessionTitle";
const COL_LIFER: &str = "lifer";
const COL_YEAR_TICK: &str = "yearTick";

#[derive(Serialize)]
pub struct UploadResponse {
    pub upload_id: String,
    pub filename: String,
    pub row_count: usize,
}

#[derive(Serialize)]
pub struct UploadError {
    pub error: String,
}

struct SightingRow {
    sighting_uuid: String,
    common_name: String,
    scientific_name: Option<String>,
    count: i32,
    latitude: f64,
    longitude: f64,
    country_code: String,
    observed_at: String,
    year: i32,
    notes: Option<String>,
    trip_name: Option<String>,
    lifer: bool,
    year_tick: bool,
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
    note: Option<usize>,
    session_title: Option<usize>,
    lifer: Option<usize>,
    year_tick: Option<usize>,
}

impl ColumnMap {
    fn from_headers(headers: &csv::StringRecord) -> Self {
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
                COL_NOTE => map.note = Some(idx),
                COL_SESSION_TITLE => map.session_title = Some(idx),
                COL_LIFER => map.lifer = Some(idx),
                COL_YEAR_TICK => map.year_tick = Some(idx),
                _ => {}
            }
        }
        map
    }

    fn is_valid(&self) -> bool {
        self.sighting_id.is_some()
            && self.date.is_some()
            && self.longitude.is_some()
            && self.latitude.is_some()
            && self.common_name.is_some()
    }
}

fn get_field(record: &csv::ByteRecord, idx: Option<usize>) -> Option<String> {
    idx.and_then(|i| record.get(i))
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn parse_bool(record: &csv::ByteRecord, idx: Option<usize>) -> bool {
    get_field(record, idx)
        .map(|s| s.to_lowercase() == "true")
        .unwrap_or(false)
}

fn extract_year(date_str: &str) -> i32 {
    // ISO 8601 format: 2020-02-14T09:34:18.584Z
    date_str.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0)
}

fn parse_row(record: &csv::ByteRecord, col_map: &ColumnMap) -> Option<SightingRow> {
    let sighting_uuid = get_field(record, col_map.sighting_id)?;
    let common_name = get_field(record, col_map.common_name)?;
    let observed_at = get_field(record, col_map.date)?;

    let latitude: f64 = get_field(record, col_map.latitude)?.parse().ok()?;
    let longitude: f64 = get_field(record, col_map.longitude)?.parse().ok()?;

    let search_result = GEOCODER.search((latitude, longitude));
    let country_code = search_result.record.cc.to_string();

    let count: i32 = get_field(record, col_map.count)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);

    let year = extract_year(&observed_at);
    let lifer = parse_bool(record, col_map.lifer);
    let year_tick = parse_bool(record, col_map.year_tick);

    Some(SightingRow {
        sighting_uuid,
        common_name,
        scientific_name: get_field(record, col_map.scientific_name),
        count,
        latitude,
        longitude,
        country_code,
        observed_at,
        year,
        notes: get_field(record, col_map.note),
        trip_name: get_field(record, col_map.session_title),
        lifer,
        year_tick,
    })
}

async fn insert_batch(
    pool: &SqlitePool,
    upload_id: &str,
    rows: &[SightingRow],
) -> Result<(), sqlx::Error> {
    if rows.is_empty() {
        return Ok(());
    }

    let mut query_builder = QueryBuilder::new(
        "INSERT INTO sightings (upload_id, sighting_uuid, common_name, scientific_name, count, latitude, longitude, country_code, observed_at, year, notes, trip_name, lifer, year_tick) "
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
            .push_bind(&row.observed_at)
            .push_bind(row.year)
            .push_bind(&row.notes)
            .push_bind(&row.trip_name)
            .push_bind(row.lifer)
            .push_bind(row.year_tick);
    });

    query_builder.build().execute(pool).await?;
    Ok(())
}

pub async fn upload_csv(
    State(pool): State<SqlitePool>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let _ = &*GEOCODER;

    while let Ok(Some(field)) = multipart.next_field().await {
        let filename = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unknown.csv".to_string());

        if !filename.ends_with(".csv") {
            continue;
        }

        let data = match field.bytes().await {
            Ok(d) => d,
            Err(e) => {
                error!("Failed to read upload: {}", e);
                return (
                    StatusCode::BAD_REQUEST,
                    Json(UploadError {
                        error: "Failed to read upload data".to_string(),
                    }),
                )
                    .into_response();
            }
        };

        let upload_id = Uuid::new_v4().to_string();

        if let Err(e) = sqlx::query("INSERT INTO uploads (id, filename) VALUES (?, ?)")
            .bind(&upload_id)
            .bind(&filename)
            .execute(&pool)
            .await
        {
            error!("Failed to create upload record: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(UploadError {
                    error: "Database error".to_string(),
                }),
            )
                .into_response();
        }

        let mut reader = csv::ReaderBuilder::new()
            .has_headers(true)
            .from_reader(data.as_ref());

        let headers = match reader.headers() {
            Ok(h) => h.clone(),
            Err(e) => {
                error!("Failed to read CSV headers: {}", e);
                return (
                    StatusCode::BAD_REQUEST,
                    Json(UploadError {
                        error: "Invalid CSV headers".to_string(),
                    }),
                )
                    .into_response();
            }
        };

        let col_map = ColumnMap::from_headers(&headers);
        if !col_map.is_valid() {
            error!("CSV missing required columns");
            return (
                StatusCode::BAD_REQUEST,
                Json(UploadError {
                    error: "CSV missing required columns (sightingId, date, longitude, latitude, commonName)".to_string(),
                }),
            )
                .into_response();
        }

        let mut batch: Vec<SightingRow> = Vec::with_capacity(BATCH_SIZE);
        let mut total_rows = 0usize;
        let mut record = csv::ByteRecord::new();

        while reader.read_byte_record(&mut record).unwrap_or(false) {
            if let Some(row) = parse_row(&record, &col_map) {
                batch.push(row);

                if batch.len() >= BATCH_SIZE {
                    if let Err(e) = insert_batch(&pool, &upload_id, &batch).await {
                        error!("Batch insert failed: {}", e);
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(UploadError {
                                error: "Failed to insert sightings".to_string(),
                            }),
                        )
                            .into_response();
                    }
                    total_rows += batch.len();
                    batch.clear();
                }
            }
        }

        if !batch.is_empty() {
            if let Err(e) = insert_batch(&pool, &upload_id, &batch).await {
                error!("Final batch insert failed: {}", e);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(UploadError {
                        error: "Failed to insert sightings".to_string(),
                    }),
                )
                    .into_response();
            }
            total_rows += batch.len();
        }

        let _ = sqlx::query("UPDATE uploads SET row_count = ? WHERE id = ?")
            .bind(total_rows as i64)
            .bind(&upload_id)
            .execute(&pool)
            .await;

        info!(
            "Upload complete: {} rows from {} (upload_id: {})",
            total_rows, filename, upload_id
        );

        return (
            StatusCode::OK,
            Json(UploadResponse {
                upload_id,
                filename,
                row_count: total_rows,
            }),
        )
            .into_response();
    }

    (
        StatusCode::BAD_REQUEST,
        Json(UploadError {
            error: "No CSV file found in upload".to_string(),
        }),
    )
        .into_response()
}
