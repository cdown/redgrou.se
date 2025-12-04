use axum::extract::{Path, Query, State};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::bind_filter_params;
use crate::db;
use crate::error::ApiError;
use crate::filter::{build_filter_clause, get_distinct_values, get_field_metadata, CountQuery};
use crate::proto::{pb, Proto};

#[derive(FromRow)]
struct UploadRow {
    id: Vec<u8>,
    filename: String,
    row_count: i64,
}

#[derive(serde::Deserialize)]
pub struct FieldValuesPath {
    pub upload_id: String,
    pub field: String,
}

pub async fn get_upload(
    State(pool): State<SqlitePool>,
    Path(upload_id): Path<String>,
) -> Result<Proto<pb::UploadMetadata>, ApiError> {
    let upload_uuid = Uuid::parse_str(&upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
    let row = db::query_with_timeout(
        sqlx::query_as::<_, UploadRow>("SELECT id, filename, row_count FROM uploads WHERE id = ?")
            .bind(&upload_uuid.as_bytes()[..])
            .fetch_optional(&pool),
    )
    .await
    .map_err(|e| e.into_api_error("loading upload metadata", "Database error"))?
    .ok_or_else(|| ApiError::not_found("Upload not found"))?;

    // Convert BLOB UUID back to string
    let id_uuid = Uuid::from_slice(&row.id)
        .map_err(|_| ApiError::internal("Invalid UUID format in database"))?;

    Ok(Proto::new(pb::UploadMetadata {
        upload_id: id_uuid.to_string(),
        filename: row.filename,
        row_count: row.row_count,
    }))
}

pub async fn get_filtered_count(
    State(pool): State<SqlitePool>,
    Path(upload_id): Path<String>,
    Query(query): Query<CountQuery>,
) -> Result<Proto<pb::CountResponse>, ApiError> {
    let upload_uuid = Uuid::parse_str(&upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
    let filter_result = build_filter_clause(
        query.filter.as_ref(),
        query.lifers_only,
        query.year_tick_year,
        query.country_tick_country.as_ref(),
        None,
    )?;

    let sql = format!(
        "SELECT COUNT(*) as cnt FROM sightings WHERE upload_id = ?{}",
        filter_result.filter_clause
    );

    let db_query = bind_filter_params!(
        sqlx::query_scalar::<_, i64>(&sql),
        &upload_uuid.as_bytes()[..],
        &filter_result.params
    );

    let count = db::query_with_timeout(db_query.fetch_one(&pool))
        .await
        .map_err(|e| e.into_api_error("counting sightings", "Database error"))?;

    Ok(Proto::new(pb::CountResponse { count }))
}

pub async fn fields_metadata() -> Proto<pb::FieldMetadataList> {
    let fields = get_field_metadata()
        .into_iter()
        .map(|field| pb::FieldMetadata {
            name: field.name,
            label: field.label,
            field_type: field.field_type,
        })
        .collect();
    Proto::new(pb::FieldMetadataList { fields })
}

pub async fn field_values(
    State(pool): State<SqlitePool>,
    Path(path): Path<FieldValuesPath>,
) -> Result<Proto<pb::FieldValues>, ApiError> {
    let upload_uuid = Uuid::parse_str(&path.upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
    let values = get_distinct_values(&pool, &upload_uuid.as_bytes()[..], &path.field)
        .await
        .map_err(|e| e.into_api_error("loading field values", "Database error"))?;

    tracing::debug!(
        "Field values for {}: returning {} values",
        path.field,
        values.len()
    );

    Ok(Proto::new(pb::FieldValues {
        field: path.field,
        values,
    }))
}
