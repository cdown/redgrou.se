use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use mvt::{GeomEncoder, GeomType, Tile};
use sqlx::SqlitePool;
use tracing::{debug, error};

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

#[derive(sqlx::FromRow)]
struct SightingPoint {
    id: i64,
    latitude: f64,
    longitude: f64,
    common_name: String,
    count: i32,
}

pub async fn get_tile(
    State(pool): State<SqlitePool>,
    Path((upload_id, z, x, y_str)): Path<(String, u32, u32, String)>,
) -> impl IntoResponse {
    let y: u32 = match y_str.trim_end_matches(".pbf").parse() {
        Ok(v) => v,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, "Invalid y coordinate").into_response();
        }
    };

    let (lon_min, lat_min, lon_max, lat_max) = tile_to_bbox(z, x, y);

    debug!(
        "Tile request: z={} x={} y={} bbox=[{},{},{},{}]",
        z, x, y, lon_min, lat_min, lon_max, lat_max
    );

    let points: Vec<SightingPoint> = match sqlx::query_as(
        r#"
        SELECT id, latitude, longitude, common_name, count
        FROM sightings
        WHERE upload_id = ?
          AND latitude >= ? AND latitude <= ?
          AND longitude >= ? AND longitude <= ?
        "#,
    )
    .bind(&upload_id)
    .bind(lat_min)
    .bind(lat_max)
    .bind(lon_min)
    .bind(lon_max)
    .fetch_all(&pool)
    .await
    {
        Ok(p) => p,
        Err(e) => {
            error!("Failed to query sightings: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response();
        }
    };

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
