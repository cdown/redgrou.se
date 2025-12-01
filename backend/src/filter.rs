use crate::db::{self, DbQueryError};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum Combinator {
    And,
    Or,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(untagged)]
pub enum FilterValue {
    String(String),
    Number(f64),
    List(Vec<String>),
}

/// Type-safe representation of filterable field names.
/// This enum ensures only valid fields can be used in filters,
/// preventing SQL injection via field names at compile time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../frontend/src/lib/generated/")]
pub enum FilterField {
    CommonName,
    ScientificName,
    CountryCode,
    Count,
    ObservedAt,
    Year,
}

impl FilterField {
    /// Returns the SQL column name for this field.
    pub fn as_sql_column(&self) -> &'static str {
        match self {
            FilterField::CommonName => "common_name",
            FilterField::ScientificName => "scientific_name",
            FilterField::CountryCode => "country_code",
            FilterField::Count => "count",
            FilterField::ObservedAt => "observed_at",
            FilterField::Year => "year",
        }
    }

    /// Returns the string representation used in the API.
    pub fn as_str(&self) -> &'static str {
        self.as_sql_column()
    }
}

// Serialization/deserialization is handled by serde's rename attributes above
// The enum will serialize as the snake_case string values

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Condition {
    pub field: FilterField,
    pub operator: Operator,
    pub value: FilterValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(untagged)]
pub enum Rule {
    Condition(Condition),
    Group(FilterGroup),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FilterGroup {
    pub combinator: Combinator,
    pub rules: Vec<Rule>,
}

const MAX_FILTER_DEPTH: usize = 5;
const MAX_FILTER_RULES: usize = 100;
const MAX_LIST_VALUES: usize = 50;

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
            Rule::Condition(c) => c.to_sql(params),
            Rule::Group(g) => g.to_sql(params),
        }
    }
}

impl Condition {
    fn validate(&self) -> Result<(), FilterValidationError> {
        match &self.value {
            FilterValue::List(values) if values.len() > MAX_LIST_VALUES => {
                Err(FilterValidationError::new(format!(
                    "Lists are limited to {} values",
                    MAX_LIST_VALUES
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
                Some(format!("{} = ?", field))
            }
            (Operator::Eq, FilterValue::Number(v)) => {
                params.push(v.to_string());
                Some(format!("{} = ?", field))
            }
            (Operator::Neq, FilterValue::String(v)) => {
                params.push(v.clone());
                Some(format!("{} != ?", field))
            }
            (Operator::Neq, FilterValue::Number(v)) => {
                params.push(v.to_string());
                Some(format!("{} != ?", field))
            }
            (Operator::Contains, FilterValue::String(v)) => {
                params.push(format!("%{}%", v));
                Some(format!("{} LIKE ?", field))
            }
            (Operator::StartsWith, FilterValue::String(v)) => {
                params.push(format!("{}%", v));
                Some(format!("{} LIKE ?", field))
            }
            (Operator::EndsWith, FilterValue::String(v)) => {
                params.push(format!("%{}", v));
                Some(format!("{} LIKE ?", field))
            }
            (Operator::Gte, FilterValue::Number(v)) => {
                params.push(v.to_string());
                Some(format!("{} >= ?", field))
            }
            (Operator::Gte, FilterValue::String(v)) => {
                params.push(v.clone());
                Some(format!("{} >= ?", field))
            }
            (Operator::Lte, FilterValue::Number(v)) => {
                params.push(v.to_string());
                Some(format!("{} <= ?", field))
            }
            (Operator::Lte, FilterValue::String(v)) => {
                params.push(v.clone());
                Some(format!("{} <= ?", field))
            }
            (Operator::In, FilterValue::List(vals)) if !vals.is_empty() => {
                let placeholders: Vec<&str> = vals.iter().map(|_| "?").collect();
                params.extend(vals.clone());
                // Note: year_tick is not a FilterField, so this special case
                // is handled elsewhere (in the year_tick_year query parameter)
                Some(format!("{} IN ({})", field, placeholders.join(", ")))
            }
            (Operator::NotIn, FilterValue::List(vals)) if !vals.is_empty() => {
                let placeholders: Vec<&str> = vals.iter().map(|_| "?").collect();
                params.extend(vals.clone());
                Some(format!("{} NOT IN ({})", field, placeholders.join(", ")))
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
            "Filters exceed maximum depth of {}",
            MAX_FILTER_DEPTH
        )));
    }

    for rule in &group.rules {
        match rule {
            Rule::Condition(condition) => {
                stats.rules += 1;
                if stats.rules > MAX_FILTER_RULES {
                    return Err(FilterValidationError::new(format!(
                        "Filters exceed maximum of {} conditions",
                        MAX_FILTER_RULES
                    )));
                }
                condition.validate()?;
            }
            Rule::Group(child) => validate_group(child, depth + 1, stats)?,
        }
    }

    Ok(())
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
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

#[derive(Debug, Serialize)]
pub struct FieldValues {
    pub field: String,
    pub values: Vec<String>,
}

pub async fn get_distinct_values(
    pool: &SqlitePool,
    upload_id: &str,
    field: &str,
) -> Result<Vec<String>, DbQueryError> {
    // Parse and validate the field string into a FilterField enum
    let filter_field = match field {
        "common_name" => FilterField::CommonName,
        "scientific_name" => FilterField::ScientificName,
        "country_code" => FilterField::CountryCode,
        "count" => FilterField::Count,
        "observed_at" => FilterField::ObservedAt,
        "year" => FilterField::Year,
        _ => return Ok(vec![]), // Invalid field, return empty
    };

    let column = filter_field.as_sql_column();
    let query = format!(
        "SELECT DISTINCT CAST({} AS TEXT) FROM sightings WHERE upload_id = ? AND {} IS NOT NULL ORDER BY {} LIMIT 500",
        column, column, column
    );

    let rows: Vec<(String,)> =
        db::query_with_timeout(sqlx::query_as(&query).bind(upload_id).fetch_all(pool)).await?;

    Ok(rows.into_iter().map(|(v,)| v).collect())
}
