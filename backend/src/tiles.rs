use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use mvt::{GeomEncoder, GeomType, Tile};
use serde::Deserialize;
use sqlx::{Row, SqlitePool};
use tracing::{debug, error};

use crate::db;
use crate::error::ApiError;
use crate::filter::{FilterGroup, TickFilters};

const TILE_EXTENT: u32 = 4096;
// Maximum vis_rank value (0-10000). When threshold equals this, all points are included.
const MAX_VIS_RANK: i32 = 10000;

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
    country_tick_country: Option<String>,
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

    debug!(
        "Tile request: z={} x={} y={} bbox=[{},{},{},{}]",
        z, x, y, lon_min, lat_min, lon_max, lat_max
    );

    let mut filter_params: Vec<String> = Vec::new();

    let mut filter_clause = if let Some(filter_json) = &query.filter {
        let filter: FilterGroup = filter_json.try_into()?;
        filter
            .to_sql(&mut filter_params)
            .map(|sql| format!(" AND {sql}"))
    } else {
        None
    };

    let mut tick_filters = TickFilters::new();
    if query.lifers_only == Some(true) {
        tick_filters.add_lifers_only(Some("s"));
    }
    if let Some(year) = query.year_tick_year {
        tick_filters.add_year_tick(year, Some("s"));
    }
    if let Some(country) = &query.country_tick_country {
        tick_filters.add_country_tick(country, Some("s"));
    }
    let (clauses, tick_params) = tick_filters.into_parts();
    filter_params.extend(tick_params);
    if !clauses.is_empty() {
        let clause_str = format!(" {}", clauses.join(" "));
        filter_clause = Some(match filter_clause {
            Some(existing) => format!("{existing}{clause_str}"),
            None => clause_str.trim_start_matches(" ").to_string(),
        });
    }

    // Use vis_rank-based sampling for efficient tile generation.
    // vis_rank is assigned at ingest time (0-MAX_VIS_RANK, where 0 = highest priority for lifers/year_ticks).
    // This turns O(NlogN) sorting operations into O(K) B-Tree range scans.
    //
    // Zoom-based thresholds:
    // - Very low zoom (z0-z2): vis_rank < 100 (~1% of points, ensures lifers/year_ticks visible)
    // - Low zoom (z3-z4): vis_rank < 1000 (~10% of points)
    // - Mid zoom (z5-z7): vis_rank < 5000 (~50% of points)
    // - High zoom (z8+): MAX_VIS_RANK (all points, filter skipped for performance)
    let vis_rank_threshold = match z {
        0..=2 => 100,      // Very low zoom: ~1% of points
        3..=4 => 1000,     // Low zoom: ~10% of points
        5..=7 => 5000,     // Mid zoom: ~50% of points
        _ => MAX_VIS_RANK, // High zoom: all points
    };

    // Safety cap on rendered points.
    let max_points = match z {
        0..=2 => 5000,
        3..=4 => 10000,
        5..=7 => 25000,
        _ => 100000,
    };

    // Filter by upload_id + vis_rank before the rtree join; skip the vis_rank predicate
    // entirely when the threshold would include everyone.
    let include_all_points = vis_rank_threshold >= MAX_VIS_RANK;
    let vis_rank_clause = if include_all_points {
        String::new()
    } else {
        " AND s.vis_rank < ?".to_string()
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
            s.year_tick,
            s.country_tick
        FROM sightings AS s
        JOIN sightings_geo AS sg ON sg.id = s.id
        WHERE s.upload_id = ?{}
          AND sg.max_lat >= ? AND sg.min_lat <= ?
          AND sg.max_lon >= ? AND sg.min_lon <= ?
        {}
        LIMIT ?
        ",
        vis_rank_clause,
        filter_clause.unwrap_or_default()
    );

    let mut db_query = sqlx::query(&sql).bind(&upload_id);
    if !include_all_points {
        db_query = db_query.bind(vis_rank_threshold);
    }
    db_query = db_query
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
        let country_tick: i32 = row.get("country_tick");

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
        feature.add_tag_uint(
            "country_tick",
            u64::try_from(country_tick.max(0)).unwrap_or(0),
        );

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
