use crate::bitmaps;
use crate::db::{self, DbQueryError};
use crate::error::ApiError;
use roaring::RoaringBitmap;
use serde::{Deserialize, Serialize};
use std::convert::TryFrom;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Combinator {
    And,
    Or,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    Eq,
    Neq,
    Contains,
    StartsWith,
    EndsWith,
    Gte,
    Lte,
    In,
    NotIn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterValue {
    String(String),
    Number(f64),
    List(Vec<String>),
}

/// Type-safe representation of filterable field names.
/// This enum ensures only valid fields can be used in filters,
/// preventing SQL injection via field names at compile time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterField {
    CommonName,
    ScientificName,
    CountryCode,
    Count,
    ObservedAt,
    Year,
}

impl FilterField {
    pub const fn as_sql_column(&self) -> &'static str {
        match self {
            Self::CommonName => "common_name",
            Self::ScientificName => "scientific_name",
            Self::CountryCode => "country_code",
            Self::Count => "count",
            Self::ObservedAt => "observed_at",
            Self::Year => "year",
        }
    }

    pub fn as_str(&self) -> &'static str {
        self.as_sql_column()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Condition {
    pub field: FilterField,
    pub operator: Operator,
    pub value: FilterValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Rule {
    Condition(Condition),
    Group(FilterGroup),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterGroup {
    pub combinator: Combinator,
    pub rules: Vec<Rule>,
}

const MAX_FILTER_DEPTH: usize = 5;
const MAX_FILTER_RULES: usize = 100;
const MAX_LIST_VALUES: usize = 50;
const MAX_DISTINCT_FIELD_VALUES: usize = 20000;

#[derive(Debug)]
pub struct FilterValidationError {
    message: String,
}

impl FilterValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Default)]
struct FilterStats {
    rules: usize,
}

#[derive(Clone, Copy)]
pub struct TableAliases<'a> {
    pub sightings: Option<&'a str>,
    pub species: Option<&'a str>,
}

impl<'a> TableAliases<'a> {
    pub const fn new(sightings: Option<&'a str>, species: Option<&'a str>) -> Self {
        Self { sightings, species }
    }
}

#[derive(Debug, Clone)]
pub struct FilterSql {
    clause: String,
    params: Vec<String>,
}

impl FilterSql {
    const fn new(clause: String, params: Vec<String>) -> Self {
        Self { clause, params }
    }

    pub fn clause(&self) -> &str {
        &self.clause
    }

    pub fn params(&self) -> &[String] {
        &self.params
    }

    pub fn is_empty(&self) -> bool {
        self.clause.is_empty()
    }
}

struct ColumnResolver<'a> {
    sightings_alias: Option<&'a str>,
    species_alias: Option<&'a str>,
}

impl<'a> ColumnResolver<'a> {
    fn new(aliases: TableAliases<'a>) -> Self {
        Self {
            sightings_alias: aliases.sightings,
            species_alias: aliases.species,
        }
    }

    fn column(&self, field: FilterField) -> String {
        match field {
            FilterField::CommonName | FilterField::ScientificName => {
                if let Some(species) = self.species_alias {
                    return format!("{species}.{}", field.as_sql_column());
                }
                self.format_with_alias(self.sightings_alias, field.as_sql_column())
            }
            _ => self.format_with_alias(self.sightings_alias, field.as_sql_column()),
        }
    }

    fn format_with_alias(&self, alias: Option<&str>, column: &str) -> String {
        match alias {
            Some(prefix) => format!("{prefix}.{column}"),
            None => column.to_string(),
        }
    }
}

impl FilterGroup {
    pub fn validate(&self) -> Result<(), FilterValidationError> {
        let mut stats = FilterStats::default();
        validate_group(self, 1, &mut stats)
    }

    pub fn needs_species_join(&self) -> bool {
        fn check_rule(rule: &Rule) -> bool {
            match rule {
                Rule::Condition(c) => {
                    matches!(
                        c.field,
                        FilterField::CommonName | FilterField::ScientificName
                    )
                }
                Rule::Group(g) => g.needs_species_join(),
            }
        }

        self.rules.iter().any(check_rule)
    }

    fn to_sql(&self, resolver: &ColumnResolver<'_>, params: &mut Vec<String>) -> Option<String> {
        if self.rules.is_empty() {
            return None;
        }

        let clauses: Vec<String> = self
            .rules
            .iter()
            .filter_map(|rule| rule.to_sql(resolver, params))
            .collect();

        if clauses.is_empty() {
            return None;
        }

        let joiner = match self.combinator {
            Combinator::And => " AND ",
            Combinator::Or => " OR ",
        };

        Some(format!("({})", clauses.join(joiner)))
    }
}

impl Rule {
    fn to_sql(&self, resolver: &ColumnResolver<'_>, params: &mut Vec<String>) -> Option<String> {
        match self {
            Self::Condition(c) => c.to_sql(resolver, params),
            Self::Group(g) => g.to_sql(resolver, params),
        }
    }
}

impl Condition {
    fn validate(&self) -> Result<(), FilterValidationError> {
        match &self.value {
            FilterValue::List(values) if values.len() > MAX_LIST_VALUES => {
                Err(FilterValidationError::new(format!(
                    "Lists are limited to {MAX_LIST_VALUES} values"
                )))
            }
            _ => Ok(()),
        }
    }

    fn to_sql(&self, resolver: &ColumnResolver<'_>, params: &mut Vec<String>) -> Option<String> {
        let field = resolver.column(self.field);

        match (&self.operator, &self.value) {
            (Operator::Eq, FilterValue::String(v)) => {
                params.push(v.clone());
                Some(format!("{field} = ?"))
            }
            (Operator::Eq, FilterValue::Number(v)) => {
                params.push(v.to_string());
                Some(format!("{field} = ?"))
            }
            (Operator::Neq, FilterValue::String(v)) => {
                params.push(v.clone());
                Some(format!("{field} != ?"))
            }
            (Operator::Neq, FilterValue::Number(v)) => {
                params.push(v.to_string());
                Some(format!("{field} != ?"))
            }
            (Operator::Contains, FilterValue::String(v)) => {
                params.push(format!("%{v}%"));
                Some(format!("{field} LIKE ?"))
            }
            (Operator::StartsWith, FilterValue::String(v)) => {
                params.push(format!("{v}%"));
                Some(format!("{field} LIKE ?"))
            }
            (Operator::EndsWith, FilterValue::String(v)) => {
                params.push(format!("%{v}"));
                Some(format!("{field} LIKE ?"))
            }
            (Operator::Gte, FilterValue::Number(v)) => {
                params.push(v.to_string());
                Some(format!("{field} >= ?"))
            }
            (Operator::Gte, FilterValue::String(v)) => {
                params.push(v.clone());
                Some(format!("{field} >= ?"))
            }
            (Operator::Lte, FilterValue::Number(v)) => {
                params.push(v.to_string());
                Some(format!("{field} <= ?"))
            }
            (Operator::Lte, FilterValue::String(v)) => {
                params.push(v.clone());
                Some(format!("{field} <= ?"))
            }
            (Operator::In, FilterValue::List(vals)) if !vals.is_empty() => {
                let placeholders: Vec<&str> = vals.iter().map(|_| "?").collect();
                params.extend(vals.clone());
                // Note: year_tick is not a FilterField, so this special case
                // is handled elsewhere (in the year_tick_year query parameter)
                Some(format!("{field} IN ({})", placeholders.join(", ")))
            }
            (Operator::NotIn, FilterValue::List(vals)) if !vals.is_empty() => {
                let placeholders: Vec<&str> = vals.iter().map(|_| "?").collect();
                params.extend(vals.clone());
                Some(format!("{field} NOT IN ({})", placeholders.join(", ")))
            }
            _ => None,
        }
    }
}

fn validate_group(
    group: &FilterGroup,
    depth: usize,
    stats: &mut FilterStats,
) -> Result<(), FilterValidationError> {
    if depth > MAX_FILTER_DEPTH {
        return Err(FilterValidationError::new(format!(
            "Filters exceed maximum depth of {MAX_FILTER_DEPTH}"
        )));
    }

    for rule in &group.rules {
        match rule {
            Rule::Condition(condition) => {
                stats.rules += 1;
                if stats.rules > MAX_FILTER_RULES {
                    return Err(FilterValidationError::new(format!(
                        "Filters exceed maximum of {MAX_FILTER_RULES} conditions"
                    )));
                }
                condition.validate()?;
            }
            Rule::Group(child) => validate_group(child, depth + 1, stats)?,
        }
    }

    Ok(())
}

#[derive(Debug, Serialize)]
pub struct FieldMetadata {
    pub name: String,
    pub label: String,
    pub field_type: String,
}

pub fn get_field_metadata() -> Vec<FieldMetadata> {
    vec![
        FieldMetadata {
            name: "common_name".into(),
            label: "Common Name".into(),
            field_type: "string".into(),
        },
        FieldMetadata {
            name: "scientific_name".into(),
            label: "Scientific Name".into(),
            field_type: "string".into(),
        },
        FieldMetadata {
            name: "country_code".into(),
            label: "Country".into(),
            field_type: "string".into(),
        },
        FieldMetadata {
            name: "count".into(),
            label: "Count".into(),
            field_type: "number".into(),
        },
        FieldMetadata {
            name: "observed_at".into(),
            label: "Date".into(),
            field_type: "date".into(),
        },
        FieldMetadata {
            name: "year".into(),
            label: "Year".into(),
            field_type: "number".into(),
        },
    ]
}

impl TryFrom<&str> for FilterGroup {
    type Error = ApiError;

    fn try_from(filter_json: &str) -> Result<Self, Self::Error> {
        let filter: FilterGroup = serde_json::from_str(filter_json)
            .map_err(|_| ApiError::bad_request("Invalid filter JSON"))?;
        filter
            .validate()
            .map_err(|e| ApiError::bad_request(e.message()))?;
        Ok(filter)
    }
}

impl TryFrom<String> for FilterGroup {
    type Error = ApiError;

    fn try_from(filter_json: String) -> Result<Self, Self::Error> {
        filter_json.as_str().try_into()
    }
}

impl TryFrom<&String> for FilterGroup {
    type Error = ApiError;

    fn try_from(filter_json: &String) -> Result<Self, Self::Error> {
        filter_json.as_str().try_into()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TickVisibility {
    pub include_normal: bool,
    pub include_lifer: bool,
    pub include_year: bool,
    pub include_country: bool,
}

impl TickVisibility {
    pub fn all() -> Self {
        Self {
            include_normal: true,
            include_lifer: true,
            include_year: true,
            include_country: true,
        }
    }

    pub fn empty() -> Self {
        Self {
            include_normal: false,
            include_lifer: false,
            include_year: false,
            include_country: false,
        }
    }

    pub fn from_query(tick_filter: Option<&str>) -> Result<Self, ApiError> {
        if let Some(raw) = tick_filter {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Ok(Self::empty());
            }

            let mut visibility = Self::empty();
            for value in trimmed.split(',') {
                let token = value.trim().to_ascii_lowercase();
                if token.is_empty() {
                    continue;
                }
                match token.as_str() {
                    "normal" | "default" => visibility.include_normal = true,
                    "lifer" | "lifers" => visibility.include_lifer = true,
                    "year" | "year_tick" | "year_ticks" => visibility.include_year = true,
                    "country" | "country_tick" | "country_ticks" => {
                        visibility.include_country = true
                    }
                    _ => {
                        return Err(ApiError::bad_request(format!(
                            "Invalid tick_filter value: {}",
                            token
                        )));
                    }
                }
            }
            return Ok(visibility);
        }

        Ok(Self::all())
    }

    pub fn with_required(
        mut self,
        year_tick_year: Option<i32>,
        country_tick_country: Option<&String>,
    ) -> Self {
        if year_tick_year.is_some() {
            self.include_year = true;
        }
        if country_tick_country.is_some() {
            self.include_country = true;
        }
        self
    }

    pub fn is_all(&self) -> bool {
        self.include_normal && self.include_lifer && self.include_year && self.include_country
    }

    pub fn is_empty(&self) -> bool {
        !self.include_normal && !self.include_lifer && !self.include_year && !self.include_country
    }

    pub fn to_sql_clause(&self, table_prefix: Option<&str>) -> Option<String> {
        if self.is_all() {
            return None;
        }

        if self.is_empty() {
            return Some("0 = 1".to_string());
        }

        let prefix = table_prefix.map(|p| format!("{p}.")).unwrap_or_default();

        let mut clauses = Vec::new();
        if self.include_lifer {
            clauses.push(format!("{prefix}lifer = 1"));
        }
        if self.include_year {
            clauses.push(format!("{prefix}year_tick = 1"));
        }
        if self.include_country {
            clauses.push(format!("{prefix}country_tick = 1"));
        }
        if self.include_normal {
            clauses.push(format!(
                "({prefix}lifer = 0 AND {prefix}year_tick = 0 AND {prefix}country_tick = 0)"
            ));
        }

        Some(format!("({})", clauses.join(" OR ")))
    }
}

#[derive(Debug, Deserialize)]
pub struct CountQuery {
    pub filter: Option<String>,
    pub year_tick_year: Option<i32>,
    pub country_tick_country: Option<String>,
    pub tick_filter: Option<String>,
}

impl CountQuery {
    pub fn tick_visibility(&self) -> Result<TickVisibility, ApiError> {
        TickVisibility::from_query(self.tick_filter.as_deref())
            .map(|vis| vis.with_required(self.year_tick_year, self.country_tick_country.as_ref()))
    }
}

const SQLITE_SAFE_PARAM_LIMIT: u64 = 30_000;

/// Builds filter SQL clauses and parameters using roaring bitmaps for tick filters.
/// Returns filter_clause (a string like " AND (...)" or empty string) and params.
pub async fn build_filter_clause(request: FilterRequest<'_>) -> Result<FilterSql, ApiError> {
    request.build().await
}

pub struct FilterRequest<'a> {
    pub pool: &'a sqlx::SqlitePool,
    pub upload_id: &'a [u8],
    pub filter_json: Option<&'a String>,
    pub year_tick_year: Option<i32>,
    pub country_tick_country: Option<&'a String>,
    pub aliases: TableAliases<'a>,
    pub tick_visibility: &'a TickVisibility,
}

impl<'a> FilterRequest<'a> {
    pub async fn build(self) -> Result<FilterSql, ApiError> {
        let mut params: Vec<String> = Vec::new();
        let mut clauses: Vec<String> = Vec::new();
        let resolver = ColumnResolver::new(self.aliases);

        if let Some(filter_json) = self.filter_json {
            let filter: FilterGroup = filter_json.try_into()?;
            if let Some(sql) = filter.to_sql(&resolver, &mut params) {
                clauses.push(sql);
            }
        }

        if self.year_tick_year.is_some() || self.country_tick_country.is_some() {
            if let Some(bitmap_clause) = build_bitmap_clause(
                self.pool,
                self.upload_id,
                self.year_tick_year,
                self.country_tick_country,
                self.aliases.sightings,
                &mut params,
            )
            .await?
            {
                clauses.push(bitmap_clause);
            }
        }

        if let Some(tick_clause) = self.tick_visibility.to_sql_clause(self.aliases.sightings) {
            clauses.push(tick_clause);
        }

        let filter_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!(" AND {}", clauses.join(" AND "))
        };

        Ok(FilterSql::new(filter_clause, params))
    }
}

async fn load_bitmap_or_fail(
    pool: &sqlx::SqlitePool,
    upload_id_blob: &[u8],
    bitmap_type: &str,
    bitmap_key: Option<&str>,
    context: &'static str,
    missing_label: &str,
) -> Result<RoaringBitmap, ApiError> {
    let bitmap = bitmaps::load_bitmap(pool, upload_id_blob, bitmap_type, bitmap_key)
        .await
        .map_err(|e| e.into_api_error(context, "Database error"))?
        .ok_or_else(|| {
            ApiError::with_code(
                axum::http::StatusCode::NOT_FOUND,
                format!("Missing tick bitmap {}", missing_label),
                "MISSING_BITMAP",
            )
        })?;
    Ok(bitmap)
}

fn merge_bitmap(target: &mut Option<RoaringBitmap>, bitmap: RoaringBitmap) {
    match target {
        Some(existing) => {
            *existing &= bitmap;
        }
        None => {
            *target = Some(bitmap);
        }
    }
}

fn bitmap_to_clause(
    bitmap: &RoaringBitmap,
    sightings_alias: Option<&str>,
    params: &mut Vec<String>,
) -> Result<String, ApiError> {
    if bitmap.is_empty() {
        return Ok("0 = 1".to_string());
    }

    let bitmap_len = bitmap.len();
    if bitmap_len >= SQLITE_SAFE_PARAM_LIMIT {
        return Err(ApiError::internal(
            "Tick bitmap exceeds SQLite bind parameter limit",
        ));
    }

    let prefix = sightings_alias.map(|p| format!("{p}.")).unwrap_or_default();
    let mut placeholders = Vec::with_capacity(bitmap_len as usize);
    for id in bitmap.iter() {
        placeholders.push("?".to_string());
        params.push(id.to_string());
    }

    Ok(format!("{}id IN ({})", prefix, placeholders.join(", ")))
}

async fn build_bitmap_clause(
    pool: &sqlx::SqlitePool,
    upload_id_blob: &[u8],
    year_tick_year: Option<i32>,
    country_tick_country: Option<&String>,
    sightings_alias: Option<&str>,
    params: &mut Vec<String>,
) -> Result<Option<String>, ApiError> {
    let mut final_bitmap: Option<RoaringBitmap> = None;

    if let Some(year) = year_tick_year {
        let year_key = year.to_string();
        let bitmap = load_bitmap_or_fail(
            pool,
            upload_id_blob,
            "year_tick",
            Some(&year_key),
            "loading year tick bitmap",
            &format!("year_tick:{year_key}"),
        )
        .await?;
        merge_bitmap(&mut final_bitmap, bitmap);
    }

    if let Some(country) = country_tick_country {
        let bitmap = load_bitmap_or_fail(
            pool,
            upload_id_blob,
            "country_tick",
            Some(country),
            "loading country tick bitmap",
            &format!("country_tick:{country}"),
        )
        .await?;
        merge_bitmap(&mut final_bitmap, bitmap);
    }

    if let Some(bitmap) = final_bitmap {
        let clause = bitmap_to_clause(&bitmap, sightings_alias, params)?;
        Ok(Some(clause))
    } else {
        Ok(None)
    }
}

struct FieldColumnInfo {
    column: &'static str,
    needs_join: bool,
}

pub async fn get_distinct_values(
    pool: &sqlx::SqlitePool,
    upload_id: &[u8],
    field: &str,
) -> Result<Vec<String>, DbQueryError> {
    let field_info = match field {
        "common_name" => FieldColumnInfo {
            column: "sp.common_name",
            needs_join: true,
        },
        "scientific_name" => FieldColumnInfo {
            column: "sp.scientific_name",
            needs_join: true,
        },
        "country_code" => FieldColumnInfo {
            column: "s.country_code",
            needs_join: false,
        },
        "count" => FieldColumnInfo {
            column: "s.count",
            needs_join: false,
        },
        "observed_at" => FieldColumnInfo {
            column: "s.observed_at",
            needs_join: false,
        },
        "year" => FieldColumnInfo {
            column: "s.year",
            needs_join: false,
        },
        _ => return Ok(vec![]),
    };

    #[derive(sqlx::FromRow)]
    struct ValueRow {
        value: String,
    }

    let query = if field_info.needs_join {
        format!(
            "SELECT DISTINCT CAST({} AS TEXT) as value FROM sightings s JOIN species sp ON s.species_id = sp.id WHERE s.upload_id = ? AND {} IS NOT NULL ORDER BY {} LIMIT {}",
            field_info.column, field_info.column, field_info.column, MAX_DISTINCT_FIELD_VALUES
        )
    } else {
        format!(
            "SELECT DISTINCT CAST({} AS TEXT) as value FROM sightings s WHERE s.upload_id = ? AND {} IS NOT NULL ORDER BY {} LIMIT {}",
            field_info.column, field_info.column, field_info.column, MAX_DISTINCT_FIELD_VALUES
        )
    };

    let rows: Vec<ValueRow> =
        db::query_with_timeout(sqlx::query_as(&query).bind(upload_id).fetch_all(pool)).await?;

    Ok(rows.into_iter().map(|row| row.value).collect())
}
