pub mod api_constants;
pub mod db;
pub mod error;
pub mod filter;
pub mod pipeline;
pub mod sightings;
pub mod tiles;
pub mod upload;

use axum::extract::State;
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use sqlx::SqlitePool;

/// Create a minimal test router for benchmarks without production middleware
pub async fn create_test_router(pool: SqlitePool) -> Router {
    use crate::api_constants;
    use crate::error::ApiError;
    use crate::filter::{
        build_filter_clause, get_distinct_values, get_field_metadata, CountQuery, FieldMetadata,
        FieldValues,
    };
    use crate::sightings::get_sightings;
    use crate::tiles::get_tile;
    use crate::upload::{delete_upload, update_csv, upload_csv};

    #[derive(serde::Serialize)]
    struct UploadMetadata {
        upload_id: String,
        filename: String,
        row_count: i64,
    }

    async fn get_upload(
        State(pool): State<SqlitePool>,
        axum::extract::Path(upload_id): axum::extract::Path<String>,
    ) -> Result<Json<UploadMetadata>, ApiError> {
        let row = crate::db::query_with_timeout(
            sqlx::query_as::<_, (String, String, i64)>(
                "SELECT id, filename, row_count FROM uploads WHERE id = ?",
            )
            .bind(&upload_id)
            .fetch_optional(&pool),
        )
        .await
        .map_err(|e| e.into_api_error("loading upload metadata", "Database error"))?
        .ok_or_else(|| ApiError::not_found("Upload not found"))?;

        Ok(Json(UploadMetadata {
            upload_id: row.0,
            filename: row.1,
            row_count: row.2,
        }))
    }

    #[derive(serde::Serialize)]
    struct CountResponse {
        count: i64,
    }

    async fn get_filtered_count(
        State(pool): State<SqlitePool>,
        axum::extract::Path(upload_id): axum::extract::Path<String>,
        axum::extract::Query(query): axum::extract::Query<CountQuery>,
    ) -> Result<Json<CountResponse>, ApiError> {
        let (filter_clause, params) = build_filter_clause(
            query.filter.as_ref(),
            query.lifers_only,
            query.year_tick_year,
            query.country_tick_country.as_ref(),
            None,
        )?;

        let mut all_params = vec![upload_id];
        all_params.extend(params);

        let sql = format!(
            "SELECT COUNT(*) as cnt FROM sightings WHERE upload_id = ?{}",
            filter_clause
        );

        let mut db_query = sqlx::query_scalar::<_, i64>(&sql);
        for param in &all_params {
            db_query = db_query.bind(param);
        }

        let count = crate::db::query_with_timeout(db_query.fetch_one(&pool))
            .await
            .map_err(|e| e.into_api_error("counting sightings", "Database error"))?;

        Ok(Json(CountResponse { count }))
    }

    async fn fields_metadata() -> Json<Vec<FieldMetadata>> {
        Json(get_field_metadata())
    }

    async fn field_values(
        State(pool): State<SqlitePool>,
        axum::extract::Path((upload_id, field)): axum::extract::Path<(String, String)>,
    ) -> Result<Json<FieldValues>, ApiError> {
        let values = get_distinct_values(&pool, &upload_id, &field)
            .await
            .map_err(|e| e.into_api_error("loading field values", "Database error"))?;
        Ok(Json(FieldValues {
            field: field.clone(),
            values,
        }))
    }

    Router::new()
        .route(api_constants::UPLOAD_ROUTE, post(upload_csv))
        .route(
            api_constants::UPLOAD_DETAILS_ROUTE,
            get(get_upload).put(update_csv).delete(delete_upload),
        )
        .route(api_constants::UPLOAD_COUNT_ROUTE, get(get_filtered_count))
        .route(api_constants::UPLOAD_SIGHTINGS_ROUTE, get(get_sightings))
        .route(api_constants::TILE_ROUTE, get(get_tile))
        .route(api_constants::FIELDS_ROUTE, get(fields_metadata))
        .route(api_constants::FIELD_VALUES_ROUTE, get(field_values))
        .with_state(pool)
}
