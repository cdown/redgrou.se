use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

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
    Gt,
    Gte,
    Lt,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Condition {
    pub field: String,
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

const ALLOWED_FIELDS: &[&str] = &[
    "common_name",
    "scientific_name",
    "country_code",
    "count",
    "observed_at",
    "notes",
    "trip_name",
];

fn is_allowed_field(field: &str) -> bool {
    ALLOWED_FIELDS.contains(&field)
}

impl FilterGroup {
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
    fn to_sql(&self, params: &mut Vec<String>) -> Option<String> {
        if !is_allowed_field(&self.field) {
            return None;
        }

        let field = &self.field;

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
            (Operator::Gt, FilterValue::Number(v)) => {
                params.push(v.to_string());
                Some(format!("{} > ?", field))
            }
            (Operator::Gte, FilterValue::Number(v)) => {
                params.push(v.to_string());
                Some(format!("{} >= ?", field))
            }
            (Operator::Lt, FilterValue::Number(v)) => {
                params.push(v.to_string());
                Some(format!("{} < ?", field))
            }
            (Operator::Lte, FilterValue::Number(v)) => {
                params.push(v.to_string());
                Some(format!("{} <= ?", field))
            }
            (Operator::In, FilterValue::List(vals)) if !vals.is_empty() => {
                let placeholders: Vec<&str> = vals.iter().map(|_| "?").collect();
                params.extend(vals.clone());
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
            name: "trip_name".into(),
            label: "Trip".into(),
            field_type: "string".into(),
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
) -> Result<Vec<String>, sqlx::Error> {
    if !is_allowed_field(field) {
        return Ok(vec![]);
    }

    let query = format!(
        "SELECT DISTINCT {} FROM sightings WHERE upload_id = ? AND {} IS NOT NULL ORDER BY {} LIMIT 500",
        field, field, field
    );

    let rows: Vec<(String,)> = sqlx::query_as(&query)
        .bind(upload_id)
        .fetch_all(pool)
        .await?;

    Ok(rows.into_iter().map(|(v,)| v).collect())
}
