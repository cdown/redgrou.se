use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use redgrouse::api_constants;
use redgrouse::db;
use redgrouse::filter::FilterGroup;
use redgrouse::sightings::SortField;
use std::env;
use std::io::Write;
use tempfile::TempDir;
use tokio::runtime::Runtime;
use uuid::Uuid;

// Helper to generate CSV test data
fn generate_csv(rows: usize) -> Vec<u8> {
    let mut csv = Vec::new();
    writeln!(
        csv,
        "sightingId,date,longitude,latitude,commonName,scientificName,count"
    )
    .unwrap();

    // Generate diverse test data across different regions
    let species = [
        ("Eurasian Blackbird", "Turdus merula"),
        ("European Robin", "Erithacus rubecula"),
        ("Common Chaffinch", "Fringilla coelebs"),
        ("Blue Tit", "Cyanistes caeruleus"),
        ("Great Tit", "Parus major"),
        ("House Sparrow", "Passer domesticus"),
        ("Common Starling", "Sturnus vulgaris"),
        ("Wood Pigeon", "Columba palumbus"),
        ("Carrion Crow", "Corvus corone"),
        ("Magpie", "Pica pica"),
    ];

    // Spread points across different regions for realistic tile testing
    let regions = [
        (51.5074, -0.1278, "GB"),   // London
        (52.5200, 13.4050, "DE"),   // Berlin
        (48.8566, 2.3522, "FR"),    // Paris
        (40.7128, -74.0060, "US"),  // New York
        (-33.8688, 151.2093, "AU"), // Sydney
    ];

    for i in 0..rows {
        let (lat_base, lon_base, _country) = regions[i % regions.len()];
        let lat = lat_base + (i as f64 % 100.0) * 0.01;
        let lon = lon_base + (i as f64 % 100.0) * 0.01;
        let (common_name, scientific_name) = species[i % species.len()];
        let count = (i % 10) + 1;
        // Generate dates across a year
        let date = format!("2024-{:02}-{:02}", (i % 12) + 1, (i % 28) + 1);

        writeln!(
            csv,
            "{},{},{},{},{},{},{}",
            Uuid::new_v4(),
            date,
            lon,
            lat,
            common_name,
            scientific_name,
            count
        )
        .unwrap();
    }

    csv
}

// Setup test server with a temporary database
async fn setup_test_server() -> (axum::Router, TempDir, String) {
    // Rate limits are disabled via the disable-rate-limits feature flag

    let temp_dir = TempDir::new().expect("Failed to create temp directory");
    let db_path = temp_dir.path().join("bench.db");
    let database_url = format!("sqlite:{}", db_path.display());

    let pool = db::init_pool(&database_url)
        .await
        .expect("Failed to initialize pool");
    db::run_migrations(&pool)
        .await
        .expect("Failed to run migrations");

    // Create a minimal router for testing (without all the production middleware)
    let app = redgrouse::create_test_router(pool).await;

    (app, temp_dir, database_url)
}

struct UploadResult {
    upload_id: String,
    edit_token: String,
}

// Helper to upload CSV and get upload_id
async fn upload_csv(app: &axum::Router, csv_data: &[u8]) -> UploadResult {
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use tower::ServiceExt;

    // Use proper multipart/form-data format with \r\n line endings
    let boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
    let mut body = Vec::new();

    // Start boundary
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    // Content-Disposition header
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"test.csv\"\r\n",
    );
    // Content-Type header
    body.extend_from_slice(b"Content-Type: text/csv\r\n");
    // Empty line before body
    body.extend_from_slice(b"\r\n");
    // File content
    body.extend_from_slice(csv_data);
    // End boundary
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());

    let req = Request::builder()
        .method("POST")
        .uri(api_constants::UPLOAD_ROUTE)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(Body::from(body))
        .unwrap();

    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status();

    // Debug: print status and error if not OK
    if status != StatusCode::OK {
        let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let error_text = String::from_utf8_lossy(&body_bytes);
        panic!("Upload failed with status {}: {}", status, error_text);
    }

    let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    let upload_id = json["upload_id"].as_str().unwrap().to_string();
    let edit_token = json["edit_token"].as_str().unwrap().to_string();

    UploadResult {
        upload_id,
        edit_token,
    }
}

fn benchmark_upload(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    let mut group = c.benchmark_group("upload");
    // Estimate samples for ~5s (default), but allow up to 30s to collect them
    group.measurement_time(std::time::Duration::from_secs(30));
    for size in [100, 1000, 10000].iter() {
        let csv_data = generate_csv(*size);
        group.throughput(Throughput::Bytes(csv_data.len() as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(size),
            &csv_data,
            |b, csv_data| {
                b.to_async(&rt).iter(|| async {
                    let (app, _temp_dir, _db_url) = setup_test_server().await;
                    upload_csv(&app, csv_data).await
                });
            },
        );
    }
    group.finish();
}

fn benchmark_tiles(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    // Pre-upload data once
    let (app, _temp_dir, _db_url) = rt.block_on(setup_test_server());
    let csv_data = generate_csv(5000);
    let upload_result = rt.block_on(upload_csv(&app, &csv_data));

    let mut group = c.benchmark_group("tiles");
    group.measurement_time(std::time::Duration::from_secs(30));
    for zoom in [0, 5, 10, 15].iter() {
        // Test different tile coordinates at each zoom level
        let x = 1 << (zoom / 2);
        let y = 1 << (zoom / 2);

        group.bench_with_input(
            BenchmarkId::new("get_tile", format!("z{}_x{}_y{}", zoom, x, y)),
            &(upload_result.upload_id.clone(), *zoom, x, y),
            |b, (upload_id, z, x, y)| {
                b.to_async(&rt).iter(|| async {
                    use axum::body::Body;
                    use axum::http::Request;
                    use tower::ServiceExt;

                    let uri = format!("/api/tiles/{}/{}/{}/{}.pbf", upload_id, z, x, y);
                    let req = Request::builder()
                        .method("GET")
                        .uri(&uri)
                        .body(Body::empty())
                        .unwrap();

                    let response = app.clone().oneshot(req).await.unwrap();
                    assert_eq!(response.status(), 200);
                    let _body = axum::body::to_bytes(response.into_body(), usize::MAX)
                        .await
                        .unwrap();
                });
            },
        );
    }
    group.finish();
}

fn benchmark_tiles_with_filter(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    let (app, _temp_dir, _db_url) = rt.block_on(setup_test_server());
    let csv_data = generate_csv(5000);
    let upload_result = rt.block_on(upload_csv(&app, &csv_data));

    // Create a filter: common_name contains "Blackbird"
    let filter = FilterGroup {
        combinator: redgrouse::filter::Combinator::And,
        rules: vec![redgrouse::filter::Rule::Condition(
            redgrouse::filter::Condition {
                field: redgrouse::filter::FilterField::CommonName,
                operator: redgrouse::filter::Operator::Contains,
                value: redgrouse::filter::FilterValue::String("Blackbird".to_string()),
            },
        )],
    };
    let filter_json = serde_json::to_string(&filter).unwrap();

    let mut group = c.benchmark_group("tiles_filtered");
    group.measurement_time(std::time::Duration::from_secs(30));
    group.bench_function("tile_with_filter", |b| {
        b.to_async(&rt).iter(|| async {
            use axum::body::Body;
            use axum::http::Request;
            use tower::ServiceExt;

            let uri = format!(
                "/api/tiles/{}/10/512/512.pbf?filter={}",
                upload_result.upload_id,
                urlencoding::encode(&filter_json)
            );
            let req = Request::builder()
                .method("GET")
                .uri(&uri)
                .body(Body::empty())
                .unwrap();

            let response = app.clone().oneshot(req).await.unwrap();
            assert_eq!(response.status(), 200);
            let _body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
        });
    });
    group.finish();
}

fn benchmark_sightings(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    let (app, _temp_dir, _db_url) = rt.block_on(setup_test_server());
    let csv_data = generate_csv(5000);
    let upload_result = rt.block_on(upload_csv(&app, &csv_data));

    let mut group = c.benchmark_group("sightings");
    group.measurement_time(std::time::Duration::from_secs(30));

    // Test pagination
    for page_size in [10, 100, 500].iter() {
        group.bench_with_input(
            BenchmarkId::new("get_sightings", format!("page_size_{}", page_size)),
            page_size,
            |b, page_size| {
                b.to_async(&rt).iter(|| async {
                    use axum::body::Body;
                    use axum::http::Request;
                    use tower::ServiceExt;

                    let uri = format!(
                        "/api/uploads/{}/sightings?page=1&page_size={}",
                        upload_result.upload_id, page_size
                    );
                    let req = Request::builder()
                        .method("GET")
                        .uri(&uri)
                        .body(Body::empty())
                        .unwrap();

                    let response = app.clone().oneshot(req).await.unwrap();
                    assert_eq!(response.status(), 200);
                    let _body = axum::body::to_bytes(response.into_body(), usize::MAX)
                        .await
                        .unwrap();
                });
            },
        );
    }

    // Test sorting
    for sort_field in [
        SortField::CommonName,
        SortField::ObservedAt,
        SortField::Count,
    ] {
        // Use the same serialization as query parameters (snake_case)
        let sort_field_str = sort_field.as_query_param();

        group.bench_with_input(
            BenchmarkId::new("get_sightings_sorted", format!("{:?}", sort_field)),
            &sort_field_str,
            |b, sort_field_str| {
                b.to_async(&rt).iter(|| async {
                    use axum::body::Body;
                    use axum::http::Request;
                    use tower::ServiceExt;

                    let uri = format!(
                        "/api/uploads/{}/sightings?sort_field={}&sort_dir=asc",
                        upload_result.upload_id, sort_field_str
                    );
                    let req = Request::builder()
                        .method("GET")
                        .uri(&uri)
                        .body(Body::empty())
                        .unwrap();

                    let response = app.clone().oneshot(req).await.unwrap();
                    let status = response.status();
                    let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                        .await
                        .unwrap();

                    if status != 200 {
                        let error_text = String::from_utf8_lossy(&body_bytes);
                        panic!(
                            "Sightings query failed with status {}: {}",
                            status, error_text
                        );
                    }
                });
            },
        );
    }

    group.finish();
}

fn benchmark_sightings_with_filter(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    let (app, _temp_dir, _db_url) = rt.block_on(setup_test_server());
    let csv_data = generate_csv(5000);
    let upload_result = rt.block_on(upload_csv(&app, &csv_data));

    // Create a complex filter
    let filter = FilterGroup {
        combinator: redgrouse::filter::Combinator::And,
        rules: vec![
            redgrouse::filter::Rule::Condition(redgrouse::filter::Condition {
                field: redgrouse::filter::FilterField::CommonName,
                operator: redgrouse::filter::Operator::Contains,
                value: redgrouse::filter::FilterValue::String("Tit".to_string()),
            }),
            redgrouse::filter::Rule::Condition(redgrouse::filter::Condition {
                field: redgrouse::filter::FilterField::Count,
                operator: redgrouse::filter::Operator::Gte,
                value: redgrouse::filter::FilterValue::Number(5.0),
            }),
        ],
    };
    let filter_json = serde_json::to_string(&filter).unwrap();

    let mut group = c.benchmark_group("sightings_filtered");
    group.measurement_time(std::time::Duration::from_secs(30));
    group.bench_function("sightings_with_filter", |b| {
        b.to_async(&rt).iter(|| async {
            use axum::body::Body;
            use axum::http::Request;
            use tower::ServiceExt;

            let uri = format!(
                "/api/uploads/{}/sightings?filter={}",
                upload_result.upload_id,
                urlencoding::encode(&filter_json)
            );
            let req = Request::builder()
                .method("GET")
                .uri(&uri)
                .body(Body::empty())
                .unwrap();

            let response = app.clone().oneshot(req).await.unwrap();
            assert_eq!(response.status(), 200);
            let _body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
        });
    });
    group.finish();
}

fn benchmark_field_metadata(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    let (app, _temp_dir, _db_url) = rt.block_on(setup_test_server());
    let csv_data = generate_csv(1000);
    let _upload_result = rt.block_on(upload_csv(&app, &csv_data));

    let mut group = c.benchmark_group("metadata");
    group.measurement_time(std::time::Duration::from_secs(30));
    group.bench_function("get_field_metadata", |b| {
        b.to_async(&rt).iter(|| async {
            use axum::body::Body;
            use axum::http::Request;
            use tower::ServiceExt;

            let req = Request::builder()
                .method("GET")
                .uri(api_constants::FIELDS_ROUTE)
                .body(Body::empty())
                .unwrap();

            let response = app.clone().oneshot(req).await.unwrap();
            assert_eq!(response.status(), 200);
            let _body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
        });
    });
    group.finish();
}

fn benchmark_field_values(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    let (app, _temp_dir, _db_url) = rt.block_on(setup_test_server());
    let csv_data = generate_csv(5000);
    let upload_result = rt.block_on(upload_csv(&app, &csv_data));

    let mut group = c.benchmark_group("field_values");
    group.measurement_time(std::time::Duration::from_secs(30));
    for field in ["common_name", "country_code", "count"].iter() {
        group.bench_with_input(BenchmarkId::from_parameter(field), field, |b, field| {
            b.to_async(&rt).iter(|| async {
                use axum::body::Body;
                use axum::http::Request;
                use tower::ServiceExt;

                let uri = format!("/api/uploads/{}/fields/{}", upload_result.upload_id, field);
                let req = Request::builder()
                    .method("GET")
                    .uri(&uri)
                    .body(Body::empty())
                    .unwrap();

                let response = app.clone().oneshot(req).await.unwrap();
                assert_eq!(response.status(), 200);
                let _body = axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap();
            });
        });
    }
    group.finish();
}

fn benchmark_filtered_count(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    let (app, _temp_dir, _db_url) = rt.block_on(setup_test_server());
    let csv_data = generate_csv(5000);
    let upload_result = rt.block_on(upload_csv(&app, &csv_data));

    // Create a filter
    let filter = FilterGroup {
        combinator: redgrouse::filter::Combinator::And,
        rules: vec![redgrouse::filter::Rule::Condition(
            redgrouse::filter::Condition {
                field: redgrouse::filter::FilterField::CommonName,
                operator: redgrouse::filter::Operator::Contains,
                value: redgrouse::filter::FilterValue::String("Robin".to_string()),
            },
        )],
    };
    let filter_json = serde_json::to_string(&filter).unwrap();

    let mut group = c.benchmark_group("count");
    group.measurement_time(std::time::Duration::from_secs(30));
    group.bench_function("filtered_count", |b| {
        b.to_async(&rt).iter(|| async {
            use axum::body::Body;
            use axum::http::Request;
            use tower::ServiceExt;

            let uri = format!(
                "/api/uploads/{}/count?filter={}",
                upload_result.upload_id,
                urlencoding::encode(&filter_json)
            );
            let req = Request::builder()
                .method("GET")
                .uri(&uri)
                .body(Body::empty())
                .unwrap();

            let response = app.clone().oneshot(req).await.unwrap();
            assert_eq!(response.status(), 200);
            let _body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
        });
    });
    group.finish();
}

criterion_group! {
    name = benches;
    config = Criterion::default()
        // Keep default measurement_time (~5s) for sample estimation
        // Set fixed sample_size so estimation is based on ~5s, not 30s
        .sample_size(100) // Default sample size, estimated for ~5s
        .warm_up_time(std::time::Duration::from_secs(3));
    targets =
        benchmark_upload,
        benchmark_tiles,
        benchmark_tiles_with_filter,
        benchmark_sightings,
        benchmark_sightings_with_filter,
        benchmark_field_metadata,
        benchmark_field_values,
        benchmark_filtered_count
}
criterion_main!(benches);
