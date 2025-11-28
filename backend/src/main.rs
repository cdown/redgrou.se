mod db;
mod filter;
mod tiles;
mod upload;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use sqlx::SqlitePool;
use std::env;
use std::net::SocketAddr;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

use filter::{get_distinct_values, get_field_metadata, FieldMetadata, FieldValues};

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
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/upload", post(upload::upload_csv))
        .route("/api/uploads/{upload_id}", get(get_upload))
        .route("/api/tiles/{upload_id}/{z}/{x}/{y}", get(tiles::get_tile))
        .route("/api/fields", get(fields_metadata))
        .route("/api/fields/{upload_id}/{field}", get(field_values))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(pool);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3001));
    info!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn health_check() -> &'static str {
    "OK"
}

#[derive(Serialize)]
struct UploadMetadata {
    upload_id: String,
    filename: String,
    row_count: i64,
}

async fn get_upload(
    State(pool): State<SqlitePool>,
    Path(upload_id): Path<String>,
) -> Result<Json<UploadMetadata>, StatusCode> {
    let row = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT id, filename, row_count FROM uploads WHERE id = ?",
    )
    .bind(&upload_id)
    .fetch_optional(&pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;

    Ok(Json(UploadMetadata {
        upload_id: row.0,
        filename: row.1,
        row_count: row.2,
    }))
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
