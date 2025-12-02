use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use mvt::{GeomEncoder, GeomType, Tile};
use serde::Deserialize;
use sqlx::{Row, SqlitePool};
use tracing::{debug, error};

use crate::db;
use crate::error::ApiError;
use crate::filter::FilterGroup;

const TILE_EXTENT: u32 = 4096;

fn tile_to_bbox(z: u32, x: u32, y: u32) -> (f64, f64, f64, f64) {
    let n = 2_f64.powi(i32::try_from(z).unwrap_or(i32::MAX));

    let lon_min = (f64::from(x) / n) * 360.0 - 180.0;
    let lon_max = (f64::from(x + 1) / n) * 360.0 - 180.0;

    let lat_max = (std::f64::consts::PI * (1.0 - 2.0 * f64::from(y) / n))
        .sinh()
        .atan()
        .to_degrees();
    let lat_min = (std::f64::consts::PI * (1.0 - 2.0 * f64::from(y + 1) / n))
        .sinh()
        .atan()
        .to_degrees();

    (lon_min, lat_min, lon_max, lat_max)
}

fn latlng_to_tile_coords(lat: f64, lng: f64, z: u32, x: u32, y: u32) -> (f64, f64) {
    let n = 2_f64.powi(i32::try_from(z).unwrap_or(i32::MAX));

    let world_x = (lng + 180.0) / 360.0 * n;
    let lat_rad = lat.to_radians();
    let world_y =
        (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / std::f64::consts::PI) / 2.0 * n;

    let tile_x = (world_x - f64::from(x)) * f64::from(TILE_EXTENT);
    let tile_y = (world_y - f64::from(y)) * f64::from(TILE_EXTENT);

    (tile_x, tile_y)
}

#[derive(Debug, Deserialize)]
pub struct TileQuery {
    filter: Option<String>,
    lifers_only: Option<bool>,
    year_tick_year: Option<i32>,
}

pub async fn get_tile(
    State(pool): State<SqlitePool>,
    Path((upload_id, z, x, y_str)): Path<(String, u32, u32, String)>,
    Query(query): Query<TileQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let y: u32 = match y_str.trim_end_matches(".pbf").parse() {
        Ok(v) => v,
        Err(_) => {
            return Err(ApiError::bad_request("Invalid y coordinate"));
        }
    };

    let (lon_min, lat_min, lon_max, lat_max) = tile_to_bbox(z, x, y);

    // TODO: Currently we query every point for every tile request, regardless of zoom level.
    // For small datasets (~1.5k points), this means we re-send the same points as the user zooms in,
    // which is bandwidth-wasteful but functionally correct.
    //
    // In the future (Phase 4), we will implement clustering at low zoom levels (e.g. z < 10).
    // The client (MapLibre) correctly requests new tiles on zoom because it expects
    // the backend to provide different data (higher detail) at higher zoom levels.
    debug!(
        "Tile request: z={} x={} y={} bbox=[{},{},{},{}]",
        z, x, y, lon_min, lat_min, lon_max, lat_max
    );

    let mut filter_params: Vec<String> = Vec::new();

    let mut filter_clause = if let Some(filter_json) = &query.filter {
        let filter: FilterGroup = serde_json::from_str(filter_json).map_err(|e| {
            error!("Invalid filter JSON: {}", e);
            ApiError::bad_request("Invalid filter JSON")
        })?;
        filter
            .validate()
            .map_err(|e| ApiError::bad_request(e.message()))?;
        filter
            .to_sql(&mut filter_params)
            .map(|sql| format!(" AND {sql}"))
    } else {
        None
    };

    // Add lifers_only filter if requested
    if query.lifers_only == Some(true) {
        let lifer_clause = " AND s.lifer = 1".to_string();
        filter_clause = Some(match filter_clause {
            Some(existing) => format!("{existing}{lifer_clause}"),
            None => lifer_clause,
        });
    }

    // Add year_tick filter if requested
    if let Some(year) = query.year_tick_year {
        filter_params.push(year.to_string());
        let year_tick_clause = " AND s.year_tick = 1 AND s.year = ?".to_string();
        filter_clause = Some(match filter_clause {
            Some(existing) => format!("{existing}{year_tick_clause}"),
            None => year_tick_clause,
        });
    }

    // Limit points returned at low zoom levels to prevent memory spikes.
    // At z=0-4, a single tile can contain 100k+ points. Limiting to 10k
    // prevents excessive memory usage and slow serialization.
    let max_points = match z {
        0..=2 => 5000,  // Very low zoom: 5k points max
        3..=4 => 10000, // Low zoom: 10k points max
        5..=7 => 25000, // Medium-low zoom: 25k points max
        _ => 100000,    // Higher zoom: 100k points max (effectively unlimited)
    };

    let sql = format!(
        r"
        SELECT
            s.id,
            s.latitude,
            s.longitude,
            s.common_name,
            s.scientific_name,
            s.count,
            s.observed_at,
            s.lifer,
            s.year_tick
        FROM sightings AS s
        JOIN sightings_geo AS sg ON sg.id = s.id
        WHERE s.upload_id = ?
          AND sg.max_lat >= ? AND sg.min_lat <= ?
          AND sg.max_lon >= ? AND sg.min_lon <= ?
        {}
        LIMIT ?
        ",
        filter_clause.unwrap_or_default()
    );

    let mut db_query = sqlx::query(&sql)
        .bind(&upload_id)
        .bind(lat_min)
        .bind(lat_max)
        .bind(lon_min)
        .bind(lon_max);
    for param in &filter_params {
        db_query = db_query.bind(param);
    }
    db_query = db_query.bind(i64::from(max_points));

    let rows = db::query_with_timeout(db_query.fetch_all(&pool))
        .await
        .map_err(|e| e.into_api_error("loading tile sightings", "Database error"))?;

    let mut tile = Tile::new(TILE_EXTENT);
    let mut layer = tile.create_layer("sightings");
    let mut point_count = 0usize;

    for row in rows {
        let id: i64 = row.get("id");
        let latitude: f64 = row.get("latitude");
        let longitude: f64 = row.get("longitude");
        let common_name: String = row.get("common_name");
        let scientific_name: Option<String> = row.get("scientific_name");
        let count: i32 = row.get("count");
        let observed_at: String = row.get("observed_at");
        let lifer: i32 = row.get("lifer");
        let year_tick: i32 = row.get("year_tick");

        let (tile_x, tile_y) = latlng_to_tile_coords(latitude, longitude, z, x, y);

        let encoder = GeomEncoder::new(GeomType::Point);
        let geom_data = match encoder
            .point(tile_x, tile_y)
            .and_then(mvt::GeomEncoder::encode)
        {
            Ok(data) => data,
            Err(e) => {
                error!("Failed to encode geometry: {}", e);
                continue;
            }
        };

        let mut feature = layer.into_feature(geom_data);
        feature.set_id(u64::try_from(id).unwrap_or(0));
        feature.add_tag_string("name", &common_name);
        feature.add_tag_uint("count", u64::try_from(count.max(0)).unwrap_or(0));
        if let Some(scientific_name) = scientific_name {
            feature.add_tag_string("scientific_name", &scientific_name);
        }
        feature.add_tag_string("observed_at", &observed_at);
        feature.add_tag_uint("lifer", u64::try_from(lifer.max(0)).unwrap_or(0));
        feature.add_tag_uint("year_tick", u64::try_from(year_tick.max(0)).unwrap_or(0));

        layer = feature.into_layer();
        point_count += 1;
    }

    if let Err(e) = tile.add_layer(layer) {
        error!("Failed to add layer to tile: {}", e);
        return Err(ApiError::internal("Tile encoding error"));
    }

    let data = match tile.to_bytes() {
        Ok(bytes) => bytes,
        Err(e) => {
            error!("Failed to encode tile: {}", e);
            return Err(ApiError::internal("Tile encoding error"));
        }
    };

    debug!("Generated tile with {} points", point_count);

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-protobuf")
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .body(axum::body::Body::from(data))
        .unwrap();

    Ok(response)
}
