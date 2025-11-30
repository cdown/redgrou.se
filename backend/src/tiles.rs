use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use mvt::{GeomEncoder, GeomType, Tile};
use serde::Deserialize;
use sqlx::{Row, SqlitePool};
use tracing::{debug, error};

use crate::filter::FilterGroup;

const TILE_EXTENT: u32 = 4096;

fn tile_to_bbox(z: u32, x: u32, y: u32) -> (f64, f64, f64, f64) {
    let n = 2_f64.powi(z as i32);

    let lon_min = (x as f64 / n) * 360.0 - 180.0;
    let lon_max = ((x + 1) as f64 / n) * 360.0 - 180.0;

    let lat_max = (std::f64::consts::PI * (1.0 - 2.0 * y as f64 / n))
        .sinh()
        .atan()
        .to_degrees();
    let lat_min = (std::f64::consts::PI * (1.0 - 2.0 * (y + 1) as f64 / n))
        .sinh()
        .atan()
        .to_degrees();

    (lon_min, lat_min, lon_max, lat_max)
}

fn latlng_to_tile_coords(lat: f64, lng: f64, z: u32, x: u32, y: u32) -> (f64, f64) {
    let n = 2_f64.powi(z as i32);

    let world_x = (lng + 180.0) / 360.0 * n;
    let lat_rad = lat.to_radians();
    let world_y =
        (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / std::f64::consts::PI) / 2.0 * n;

    let tile_x = (world_x - x as f64) * TILE_EXTENT as f64;
    let tile_y = (world_y - y as f64) * TILE_EXTENT as f64;

    (tile_x, tile_y)
}

struct SightingPoint {
    id: i64,
    latitude: f64,
    longitude: f64,
    common_name: String,
    scientific_name: Option<String>,
    count: i32,
    observed_at: String,
    lifer: i32,
    year_tick: i32,
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
) -> impl IntoResponse {
    let y: u32 = match y_str.trim_end_matches(".pbf").parse() {
        Ok(v) => v,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, "Invalid y coordinate").into_response();
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

    let mut params: Vec<String> = vec![
        upload_id.clone(),
        lat_min.to_string(),
        lat_max.to_string(),
        lon_min.to_string(),
        lon_max.to_string(),
    ];

    let mut filter_clause = if let Some(filter_json) = &query.filter {
        match serde_json::from_str::<FilterGroup>(filter_json) {
            Ok(filter) => filter
                .to_sql(&mut params)
                .map(|sql| format!(" AND {}", sql)),
            Err(e) => {
                error!("Invalid filter JSON: {}", e);
                None
            }
        }
    } else {
        None
    };

    // Add lifers_only filter if requested
    if query.lifers_only == Some(true) {
        let lifer_clause = " AND lifer = 1".to_string();
        filter_clause = Some(match filter_clause {
            Some(existing) => format!("{}{}", existing, lifer_clause),
            None => lifer_clause,
        });
    }

    // Add year_tick filter if requested
    if let Some(year) = query.year_tick_year {
        params.push(year.to_string());
        let year_tick_clause = " AND year_tick = 1 AND year = ?".to_string();
        filter_clause = Some(match filter_clause {
            Some(existing) => format!("{}{}", existing, year_tick_clause),
            None => year_tick_clause,
        });
    }

    let sql = format!(
        r#"
        SELECT id, latitude, longitude, common_name, scientific_name, count, observed_at, lifer, year_tick
        FROM sightings
        WHERE upload_id = ?
          AND latitude >= ? AND latitude <= ?
          AND longitude >= ? AND longitude <= ?
        {}
        "#,
        filter_clause.unwrap_or_default()
    );

    let mut db_query = sqlx::query(&sql);
    for param in &params {
        db_query = db_query.bind(param);
    }

    let rows = match db_query.fetch_all(&pool).await {
        Ok(r) => r,
        Err(e) => {
            error!("Failed to query sightings: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response();
        }
    };

    let points: Vec<SightingPoint> = rows
        .iter()
        .map(|row| SightingPoint {
            id: row.get("id"),
            latitude: row.get("latitude"),
            longitude: row.get("longitude"),
            common_name: row.get("common_name"),
            scientific_name: row.get("scientific_name"),
            count: row.get("count"),
            observed_at: row.get("observed_at"),
            lifer: row.get("lifer"),
            year_tick: row.get("year_tick"),
        })
        .collect();

    let mut tile = Tile::new(TILE_EXTENT);
    let mut layer = tile.create_layer("sightings");

    for point in &points {
        let (tile_x, tile_y) = latlng_to_tile_coords(point.latitude, point.longitude, z, x, y);

        let encoder = GeomEncoder::new(GeomType::Point);
        let geom_data = match encoder.point(tile_x, tile_y).and_then(|e| e.encode()) {
            Ok(data) => data,
            Err(e) => {
                error!("Failed to encode geometry: {}", e);
                continue;
            }
        };

        let mut feature = layer.into_feature(geom_data);
        feature.set_id(point.id as u64);
        feature.add_tag_string("name", &point.common_name);
        feature.add_tag_uint("count", point.count as u64);
        if let Some(ref scientific_name) = point.scientific_name {
            feature.add_tag_string("scientific_name", scientific_name);
        }
        feature.add_tag_string("observed_at", &point.observed_at);
        feature.add_tag_uint("lifer", point.lifer as u64);
        feature.add_tag_uint("year_tick", point.year_tick as u64);

        layer = feature.into_layer();
    }

    if let Err(e) = tile.add_layer(layer) {
        error!("Failed to add layer to tile: {}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Tile encoding error").into_response();
    }

    let data = match tile.to_bytes() {
        Ok(bytes) => bytes,
        Err(e) => {
            error!("Failed to encode tile: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Tile encoding error").into_response();
        }
    };

    debug!("Generated tile with {} points", points.len());

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-protobuf")
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .body(axum::body::Body::from(data))
        .unwrap()
}
