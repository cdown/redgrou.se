use axum::body::Body;
use axum::error_handling::HandleErrorLayer;
use axum::extract::{ConnectInfo, Extension, Path, Query, State};
use axum::http::{header, HeaderValue, Request};
use axum::middleware::{from_fn, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{BoxError, Json, Router};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::env;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tower::limit::ConcurrencyLimitLayer;
use tower::timeout::error::Elapsed;
use tower::ServiceBuilder;
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;
use tower_http::{catch_panic::CatchPanicLayer, timeout::RequestBodyTimeoutLayer};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use ts_rs::TS;

use redgrouse::api_constants;
use redgrouse::error::ApiError;
use redgrouse::filter::{
    get_distinct_values, get_field_metadata, FieldMetadata, FieldValues, FilterGroup,
};
use redgrouse::{db, sightings, tiles, upload};

const BUILD_VERSION: &str = env!("BUILD_VERSION");

/// Maximum time any request can take before being terminated.
/// Applies to: All routes (tiles, sightings, uploads, metadata).
/// Heavy user estimate: N/A - this is a safety timeout, not a throughput limit.
const GLOBAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Maximum concurrent requests being processed server-wide.
/// Applies to: All in-flight requests across all IPs combined.
/// Does NOT limit: Per-IP request rate (see GLOBAL_RATE_LIMIT_PER_MINUTE).
/// Heavy user estimate: A single user doing rapid zoom/pan might have 20-50
/// concurrent tile requests in flight. With 100 limit, ~2-5 heavy users can
/// saturate this before requests start queueing.
const GLOBAL_CONCURRENCY_LIMIT: usize = 100;

/// Maximum requests per IP address per minute.
/// Applies to: All requests from a single IP (identified via CloudFront headers
/// in production, or peer address locally).
/// Does NOT limit: Server-wide throughput (see GLOBAL_CONCURRENCY_LIMIT).
/// Heavy user estimate: Rapid map zoom/pan generates ~24 tiles per zoom level.
/// Scrollwheel zooming through 10 levels in a few seconds = 240 tiles. Heavy
/// use with panning = ~1000-2000 tiles/minute. 20000 provides 10-20x headroom.
const GLOBAL_RATE_LIMIT_PER_MINUTE: u64 = 20000;

/// Maximum concurrent CSV upload/update operations.
/// Applies to: POST /upload and PUT /single/{id} routes only.
/// Does NOT limit: Read operations (tiles, sightings, metadata).
/// Heavy user estimate: Uploads are rare - typically 1 per session. This limit
/// prevents a single user from monopolizing DB write capacity with parallel
/// uploads of large CSVs.
const UPLOAD_CONCURRENCY_LIMIT: usize = 2;

/// Maximum time to receive the full request body for uploads.
/// Applies to: POST /upload and PUT /single/{id} routes only.
/// Heavy user estimate: A 200MB CSV over a slow connection might take 30-60s.
const UPLOAD_BODY_TIMEOUT: Duration = Duration::from_secs(60);

/// Window duration for per-IP rate limiting (used with GLOBAL_RATE_LIMIT_PER_MINUTE).
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);
const CLOUDFRONT_IP_RANGES_URL: &str = "https://ip-ranges.amazonaws.com/ip-ranges.json";

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

    let ingest_layer = ServiceBuilder::new()
        .layer(RequestBodyLimitLayer::new(upload::MAX_UPLOAD_BODY_BYTES))
        .layer(RequestBodyTimeoutLayer::new(UPLOAD_BODY_TIMEOUT))
        .layer(ConcurrencyLimitLayer::new(UPLOAD_CONCURRENCY_LIMIT))
        .into_inner();

    let ingest_routes = Router::new()
        .route(api_constants::UPLOAD_ROUTE, post(upload::upload_csv))
        .route(api_constants::UPLOAD_DETAILS_ROUTE, put(upload::update_csv))
        .route_layer(ingest_layer);

    let rate_limiter = RequestRateLimiter::new(GLOBAL_RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW);
    let trusted_proxies = match fetch_cloudfront_proxies().await {
        Ok(networks) => {
            info!("Loaded {} CloudFront proxy ranges", networks.len());
            TrustedProxyList::new(networks)
        }
        Err(err) => {
            warn!(
                "Failed to load CloudFront ranges ({}); defaulting to no trusted proxies",
                err
            );
            TrustedProxyList::new(Vec::new())
        }
    };

    let app = Router::new()
        .route(api_constants::HEALTH_ROUTE, get(health_check))
        .route(
            api_constants::UPLOAD_DETAILS_ROUTE,
            get(get_upload).delete(upload::delete_upload),
        )
        .route(api_constants::UPLOAD_COUNT_ROUTE, get(get_filtered_count))
        .route(
            api_constants::UPLOAD_SIGHTINGS_ROUTE,
            get(sightings::get_sightings),
        )
        .route(api_constants::TILE_ROUTE, get(tiles::get_tile))
        .route(api_constants::FIELDS_ROUTE, get(fields_metadata))
        .route(api_constants::FIELD_VALUES_ROUTE, get(field_values))
        .merge(ingest_routes)
        .layer(from_fn(enforce_rate_limit))
        .layer(Extension(rate_limiter))
        .layer(Extension(trusted_proxies.clone()))
        .layer(build_version_header)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(CatchPanicLayer::new())
        .layer(
            ServiceBuilder::new()
                .layer(HandleErrorLayer::new(handle_layer_error))
                .timeout(GLOBAL_REQUEST_TIMEOUT)
                .into_inner(),
        )
        .layer(ConcurrencyLimitLayer::new(GLOBAL_CONCURRENCY_LIMIT))
        .with_state(pool);

    let port = env::var("PORT")
        .or_else(|_| env::var("REDGROUSE_BACKEND_PORT"))
        .unwrap_or_else(|_| "3001".to_string())
        .parse::<u16>()
        .map_err(|e| anyhow::anyhow!("Invalid port: {}", e))?;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

async fn health_check() -> &'static str {
    "OK"
}

async fn handle_layer_error(err: BoxError) -> ApiError {
    if err.is::<Elapsed>() {
        ApiError::service_unavailable("Request timed out")
    } else {
        ApiError::internal("Request failed")
    }
}

#[derive(Clone)]
struct TrustedProxyList {
    networks: Arc<Vec<IpNet>>,
}

impl TrustedProxyList {
    fn new(networks: Vec<IpNet>) -> Self {
        Self {
            networks: Arc::new(networks),
        }
    }

    fn contains(&self, addr: &SocketAddr) -> bool {
        let ip = addr.ip();
        self.networks.iter().any(|net| net.contains(&ip))
    }
}

#[derive(Clone)]
struct RequestRateLimiter {
    limit: u64,
    window: Duration,
    buckets: Arc<Mutex<HashMap<String, RateWindow>>>,
}

struct RateWindow {
    start: Instant,
    count: u64,
}

impl RequestRateLimiter {
    fn new(limit: u64, window: Duration) -> Self {
        Self {
            limit,
            window,
            buckets: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn try_acquire(&self, key: &str) -> bool {
        let mut buckets = self.buckets.lock().await;
        let state = buckets.entry(key.to_string()).or_insert(RateWindow {
            start: Instant::now(),
            count: 0,
        });
        let now = Instant::now();
        if now.duration_since(state.start) >= self.window {
            state.start = now;
            state.count = 0;
        }

        if state.count < self.limit {
            state.count += 1;
            true
        } else {
            false
        }
    }
}

async fn enforce_rate_limit(
    Extension(limiter): Extension<RequestRateLimiter>,
    Extension(trusted): Extension<TrustedProxyList>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let client_key = extract_client_addr(&req, peer_addr, &trusted);
    if limiter.try_acquire(&client_key).await {
        next.run(req).await
    } else {
        ApiError::service_unavailable("Too many requests").into_response()
    }
}

fn extract_client_addr<B>(
    req: &Request<B>,
    peer_addr: SocketAddr,
    trusted: &TrustedProxyList,
) -> String {
    if trusted.contains(&peer_addr) {
        if let Some(viewer) = req
            .headers()
            .get("cloudfront-viewer-address")
            .and_then(|v| v.to_str().ok())
        {
            if let Some(ip) = viewer.split(':').next() {
                return ip.trim().to_string();
            }
        }

        if let Some(ip) = req
            .headers()
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
        {
            return ip.trim().to_string();
        }

        if let Some(forwarded) = req
            .headers()
            .get(header::FORWARDED)
            .and_then(|v| v.to_str().ok())
        {
            for part in forwarded.split(';') {
                if let Some(value) = part
                    .trim()
                    .strip_prefix("for=")
                    .map(|s| s.trim_matches('"').to_string())
                {
                    return value;
                }
            }
            return forwarded.trim().to_string();
        }

        if let Some(xff) = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
        {
            if let Some(ip) = xff.split(',').next() {
                return ip.trim().to_string();
            }
        }
    }

    peer_addr.ip().to_string()
}

#[derive(Deserialize)]
struct AwsIpRanges {
    #[serde(default)]
    prefixes: Vec<AwsPrefix>,
    #[serde(default)]
    ipv6_prefixes: Vec<AwsIpv6Prefix>,
}

#[derive(Deserialize)]
struct AwsPrefix {
    #[serde(default)]
    ip_prefix: Option<String>,
    #[serde(default)]
    service: Option<String>,
}

#[derive(Deserialize)]
struct AwsIpv6Prefix {
    #[serde(default)]
    ipv6_prefix: Option<String>,
    #[serde(default)]
    service: Option<String>,
}

async fn fetch_cloudfront_proxies() -> anyhow::Result<Vec<IpNet>> {
    let resp: AwsIpRanges = reqwest::get(CLOUDFRONT_IP_RANGES_URL).await?.json().await?;
    let mut networks = Vec::new();

    for entry in resp
        .prefixes
        .into_iter()
        .filter(|p| matches!(p.service.as_deref(), Some("CLOUDFRONT")) && p.ip_prefix.is_some())
    {
        if let Some(cidr) = entry.ip_prefix {
            if let Ok(net) = cidr.parse::<IpNet>() {
                networks.push(net);
            }
        }
    }

    for entry in resp
        .ipv6_prefixes
        .into_iter()
        .filter(|p| matches!(p.service.as_deref(), Some("CLOUDFRONT")) && p.ipv6_prefix.is_some())
    {
        if let Some(cidr) = entry.ipv6_prefix {
            if let Ok(net) = cidr.parse::<IpNet>() {
                networks.push(net);
            }
        }
    }

    Ok(networks)
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
    let row = db::query_with_timeout(
        sqlx::query_as::<_, (String, String, i64)>(
            "SELECT id, filename, row_count FROM uploads WHERE id = ?",
        )
        .bind(&upload_id)
        .fetch_optional(&pool),
    )
    .await
    .map_err(|e| e.into_api_error("loading upload metadata", "Database error"))?
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

    let count = db::query_with_timeout(db_query.fetch_one(&pool))
        .await
        .map_err(|e| e.into_api_error("counting sightings", "Database error"))?;

    Ok(Json(CountResponse { count }))
}

async fn fields_metadata() -> Json<Vec<FieldMetadata>> {
    Json(get_field_metadata())
}

async fn field_values(
    State(pool): State<SqlitePool>,
    Path((upload_id, field)): Path<(String, String)>,
) -> Result<Json<FieldValues>, ApiError> {
    let values = get_distinct_values(&pool, &upload_id, &field)
        .await
        .map_err(|e| e.into_api_error("loading field values", "Database error"))?;

    Ok(Json(FieldValues { field, values }))
}
