use crate::db::{self, DbQueryError};
use crate::error::ApiError;
use country_boundaries::{CountryBoundaries, LatLon, BOUNDARIES_ODBL_360X180};
use csv_async::{ByteRecord, StringRecord};
use once_cell::sync::Lazy;
use serde::Serialize;
use smartstring::{LazyCompact, SmartString};
use sqlx::{Acquire, QueryBuilder, Sqlite, Transaction};
use tracing::error;
use uuid::Uuid;

// Initialised once to avoid reloading the dataset on every request.
// Uses point-in-polygon testing with OpenStreetMap boundaries data.
static BOUNDARIES: Lazy<CountryBoundaries> = Lazy::new(|| {
    tracing::info!("Initialising country boundaries");
    CountryBoundaries::from_reader(BOUNDARIES_ODBL_360X180)
        .expect("Failed to load country boundaries data")
});

pub const BATCH_SIZE: usize = 1000;
pub const MAX_UPLOAD_ROWS: usize = 250_000;
const MAX_CSV_COLUMNS: usize = 256;
const MAX_RECORD_BYTES: usize = 8 * 1024; // 8 KiB per record to prevent line bombs

const COL_SIGHTING_ID: &str = "sightingId";
const COL_DATE: &str = "date";
const COL_LONGITUDE: &str = "longitude";
const COL_LATITUDE: &str = "latitude";
const COL_SCIENTIFIC_NAME: &str = "scientificName";
const COL_COMMON_NAME: &str = "commonName";
const COL_COUNT: &str = "count";

/// Raw sighting data parsed from CSV (before geocoding)
#[derive(Debug, Clone)]
pub struct ParsedSighting {
    pub sighting_uuid: String,
    pub common_name: String,
    pub scientific_name: Option<String>,
    pub count: i32,
    pub latitude: f64,
    pub longitude: f64,
    pub observed_at: String,
}

/// Type alias for stack-allocated strings (inline up to 23 bytes on 64-bit)
type SString = SmartString<LazyCompact>;

/// Fully processed sighting ready for database insertion
#[derive(Debug, Clone, Serialize)]
pub struct ProcessedSighting {
    // UUID: 16 bytes on stack (no heap allocation, no destructor overhead)
    pub sighting_uuid: Uuid,
    // Names & codes: stack-allocated if < 24 bytes ("Blue Tit", "US", "US-NY" fit inline)
    pub common_name: SString,
    pub scientific_name: Option<SString>,
    pub country_code: SString,
    pub region_code: Option<SString>,
    // ISO dates "YYYY-MM-DD" are 10 bytes -> fit inline perfectly
    pub observed_at: SString,
    pub count: i32,
    pub latitude: f64,
    pub longitude: f64,
    pub year: i32,
}

/// CSV Parser stage: reads CSV and parses rows into ParsedSighting
pub struct CsvParser {
    col_map: ColumnMap,
    row_number: usize,
}

impl CsvParser {
    pub fn new(headers: &StringRecord) -> Result<Self, ApiError> {
        validate_header_limits(headers)?;
        let col_map = ColumnMap::from_headers(headers);
        if !col_map.is_valid() {
            error!("CSV missing required columns");
            return Err(ApiError::bad_request(
                "CSV missing required columns (sightingId, date, longitude, latitude, commonName)",
            ));
        }
        Ok(Self {
            col_map,
            row_number: 1,
        })
    }

    pub fn parse_row(&mut self, record: &ByteRecord) -> Result<Option<ParsedSighting>, ApiError> {
        enforce_record_limits(record, self.row_number)?;
        self.row_number += 1;

        let Some(sighting_uuid) = get_field(
            record,
            self.col_map.sighting_id,
            COL_SIGHTING_ID,
            self.row_number - 1,
        )?
        else {
            return Ok(None);
        };
        let Some(common_name) = get_field(
            record,
            self.col_map.common_name,
            COL_COMMON_NAME,
            self.row_number - 1,
        )?
        else {
            return Ok(None);
        };
        let Some(observed_at) =
            get_field(record, self.col_map.date, COL_DATE, self.row_number - 1)?
        else {
            return Ok(None);
        };

        let latitude = match get_field(
            record,
            self.col_map.latitude,
            COL_LATITUDE,
            self.row_number - 1,
        )? {
            Some(value) => match value.parse::<f64>() {
                Ok(parsed) => parsed,
                Err(_) => return Ok(None),
            },
            None => return Ok(None),
        };
        let longitude = match get_field(
            record,
            self.col_map.longitude,
            COL_LONGITUDE,
            self.row_number - 1,
        )? {
            Some(value) => match value.parse::<f64>() {
                Ok(parsed) => parsed,
                Err(_) => return Ok(None),
            },
            None => return Ok(None),
        };

        let count: i32 = get_field(record, self.col_map.count, COL_COUNT, self.row_number - 1)?
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);

        let scientific_name = get_field(
            record,
            self.col_map.scientific_name,
            COL_SCIENTIFIC_NAME,
            self.row_number - 1,
        )?;

        Ok(Some(ParsedSighting {
            sighting_uuid,
            common_name,
            scientific_name,
            count,
            latitude,
            longitude,
            observed_at,
        }))
    }
}

/// Geocoder stage: adds country/region codes to parsed sightings
pub struct Geocoder;

impl Geocoder {
    pub fn new() -> Self {
        Self
    }

    pub async fn geocode_batch(
        &self,
        sightings: Vec<ParsedSighting>,
    ) -> Result<Vec<ProcessedSighting>, ApiError> {
        let coords: Vec<(f64, f64)> = sightings
            .iter()
            .map(|s| (s.latitude, s.longitude))
            .collect();

        let geocode_results = tokio::task::spawn_blocking(move || {
            coords
                .into_iter()
                .map(|(lat, lon)| {
                    let country_code = get_country_code(lat, lon);
                    let region_code = get_region_code(lat, lon);
                    (country_code, region_code)
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| {
            error!("Geocoding task join error: {}", e);
            ApiError::internal("Geocoding error")
        })?;

        Ok(sightings
            .into_iter()
            .zip(geocode_results)
            .map(|(sighting, (country_code, region_code))| {
                let year = extract_year(&sighting.observed_at);
                // Parse UUID from CSV string (validated during CSV parsing)
                let sighting_uuid = Uuid::parse_str(&sighting.sighting_uuid)
                    .expect("Invalid UUID format (should be caught during CSV parsing)");
                ProcessedSighting {
                    sighting_uuid,
                    common_name: sighting.common_name.into(),
                    scientific_name: sighting.scientific_name.map(Into::into),
                    count: sighting.count,
                    latitude: sighting.latitude,
                    longitude: sighting.longitude,
                    country_code: country_code.into(),
                    region_code: region_code.map(Into::into),
                    observed_at: sighting.observed_at.into(),
                    year,
                }
            })
            .collect())
    }
}

/// Database sink stage: writes processed sightings to the database
pub struct DbSink {
    upload_id: String,
    batch: Vec<ProcessedSighting>,
    total_rows: usize,
}

impl DbSink {
    pub fn new(upload_id: String) -> Self {
        Self {
            upload_id,
            batch: Vec::with_capacity(BATCH_SIZE),
            total_rows: 0,
        }
    }

    pub fn needs_flush(&self) -> bool {
        self.batch.len() >= BATCH_SIZE
    }

    pub fn add(&mut self, sighting: ProcessedSighting) -> Result<(), ApiError> {
        if self.total_rows + self.batch.len() + 1 > MAX_UPLOAD_ROWS {
            return Err(ApiError::bad_request(format!(
                "CSV exceeds {MAX_UPLOAD_ROWS} row limit"
            )));
        }

        self.batch.push(sighting);
        Ok(())
    }

    pub async fn flush(&mut self, tx: &mut Transaction<'_, Sqlite>) -> Result<(), ApiError> {
        if self.batch.is_empty() {
            return Ok(());
        }

        let batch_len = self.batch.len();

        {
            let conn = tx.acquire().await.map_err(|e| {
                error!("Failed to acquire connection for batch insert: {}", e);
                ApiError::internal("Database error")
            })?;

            insert_batch(conn, &self.upload_id, &self.batch)
                .await
                .map_err(|e| {
                    e.into_api_error("inserting sightings batch", "Failed to insert sightings")
                })?;
        }

        self.total_rows += batch_len;
        self.batch.clear();
        Ok(())
    }

    pub fn total_rows(&self) -> usize {
        self.total_rows + self.batch.len()
    }
}

async fn insert_batch<'e, E>(
    executor: E,
    upload_id: &str,
    rows: &[ProcessedSighting],
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
            .push_bind(row.sighting_uuid.to_string())
            .push_bind(row.common_name.as_str())
            .push_bind(row.scientific_name.as_ref().map(|s| s.as_str()))
            .push_bind(row.count)
            .push_bind(row.latitude)
            .push_bind(row.longitude)
            .push_bind(row.country_code.as_str())
            .push_bind(row.region_code.as_ref().map(|s| s.as_str()))
            .push_bind(row.observed_at.as_str())
            .push_bind(row.year);
    });

    db::query_with_timeout(query_builder.build().execute(executor)).await?;
    Ok(())
}

fn validate_header_limits(headers: &StringRecord) -> Result<(), ApiError> {
    let column_count = headers.len();
    if column_count > MAX_CSV_COLUMNS {
        return Err(ApiError::bad_request(format!(
            "CSV has {column_count} columns; maximum supported is {MAX_CSV_COLUMNS}"
        )));
    }
    Ok(())
}

fn enforce_record_limits(record: &ByteRecord, row_number: usize) -> Result<(), ApiError> {
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
    fn from_headers(headers: &StringRecord) -> Self {
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
    record: &ByteRecord,
    idx: Option<usize>,
    field_name: &str,
    row_number: usize,
) -> Result<Option<String>, ApiError> {
    let Some(bytes) = idx.and_then(|i| record.get(i)) else {
        return Ok(None);
    };

    // Try UTF-8 first, fallback to Windows-1252 for Excel files
    let value = match std::str::from_utf8(bytes) {
        Ok(v) => v.to_string(),
        Err(_) => {
            // Decode as Windows-1252 (common encoding for Excel CSV files on Windows)
            // This gracefully handles CSV files created in Excel that aren't UTF-8
            encoding_rs::WINDOWS_1252.decode_without_bom_handling_and_without_replacement(bytes)
                .ok_or_else(|| {
                    ApiError::bad_request(format!(
                        "Row {row_number} has invalid encoding in column {field_name} (neither UTF-8 nor Windows-1252)"
                    ))
                })?
                .into_owned()
        }
    };

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

fn get_country_code(lat: f64, lon: f64) -> SString {
    let Ok(latlon) = LatLon::new(lat, lon) else {
        return "XX".into();
    };

    let ids = BOUNDARIES.ids(latlon);
    // ids returns e.g. ["US-TX", "US"] or ["SG"] - we want the shortest (country) code
    ids.iter()
        .find(|id| !id.contains('-'))
        .or_else(|| ids.first())
        .map_or_else(|| "XX".into(), |s| (*s).into())
}

fn get_region_code(lat: f64, lon: f64) -> Option<SString> {
    let Ok(latlon) = LatLon::new(lat, lon) else {
        return None;
    };

    let ids = BOUNDARIES.ids(latlon);
    // ids returns e.g. ["US-TX", "US"] or ["SG"] - we want the code with a dash (region/subdivision)
    // If no subdivision exists (like Singapore), return None
    ids.iter().find(|id| id.contains('-')).map(|s| (*s).into())
}
