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
    pub fn as_sql_column(&self) -> &'static str {
        match self {
            SortField::CommonName => "common_name",
            SortField::ScientificName => "scientific_name",
            SortField::Count => "count",
            SortField::SpeciesCount => "species_count",
            SortField::CountryCode => "country_code",
            SortField::ObservedAt => "observed_at",
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
    let offset = ((page as u64 - 1) * page_size as u64).min(i64::MAX as u64);
    let offset_i64 = offset as i64;

    let mut params: Vec<String> = vec![upload_id.clone()];

    let mut filter_clause = if let Some(filter_json) = &query.filter {
        let filter: FilterGroup = serde_json::from_str(filter_json)
            .map_err(|_| ApiError::bad_request("Invalid filter JSON"))?;
        filter
            .validate()
            .map_err(|e| ApiError::bad_request(e.message()))?;
        filter.to_sql(&mut params).map(|sql| format!(" AND {sql}"))
    } else {
        None
    };

    // Add lifers_only filter if requested
    if query.lifers_only == Some(true) {
        let lifer_clause = " AND lifer = 1".to_string();
        filter_clause = Some(match filter_clause {
            Some(existing) => format!("{existing}{lifer_clause}"),
            None => lifer_clause,
        });
    }

    // Add year_tick filter if requested
    if let Some(year) = query.year_tick_year {
        params.push(year.to_string());
        let year_tick_clause = " AND year_tick = 1 AND year = ?".to_string();
        filter_clause = Some(match filter_clause {
            Some(existing) => format!("{existing}{year_tick_clause}"),
            None => year_tick_clause,
        });
    }

    // Handle grouped query
    if let Some(group_by_str) = &query.group_by {
        let group_by_fields: Vec<String> = group_by_str.split(',').map(|s| s.to_string()).collect();
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

        // Build SELECT clause - use DATE() for observed_at, preserve NULLs for others
        let select_clause: Vec<String> = validated_fields
            .iter()
            .map(|f| {
                if f == "observed_at" {
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
            select_clause_str,
            filter_clause.as_deref().unwrap_or(""),
            group_by_clause_str
        );

        let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
        for param in &params {
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
            filter_clause.as_deref().unwrap_or(""),
            group_by_clause_str,
            sort_field_actual,
            sort_dir
        );

        // Build query with proper parameter binding
        let mut select_query = sqlx::query(&select_sql);
        for param in &params {
            select_query = select_query.bind(param);
        }
        select_query = select_query.bind(page_size as i64);
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

        let total_pages = ((total as f64) / (page_size as f64)).ceil() as u32;

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

    let count_sql = format!(
        "SELECT COUNT(*) FROM sightings WHERE upload_id = ?{}",
        filter_clause.as_deref().unwrap_or("")
    );

    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    for param in &params {
        count_query = count_query.bind(param);
    }

    let total = db::query_with_timeout(count_query.fetch_one(&pool))
        .await
        .map_err(|e| e.into_api_error("counting sightings", "Database error"))?;

    let select_sql = format!(
        r#"SELECT id, common_name, scientific_name, count, latitude, longitude,
           country_code, region_code, observed_at
           FROM sightings
           WHERE upload_id = ?{}
           ORDER BY {} {}
           LIMIT ? OFFSET ?"#,
        filter_clause.as_deref().unwrap_or(""),
        sort_field,
        sort_dir
    );

    params.push(page_size.to_string());
    params.push(offset_i64.to_string());

    let mut select_query = sqlx::query_as::<_, Sighting>(&select_sql);

    for param in &params {
        select_query = select_query.bind(param);
    }

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
