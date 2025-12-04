use crate::db::{self, DbQueryError};
use crate::error::ApiError;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
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

impl FilterGroup {
    pub fn validate(&self) -> Result<(), FilterValidationError> {
        let mut stats = FilterStats::default();
        validate_group(self, 1, &mut stats)
    }

    pub fn to_sql(&self, params: &mut Vec<String>) -> Option<String> {
        if self.rules.is_empty() {
            return None;
        }

        let clauses: Vec<String> = self
            .rules
            .iter()
            .filter_map(|rule| rule.to_sql(params))
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
    fn to_sql(&self, params: &mut Vec<String>) -> Option<String> {
        match self {
            Self::Condition(c) => c.to_sql(params),
            Self::Group(g) => g.to_sql(params),
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

    fn to_sql(&self, params: &mut Vec<String>) -> Option<String> {
        let field = self.field.as_sql_column();

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

pub struct TickFilters {
    pub clauses: Vec<String>,
    pub params: Vec<String>,
}

impl TickFilters {
    pub fn new() -> Self {
        Self {
            clauses: Vec::new(),
            params: Vec::new(),
        }
    }

    pub fn add_lifers_only(&mut self, table_prefix: Option<&str>) {
        let prefix = table_prefix.map(|p| format!("{p}.")).unwrap_or_default();
        self.clauses.push(format!("AND {prefix}lifer = 1"));
    }

    pub fn add_year_tick(&mut self, year: i32, table_prefix: Option<&str>) {
        let prefix = table_prefix.map(|p| format!("{p}.")).unwrap_or_default();
        self.params.push(year.to_string());
        self.clauses
            .push(format!("AND {prefix}year_tick = 1 AND {prefix}year = ?"));
    }

    pub fn add_country_tick(&mut self, country: &str, table_prefix: Option<&str>) {
        let prefix = table_prefix.map(|p| format!("{p}.")).unwrap_or_default();
        self.params.push(country.to_string());
        self.clauses.push(format!(
            "AND {prefix}country_tick = 1 AND {prefix}country_code = ?"
        ));
    }

    pub fn into_parts(self) -> (Vec<String>, Vec<String>) {
        (self.clauses, self.params)
    }
}

impl Default for TickFilters {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Deserialize)]
pub struct CountQuery {
    pub filter: Option<String>,
    pub lifers_only: Option<bool>,
    pub year_tick_year: Option<i32>,
    pub country_tick_country: Option<String>,
}

/// Builds filter SQL clause and parameters from query options.
/// Returns (filter_clause, params) where filter_clause is a string like " AND (...)" or empty string.
pub fn build_filter_clause(
    filter_json: Option<&String>,
    lifers_only: Option<bool>,
    year_tick_year: Option<i32>,
    country_tick_country: Option<&String>,
    table_prefix: Option<&str>,
) -> Result<(String, Vec<String>), ApiError> {
    let mut params: Vec<String> = Vec::new();

    let mut filter_clause = if let Some(filter_json) = filter_json {
        let filter: FilterGroup = filter_json.try_into()?;
        filter.to_sql(&mut params).map(|sql| format!(" AND {sql}"))
    } else {
        None
    };

    let mut tick_filters = TickFilters::new();
    if lifers_only == Some(true) {
        tick_filters.add_lifers_only(table_prefix);
    }
    if let Some(year) = year_tick_year {
        tick_filters.add_year_tick(year, table_prefix);
    }
    if let Some(country) = country_tick_country {
        tick_filters.add_country_tick(country, table_prefix);
    }
    let (clauses, tick_params) = tick_filters.into_parts();
    params.extend(tick_params);
    if !clauses.is_empty() {
        let clause_str = format!(" {}", clauses.join(" "));
        filter_clause = Some(match filter_clause {
            Some(existing) => format!("{existing}{clause_str}"),
            None => clause_str.trim_start_matches(" ").to_string(),
        });
    }

    Ok((filter_clause.unwrap_or_default(), params))
}

pub async fn get_distinct_values(
    pool: &SqlitePool,
    upload_id: &[u8],
    field: &str,
) -> Result<Vec<String>, DbQueryError> {
    let (column, needs_join) = match field {
        "common_name" => ("sp.common_name", true),
        "scientific_name" => ("sp.scientific_name", true),
        "country_code" => ("s.country_code", true),
        "count" => ("s.count", false),
        "observed_at" => ("s.observed_at", false),
        "year" => ("s.year", false),
        _ => return Ok(vec![]),
    };

    let query = if needs_join {
        format!(
            "SELECT DISTINCT CAST({column} AS TEXT) FROM sightings s JOIN species sp ON s.species_id = sp.id WHERE s.upload_id = ? AND {column} IS NOT NULL ORDER BY {column} LIMIT {}",
            MAX_DISTINCT_FIELD_VALUES
        )
    } else {
        format!(
            "SELECT DISTINCT CAST({column} AS TEXT) FROM sightings s WHERE s.upload_id = ? AND {column} IS NOT NULL ORDER BY {column} LIMIT {}",
            MAX_DISTINCT_FIELD_VALUES
        )
    };

    let rows: Vec<(String,)> =
        db::query_with_timeout(sqlx::query_as(&query).bind(upload_id).fetch_all(pool)).await?;

    Ok(rows.into_iter().map(|(v,)| v).collect())
}
