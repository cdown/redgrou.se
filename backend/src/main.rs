use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::env;
use std::net::SocketAddr;
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;
use ts_rs::TS;

use redgrouse::api_constants;
use redgrouse::error::ApiError;
use redgrouse::filter::{
    get_distinct_values, get_field_metadata, FieldMetadata, FieldValues, FilterGroup,
};
use redgrouse::{db, sightings, tiles, upload};

const BUILD_VERSION: &str = env!("BUILD_VERSION");

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("redgrouse=debug".parse()?))
        .init();

    info!("Starting redgrou.se backend");

    let database_url =
        env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:redgrouse.db".to_string());

    let pool = db::init_pool(&database_url).await?;
    db::run_migrations(&pool).await?;

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([header::HeaderName::from_static("x-build-version")]);

    let build_version_header = SetResponseHeaderLayer::if_not_present(
        header::HeaderName::from_static("x-build-version"),
        HeaderValue::from_static(BUILD_VERSION),
    );

    let app = Router::new()
        .route(api_constants::HEALTH_ROUTE, get(health_check))
        .route(
            api_constants::UPLOAD_ROUTE,
            post(upload::upload_csv)
                .layer(RequestBodyLimitLayer::new(upload::MAX_UPLOAD_BODY_BYTES)),
        )
        .route(
            api_constants::UPLOAD_DETAILS_ROUTE,
            get(get_upload)
                .put(upload::update_csv)
                .delete(upload::delete_upload)
                .layer(RequestBodyLimitLayer::new(upload::MAX_UPLOAD_BODY_BYTES)),
        )
        .route(api_constants::UPLOAD_COUNT_ROUTE, get(get_filtered_count))
        .route(
            api_constants::UPLOAD_SIGHTINGS_ROUTE,
            get(sightings::get_sightings),
        )
        .route(api_constants::TILE_ROUTE, get(tiles::get_tile))
        .route(api_constants::FIELDS_ROUTE, get(fields_metadata))
        .route(api_constants::FIELD_VALUES_ROUTE, get(field_values))
        .layer(build_version_header)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(pool);

    let port = env::var("PORT")
        .or_else(|_| env::var("REDGROUSE_BACKEND_PORT"))
        .unwrap_or_else(|_| "3001".to_string())
        .parse::<u16>()
        .map_err(|e| anyhow::anyhow!("Invalid port: {}", e))?;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn health_check() -> &'static str {
    "OK"
}

#[derive(Serialize, TS)]
#[ts(export)]
struct UploadMetadata {
    upload_id: String,
    filename: String,
    row_count: i64,
}

async fn get_upload(
    State(pool): State<SqlitePool>,
    Path(upload_id): Path<String>,
) -> Result<Json<UploadMetadata>, ApiError> {
    let row = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT id, filename, row_count FROM uploads WHERE id = ?",
    )
    .bind(&upload_id)
    .fetch_optional(&pool)
    .await
    .map_err(|_| ApiError::internal("Database error"))?
    .ok_or_else(|| ApiError::not_found("Upload not found"))?;

    Ok(Json(UploadMetadata {
        upload_id: row.0,
        filename: row.1,
        row_count: row.2,
    }))
}

#[derive(Debug, Deserialize)]
struct CountQuery {
    filter: Option<String>,
    lifers_only: Option<bool>,
    year_tick_year: Option<i32>,
}

#[derive(Serialize, TS)]
#[ts(export)]
struct CountResponse {
    count: i64,
}

async fn get_filtered_count(
    State(pool): State<SqlitePool>,
    Path(upload_id): Path<String>,
    Query(query): Query<CountQuery>,
) -> Result<Json<CountResponse>, ApiError> {
    let mut params: Vec<String> = vec![upload_id];

    let mut filter_clause = if let Some(filter_json) = &query.filter {
        let filter: FilterGroup = serde_json::from_str(filter_json)
            .map_err(|_| ApiError::bad_request("Invalid filter JSON"))?;
        filter
            .validate()
            .map_err(|e| ApiError::bad_request(e.message()))?;
        filter
            .to_sql(&mut params)
            .map(|sql| format!(" AND {}", sql))
    } else {
        None
    };

    // Add lifers_only filter if requested
    if query.lifers_only == Some(true) {
        let lifer_clause = " AND lifer = 1".to_string();
        filter_clause = Some(match filter_clause {
            Some(existing) => format!("{}{}", existing, lifer_clause),
            None => lifer_clause,
        });
    }

    // Add year_tick filter if requested
    if let Some(year) = query.year_tick_year {
        params.push(year.to_string());
        let year_tick_clause = " AND year_tick = 1 AND year = ?".to_string();
        filter_clause = Some(match filter_clause {
            Some(existing) => format!("{}{}", existing, year_tick_clause),
            None => year_tick_clause,
        });
    }

    let sql = format!(
        "SELECT COUNT(*) as cnt FROM sightings WHERE upload_id = ?{}",
        filter_clause.unwrap_or_default()
    );

    let mut db_query = sqlx::query_scalar::<_, i64>(&sql);
    for param in &params {
        db_query = db_query.bind(param);
    }

    let count = db_query
        .fetch_one(&pool)
        .await
        .map_err(|_| ApiError::internal("Database error"))?;

    Ok(Json(CountResponse { count }))
}

async fn fields_metadata() -> Json<Vec<FieldMetadata>> {
    Json(get_field_metadata())
}

async fn field_values(
    State(pool): State<SqlitePool>,
    Path((upload_id, field)): Path<(String, String)>,
) -> Json<FieldValues> {
    let values = get_distinct_values(&pool, &upload_id, &field)
        .await
        .unwrap_or_default();

    Json(FieldValues { field, values })
}
