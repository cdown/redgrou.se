use axum::body::Body;
use axum::error_handling::HandleErrorLayer;
use axum::extract::{ConnectInfo, Extension, Path, Query, State};
use axum::http::{header, HeaderValue, Request};
use axum::middleware::{from_fn, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{BoxError, Router};
use dashmap::DashMap;
use ipnet::IpNet;
use serde::Deserialize;
use sqlx::{Row, SqlitePool};
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

use redgrouse::api_constants;
use redgrouse::config;
use redgrouse::error::ApiError;
use redgrouse::filter::{build_filter_clause, CountQuery};
use redgrouse::handlers;
use redgrouse::proto::{pb, Proto};
use redgrouse::{db, sightings, tiles, upload};

const BUILD_VERSION: &str = env!("BUILD_VERSION");
const BUILD_DATE: &str = env!("BUILD_DATE");
const RUSTC_VERSION: &str = env!("RUSTC_VERSION");

/// Maximum time any request can take before being terminated.
/// Applies to: All routes except uploads (tiles, sightings, metadata).
/// Heavy user estimate: N/A - this is a safety timeout, not a throughput limit.
const GLOBAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

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
/// Heavy user estimate: A 200MB CSV over a slow connection might take 30s.
const UPLOAD_BODY_TIMEOUT: Duration = Duration::from_secs(30);

/// Maximum time for upload requests (body + processing).
/// Applies to: POST /upload and PUT /single/{id} routes only.
const UPLOAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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
    db::vacuum_database(&pool).await;

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
        .layer(HandleErrorLayer::new(handle_layer_error))
        .layer(RequestBodyLimitLayer::new(upload::MAX_UPLOAD_BODY_BYTES))
        .layer(RequestBodyTimeoutLayer::new(UPLOAD_BODY_TIMEOUT))
        .timeout(UPLOAD_REQUEST_TIMEOUT)
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
        .route(api_constants::VERSION_ROUTE, get(version_info))
        .route(
            api_constants::UPLOAD_DETAILS_ROUTE,
            get(handlers::get_upload).delete(upload::delete_upload),
        )
        .route(
            api_constants::UPLOAD_COUNT_ROUTE,
            get(handlers::get_filtered_count),
        )
        .route(api_constants::UPLOAD_BBOX_ROUTE, get(get_bbox))
        .route(
            api_constants::UPLOAD_SIGHTINGS_ROUTE,
            get(sightings::get_sightings),
        )
        .route(api_constants::TILE_ROUTE, get(tiles::get_tile))
        .route(api_constants::FIELDS_ROUTE, get(handlers::fields_metadata))
        .route(
            api_constants::FIELD_VALUES_ROUTE,
            get(handlers::field_values),
        )
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

    let port = config::parse_port()?;
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

async fn version_info() -> Proto<pb::VersionInfo> {
    Proto::new(pb::VersionInfo {
        git_hash: BUILD_VERSION.to_string(),
        build_date: BUILD_DATE.to_string(),
        rustc_version: RUSTC_VERSION.to_string(),
    })
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
    buckets: Arc<DashMap<String, RateWindow>>,
}

struct RateWindow {
    start: Instant,
    count: u64,
}

impl RequestRateLimiter {
    fn new(limit: u64, window: Duration) -> Self {
        let buckets = Arc::new(DashMap::new());
        let buckets_clone = Arc::clone(&buckets);
        let window_clone = window;

        // Background pruning task: removes expired entries every 5 minutes
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            loop {
                interval.tick().await;
                let now = Instant::now();
                let prune_before = now - window_clone * 2;
                buckets_clone.retain(|_, state: &mut RateWindow| state.start > prune_before);
            }
        });

        Self {
            limit,
            window,
            buckets,
        }
    }

    fn try_acquire(&self, key: &str) -> bool {
        let now = Instant::now();

        let mut state = self.buckets.entry(key.to_string()).or_insert(RateWindow {
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

/// RAII guard that automatically releases an upload slot when dropped.
/// Ensures slots are released even if the client disconnects or the request is cancelled.
pub struct UploadGuard {
    limiter: Arc<Mutex<HashMap<String, UploadState>>>,
    key: String,
}

impl Drop for UploadGuard {
    fn drop(&mut self) {
        let limiter = Arc::clone(&self.limiter);
        let key = self.key.clone();
        // Spawn a task to decrement the counter asynchronously.
        // This ensures cleanup happens even if the guard is dropped during cancellation.
        tokio::spawn(async move {
            let mut state = limiter.lock().await;
            if let Some(entry) = state.get_mut(&key) {
                entry.active = entry.active.saturating_sub(1);
            }
        });
    }
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

    async fn try_start(&self, key: &str) -> Result<UploadGuard, &'static str> {
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
        Ok(UploadGuard {
            limiter: Arc::clone(&self.state),
            key: key.to_string(),
        })
    }
}

async fn enforce_upload_limit(
    Extension(limiter): Extension<UploadLimiter>,
    Extension(trusted): Extension<TrustedProxyList>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    req: Request<Body>,
    next: Next,
) -> Response {
    #[cfg(feature = "disable-rate-limits")]
    {
        return next.run(req).await;
    }

    #[cfg(not(feature = "disable-rate-limits"))]
    {
        let dominated_by_upload =
            req.method() == axum::http::Method::POST || req.method() == axum::http::Method::PUT;
        if !dominated_by_upload {
            return next.run(req).await;
        }

        let client_key = extract_client_addr(&req, peer_addr, &trusted);

        let _guard = match limiter.try_start(&client_key).await {
            Ok(guard) => guard,
            Err(msg) => return ApiError::too_many_requests(msg).into_response(),
        };

        // Guard is automatically dropped when this function returns, releasing the slot.
        // This ensures cleanup even if the client disconnects or the request is cancelled.
        next.run(req).await
    }
}

async fn enforce_rate_limit(
    Extension(limiter): Extension<RequestRateLimiter>,
    Extension(trusted): Extension<TrustedProxyList>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    req: Request<Body>,
    next: Next,
) -> Response {
    #[cfg(feature = "disable-rate-limits")]
    {
        return next.run(req).await;
    }

    #[cfg(not(feature = "disable-rate-limits"))]
    {
        let client_key = extract_client_addr(&req, peer_addr, &trusted);
        if limiter.try_acquire(&client_key) {
            next.run(req).await
        } else {
            ApiError::too_many_requests("Too many requests").into_response()
        }
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

fn extract_ip_for_logging<B>(req: &Request<B>) -> String {
    if let Some(ip) = req.extensions().get::<String>() {
        return ip.clone();
    }

    "unknown".to_string()
}

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

async fn parse_cidr_list(text: &str, label: &str) -> Vec<IpNet> {
    let mut networks = Vec::new();
    for cidr in text.lines().map(str::trim) {
        if cidr.is_empty() || cidr.starts_with('#') {
            continue;
        }

        match cidr.parse::<IpNet>() {
            Ok(net) => networks.push(net),
            Err(err) => warn!("Skipping invalid {} CIDR {} ({})", label, cidr, err),
        }
    }
    networks
}

async fn fetch_cloudflare_proxies() -> anyhow::Result<Vec<IpNet>> {
    let mut networks = Vec::new();

    let ipv4_text = reqwest::get(CLOUDFLARE_IPV4_RANGES_URL)
        .await?
        .text()
        .await?;
    networks.extend(parse_cidr_list(&ipv4_text, "Cloudflare IPv4").await);

    let ipv6_text = reqwest::get(CLOUDFLARE_IPV6_RANGES_URL)
        .await?
        .text()
        .await?;
    networks.extend(parse_cidr_list(&ipv6_text, "Cloudflare IPv6").await);

    Ok(networks)
}

async fn get_bbox(
    State(pool): State<SqlitePool>,
    Path(upload_id): Path<String>,
    Query(query): Query<CountQuery>,
) -> Result<Proto<pb::BboxResponse>, ApiError> {
    let filter_result = build_filter_clause(
        query.filter.as_ref(),
        query.lifers_only,
        query.year_tick_year,
        query.country_tick_country.as_ref(),
        None,
    )?;

    let upload_uuid = uuid::Uuid::parse_str(&upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;

    let sql = format!(
        "SELECT MIN(longitude) as min_lng, MIN(latitude) as min_lat, MAX(longitude) as max_lng, MAX(latitude) as max_lat FROM sightings WHERE upload_id = ?{}",
        filter_result.filter_clause
    );

    let mut db_query = sqlx::query(&sql);
    db_query = db_query.bind(&upload_uuid.as_bytes()[..]);
    for param in &filter_result.params {
        db_query = db_query.bind(param);
    }

    let row = db::query_with_timeout(db_query.fetch_optional(&pool))
        .await
        .map_err(|e| e.into_api_error("getting bounding box", "Database error"))?
        .ok_or_else(|| ApiError::not_found("No sightings found"))?;

    let min_lng: Option<f64> = row.get("min_lng");
    let min_lat: Option<f64> = row.get("min_lat");
    let max_lng: Option<f64> = row.get("max_lng");
    let max_lat: Option<f64> = row.get("max_lat");

    if min_lng.is_none() || min_lat.is_none() || max_lng.is_none() || max_lat.is_none() {
        return Err(ApiError::not_found("No sightings found"));
    }

    Ok(Proto::new(pb::BboxResponse {
        min_lng: min_lng.unwrap(),
        min_lat: min_lat.unwrap(),
        max_lng: max_lng.unwrap(),
        max_lat: max_lat.unwrap(),
    }))
}
