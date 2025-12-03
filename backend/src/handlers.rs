use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Serialize;
use sqlx::SqlitePool;
use ts_rs::TS;
use uuid::Uuid;

use crate::bind_filter_params;
use crate::db;
use crate::error::ApiError;
use crate::filter::{
    build_filter_clause, get_distinct_values, get_field_metadata, CountQuery, FieldMetadata,
    FieldValues,
};

#[derive(Serialize, TS)]
#[ts(export)]
pub struct UploadMetadata {
    pub upload_id: String,
    pub filename: String,
    pub row_count: i64,
}

pub async fn get_upload(
    State(pool): State<SqlitePool>,
    Path(upload_id): Path<String>,
) -> Result<Json<UploadMetadata>, ApiError> {
    let upload_uuid = Uuid::parse_str(&upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
    let row = db::query_with_timeout(
        sqlx::query_as::<_, (Vec<u8>, String, i64)>(
            "SELECT id, filename, row_count FROM uploads WHERE id = ?",
        )
        .bind(&upload_uuid.as_bytes()[..])
        .fetch_optional(&pool),
    )
    .await
    .map_err(|e| e.into_api_error("loading upload metadata", "Database error"))?
    .ok_or_else(|| ApiError::not_found("Upload not found"))?;

    // Convert BLOB UUID back to string
    let id_uuid = Uuid::from_slice(&row.0)
        .map_err(|_| ApiError::internal("Invalid UUID format in database"))?;

    Ok(Json(UploadMetadata {
        upload_id: id_uuid.to_string(),
        filename: row.1,
        row_count: row.2,
    }))
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct CountResponse {
    pub count: i64,
}

pub async fn get_filtered_count(
    State(pool): State<SqlitePool>,
    Path(upload_id): Path<String>,
    Query(query): Query<CountQuery>,
) -> Result<Json<CountResponse>, ApiError> {
    let upload_uuid = Uuid::parse_str(&upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
    let (filter_clause, filter_params) = build_filter_clause(
        query.filter.as_ref(),
        query.lifers_only,
        query.year_tick_year,
        query.country_tick_country.as_ref(),
        None,
    )?;

    let sql = format!(
        "SELECT COUNT(*) as cnt FROM sightings WHERE upload_id = ?{}",
        filter_clause
    );

    let db_query = bind_filter_params!(
        sqlx::query_scalar::<_, i64>(&sql),
        &upload_uuid.as_bytes()[..],
        &filter_params
    );

    let count = db::query_with_timeout(db_query.fetch_one(&pool))
        .await
        .map_err(|e| e.into_api_error("counting sightings", "Database error"))?;

    Ok(Json(CountResponse { count }))
}

pub async fn fields_metadata() -> Json<Vec<FieldMetadata>> {
    Json(get_field_metadata())
}

pub async fn field_values(
    State(pool): State<SqlitePool>,
    Path((upload_id, field)): Path<(String, String)>,
) -> Result<Json<FieldValues>, ApiError> {
    let upload_uuid = Uuid::parse_str(&upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
    let values = get_distinct_values(&pool, &upload_uuid.as_bytes()[..], &field)
        .await
        .map_err(|e| e.into_api_error("loading field values", "Database error"))?;

    Ok(Json(FieldValues { field, values }))
}
