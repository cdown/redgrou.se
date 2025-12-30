use crate::db::{self, DbQueryError};
use crate::error::ApiError;
use crate::tiles::LatLng;
use country_boundaries::{CountryBoundaries, LatLon, BOUNDARIES_ODBL_360X180};
use csv_async::{ByteRecord, StringRecord};
use once_cell::sync::Lazy;
use smartstring::{LazyCompact, SmartString};
use sqlx::{Acquire, QueryBuilder, Sqlite, Transaction};
use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use tracing::error;
use uuid::Uuid;

// Initialised once to avoid reloading the dataset on every request.
// Uses point-in-polygon testing with OpenStreetMap boundaries data.
static BOUNDARIES: Lazy<CountryBoundaries> = Lazy::new(|| {
    tracing::info!("Initialising country boundaries");
    CountryBoundaries::from_reader(BOUNDARIES_ODBL_360X180).unwrap_or_else(|err| {
        error!("Failed to load country boundaries data: {}", err);
        panic!("Country boundaries data is required for geocoding. Application cannot start without it.");
    })
});

pub const BATCH_SIZE: usize = 1000;
pub const MAX_UPLOAD_ROWS: usize = 250_000;
const MAX_CSV_COLUMNS: usize = 256;
const MAX_RECORD_BYTES: usize = 8 * 1024; // 8 KiB per record to prevent line bombs
const SQLITE_MAX_VARIABLES: usize = 999;
const SPECIES_LOOKUP_BATCH_SIZE: usize = SQLITE_MAX_VARIABLES / 2;

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

type SString = SmartString<LazyCompact>;
type SpeciesKey = (SString, SString);

/// Fully processed sighting ready for database insertion
#[derive(Debug, Clone)]
pub struct ProcessedSighting {
    // UUID: 16 bytes on stack (no heap allocation, no destructor overhead)
    pub sighting_uuid: Uuid,
    // Species names stored temporarily for lookup, then converted to species_id
    pub common_name: SString,
    pub scientific_name: SString,
    // Species ID (looked up before insertion)
    pub species_id: Option<i64>,
    pub country_code: SString,
    pub region_code: Option<SString>,
    // ISO dates "YYYY-MM-DD" are 10 bytes -> fit inline perfectly
    pub observed_at: SString,
    pub count: i32,
    pub latitude: f64,
    pub longitude: f64,
    pub year: i32,
    // Tick flags (computed during upload)
    pub lifer: bool,
    pub year_tick: bool,
    pub country_tick: bool,
    pub vis_rank: i32,
}

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

pub struct Geocoder;

impl Geocoder {
    pub fn new() -> Self {
        Self
    }

    pub async fn geocode_batch(
        &self,
        sightings: Vec<ParsedSighting>,
    ) -> Result<Vec<ProcessedSighting>, ApiError> {
        let coords: Vec<LatLng> = sightings
            .iter()
            .map(|s| LatLng {
                lat: s.latitude,
                lng: s.longitude,
            })
            .collect();

        let geocode_results = tokio::task::spawn_blocking(move || {
            coords
                .into_iter()
                .map(|latlng| {
                    let country_code = get_country_code(latlng);
                    let region_code = get_region_code(latlng);
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
                let sighting_uuid = Uuid::parse_str(&sighting.sighting_uuid).unwrap_or_else(|err| {
                    error!("Invalid UUID format in processed sighting (should be caught during CSV parsing): {} - {}", sighting.sighting_uuid, err);
                    // Generate a new UUID as fallback - this should never happen in practice
                    Uuid::new_v4()
                });
                ProcessedSighting {
                    sighting_uuid,
                    common_name: sighting.common_name.into(),
                    scientific_name: sighting.scientific_name.unwrap_or_default().into(),
                    species_id: None, // Will be looked up before insertion
                    count: sighting.count,
                    latitude: sighting.latitude,
                    longitude: sighting.longitude,
                    country_code,
                    region_code,
                    observed_at: sighting.observed_at.into(),
                    year,
                    lifer: false, // Will be set during flush
                    year_tick: false, // Will be set during flush
                    country_tick: false, // Will be set during flush
                    vis_rank: 0, // Will be set during flush
                }
            })
            .collect())
    }
}

impl Default for Geocoder {
    fn default() -> Self {
        Self::new()
    }
}

pub struct DbSink {
    upload_id: String,
    batch: Vec<ProcessedSighting>,
    total_rows: usize,
    // Track seen species/years/countries for tick calculation
    seen_species: HashSet<i64>,
    seen_year_ticks: HashSet<(i64, i32)>,
    seen_country_ticks: HashSet<(i64, String)>,
    species_cache: HashMap<(SString, SString), i64>,
}

impl DbSink {
    pub fn new(upload_id: String) -> Self {
        Self {
            upload_id,
            batch: Vec::with_capacity(BATCH_SIZE),
            total_rows: 0,
            seen_species: HashSet::new(),
            seen_year_ticks: HashSet::new(),
            seen_country_ticks: HashSet::new(),
            species_cache: HashMap::new(),
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

    pub async fn flush(&mut self, pool: &sqlx::SqlitePool) -> Result<(), ApiError> {
        if self.batch.is_empty() {
            return Ok(());
        }

        let mut tx = db::query_with_timeout(pool.begin())
            .await
            .map_err(|e| e.into_api_error("starting upload batch transaction", "Database error"))?;

        self.flush_with_transaction(&mut tx).await?;

        db::query_with_timeout(tx.commit()).await.map_err(|e| {
            e.into_api_error("committing upload batch transaction", "Database error")
        })?;

        let batch_len = self.batch.len();
        self.total_rows += batch_len;
        self.batch.clear();
        Ok(())
    }

    async fn flush_with_transaction(
        &mut self,
        tx: &mut Transaction<'_, Sqlite>,
    ) -> Result<(), ApiError> {
        let conn = tx.acquire().await.map_err(|e| {
            error!("Failed to acquire connection for batch insert: {}", e);
            ApiError::internal("Database error")
        })?;

        self.resolve_species_ids(&mut *conn).await?;

        // Compute tick flags
        for sighting in &mut self.batch {
            let species_id = sighting.species_id.expect("species_id should be set");

            // Check for lifer (first sighting of this species in this upload)
            if !self.seen_species.contains(&species_id) {
                sighting.lifer = true;
                self.seen_species.insert(species_id);
            }

            // Check for year tick (first sighting of this species in this year)
            let year_tick_key = (species_id, sighting.year);
            if !self.seen_year_ticks.contains(&year_tick_key) {
                sighting.year_tick = true;
                self.seen_year_ticks.insert(year_tick_key);
            }

            // Check for country tick (first sighting of this species in this country)
            if !sighting.country_code.is_empty()
                && !sighting.country_code.eq_ignore_ascii_case("XX")
            {
                let country_tick_key = (species_id, sighting.country_code.to_string());
                if !self.seen_country_ticks.contains(&country_tick_key) {
                    sighting.country_tick = true;
                    self.seen_country_ticks.insert(country_tick_key);
                }
            }

            // Set vis_rank: 0 for lifers/year_ticks/country_ticks, pseudo-random otherwise
            if sighting.lifer || sighting.year_tick || sighting.country_tick {
                sighting.vis_rank = 0;
            } else {
                // Use hash of UUID for pseudo-random vis_rank (0-10000)
                let mut hasher = DefaultHasher::new();
                sighting.sighting_uuid.hash(&mut hasher);
                sighting.vis_rank = (hasher.finish() % 10001) as i32;
            }
        }

        insert_batch(conn, &self.upload_id, &self.batch)
            .await
            .map_err(|e| {
                e.into_api_error("inserting sightings batch", "Failed to insert sightings")
            })?;

        Ok(())
    }

    async fn resolve_species_ids(
        &mut self,
        conn: &mut sqlx::SqliteConnection,
    ) -> Result<(), ApiError> {
        let mut pending: HashMap<SpeciesKey, Vec<usize>> = HashMap::new();

        for (idx, sighting) in self.batch.iter_mut().enumerate() {
            if sighting.species_id.is_some() {
                continue;
            }

            let key = (
                sighting.common_name.clone(),
                sighting.scientific_name.clone(),
            );

            if let Some(&cached_id) = self.species_cache.get(&key) {
                sighting.species_id = Some(cached_id);
                continue;
            }

            pending.entry(key).or_default().push(idx);
        }

        if pending.is_empty() {
            return Ok(());
        }

        let lookup_keys: Vec<SpeciesKey> = pending.keys().cloned().collect();
        let existing = fetch_species_ids(conn, &lookup_keys)
            .await
            .map_err(|e| e.into_api_error("looking up species", "Failed to look up species"))?;
        apply_resolved_species(
            existing,
            &mut pending,
            &mut self.species_cache,
            &mut self.batch,
        );

        if !pending.is_empty() {
            let missing_keys: Vec<SpeciesKey> = pending.keys().cloned().collect();
            let inserted = insert_species_batch(conn, &missing_keys)
                .await
                .map_err(|e| e.into_api_error("looking up species", "Failed to look up species"))?;
            apply_resolved_species(
                inserted,
                &mut pending,
                &mut self.species_cache,
                &mut self.batch,
            );
        }

        if !pending.is_empty() {
            let retry_keys: Vec<SpeciesKey> = pending.keys().cloned().collect();
            let resolved = fetch_species_ids(conn, &retry_keys)
                .await
                .map_err(|e| e.into_api_error("looking up species", "Failed to look up species"))?;
            apply_resolved_species(
                resolved,
                &mut pending,
                &mut self.species_cache,
                &mut self.batch,
            );
        }

        if !pending.is_empty() {
            error!(
                "Failed to resolve species IDs for {:?}",
                pending.keys().collect::<Vec<_>>()
            );
            return Err(ApiError::internal("Failed to look up species"));
        }

        Ok(())
    }

    pub fn total_rows(&self) -> usize {
        self.total_rows + self.batch.len()
    }
}

async fn fetch_species_ids(
    conn: &mut sqlx::SqliteConnection,
    keys: &[SpeciesKey],
) -> Result<Vec<(SpeciesKey, i64)>, DbQueryError> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }

    let mut resolved = Vec::new();

    for chunk in keys.chunks(SPECIES_LOOKUP_BATCH_SIZE.max(1)) {
        let mut qb =
            QueryBuilder::new("SELECT common_name, scientific_name, id FROM species WHERE ");

        let mut first = true;
        for key in chunk {
            if !first {
                qb.push(" OR ");
            }
            first = false;
            qb.push("(common_name = ")
                .push_bind(key.0.as_str())
                .push(" AND scientific_name = ")
                .push_bind(key.1.as_str())
                .push(")");
        }

        let rows = db::query_with_timeout(
            qb.build_query_as::<(String, String, i64)>()
                .fetch_all(&mut *conn),
        )
        .await?;

        resolved.extend(
            rows.into_iter()
                .map(|(common, scientific, id)| ((common.into(), scientific.into()), id)),
        );
    }

    Ok(resolved)
}

async fn insert_species_batch(
    conn: &mut sqlx::SqliteConnection,
    keys: &[SpeciesKey],
) -> Result<Vec<(SpeciesKey, i64)>, DbQueryError> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }

    let mut inserted = Vec::new();

    for chunk in keys.chunks(SPECIES_LOOKUP_BATCH_SIZE.max(1)) {
        let mut qb =
            QueryBuilder::new("INSERT INTO species (common_name, scientific_name) VALUES ");

        let mut first = true;
        for key in chunk {
            if !first {
                qb.push(", ");
            }
            first = false;
            qb.push("(")
                .push_bind(key.0.as_str())
                .push(", ")
                .push_bind(key.1.as_str())
                .push(")");
        }
        qb.push(" ON CONFLICT DO NOTHING RETURNING common_name, scientific_name, id");

        let rows = db::query_with_timeout(
            qb.build_query_as::<(String, String, i64)>()
                .fetch_all(&mut *conn),
        )
        .await?;

        inserted.extend(
            rows.into_iter()
                .map(|(common, scientific, id)| ((common.into(), scientific.into()), id)),
        );
    }

    Ok(inserted)
}

fn apply_resolved_species(
    resolved: Vec<(SpeciesKey, i64)>,
    pending: &mut HashMap<SpeciesKey, Vec<usize>>,
    cache: &mut HashMap<SpeciesKey, i64>,
    batch: &mut [ProcessedSighting],
) {
    for (key, id) in resolved {
        cache.insert(key.clone(), id);
        if let Some(indices) = pending.remove(&key) {
            for idx in indices {
                batch[idx].species_id = Some(id);
            }
        }
    }
}

async fn insert_batch(
    conn: &mut sqlx::SqliteConnection,
    upload_id: &str,
    rows: &[ProcessedSighting],
) -> Result<(), DbQueryError> {
    if rows.is_empty() {
        return Ok(());
    }

    let upload_uuid = Uuid::parse_str(upload_id)
        .map_err(|_| DbQueryError::Sqlx(sqlx::Error::Decode("Invalid UUID format".into())))?;
    let upload_blob = upload_uuid.as_bytes();
    const COLUMNS_PER_ROW: usize = 14;
    let max_rows_per_chunk = (SQLITE_MAX_VARIABLES / COLUMNS_PER_ROW).max(1);

    for chunk in rows.chunks(max_rows_per_chunk) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "INSERT INTO sightings (upload_id, sighting_uuid, species_id, count, latitude, longitude, country_code, region_code, observed_at, year, lifer, year_tick, country_tick, vis_rank) VALUES ",
        );

        for (idx, sighting) in chunk.iter().enumerate() {
            let species_id = sighting
                .species_id
                .expect("species_id should be set before insert");

            if idx > 0 {
                qb.push(", ");
            }

            qb.push("(");
            qb.push_bind(upload_blob.as_ref());
            qb.push(", ");
            qb.push_bind(&sighting.sighting_uuid.as_bytes()[..]);
            qb.push(", ");
            qb.push_bind(species_id);
            qb.push(", ");
            qb.push_bind(sighting.count);
            qb.push(", ");
            qb.push_bind(sighting.latitude);
            qb.push(", ");
            qb.push_bind(sighting.longitude);
            qb.push(", ");
            qb.push_bind(sighting.country_code.as_str());
            qb.push(", ");
            qb.push_bind(sighting.region_code.as_deref());
            qb.push(", ");
            qb.push_bind(sighting.observed_at.as_str());
            qb.push(", ");
            qb.push_bind(sighting.year);
            qb.push(", ");
            qb.push_bind(i32::from(sighting.lifer));
            qb.push(", ");
            qb.push_bind(i32::from(sighting.year_tick));
            qb.push(", ");
            qb.push_bind(i32::from(sighting.country_tick));
            qb.push(", ");
            qb.push_bind(sighting.vis_rank);
            qb.push(")");
        }

        let query = qb.build();
        db::query_with_timeout(query.execute(&mut *conn)).await?;
    }

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
    date_str
        .get(0..4)
        .and_then(|y| y.parse().ok())
        .unwrap_or_else(|| {
            tracing::warn!("Failed to extract year from date string: {}", date_str);
            0
        })
}

fn get_country_code(latlng: LatLng) -> SString {
    let Ok(latlon) = LatLon::new(latlng.lat, latlng.lng) else {
        return "XX".into();
    };

    let ids = BOUNDARIES.ids(latlon);
    // ids returns e.g. ["US-TX", "US"] or ["SG"] - we want the shortest (country) code
    ids.iter()
        .find(|id| !id.contains('-'))
        .or_else(|| ids.first())
        .map_or_else(|| "XX".into(), |s| (*s).into())
}

fn get_region_code(latlng: LatLng) -> Option<SString> {
    let Ok(latlon) = LatLon::new(latlng.lat, latlng.lng) else {
        return None;
    };

    let ids = BOUNDARIES.ids(latlon);
    // ids returns e.g. ["US-TX", "US"] or ["SG"] - we want the code with a dash (region/subdivision)
    // If no subdivision exists (like Singapore), return None
    ids.iter().find(|id| id.contains('-')).map(|s| (*s).into())
}
