pub mod api_constants;
pub mod bitmaps;
pub mod config;
pub mod db;
pub mod error;
pub mod filter;
pub mod handlers;
pub mod limits;
pub mod pipeline;
pub mod proto;
pub mod sightings;
pub mod tiles;
pub mod upload;
pub mod zip_extract;

use crate::db::DbPools;
use crate::limits::UploadUsageTracker;
use axum::routing::{get, post};
use axum::{Extension, Router};

/// Create a minimal test router for benchmarks without production middleware
pub async fn create_test_router(pools: DbPools) -> Router {
    use crate::api_constants;
    use crate::handlers;
    use crate::sightings::get_sightings;
    use crate::tiles::get_tile;
    use crate::upload::{delete_upload, update_csv, upload_csv};

    Router::new()
        .route(api_constants::UPLOAD_ROUTE, post(upload_csv))
        .route(
            api_constants::UPLOAD_DETAILS_ROUTE,
            get(handlers::get_upload)
                .put(update_csv)
                .delete(delete_upload),
        )
        .route(
            api_constants::UPLOAD_COUNT_ROUTE,
            get(handlers::get_filtered_count),
        )
        .route(api_constants::UPLOAD_SIGHTINGS_ROUTE, get(get_sightings))
        .route(api_constants::TILE_ROUTE, get(get_tile))
        .route(api_constants::FIELDS_ROUTE, get(handlers::fields_metadata))
        .route(
            api_constants::FIELD_VALUES_ROUTE,
            get(handlers::field_values),
        )
        .layer(Extension(UploadUsageTracker::disabled()))
        .with_state(pools)
}
