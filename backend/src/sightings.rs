use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Row, SqlitePool};
use ts_rs::TS;

use crate::api_constants;
use crate::bind_filter_params;
use crate::db;
use crate::error::ApiError;
use crate::filter::build_filter_clause;

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
            Self::CommonName => "sp.common_name",
            Self::ScientificName => "sp.scientific_name",
            Self::Count => "s.count",
            Self::SpeciesCount => "species_count",
            Self::CountryCode => "s.country_code",
            Self::ObservedAt => "s.observed_at",
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
    country_tick_country: Option<String>,
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

fn parse_sort_direction(sort_dir: Option<&String>) -> &'static str {
    match sort_dir {
        Some(dir) if dir == "asc" => "ASC",
        _ => "DESC",
    }
}

fn calculate_total_pages(total: i64, page_size: u32) -> u32 {
    ((total as f64) / (f64::from(page_size))).ceil() as u32
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

    // Collect filter params separately so upload_id stays first and field names remain enum-whitelisted.
    let (filter_clause_str, filter_params) = build_filter_clause(
        query.filter.as_ref(),
        query.lifers_only,
        query.year_tick_year,
        query.country_tick_country.as_ref(),
        None,
    )?;

    if let Some(group_by_str) = &query.group_by {
        let group_by_fields: Vec<String> =
            group_by_str.split(',').map(ToString::to_string).collect();
        let validated_fields = validate_group_by_fields(&group_by_fields)?;

        if validated_fields.is_empty() {
            return Err(ApiError::bad_request(
                "group_by must contain at least one field",
            ));
        }

        // Build SELECT and GROUP BY clauses with proper table aliases
        let select_clause_with_aliases: Vec<String> = validated_fields
            .iter()
            .map(|f| {
                if f == "observed_at" {
                    "DATE(s.observed_at) as observed_at".to_string()
                } else if f == "common_name" {
                    "sp.common_name".to_string()
                } else if f == "scientific_name" {
                    "sp.scientific_name".to_string()
                } else if f == "country_code" {
                    "s.country_code".to_string()
                } else {
                    format!("s.{}", f)
                }
            })
            .collect();
        let select_clause_with_aliases_str = select_clause_with_aliases.join(", ");

        let group_by_clause_with_aliases: Vec<String> = validated_fields
            .iter()
            .map(|f| {
                if f == "observed_at" {
                    "DATE(s.observed_at)".to_string()
                } else if f == "common_name" {
                    "sp.common_name".to_string()
                } else if f == "scientific_name" {
                    "sp.scientific_name".to_string()
                } else if f == "country_code" {
                    "s.country_code".to_string()
                } else {
                    format!("s.{}", f)
                }
            })
            .collect();
        let group_by_clause_with_aliases_str = group_by_clause_with_aliases.join(", ");

        let count_sql = format!(
            "SELECT COUNT(*) FROM (SELECT {} FROM sightings s JOIN species sp ON s.species_id = sp.id WHERE s.upload_id = ?{} GROUP BY {})",
            select_clause_with_aliases_str, filter_clause_str, group_by_clause_with_aliases_str
        );

        let count_query = bind_filter_params!(
            sqlx::query_scalar::<_, i64>(&count_sql),
            &upload_id,
            &filter_params
        );

        let total = db::query_with_timeout(count_query.fetch_one(&pool))
            .await
            .map_err(|e| e.into_api_error("counting grouped sightings", "Database error"))?;

        let sort_field = if let Some(sf) = query.sort_field {
            let col = sf.as_sql_column();
            // Check if the column (with or without alias) is in validated_fields
            let col_base = col
                .strip_prefix("sp.")
                .unwrap_or(col.strip_prefix("s.").unwrap_or(col));
            if validated_fields.contains(&col_base.to_string())
                || col_base == "count"
                || col_base == "species_count"
            {
                col.to_string()
            } else {
                // Default to first validated field with proper alias
                let first_field = validated_fields.first().unwrap();
                if first_field == "common_name" {
                    "sp.common_name".to_string()
                } else if first_field == "scientific_name" {
                    "sp.scientific_name".to_string()
                } else if first_field == "country_code" {
                    "s.country_code".to_string()
                } else if first_field == "observed_at" {
                    "DATE(s.observed_at)".to_string()
                } else {
                    format!("s.{}", first_field)
                }
            }
        } else {
            "count".to_string()
        };

        let sort_dir = parse_sort_direction(query.sort_dir.as_ref());

        // For sorting by observed_at, use DATE() to match the grouping
        let sort_field_with_alias = if sort_field == "sp.observed_at"
            || sort_field == "s.observed_at"
            || sort_field == "observed_at"
        {
            "DATE(s.observed_at)"
        } else {
            &sort_field
        };

        let select_sql = format!(
            "SELECT {}, COUNT(*) as count, COUNT(DISTINCT sp.scientific_name) as species_count FROM sightings s JOIN species sp ON s.species_id = sp.id WHERE s.upload_id = ?{} GROUP BY {} ORDER BY {} {} LIMIT ? OFFSET ?",
            select_clause_with_aliases_str,
            filter_clause_str,
            group_by_clause_with_aliases_str,
            sort_field_with_alias,
            sort_dir
        );

        let mut select_query =
            bind_filter_params!(sqlx::query(&select_sql), &upload_id, &filter_params);
        select_query = select_query.bind(i64::from(page_size));
        select_query = select_query.bind(offset_i64);

        let rows = db::query_with_timeout(select_query.fetch_all(&pool))
            .await
            .map_err(|e| e.into_api_error("loading grouped sightings", "Database error"))?;

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

        let total_pages = calculate_total_pages(total, page_size);

        return Ok(Json(SightingsResponse {
            sightings: None,
            groups: Some(groups),
            total,
            page,
            page_size,
            total_pages,
        }));
    }

    let sort_field = query
        .sort_field
        .unwrap_or(SortField::ObservedAt)
        .as_sql_column()
        .to_string();

    let sort_dir = parse_sort_direction(query.sort_dir.as_ref());

    let count_sql = format!(
        "SELECT COUNT(*) FROM sightings s JOIN species sp ON s.species_id = sp.id WHERE s.upload_id = ?{}",
        filter_clause_str
    );
    let count_query = bind_filter_params!(
        sqlx::query_scalar::<_, i64>(&count_sql),
        &upload_id,
        &filter_params
    );

    let total = db::query_with_timeout(count_query.fetch_one(&pool))
        .await
        .map_err(|e| e.into_api_error("counting sightings", "Database error"))?;

    let select_sql = format!(
        r"SELECT s.id, sp.common_name, sp.scientific_name, s.count, s.latitude, s.longitude,
            s.country_code, s.region_code, s.observed_at
            FROM sightings s
            JOIN species sp ON s.species_id = sp.id
            WHERE s.upload_id = ?{}
            ORDER BY {} {}
            LIMIT ? OFFSET ?",
        filter_clause_str, &sort_field, sort_dir
    );

    let mut select_query = bind_filter_params!(
        sqlx::query_as::<_, Sighting>(&select_sql),
        &upload_id,
        &filter_params
    );
    select_query = select_query.bind(i64::from(page_size));
    select_query = select_query.bind(offset_i64);

    let sightings = db::query_with_timeout(select_query.fetch_all(&pool))
        .await
        .map_err(|e| e.into_api_error("loading sightings", "Database error"))?;

    let total_pages = calculate_total_pages(total, page_size);

    Ok(Json(SightingsResponse {
        sightings: Some(sightings),
        groups: None,
        total,
        page,
        page_size,
        total_pages,
    }))
}
