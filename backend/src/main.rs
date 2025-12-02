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
use tower::timeout::error::Elapsed;
use tower::ServiceBuilder;
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;
use tower_http::{catch_panic::CatchPanicLayer, timeout::RequestBodyTimeoutLayer};
use tracing::{info, warn, Span};
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

/// Maximum requests per IP address per minute.
/// Applies to: All requests from a single IP (identified via CloudFront headers
/// in production, or peer address locally).
/// Does NOT limit: Server-wide throughput (see GLOBAL_CONCURRENCY_LIMIT).
/// Heavy user estimate: Rapid map zoom/pan generates ~24 tiles per zoom level.
/// Scrollwheel zooming through 10 levels in a few seconds = 240 tiles. Heavy
/// use with panning = ~1000-2000 tiles/minute. 20000 provides 10-20x headroom.
const GLOBAL_RATE_LIMIT_PER_MINUTE: u64 = 20000;

/// Maximum concurrent uploads per IP address.
/// Applies to: POST /upload and PUT /single/{id} routes only, per IP.
/// Heavy user estimate: Uploads are rare - typically 1 per session. This prevents
/// a single user from running parallel uploads that contend for DB writes.
const UPLOAD_CONCURRENCY_PER_IP: usize = 1;

/// Maximum uploads per IP address per minute.
/// Applies to: POST /upload and PUT /single/{id} routes only, per IP.
/// Heavy user estimate: Even rapid re-uploads during testing rarely exceed 3/min.
const UPLOAD_RATE_PER_IP_PER_MINUTE: u64 = 3;

/// Maximum time to receive the full request body for uploads.
/// Applies to: POST /upload and PUT /single/{id} routes only.
/// Heavy user estimate: A 200MB CSV over a slow connection might take 30-60s.
const UPLOAD_BODY_TIMEOUT: Duration = Duration::from_secs(60);

/// Window duration for per-IP rate limiting (used with GLOBAL_RATE_LIMIT_PER_MINUTE).
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);
const CLOUDFRONT_IP_RANGES_URL: &str = "https://ip-ranges.amazonaws.com/ip-ranges.json";
const CLOUDFLARE_IPV4_RANGES_URL: &str = "https://www.cloudflare.com/ips-v4";
const CLOUDFLARE_IPV6_RANGES_URL: &str = "https://www.cloudflare.com/ips-v6";

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
        .into_inner();

    let upload_limiter = UploadLimiter::new(
        UPLOAD_CONCURRENCY_PER_IP,
        UPLOAD_RATE_PER_IP_PER_MINUTE,
        RATE_LIMIT_WINDOW,
    );

    let ingest_routes = Router::new()
        .route(api_constants::UPLOAD_ROUTE, post(upload::upload_csv))
        .route(api_constants::UPLOAD_DETAILS_ROUTE, put(upload::update_csv))
        .route_layer(ingest_layer);

    let rate_limiter = RequestRateLimiter::new(GLOBAL_RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW);
    let (cloudfront_result, cloudflare_result) =
        tokio::join!(fetch_cloudfront_proxies(), fetch_cloudflare_proxies());

    let mut proxy_networks = Vec::new();

    match cloudfront_result {
        Ok(mut ranges) => {
            info!("Loaded {} CloudFront proxy ranges", ranges.len());
            proxy_networks.append(&mut ranges);
        }
        Err(err) => {
            warn!(
                "Failed to load CloudFront ranges ({}); continuing without them",
                err
            );
        }
    }

    match cloudflare_result {
        Ok(mut ranges) => {
            info!("Loaded {} Cloudflare proxy ranges", ranges.len());
            proxy_networks.append(&mut ranges);
        }
        Err(err) => {
            warn!(
                "Failed to load Cloudflare ranges ({}); continuing without them",
                err
            );
        }
    }

    if proxy_networks.is_empty() {
        warn!("No trusted proxy ranges loaded; falling back to peer addresses only");
    }

    let trusted_proxies = TrustedProxyList::new(proxy_networks);

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
        .layer(from_fn(enforce_upload_limit))
        .layer(from_fn(enforce_rate_limit))
        .layer(build_version_header)
        .layer(cors)
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(make_request_span)
                .on_request(on_request)
                .on_response(on_response),
        )
        .layer(from_fn(extract_and_log_ip))
        .layer(Extension(upload_limiter))
        .layer(Extension(rate_limiter))
        .layer(Extension(trusted_proxies.clone()))
        .layer(CatchPanicLayer::new())
        .layer(
            ServiceBuilder::new()
                .layer(HandleErrorLayer::new(handle_layer_error))
                .timeout(GLOBAL_REQUEST_TIMEOUT)
                .into_inner(),
        )
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
        let now = Instant::now();

        // Prune old entries periodically (every 1000 operations to avoid overhead)
        // Remove entries whose window has expired by more than one window duration
        if buckets.len() > 1000 {
            let prune_before = now - self.window * 2;
            buckets.retain(|_, state| state.start > prune_before);
        }

        let state = buckets.entry(key.to_string()).or_insert(RateWindow {
            start: now,
            count: 0,
        });

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

/// Per-IP upload limiter tracking both concurrency and rate.
#[derive(Clone)]
struct UploadLimiter {
    max_concurrent: usize,
    rate_limit: u64,
    window: Duration,
    state: Arc<Mutex<HashMap<String, UploadState>>>,
}

struct UploadState {
    active: usize,
    window_start: Instant,
    window_count: u64,
}

impl UploadLimiter {
    fn new(max_concurrent: usize, rate_limit: u64, window: Duration) -> Self {
        Self {
            max_concurrent,
            rate_limit,
            window,
            state: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Try to start an upload. Returns Ok(guard) if allowed, Err(message) if denied.
    async fn try_start(&self, key: &str) -> Result<(), &'static str> {
        let mut state = self.state.lock().await;
        let entry = state.entry(key.to_string()).or_insert(UploadState {
            active: 0,
            window_start: Instant::now(),
            window_count: 0,
        });

        let now = Instant::now();
        if now.duration_since(entry.window_start) >= self.window {
            entry.window_start = now;
            entry.window_count = 0;
        }

        if entry.active >= self.max_concurrent {
            return Err("Upload already in progress");
        }

        if entry.window_count >= self.rate_limit {
            return Err("Too many uploads, please wait");
        }

        entry.active += 1;
        entry.window_count += 1;
        Ok(())
    }

    /// Mark an upload as finished for the given IP.
    async fn finish(&self, key: &str) {
        let mut state = self.state.lock().await;
        if let Some(entry) = state.get_mut(key) {
            entry.active = entry.active.saturating_sub(1);
        }
    }
}

async fn enforce_upload_limit(
    Extension(limiter): Extension<UploadLimiter>,
    Extension(trusted): Extension<TrustedProxyList>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    req: Request<Body>,
    next: Next,
) -> Response {
    // Only apply to upload routes (POST /upload, PUT /single/{id})
    let dominated_by_upload =
        req.method() == axum::http::Method::POST || req.method() == axum::http::Method::PUT;
    if !dominated_by_upload {
        return next.run(req).await;
    }

    let client_key = extract_client_addr(&req, peer_addr, &trusted);

    if let Err(msg) = limiter.try_start(&client_key).await {
        return ApiError::service_unavailable(msg).into_response();
    }

    let response = next.run(req).await;

    limiter.finish(&client_key).await;

    response
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

// Store extracted client IP in request extensions for logging
async fn extract_and_log_ip(
    Extension(trusted): Extension<TrustedProxyList>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let client_ip = extract_client_addr(&req, peer_addr, &trusted);
    req.extensions_mut().insert(client_ip);
    next.run(req).await
}

// Extract client IP from request extensions (set by extract_and_log_ip middleware)
fn extract_ip_for_logging<B>(req: &Request<B>) -> String {
    // Get from extensions (set by middleware)
    if let Some(ip) = req.extensions().get::<String>() {
        return ip.clone();
    }

    // Fallback if middleware didn't run (shouldn't happen)
    "unknown".to_string()
}

// Custom span maker for TraceLayer that includes IP and path
fn make_request_span<B>(req: &Request<B>) -> Span {
    let method = req.method();
    let path = req.uri().path();
    let query = req.uri().query();
    let full_path = if let Some(q) = query {
        format!("{path}?{q}")
    } else {
        path.to_string()
    };

    let client_ip = extract_ip_for_logging(req);

    tracing::info_span!(
        "http_request",
        method = %method,
        path = %full_path,
        ip = %client_ip
    )
}

// Log request details when it starts
fn on_request<B>(req: &Request<B>, _span: &Span) {
    let method = req.method();
    let path = req.uri().path();
    let query = req.uri().query();
    let full_path = if let Some(q) = query {
        format!("{path}?{q}")
    } else {
        path.to_string()
    };

    let client_ip = extract_ip_for_logging(req);
    info!("{} {} from {}", method, full_path, client_ip);
}

// Log response details when it completes
fn on_response<B>(response: &Response<B>, latency: Duration, _span: &Span) {
    let status = response.status();
    let latency_ms = latency.as_millis();
    info!("Response {} in {}ms", status, latency_ms);
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

async fn fetch_cloudflare_proxies() -> anyhow::Result<Vec<IpNet>> {
    let mut networks = Vec::new();

    let ipv4_text = reqwest::get(CLOUDFLARE_IPV4_RANGES_URL)
        .await?
        .text()
        .await?;
    for cidr in ipv4_text.lines().map(str::trim) {
        if cidr.is_empty() || cidr.starts_with('#') {
            continue;
        }

        match cidr.parse::<IpNet>() {
            Ok(net) => networks.push(net),
            Err(err) => warn!("Skipping invalid Cloudflare IPv4 CIDR {} ({})", cidr, err),
        }
    }

    let ipv6_text = reqwest::get(CLOUDFLARE_IPV6_RANGES_URL)
        .await?
        .text()
        .await?;
    for cidr in ipv6_text.lines().map(str::trim) {
        if cidr.is_empty() || cidr.starts_with('#') {
            continue;
        }

        match cidr.parse::<IpNet>() {
            Ok(net) => networks.push(net),
            Err(err) => warn!("Skipping invalid Cloudflare IPv6 CIDR {} ({})", cidr, err),
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
        filter.to_sql(&mut params).map(|sql| format!(" AND {sql}"))
    } else {
        None
    };

    // Add lifers_only filter if requested
    if query.lifers_only == Some(true) {
        let lifer_clause = " AND lifer = 1".to_string();
        filter_clause = Some(match filter_clause {
            Some(existing) => format!("{existing}{lifer_clause}"),
            None => lifer_clause,
        });
    }

    // Add year_tick filter if requested
    if let Some(year) = query.year_tick_year {
        params.push(year.to_string());
        let year_tick_clause = " AND year_tick = 1 AND year = ?".to_string();
        filter_clause = Some(match filter_clause {
            Some(existing) => format!("{existing}{year_tick_clause}"),
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
