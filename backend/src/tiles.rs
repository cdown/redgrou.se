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
use tracing::{debug, error};

use crate::db;
use crate::error::ApiError;
use crate::filter::build_filter_clause;

const TILE_EXTENT: u32 = 4096;
// Maximum vis_rank value (0-10000). When threshold equals this, all points are included.
const MAX_VIS_RANK: i32 = 10000;
// Tile cache size limit: ~50MB (assuming average tile size of ~10KB, cache ~5000 tiles)
const TILE_CACHE_SIZE: u64 = 50 * 1024 * 1024;
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
    lifers_only: Option<bool>,
    year_tick_year: Option<i32>,
    country_tick_country: Option<String>,
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
    lifers_only: Option<bool>,
    year_tick_year: Option<i32>,
    country_tick_country: Option<&String>,
) -> String {
    let mut hasher = Sha256::new();
    if let Some(f) = filter {
        hasher.update(f.as_bytes());
    }
    if let Some(lo) = lifers_only {
        hasher.update([if lo { 1 } else { 0 }]);
    }
    if let Some(yt) = year_tick_year {
        hasher.update(yt.to_le_bytes());
    }
    if let Some(ct) = country_tick_country {
        hasher.update(ct.as_bytes());
    }
    hex::encode(hasher.finalize())
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
    let upload_uuid = uuid::Uuid::parse_str(&path.upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
    let y: u32 = match path.y.trim_end_matches(".pbf").parse() {
        Ok(v) => v,
        Err(_) => {
            return Err(ApiError::bad_request("Invalid y coordinate"));
        }
    };

    let tile_pos = TileCoordinates {
        z: path.z,
        x: path.x,
        y,
    };
    let bbox = tile_to_bbox(tile_pos);

    debug!(
        "Tile request: z={} x={} y={} bbox=[{},{},{},{}]",
        path.z, path.x, y, bbox.lon_min, bbox.lat_min, bbox.lon_max, bbox.lat_max
    );

    let filter_hash = compute_filter_hash(
        query.filter.as_ref(),
        query.lifers_only,
        query.year_tick_year,
        query.country_tick_country.as_ref(),
    );
    let cache_key = format!(
        "{}:{}:{}:{}:{}",
        path.upload_id, path.z, path.x, y, filter_hash
    );

    if let Some(cached_data) = TILE_CACHE.get(&cache_key).await {
        debug!("Tile cache hit: {}", cache_key);
        let response = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/x-protobuf")
            .header(header::CACHE_CONTROL, "public, max-age=3600")
            .body(axum::body::Body::from(cached_data))
            .map_err(|err| {
                error!("Failed to build cached tile response: {}", err);
                ApiError::internal("Failed to build response")
            })?;
        return Ok(response);
    }

    let filter_result = build_filter_clause(
        pools.read(),
        &upload_uuid.as_bytes()[..],
        query.filter.as_ref(),
        query.lifers_only,
        query.year_tick_year,
        query.country_tick_country.as_ref(),
        Some("s"),
    )
    .await?;

    // Use vis_rank-based sampling for efficient tile generation.
    // vis_rank is assigned at ingest time (0-MAX_VIS_RANK, where 0 = highest priority for lifers/year_ticks).
    // This turns O(NlogN) sorting operations into O(K) B-Tree range scans.
    //
    // Zoom-based thresholds:
    // - Very low zoom (z0-z2): vis_rank < 100 (~1% of points, ensures lifers/year_ticks visible)
    // - Low zoom (z3-z4): vis_rank < 1000 (~10% of points)
    // - Mid zoom (z5-z7): vis_rank < 5000 (~50% of points)
    // - High zoom (z8+): MAX_VIS_RANK (all points, filter skipped for performance)
    let vis_rank_threshold = match path.z {
        0..=2 => 100,      // Very low zoom: ~1% of points
        3..=4 => 1000,     // Low zoom: ~10% of points
        5..=7 => 5000,     // Mid zoom: ~50% of points
        _ => MAX_VIS_RANK, // High zoom: all points
    };

    // Safety cap on rendered points.
    let max_points = match path.z {
        0..=2 => 5000,
        3..=4 => 10000,
        5..=7 => 25000,
        _ => 100000,
    };

    // Filter by upload_id + vis_rank before the rtree join; skip the vis_rank predicate
    // entirely when the threshold would include everyone.
    let include_all_points = vis_rank_threshold >= MAX_VIS_RANK;
    let rows = if include_all_points {
        let candidate_limit = (i64::from(max_points)
            .saturating_mul(BBOX_CANDIDATE_LIMIT_MULTIPLIER))
        .max(i64::from(max_points))
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
            filter_result.filter_clause
        );

        let mut db_query = sqlx::query(&sql)
            .bind(bbox.lat_min)
            .bind(bbox.lat_max)
            .bind(bbox.lon_min)
            .bind(bbox.lon_max)
            .bind(candidate_limit)
            .bind(&upload_uuid.as_bytes()[..]);

        for param in &filter_result.params {
            db_query = db_query.bind(param);
        }
        db_query = db_query.bind(i64::from(max_points));

        db::query_with_timeout(db_query.fetch_all(pools.read()))
            .await
            .map_err(|e| e.into_api_error("loading tile sightings", "Database error"))?
    } else {
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
            filter_result.filter_clause
        );

        let mut db_query = sqlx::query(&sql)
            .bind(&upload_uuid.as_bytes()[..])
            .bind(vis_rank_threshold)
            .bind(bbox.lat_min)
            .bind(bbox.lat_max)
            .bind(bbox.lon_min)
            .bind(bbox.lon_max);

        for param in &filter_result.params {
            db_query = db_query.bind(param);
        }
        db_query = db_query.bind(i64::from(max_points));

        db::query_with_timeout(db_query.fetch_all(pools.read()))
            .await
            .map_err(|e| e.into_api_error("loading tile sightings", "Database error"))?
    };

    // Collect row data into a Vec to move into spawn_blocking
    // This avoids holding async types across the blocking boundary
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

    let mut row_data = Vec::new();
    for row in rows {
        row_data.push(RowData {
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
        });
    }

    let tile_pos = TileCoordinates {
        z: path.z,
        x: path.x,
        y,
    };

    // Offload CPU-bound MVT encoding to a blocking thread pool
    // This prevents geometry encoding from blocking the async executor
    let data = tokio::task::spawn_blocking(move || {
        let mut tile = Tile::new(TILE_EXTENT);
        let mut layer = tile.create_layer("sightings");
        let mut point_count = 0usize;

        for row in row_data {
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
    .map_err(|_| ApiError::internal("Tile encoding task failed"))??;

    let cached_data = data.clone();
    TILE_CACHE.insert(cache_key.clone(), cached_data).await;
    debug!("Tile cached: {}", cache_key);

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-protobuf")
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .body(axum::body::Body::from(data))
        .map_err(|err| {
            error!("Failed to build tile response: {}", err);
            ApiError::internal("Failed to build response")
        })?;

    Ok(response)
}
