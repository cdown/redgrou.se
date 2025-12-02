use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Row, SqlitePool};
use ts_rs::TS;

use crate::api_constants;
use crate::db;
use crate::error::ApiError;
use crate::filter::FilterGroup;

#[derive(Debug, Serialize, Deserialize, TS, Clone, Copy)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum SortField {
    CommonName,
    ScientificName,
    Count,
    SpeciesCount,
    CountryCode,
    ObservedAt,
}

impl SortField {
    pub const fn as_sql_column(&self) -> &'static str {
        match self {
            Self::CommonName => "common_name",
            Self::ScientificName => "scientific_name",
            Self::Count => "count",
            Self::SpeciesCount => "species_count",
            Self::CountryCode => "country_code",
            Self::ObservedAt => "observed_at",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SightingsQuery {
    filter: Option<String>,
    sort_field: Option<SortField>,
    sort_dir: Option<String>,
    page: Option<u32>,
    page_size: Option<u32>,
    group_by: Option<String>,
    lifers_only: Option<bool>,
    year_tick_year: Option<i32>,
}

#[derive(Debug, Serialize, TS, FromRow)]
#[ts(export)]
pub struct Sighting {
    pub id: i64,
    pub common_name: String,
    pub scientific_name: Option<String>,
    pub count: Option<i64>,
    pub latitude: f64,
    pub longitude: f64,
    pub country_code: Option<String>,
    pub region_code: Option<String>,
    pub observed_at: String,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct GroupedSighting {
    pub common_name: Option<String>,
    pub scientific_name: Option<String>,
    pub country_code: Option<String>,
    pub observed_at: Option<String>,
    pub count: i64,
    pub species_count: i64,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct SightingsResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sightings: Option<Vec<Sighting>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<GroupedSighting>>,
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
    pub total_pages: u32,
}

fn validate_group_by_fields(fields: &[String]) -> Result<Vec<String>, ApiError> {
    let allowed = [
        "common_name",
        "scientific_name",
        "country_code",
        "observed_at",
    ];
    let mut validated = Vec::new();
    for field in fields {
        let trimmed = field.trim();
        if allowed.contains(&trimmed) {
            validated.push(trimmed.to_string());
        } else {
            return Err(ApiError::bad_request(format!(
                "Invalid group_by field: {trimmed}"
            )));
        }
    }
    Ok(validated)
}

pub async fn get_sightings(
    State(pool): State<SqlitePool>,
    Path(upload_id): Path<String>,
    Query(query): Query<SightingsQuery>,
) -> Result<Json<SightingsResponse>, ApiError> {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query
        .page_size
        .unwrap_or(api_constants::DEFAULT_PAGE_SIZE)
        .min(api_constants::MAX_PAGE_SIZE);
    let offset = ((u64::from(page) - 1) * u64::from(page_size))
        .min(u64::try_from(i64::MAX).unwrap_or(u64::MAX));
    let offset_i64 = i64::try_from(offset).unwrap_or(i64::MAX);

    // Collect filter parameters separately from upload_id.
    // The filter module uses enum-based field names (FilterField enum) which
    // prevents SQL injection at compile time. Values are bound as parameters.
    // While string concatenation is used for the WHERE clause, it's safe because
    // field names are whitelisted via enums, not user input.
    let mut filter_params: Vec<String> = Vec::new();
    let mut filter_clause_parts: Vec<String> = Vec::new();

    if let Some(filter_json) = &query.filter {
        let filter: FilterGroup = serde_json::from_str(filter_json)
            .map_err(|_| ApiError::bad_request("Invalid filter JSON"))?;
        filter
            .validate()
            .map_err(|e| ApiError::bad_request(e.message()))?;
        if let Some(sql) = filter.to_sql(&mut filter_params) {
            filter_clause_parts.push(format!("AND {sql}"));
        }
    }

    // Add lifers_only filter if requested
    if query.lifers_only == Some(true) {
        filter_clause_parts.push("AND lifer = 1".to_string());
    }

    // Add year_tick filter if requested
    if let Some(year) = query.year_tick_year {
        filter_clause_parts.push("AND year_tick = 1 AND year = ?".to_string());
        filter_params.push(year.to_string());
    }

    let filter_clause_str = if filter_clause_parts.is_empty() {
        String::new()
    } else {
        format!(" {}", filter_clause_parts.join(" "))
    };

    // Handle grouped query
    if let Some(group_by_str) = &query.group_by {
        let group_by_fields: Vec<String> =
            group_by_str.split(',').map(ToString::to_string).collect();
        let validated_fields = validate_group_by_fields(&group_by_fields)?;

        if validated_fields.is_empty() {
            return Err(ApiError::bad_request(
                "group_by must contain at least one field",
            ));
        }

        // Build GROUP BY clause - use DATE() for observed_at to group by date only
        let group_by_clause: Vec<String> = validated_fields
            .iter()
            .map(|f| {
                if f == "observed_at" {
                    "DATE(observed_at)".to_string()
                } else {
                    f.clone()
                }
            })
            .collect();
        let group_by_clause_str = group_by_clause.join(", ");

        // Build SELECT clause - use DATE() for observed_at to group by date only.
        // DATE() returns YYYY-MM-DD format. We format it as ISO 8601 date string
        // (YYYY-MM-DD) explicitly to ensure consistent parsing in the frontend.
        // Note: This is intentionally date-only (not datetime) for grouped results.
        let select_clause: Vec<String> = validated_fields
            .iter()
            .map(|f| {
                if f == "observed_at" {
                    // DATE() returns YYYY-MM-DD, which is a valid ISO 8601 date string
                    "DATE(observed_at) as observed_at".to_string()
                } else {
                    f.clone()
                }
            })
            .collect();
        let select_clause_str = select_clause.join(", ");

        // Count total groups
        let count_sql = format!(
            "SELECT COUNT(*) FROM (SELECT {} FROM sightings WHERE upload_id = ?{} GROUP BY {})",
            select_clause_str, filter_clause_str, group_by_clause_str
        );

        let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
        count_query = count_query.bind(&upload_id);
        for param in &filter_params {
            count_query = count_query.bind(param);
        }

        let total = db::query_with_timeout(count_query.fetch_one(&pool))
            .await
            .map_err(|e| e.into_api_error("counting grouped sightings", "Database error"))?;

        // Determine sort field (must be one of the grouped fields, count, or species_count)
        let sort_field = if let Some(sf) = query.sort_field {
            let col = sf.as_sql_column();
            if validated_fields.contains(&col.to_string())
                || col == "count"
                || col == "species_count"
            {
                col
            } else {
                validated_fields.first().unwrap()
            }
        } else {
            "count"
        };

        let sort_dir = match query.sort_dir.as_deref() {
            Some("asc") => "ASC",
            _ => "DESC",
        };

        // Build SELECT query with COUNT(*)
        // For sorting by observed_at, use DATE() to match the grouping
        let sort_field_actual = if sort_field == "observed_at" {
            "DATE(observed_at)"
        } else {
            sort_field
        };

        let select_sql = format!(
            "SELECT {}, COUNT(*) as count, COUNT(DISTINCT scientific_name) as species_count FROM sightings WHERE upload_id = ?{} GROUP BY {} ORDER BY {} {} LIMIT ? OFFSET ?",
            select_clause_str,
            filter_clause_str,
            group_by_clause_str,
            sort_field_actual,
            sort_dir
        );

        // Build query with proper parameter binding
        let mut select_query = sqlx::query(&select_sql);
        select_query = select_query.bind(&upload_id);
        for param in &filter_params {
            select_query = select_query.bind(param);
        }
        select_query = select_query.bind(i64::from(page_size));
        select_query = select_query.bind(offset_i64);

        let rows = db::query_with_timeout(select_query.fetch_all(&pool))
            .await
            .map_err(|e| e.into_api_error("loading grouped sightings", "Database error"))?;

        // Parse results into GroupedSighting
        let mut groups = Vec::new();
        for row in rows {
            let mut grouped = GroupedSighting {
                common_name: None,
                scientific_name: None,
                country_code: None,
                observed_at: None,
                count: 0,
                species_count: 0,
            };

            for (i, field) in validated_fields.iter().enumerate() {
                let value: Option<String> = row.try_get(i).ok();
                match field.as_str() {
                    "common_name" => grouped.common_name = value,
                    "scientific_name" => grouped.scientific_name = value,
                    "country_code" => grouped.country_code = value,
                    "observed_at" => grouped.observed_at = value,
                    _ => {}
                }
            }

            let count_idx = validated_fields.len();
            let species_count_idx = validated_fields.len() + 1;
            grouped.count = row.try_get(count_idx).unwrap_or(0);
            grouped.species_count = row.try_get(species_count_idx).unwrap_or(0);

            groups.push(grouped);
        }

        let total_pages = ((total as f64) / (f64::from(page_size))).ceil() as u32;

        return Ok(Json(SightingsResponse {
            sightings: None,
            groups: Some(groups),
            total,
            page,
            page_size,
            total_pages,
        }));
    }

    // Original individual sightings query
    let sort_field = query
        .sort_field
        .unwrap_or(SortField::ObservedAt)
        .as_sql_column();

    let sort_dir = match query.sort_dir.as_deref() {
        Some("asc") => "ASC",
        _ => "DESC",
    };

    // Build count query - use parameterized queries with filter clause
    // (filter clause is safe because field names come from enums)
    let count_sql = format!(
        "SELECT COUNT(*) FROM sightings WHERE upload_id = ?{}",
        filter_clause_str
    );
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    count_query = count_query.bind(&upload_id);
    for param in &filter_params {
        count_query = count_query.bind(param);
    }

    let total = db::query_with_timeout(count_query.fetch_one(&pool))
        .await
        .map_err(|e| e.into_api_error("counting sightings", "Database error"))?;

    // Build select query - use QueryBuilder for structure, string for filter clause
    // (filter clause is safe because field names come from enums)
    let select_sql = format!(
        r"SELECT id, common_name, scientific_name, count, latitude, longitude,
            country_code, region_code, observed_at
            FROM sightings
            WHERE upload_id = ?{}
            ORDER BY {} {}
            LIMIT ? OFFSET ?",
        filter_clause_str, sort_field, sort_dir
    );

    let mut select_query = sqlx::query_as::<_, Sighting>(&select_sql);
    select_query = select_query.bind(&upload_id);
    for param in &filter_params {
        select_query = select_query.bind(param);
    }
    select_query = select_query.bind(i64::from(page_size));
    select_query = select_query.bind(offset_i64);

    let sightings = db::query_with_timeout(select_query.fetch_all(&pool))
        .await
        .map_err(|e| e.into_api_error("loading sightings", "Database error"))?;

    let total_pages = ((total as f64) / (page_size as f64)).ceil() as u32;

    Ok(Json(SightingsResponse {
        sightings: Some(sightings),
        groups: None,
        total,
        page,
        page_size,
        total_pages,
    }))
}
