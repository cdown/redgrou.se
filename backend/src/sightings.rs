use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::filter::FilterGroup;

const ALLOWED_SORT_FIELDS: &[&str] = &[
    "common_name",
    "scientific_name",
    "count",
    "country_code",
    "observed_at",
    "trip_name",
];

fn is_allowed_sort_field(field: &str) -> bool {
    ALLOWED_SORT_FIELDS.contains(&field)
}

#[derive(Debug, Deserialize)]
pub struct SightingsQuery {
    filter: Option<String>,
    sort_field: Option<String>,
    sort_dir: Option<String>,
    page: Option<u32>,
    page_size: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct Sighting {
    pub id: i64,
    pub common_name: String,
    pub scientific_name: Option<String>,
    pub count: Option<i64>,
    pub latitude: f64,
    pub longitude: f64,
    pub country_code: Option<String>,
    pub observed_at: String,
    pub notes: Option<String>,
    pub trip_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SightingsResponse {
    pub sightings: Vec<Sighting>,
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
    pub total_pages: u32,
}

pub async fn get_sightings(
    State(pool): State<SqlitePool>,
    Path(upload_id): Path<String>,
    Query(query): Query<SightingsQuery>,
) -> Result<Json<SightingsResponse>, StatusCode> {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(100).min(500);
    let offset = (page - 1) * page_size;

    let sort_field = query
        .sort_field
        .filter(|f| is_allowed_sort_field(f))
        .unwrap_or_else(|| "observed_at".to_string());

    let sort_dir = match query.sort_dir.as_deref() {
        Some("asc") => "ASC",
        _ => "DESC",
    };

    let mut params: Vec<String> = vec![upload_id.clone()];

    let filter_clause = if let Some(filter_json) = &query.filter {
        match serde_json::from_str::<FilterGroup>(filter_json) {
            Ok(filter) => filter
                .to_sql(&mut params)
                .map(|sql| format!(" AND {}", sql)),
            Err(_) => None,
        }
    } else {
        None
    };

    let count_sql = format!(
        "SELECT COUNT(*) FROM sightings WHERE upload_id = ?{}",
        filter_clause.as_deref().unwrap_or("")
    );

    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    for param in &params {
        count_query = count_query.bind(param);
    }

    let total = count_query
        .fetch_one(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let select_sql = format!(
        r#"SELECT id, common_name, scientific_name, count, latitude, longitude,
           country_code, observed_at, notes, trip_name
           FROM sightings
           WHERE upload_id = ?{}
           ORDER BY {} {}
           LIMIT ? OFFSET ?"#,
        filter_clause.as_deref().unwrap_or(""),
        sort_field,
        sort_dir
    );

    params.push(page_size.to_string());
    params.push(offset.to_string());

    let mut select_query = sqlx::query_as::<
        _,
        (
            i64,
            String,
            Option<String>,
            Option<i64>,
            f64,
            f64,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
        ),
    >(&select_sql);

    for param in &params {
        select_query = select_query.bind(param);
    }

    let rows = select_query
        .fetch_all(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let sightings: Vec<Sighting> = rows
        .into_iter()
        .map(|row| Sighting {
            id: row.0,
            common_name: row.1,
            scientific_name: row.2,
            count: row.3,
            latitude: row.4,
            longitude: row.5,
            country_code: row.6,
            observed_at: row.7,
            notes: row.8,
            trip_name: row.9,
        })
        .collect();

    let total_pages = ((total as f64) / (page_size as f64)).ceil() as u32;

    Ok(Json(SightingsResponse {
        sightings,
        total,
        page,
        page_size,
        total_pages,
    }))
}
