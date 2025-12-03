pub mod api_constants;
pub mod config;
pub mod db;
pub mod error;
pub mod filter;
pub mod handlers;
pub mod pipeline;
pub mod sightings;
pub mod tiles;
pub mod upload;

#[macro_use]
mod macros {
    #[macro_export]
    macro_rules! bind_filter_params {
        ($query:expr, $upload_id:expr, $filter_params:expr) => {{
            let mut q = $query;
            q = q.bind($upload_id);
            for param in $filter_params {
                q = q.bind(param);
            }
            q
        }};
    }
}

use axum::routing::{get, post};
use axum::Router;
use sqlx::SqlitePool;

/// Create a minimal test router for benchmarks without production middleware
pub async fn create_test_router(pool: SqlitePool) -> Router {
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
        .with_state(pool)
}
