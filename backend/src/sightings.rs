use axum::extract::{Path, Query, State};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Row, SqlitePool};
use uuid::Uuid;

use crate::api_constants;
use crate::bind_filter_params;
use crate::db;
use crate::error::ApiError;
use crate::filter::build_filter_clause;
use crate::proto::{pb, Proto};
use tracing::warn;

#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
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

    pub const fn as_query_param(&self) -> &'static str {
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

struct NameIndexResult {
    name_index: Vec<pb::Species>,
    species_id_to_index: std::collections::HashMap<i64, u32>,
}

async fn build_name_index(
    pool: &SqlitePool,
    upload_uuid: &[u8],
) -> Result<NameIndexResult, ApiError> {
    let species_rows = db::query_with_timeout(
        sqlx::query_as::<_, SpeciesRow>(
            r"SELECT DISTINCT sp.id, sp.common_name, sp.scientific_name
              FROM sightings s
              JOIN species sp ON s.species_id = sp.id
              WHERE s.upload_id = ?
              ORDER BY sp.id",
        )
        .bind(upload_uuid)
        .fetch_all(pool),
    )
    .await
    .map_err(|e| e.into_api_error("loading species names", "Database error"))?;

    let mut name_index = Vec::new();
    let mut species_id_to_index = std::collections::HashMap::new();

    for (idx, species) in species_rows.iter().enumerate() {
        let index =
            u32::try_from(idx).map_err(|_| ApiError::internal("Too many species for index"))?;
        species_id_to_index.insert(species.id, index);
        name_index.push(pb::Species {
            common_name: species.common_name.clone(),
            scientific_name: species.scientific_name.clone(),
        });
    }

    Ok(NameIndexResult {
        name_index,
        species_id_to_index,
    })
}

impl Sighting {
    fn into_proto(self, species_id_to_index: &std::collections::HashMap<i64, u32>) -> pb::Sighting {
        let common_name_index = species_id_to_index.get(&self.species_id).copied();
        pb::Sighting {
            id: self.id,
            common_name_index,
            count: self.count,
            latitude: self.latitude,
            longitude: self.longitude,
            country_code: self.country_code,
            region_code: self.region_code,
            observed_at: self.observed_at,
        }
    }
}

impl GroupedSighting {
    fn into_proto(
        self,
        species_id_to_index: &std::collections::HashMap<i64, u32>,
    ) -> pb::GroupedSighting {
        let common_name_index = self
            .species_id
            .and_then(|id| species_id_to_index.get(&id).copied());
        pb::GroupedSighting {
            common_name_index,
            country_code: self.country_code,
            observed_at: self.observed_at,
            count: self.count,
            species_count: self.species_count,
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
    cursor: Option<String>,
}

#[derive(Debug, FromRow)]
pub struct Sighting {
    pub id: i64,
    pub species_id: i64,
    pub count: Option<i64>,
    pub latitude: f64,
    pub longitude: f64,
    pub country_code: Option<String>,
    pub region_code: Option<String>,
    pub observed_at: String,
}

#[derive(Debug, FromRow)]
pub struct SpeciesRow {
    pub id: i64,
    pub common_name: String,
    pub scientific_name: Option<String>,
}

#[derive(Debug)]
pub struct GroupedSighting {
    pub species_id: Option<i64>,
    pub country_code: Option<String>,
    pub observed_at: Option<String>,
    pub count: i64,
    pub species_count: i64,
}

fn parse_sort_direction(sort_dir: Option<&String>) -> &'static str {
    match sort_dir {
        Some(dir) if dir == "asc" => "ASC",
        _ => "DESC",
    }
}

#[derive(Debug, Clone, Copy)]
struct TotalCount(i64);

#[derive(Debug, Clone, Copy)]
struct PageSize(u32);

impl From<u32> for PageSize {
    fn from(value: u32) -> Self {
        Self(value)
    }
}

impl From<PageSize> for u32 {
    fn from(value: PageSize) -> Self {
        value.0
    }
}

impl From<i64> for TotalCount {
    fn from(value: i64) -> Self {
        Self(value)
    }
}

fn calculate_total_pages(total: TotalCount, page_size: PageSize) -> u32 {
    ((total.0 as f64) / (f64::from(page_size.0))).ceil() as u32
}

#[derive(Debug, Serialize, Deserialize)]
struct Cursor {
    sort_value: String,
    id: i64,
}

fn encode_cursor(sort_value: &str, id: i64) -> String {
    let cursor = Cursor {
        sort_value: sort_value.to_string(),
        id,
    };
    let json = serde_json::to_string(&cursor).unwrap();
    URL_SAFE_NO_PAD.encode(json.as_bytes())
}

fn decode_cursor(cursor_str: &str) -> Result<Cursor, ApiError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(cursor_str)
        .map_err(|_| ApiError::bad_request("Invalid cursor format"))?;
    let json =
        String::from_utf8(decoded).map_err(|_| ApiError::bad_request("Invalid cursor encoding"))?;
    serde_json::from_str(&json).map_err(|_| ApiError::bad_request("Invalid cursor data"))
}

fn wrap_nullable_sort_column(sort_field: &str) -> String {
    if sort_field == "sp.scientific_name" || sort_field == "s.country_code" {
        format!("COALESCE({}, '')", sort_field)
    } else {
        sort_field.to_string()
    }
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
) -> Result<Proto<pb::SightingsResponse>, ApiError> {
    let upload_uuid = Uuid::parse_str(&upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query
        .page_size
        .unwrap_or(api_constants::DEFAULT_PAGE_SIZE)
        .min(api_constants::MAX_PAGE_SIZE);
    let offset = ((u64::from(page) - 1) * u64::from(page_size))
        .min(u64::try_from(i64::MAX).unwrap_or(u64::MAX));
    let offset_i64 = i64::try_from(offset).unwrap_or(i64::MAX);

    // Collect filter params separately so upload_id stays first and field names remain enum-whitelisted.
    let filter_result = build_filter_clause(
        Some(&pool),
        Some(&upload_uuid.as_bytes()[..]),
        query.filter.as_ref(),
        query.lifers_only,
        query.year_tick_year,
        query.country_tick_country.as_ref(),
        None,
    )
    .await?;

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
                } else if f == "common_name" || f == "scientific_name" {
                    "s.species_id as species_id".to_string()
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
                } else if f == "common_name" || f == "scientific_name" {
                    "s.species_id".to_string()
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
            select_clause_with_aliases_str, filter_result.filter_clause, group_by_clause_with_aliases_str
        );

        let count_query = bind_filter_params!(
            sqlx::query_scalar::<_, i64>(&count_sql),
            &upload_uuid.as_bytes()[..],
            &filter_result.params
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
                if col_base == "common_name" || col_base == "scientific_name" {
                    "s.species_id".to_string()
                } else {
                    col.to_string()
                }
            } else {
                // Default to first validated field with proper alias
                // validated_fields is guaranteed to be non-empty (checked above)
                let first_field = validated_fields
                    .first()
                    .expect("validated_fields should not be empty");
                if first_field == "common_name" || first_field == "scientific_name" {
                    "s.species_id".to_string()
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
            filter_result.filter_clause,
            group_by_clause_with_aliases_str,
            sort_field_with_alias,
            sort_dir
        );

        let mut select_query = bind_filter_params!(
            sqlx::query(&select_sql),
            &upload_uuid.as_bytes()[..],
            &filter_result.params
        );
        select_query = select_query.bind(i64::from(page_size));
        select_query = select_query.bind(offset_i64);

        let rows = db::query_with_timeout(select_query.fetch_all(&pool))
            .await
            .map_err(|e| e.into_api_error("loading grouped sightings", "Database error"))?;

        let index_result = build_name_index(&pool, &upload_uuid.as_bytes()[..]).await?;

        let mut groups = Vec::new();
        for row in rows {
            let mut grouped = GroupedSighting {
                species_id: None,
                country_code: None,
                observed_at: None,
                count: 0,
                species_count: 0,
            };

            for (i, field) in validated_fields.iter().enumerate() {
                match field.as_str() {
                    "common_name" | "scientific_name" => {
                        let species_id: Option<i64> = match row.try_get(i) {
                            Ok(id) => Some(id),
                            Err(err) => {
                                warn!("Failed to get species_id from field {}: {}", field, err);
                                None
                            }
                        };
                        grouped.species_id = species_id;
                    }
                    "country_code" => {
                        let value: Option<String> = match row.try_get(i) {
                            Ok(v) => Some(v),
                            Err(err) => {
                                warn!("Failed to get country_code from field {}: {}", field, err);
                                None
                            }
                        };
                        grouped.country_code = value;
                    }
                    "observed_at" => {
                        let value: Option<String> = match row.try_get(i) {
                            Ok(v) => Some(v),
                            Err(err) => {
                                warn!("Failed to get observed_at from field {}: {}", field, err);
                                None
                            }
                        };
                        grouped.observed_at = value;
                    }
                    _ => {}
                }
            }

            let count_idx = validated_fields.len();
            let species_count_idx = validated_fields.len() + 1;
            grouped.count = row.try_get(count_idx).unwrap_or(0);
            grouped.species_count = row.try_get(species_count_idx).unwrap_or(0);

            groups.push(grouped);
        }

        let total_pages = calculate_total_pages(TotalCount(total), PageSize::from(page_size));

        let groups_pb = groups
            .into_iter()
            .map(|g| g.into_proto(&index_result.species_id_to_index))
            .collect();

        return Ok(Proto::new(pb::SightingsResponse {
            name_index: index_result.name_index,
            sightings: Vec::new(),
            groups: groups_pb,
            total,
            page,
            page_size,
            total_pages,
            next_cursor: None,
        }));
    }

    let sort_field = query
        .sort_field
        .unwrap_or(SortField::ObservedAt)
        .as_sql_column()
        .to_string();

    let sort_dir = parse_sort_direction(query.sort_dir.as_ref());
    let is_asc = sort_dir == "ASC";

    let count_sql = format!(
        "SELECT COUNT(*) FROM sightings s JOIN species sp ON s.species_id = sp.id WHERE s.upload_id = ?{}",
        filter_result.filter_clause
    );
    let count_query = bind_filter_params!(
        sqlx::query_scalar::<_, i64>(&count_sql),
        &upload_uuid.as_bytes()[..],
        &filter_result.params
    );

    let total = db::query_with_timeout(count_query.fetch_one(&pool))
        .await
        .map_err(|e| e.into_api_error("counting sightings", "Database error"))?;

    let use_keyset = query.cursor.is_some();
    let mut keyset_clause = String::new();
    let mut cursor_value: Option<String> = None;
    let mut cursor_id: Option<i64> = None;

    if use_keyset {
        let cursor = decode_cursor(
            query
                .cursor
                .as_ref()
                .expect("cursor should be Some if use_keyset is true"),
        )?;
        cursor_value = Some(cursor.sort_value);
        cursor_id = Some(cursor.id);

        let comparison_op = if is_asc { ">" } else { "<" };
        let sort_field_sql = wrap_nullable_sort_column(&sort_field);
        let sort_value_placeholder = format!("({}, s.id) {} (?, ?)", sort_field_sql, comparison_op);
        keyset_clause = format!(" AND {}", sort_value_placeholder);
    }

    // Always select sort_value to generate next_cursor, even for OFFSET pagination
    // Wrap nullable columns in COALESCE to match cursor logic (NULL -> '')
    let sort_field_for_select = wrap_nullable_sort_column(&sort_field);
    let sort_field_for_order = wrap_nullable_sort_column(&sort_field);
    let select_sql = if use_keyset {
        format!(
            r"SELECT s.id, s.species_id, s.count, s.latitude, s.longitude,
                s.country_code, s.region_code, s.observed_at, {} as sort_value
                FROM sightings s
                JOIN species sp ON s.species_id = sp.id
                WHERE s.upload_id = ?{}{}
                ORDER BY {} {}
                LIMIT ?",
            sort_field_for_select,
            filter_result.filter_clause,
            keyset_clause,
            sort_field_for_order,
            sort_dir
        )
    } else {
        format!(
            r"SELECT s.id, s.species_id, s.count, s.latitude, s.longitude,
                s.country_code, s.region_code, s.observed_at, {} as sort_value
                FROM sightings s
                JOIN species sp ON s.species_id = sp.id
                WHERE s.upload_id = ?{}
                ORDER BY {} {}
                LIMIT ? OFFSET ?",
            sort_field_for_select, filter_result.filter_clause, sort_field_for_order, sort_dir
        )
    };

    let mut select_query = bind_filter_params!(
        sqlx::query(&select_sql),
        &upload_uuid.as_bytes()[..],
        &filter_result.params
    );

    if use_keyset {
        let cursor_val = cursor_value.as_ref().expect("cursor_value should be set");
        let cursor_id_val = cursor_id.expect("cursor_id should be set");
        select_query = select_query.bind(cursor_val);
        select_query = select_query.bind(cursor_id_val);
        select_query = select_query.bind(i64::from(page_size));
    } else {
        select_query = select_query.bind(i64::from(page_size));
        select_query = select_query.bind(offset_i64);
    }

    let rows = db::query_with_timeout(select_query.fetch_all(&pool))
        .await
        .map_err(|e| e.into_api_error("loading sightings", "Database error"))?;

    let mut sightings = Vec::new();
    let mut next_cursor: Option<String> = None;

    for row in rows {
        let sighting = Sighting {
            id: row.get(0),
            species_id: row.get(1),
            count: row.get(2),
            latitude: row.get(3),
            longitude: row.get(4),
            country_code: row.get(5),
            region_code: row.get(6),
            observed_at: row.get(7),
        };
        sightings.push(sighting);

        // Always generate next_cursor from the last row
        let sort_val: Option<String> = row.try_get(8).ok();
        let id: i64 = row.get(0);
        let sort_val_str = sort_val.unwrap_or_else(|| String::from(""));
        next_cursor = Some(encode_cursor(&sort_val_str, id));
    }

    let total_pages = calculate_total_pages(TotalCount(total), PageSize::from(page_size));

    let index_result = build_name_index(&pool, &upload_uuid.as_bytes()[..]).await?;

    let sightings_pb = sightings
        .into_iter()
        .map(|s| s.into_proto(&index_result.species_id_to_index))
        .collect();

    Ok(Proto::new(pb::SightingsResponse {
        name_index: index_result.name_index,
        sightings: sightings_pb,
        groups: Vec::new(),
        total,
        page,
        page_size,
        total_pages,
        next_cursor,
    }))
}
