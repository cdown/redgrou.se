use axum::extract::{Path, Query, State};
use sqlx::FromRow;
use uuid::Uuid;

use crate::db;
use crate::db::DbPools;
use crate::error::ApiError;
use crate::filter::{
    build_filter_clause, get_distinct_values, get_field_metadata, CountQuery, FilterRequest,
    TableAliases,
};
use crate::proto::{pb, Proto};
use crate::upload::{effective_display_name, get_upload_data_version};

#[derive(FromRow)]
struct UploadRow {
    id: Vec<u8>,
    filename: String,
    row_count: i64,
    display_name: Option<String>,
    data_version: i64,
}

#[derive(serde::Deserialize)]
pub struct FieldValuesPath {
    pub upload_id: String,
    pub field: String,
}

pub async fn get_upload(
    State(pools): State<DbPools>,
    Path(upload_id): Path<String>,
) -> Result<Proto<pb::UploadMetadata>, ApiError> {
    let upload_uuid = Uuid::parse_str(&upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
    let row = db::query_with_timeout(
        sqlx::query_as::<_, UploadRow>(
            "SELECT id, filename, row_count, display_name, data_version FROM uploads WHERE id = ?",
        )
        .bind(&upload_uuid.as_bytes()[..])
        .fetch_optional(pools.read()),
    )
    .await
    .map_err(|e| e.into_api_error("loading upload metadata", "Database error"))?
    .ok_or_else(|| ApiError::not_found("Upload not found"))?;

    // Convert BLOB UUID back to string
    let id_uuid = Uuid::from_slice(&row.id)
        .map_err(|_| ApiError::internal("Invalid UUID format in database"))?;

    let title = effective_display_name(row.display_name, &row.filename);

    let upload_id_blob = upload_uuid.as_bytes().to_vec();
    let write_pool = pools.write().clone();
    tokio::spawn(async move {
        if let Err(e) = db::query_with_timeout(
            sqlx::query("UPDATE uploads SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
                .bind(&upload_id_blob[..])
                .execute(&write_pool),
        )
        .await
        {
            tracing::warn!("Failed to update last_accessed_at: {:?}", e);
        }
    });

    Ok(Proto::new(pb::UploadMetadata {
        upload_id: id_uuid.to_string(),
        filename: row.filename,
        row_count: row.row_count,
        title,
        data_version: row.data_version,
    }))
}

pub async fn get_filtered_count(
    State(pools): State<DbPools>,
    Path(upload_id): Path<String>,
    Query(query): Query<CountQuery>,
) -> Result<Proto<pb::CountResponse>, ApiError> {
    let upload_uuid = Uuid::parse_str(&upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
    let data_version = get_upload_data_version(pools.read(), &upload_uuid).await?;

    let needs_join = if let Some(filter_json) = &query.filter {
        let filter: crate::filter::FilterGroup = filter_json.try_into()?;
        filter.needs_species_join()
    } else {
        false
    };

    let aliases = if needs_join {
        TableAliases::new(Some("s"), Some("sp"))
    } else {
        TableAliases::new(None, None)
    };

    let tick_visibility = query.tick_visibility()?;
    let filter_sql = build_filter_clause(FilterRequest {
        pool: pools.read(),
        upload_id: &upload_uuid.as_bytes()[..],
        filter_json: query.filter.as_ref(),
        year_tick_year: query.year_tick_year,
        country_tick_country: query.country_tick_country.as_ref(),
        aliases,
        tick_visibility: &tick_visibility,
    })
    .await?;

    let sql = if needs_join {
        format!(
            "SELECT COUNT(*) as cnt FROM sightings s JOIN species sp ON s.species_id = sp.id WHERE s.upload_id = ?{}",
            filter_sql.clause()
        )
    } else {
        format!(
            "SELECT COUNT(*) as cnt FROM sightings WHERE upload_id = ?{}",
            filter_sql.clause()
        )
    };

    let mut db_query = sqlx::query_scalar::<_, i64>(&sql).bind(&upload_uuid.as_bytes()[..]);
    for param in filter_sql.params() {
        db_query = db_query.bind(param);
    }

    let count = db::query_with_timeout(db_query.fetch_one(pools.read()))
        .await
        .map_err(|e| e.into_api_error("counting sightings", "Database error"))?;

    Ok(Proto::new(pb::CountResponse {
        count,
        data_version,
    }))
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
    State(pools): State<DbPools>,
    Path(path): Path<FieldValuesPath>,
) -> Result<Proto<pb::FieldValues>, ApiError> {
    let upload_uuid = Uuid::parse_str(&path.upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
    let data_version = get_upload_data_version(pools.read(), &upload_uuid).await?;
    let values = get_distinct_values(pools.read(), &upload_uuid.as_bytes()[..], &path.field)
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
        data_version,
    }))
}
