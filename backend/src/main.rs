mod db;
mod tiles;
mod upload;

use axum::routing::{get, post};
use axum::Router;
use std::env;
use std::net::SocketAddr;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

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
        .route("/api/tiles/{upload_id}/{z}/{x}/{y}", get(tiles::get_tile))
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
