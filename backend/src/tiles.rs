use crate::db::DbPools;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use moka::future::Cache;
use mvt::{GeomEncoder, GeomType, Tile};
use once_cell::sync::Lazy;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio::time::timeout;
use tracing::{debug, error};

use crate::db;
use crate::error::ApiError;
use crate::filter::{build_filter_clause, FilterRequest, FilterSql, TableAliases, TickVisibility};
use crate::upload::get_upload_data_version;
use uuid::Uuid;

const TILE_EXTENT: u32 = 4096;
// Maximum vis_rank value (0-10000). When threshold equals this, all points are included.
const MAX_VIS_RANK: i32 = 10000;
// Tile cache size limit: ~50MB (assuming average tile size of ~10KB, cache ~5000 tiles)
const TILE_CACHE_SIZE: u64 = 50 * 1024 * 1024;
const TILE_ENCODER_MAX_CONCURRENCY: usize = 128;
const TILE_ENCODER_WAIT_TIMEOUT_MS: u64 = 500;
static TILE_ENCODER_GUARD: Lazy<Arc<Semaphore>> =
    Lazy::new(|| Arc::new(Semaphore::new(TILE_ENCODER_MAX_CONCURRENCY)));
const BBOX_CANDIDATE_LIMIT_MULTIPLIER: i64 = 4;
const BBOX_CANDIDATE_LIMIT_MAX: i64 = 1_000_000;

// LRU cache for tiles: key is (upload_id, z, x, y, filter_hash), value is encoded MVT bytes
static TILE_CACHE: Lazy<Cache<String, Vec<u8>>> = Lazy::new(|| {
    Cache::builder()
        .max_capacity(TILE_CACHE_SIZE)
        .weigher(|_key: &String, value: &Vec<u8>| -> u32 {
            // Return size in bytes as weight (moka uses u32, so cap at u32::MAX)
            value.len().min(u32::MAX as usize) as u32
        })
        .build()
});

#[derive(Debug, Clone, Copy)]
pub struct LatLng {
    pub lat: f64,
    pub lng: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct TileCoordinates {
    pub z: u32,
    pub x: u32,
    pub y: u32,
}

struct Bbox {
    lon_min: f64,
    lat_min: f64,
    lon_max: f64,
    lat_max: f64,
}

fn tile_to_bbox(coords: TileCoordinates) -> Bbox {
    let n = 2_f64.powi(i32::try_from(coords.z).unwrap_or(i32::MAX));

    let lon_min = (f64::from(coords.x) / n) * 360.0 - 180.0;
    let lon_max = (f64::from(coords.x + 1) / n) * 360.0 - 180.0;

    let lat_max = (std::f64::consts::PI * (1.0 - 2.0 * f64::from(coords.y) / n))
        .sinh()
        .atan()
        .to_degrees();
    let lat_min = (std::f64::consts::PI * (1.0 - 2.0 * f64::from(coords.y + 1) / n))
        .sinh()
        .atan()
        .to_degrees();

    Bbox {
        lon_min,
        lat_min,
        lon_max,
        lat_max,
    }
}

struct TileCoords {
    tile_x: f64,
    tile_y: f64,
}

fn latlng_to_tile_coords(latlng: LatLng, tile_coords: TileCoordinates) -> TileCoords {
    let n = 2_f64.powi(i32::try_from(tile_coords.z).unwrap_or(i32::MAX));

    let world_x = (latlng.lng + 180.0) / 360.0 * n;
    let lat_rad = latlng.lat.to_radians();
    let world_y =
        (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / std::f64::consts::PI) / 2.0 * n;

    let tile_x = (world_x - f64::from(tile_coords.x)) * f64::from(TILE_EXTENT);
    let tile_y = (world_y - f64::from(tile_coords.y)) * f64::from(TILE_EXTENT);

    TileCoords { tile_x, tile_y }
}

#[derive(Debug, Deserialize)]
pub struct TileQuery {
    filter: Option<String>,
    year_tick_year: Option<i32>,
    country_tick_country: Option<String>,
    tick_filter: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct TilePath {
    pub upload_id: String,
    pub z: u32,
    pub x: u32,
    pub y: String,
}

fn compute_filter_hash(
    filter: Option<&String>,
    tick_filter: Option<&String>,
    tick_visibility: &TickVisibility,
    year_tick_year: Option<i32>,
    country_tick_country: Option<&String>,
) -> String {
    let mut hasher = Sha256::new();
    if let Some(f) = filter {
        hasher.update(f.as_bytes());
    }
    if let Some(tf) = tick_filter {
        hasher.update(tf.as_bytes());
    }
    hasher.update([if tick_visibility.include_lifer { 1 } else { 0 }]);
    hasher.update([if tick_visibility.include_year { 1 } else { 0 }]);
    hasher.update([if tick_visibility.include_country {
        1
    } else {
        0
    }]);
    hasher.update([if tick_visibility.include_normal { 1 } else { 0 }]);
    if let Some(yt) = year_tick_year {
        hasher.update(yt.to_le_bytes());
    }
    if let Some(ct) = country_tick_country {
        hasher.update(ct.as_bytes());
    }
    hex::encode(hasher.finalize())
}

struct RowData {
    id: i64,
    latitude: f64,
    longitude: f64,
    common_name: String,
    scientific_name: Option<String>,
    count: i32,
    observed_at: String,
    lifer: i32,
    year_tick: i32,
    country_tick: i32,
}

struct TileRequest {
    upload_uuid: Uuid,
    tile_pos: TileCoordinates,
    bbox: Bbox,
    cache_key: String,
    filter_sql: FilterSql,
    include_all_points: bool,
    vis_rank_threshold: i32,
    max_points: i64,
    data_version: i64,
}

impl TileRequest {
    async fn build(pools: &DbPools, path: TilePath, query: TileQuery) -> Result<Self, ApiError> {
        let upload_uuid = Uuid::parse_str(&path.upload_id)
            .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
        let y: u32 = path
            .y
            .trim_end_matches(".pbf")
            .parse()
            .map_err(|_| ApiError::bad_request("Invalid y coordinate"))?;
        let data_version = get_upload_data_version(pools.read(), &upload_uuid).await?;

        let tile_pos = TileCoordinates {
            z: path.z,
            x: path.x,
            y,
        };
        let bbox = tile_to_bbox(tile_pos);

        let TileQuery {
            filter,
            year_tick_year,
            country_tick_country,
            tick_filter,
        } = query;
        let tick_visibility = TickVisibility::from_query(tick_filter.as_deref())
            .map(|vis| vis.with_required(year_tick_year, country_tick_country.as_ref()))?;

        let filter_hash = compute_filter_hash(
            filter.as_ref(),
            tick_filter.as_ref(),
            &tick_visibility,
            year_tick_year,
            country_tick_country.as_ref(),
        );

        let filter_sql = build_filter_clause(FilterRequest {
            pool: pools.read(),
            upload_id: &upload_uuid.as_bytes()[..],
            filter_json: filter.as_ref(),
            year_tick_year,
            country_tick_country: country_tick_country.as_ref(),
            aliases: TableAliases::new(Some("s"), Some("sp")),
            tick_visibility: &tick_visibility,
        })
        .await?;

        let cache_key = format!(
            "{}:{}:{}:{}:{}:{}",
            path.upload_id, data_version, path.z, path.x, y, filter_hash
        );

        let (vis_rank_threshold, include_all_points) = zoom_threshold(path.z);
        let max_points = max_points_for_zoom(path.z);

        Ok(Self {
            upload_uuid,
            tile_pos,
            bbox,
            cache_key,
            filter_sql,
            include_all_points,
            vis_rank_threshold,
            max_points,
            data_version,
        })
    }

    fn cache_key(&self) -> &str {
        &self.cache_key
    }

    fn upload_id_bytes(&self) -> &[u8] {
        self.upload_uuid.as_bytes()
    }

    fn tile_pos(&self) -> TileCoordinates {
        self.tile_pos
    }

    fn bbox(&self) -> &Bbox {
        &self.bbox
    }

    fn data_version(&self) -> i64 {
        self.data_version
    }
}

struct TileDataFetcher<'a> {
    pools: &'a DbPools,
}

impl<'a> TileDataFetcher<'a> {
    fn new(pools: &'a DbPools) -> Self {
        Self { pools }
    }

    async fn fetch_rows(&self, request: &TileRequest) -> Result<Vec<RowData>, ApiError> {
        if request.include_all_points {
            self.fetch_with_rtree(request).await
        } else {
            self.fetch_with_vis_rank(request).await
        }
    }

    async fn fetch_with_rtree(&self, request: &TileRequest) -> Result<Vec<RowData>, ApiError> {
        let candidate_limit = (request
            .max_points
            .saturating_mul(BBOX_CANDIDATE_LIMIT_MULTIPLIER))
        .max(request.max_points)
        .min(BBOX_CANDIDATE_LIMIT_MAX);

        let sql = format!(
            r#"
            WITH bbox AS (
                SELECT id
                FROM sightings_geo
                WHERE max_lat >= ? AND min_lat <= ?
                  AND max_lon >= ? AND min_lon <= ?
                LIMIT ?
            )
            SELECT
                s.id,
                s.latitude,
                s.longitude,
                sp.common_name,
                sp.scientific_name,
                s.count,
                s.observed_at,
                s.lifer,
                s.year_tick,
                s.country_tick
            FROM bbox
            JOIN sightings AS s ON s.id = bbox.id
            JOIN species sp ON s.species_id = sp.id
            WHERE s.upload_id = ?{}
            LIMIT ?
            "#,
            request.filter_sql.clause()
        );

        let mut db_query = sqlx::query(&sql)
            .bind(request.bbox.lat_min)
            .bind(request.bbox.lat_max)
            .bind(request.bbox.lon_min)
            .bind(request.bbox.lon_max)
            .bind(candidate_limit)
            .bind(request.upload_id_bytes());

        for param in request.filter_sql.params() {
            db_query = db_query.bind(param);
        }
        db_query = db_query.bind(request.max_points);

        let rows = db::query_with_timeout(db_query.fetch_all(self.pools.read()))
            .await
            .map_err(|e| e.into_api_error("loading tile sightings", "Database error"))?;

        Ok(rows
            .into_iter()
            .map(|row| RowData {
                id: row.get("id"),
                latitude: row.get("latitude"),
                longitude: row.get("longitude"),
                common_name: row.get("common_name"),
                scientific_name: row.get("scientific_name"),
                count: row.get("count"),
                observed_at: row.get("observed_at"),
                lifer: row.get("lifer"),
                year_tick: row.get("year_tick"),
                country_tick: row.get("country_tick"),
            })
            .collect())
    }

    async fn fetch_with_vis_rank(&self, request: &TileRequest) -> Result<Vec<RowData>, ApiError> {
        let sql = format!(
            r#"
            SELECT
                s.id,
                s.latitude,
                s.longitude,
                sp.common_name,
                sp.scientific_name,
                s.count,
                s.observed_at,
                s.lifer,
                s.year_tick,
                s.country_tick
            FROM sightings AS s
            JOIN species sp ON s.species_id = sp.id
            JOIN sightings_geo AS sg ON sg.id = s.id
            WHERE s.upload_id = ?
              AND s.vis_rank < ?
              AND sg.max_lat >= ? AND sg.min_lat <= ?
              AND sg.max_lon >= ? AND sg.min_lon <= ?
            {}
            LIMIT ?
            "#,
            request.filter_sql.clause()
        );

        let mut db_query = sqlx::query(&sql)
            .bind(request.upload_id_bytes())
            .bind(request.vis_rank_threshold)
            .bind(request.bbox.lat_min)
            .bind(request.bbox.lat_max)
            .bind(request.bbox.lon_min)
            .bind(request.bbox.lon_max);

        for param in request.filter_sql.params() {
            db_query = db_query.bind(param);
        }
        db_query = db_query.bind(request.max_points);

        let rows = db::query_with_timeout(db_query.fetch_all(self.pools.read()))
            .await
            .map_err(|e| e.into_api_error("loading tile sightings", "Database error"))?;

        Ok(rows
            .into_iter()
            .map(|row| RowData {
                id: row.get("id"),
                latitude: row.get("latitude"),
                longitude: row.get("longitude"),
                common_name: row.get("common_name"),
                scientific_name: row.get("scientific_name"),
                count: row.get("count"),
                observed_at: row.get("observed_at"),
                lifer: row.get("lifer"),
                year_tick: row.get("year_tick"),
                country_tick: row.get("country_tick"),
            })
            .collect())
    }
}

struct TileEncoder;

impl TileEncoder {
    async fn encode(tile_pos: TileCoordinates, rows: Vec<RowData>) -> Result<Vec<u8>, ApiError> {
        let _encoder_permit = match timeout(
            Duration::from_millis(TILE_ENCODER_WAIT_TIMEOUT_MS),
            TILE_ENCODER_GUARD.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => {
                return Err(ApiError::service_unavailable("Tile encoder unavailable"));
            }
            Err(_) => {
                return Err(ApiError::service_unavailable(
                    "Tile renderer is busy, please retry",
                ));
            }
        };

        tokio::task::spawn_blocking(move || {
            let mut tile = Tile::new(TILE_EXTENT);
            let mut layer = tile.create_layer("sightings");
            let mut point_count = 0usize;

            for row in rows {
                let latlng = LatLng {
                    lat: row.latitude,
                    lng: row.longitude,
                };
                let tile_coords = latlng_to_tile_coords(latlng, tile_pos);

                let encoder = GeomEncoder::new(GeomType::Point);
                let geom_data = match encoder
                    .point(tile_coords.tile_x, tile_coords.tile_y)
                    .and_then(mvt::GeomEncoder::encode)
                {
                    Ok(data) => data,
                    Err(e) => {
                        error!("Failed to encode geometry: {}", e);
                        continue;
                    }
                };

                let mut feature = layer.into_feature(geom_data);
                feature.set_id(u64::try_from(row.id).unwrap_or(0));
                feature.add_tag_string("name", &row.common_name);
                feature.add_tag_uint("count", u64::try_from(row.count.max(0)).unwrap_or(0));
                if let Some(scientific_name) = row.scientific_name {
                    feature.add_tag_string("scientific_name", &scientific_name);
                }
                feature.add_tag_string("observed_at", &row.observed_at);
                feature.add_tag_uint("lifer", u64::try_from(row.lifer.max(0)).unwrap_or(0));
                feature.add_tag_uint(
                    "year_tick",
                    u64::try_from(row.year_tick.max(0)).unwrap_or(0),
                );
                feature.add_tag_uint(
                    "country_tick",
                    u64::try_from(row.country_tick.max(0)).unwrap_or(0),
                );

                layer = feature.into_layer();
                point_count += 1;
            }

            if let Err(e) = tile.add_layer(layer) {
                error!("Failed to add layer to tile: {}", e);
                return Err(ApiError::internal("Tile encoding error"));
            }

            match tile.to_bytes() {
                Ok(bytes) => {
                    debug!("Generated tile with {} points", point_count);
                    Ok(bytes)
                }
                Err(e) => {
                    error!("Failed to encode tile: {}", e);
                    Err(ApiError::internal("Tile encoding error"))
                }
            }
        })
        .await
        .map_err(|_| ApiError::internal("Tile encoding task failed"))?
    }
}

fn zoom_threshold(z: u32) -> (i32, bool) {
    let threshold = match z {
        0..=2 => 100,
        3..=4 => 1000,
        5..=7 => 5000,
        _ => MAX_VIS_RANK,
    };
    (threshold, threshold >= MAX_VIS_RANK)
}

fn max_points_for_zoom(z: u32) -> i64 {
    match z {
        0..=2 => 5000,
        3..=4 => 10000,
        5..=7 => 25000,
        _ => 100000,
    }
}

pub async fn invalidate_upload_cache(upload_id: &str) {
    let prefix = format!("{}:", upload_id);
    match TILE_CACHE.invalidate_entries_if(move |k, _v| k.starts_with(&prefix)) {
        Ok(count) => debug!(
            "Invalidated {} cache entries for upload: {}",
            count, upload_id
        ),
        Err(e) => error!("Failed to invalidate cache for upload {}: {}", upload_id, e),
    }
}

pub async fn get_tile(
    State(pools): State<DbPools>,
    Path(path): Path<TilePath>,
    Query(query): Query<TileQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let request = TileRequest::build(&pools, path, query).await?;
    let tile_pos = request.tile_pos();
    let bbox = request.bbox();

    debug!(
        "Tile request: z={} x={} y={} bbox=[{},{},{},{}]",
        tile_pos.z, tile_pos.x, tile_pos.y, bbox.lon_min, bbox.lat_min, bbox.lon_max, bbox.lat_max
    );

    if let Some(cached_data) = TILE_CACHE.get(request.cache_key()).await {
        debug!("Tile cache hit: {}", request.cache_key());
        let response = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/x-protobuf")
            .header(header::CACHE_CONTROL, "public, max-age=3600")
            .header("x-upload-version", request.data_version().to_string())
            .body(axum::body::Body::from(cached_data))
            .map_err(|err| {
                error!("Failed to build cached tile response: {}", err);
                ApiError::internal("Failed to build response")
            })?;
        return Ok(response);
    }

    let fetcher = TileDataFetcher::new(&pools);
    let rows = fetcher.fetch_rows(&request).await?;
    let data = TileEncoder::encode(request.tile_pos(), rows).await?;

    TILE_CACHE
        .insert(request.cache_key().to_string(), data.clone())
        .await;
    debug!("Tile cached: {}", request.cache_key());

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-protobuf")
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .header("x-upload-version", request.data_version().to_string())
        .body(axum::body::Body::from(data))
        .map_err(|err| {
            error!("Failed to build tile response: {}", err);
            ApiError::internal("Failed to build response")
        })?;

    Ok(response)
}
