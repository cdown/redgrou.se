# Hacking on redgrou.se

## Prerequisites

- Rust (1.85+)
- Node.js (20+)
- SQLite (3.35+)

## Running Locally

The simplest way to run both services:

```bash
./rgrse dev
```

This starts:
- Backend on `http://localhost:3001`
- Frontend on `http://localhost:3000` (with Next.js hot reload)

Logs are prefixed with `[backend]` or `[frontend]`. Press Ctrl+C to stop both.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDGROUSE_DATA_DIR` | `./data` | SQLite database location |
| `REDGROUSE_BACKEND_PORT` | `3001` | Backend port |
| `REDGROUSE_FRONTEND_PORT` | `3000` | Frontend port |

## Linting Requirements

All PRs must pass these checks:

### Backend

```bash
cd backend
cargo fmt --check
cargo clippy -- -D warnings
cargo check
```

### Frontend

```bash
cd frontend
npm run lint:strict
```

## Type generation

Rust structs shared with the frontend use
[ts-rs](https://github.com/Aleph-Alpha/ts-rs) to generate TypeScript
definitions.

You should regenerate:

- After adding or modifying any struct with `#[derive(TS)]` and `#[ts(export)]`
- After changing `api_constants.rs`

You can do this with:

```bash
cd backend
cargo run --bin export_types
```

This outputs to `frontend/src/lib/generated/`. The generated files are
persisted to git.

To add a new shared type:

1. Add `#[derive(TS)]` and `#[ts(export)]` to your Rust struct
2. Import and call `YourType::export_all_to(out_dir)` in
   `src/bin/export_types.rs`
3. Run the export command above
4. Import from `@/lib/generated` in the frontend

## DB debugging

The SQLite database lives at `$REDGROUSE_DATA_DIR/redgrouse.db` (default:
`./data/redgrouse.db`).

```bash
# Open database
sqlite3 data/redgrouse.db

# Useful queries
.tables                              -- List tables
.schema sightings                    -- Show schema
SELECT COUNT(*) FROM sightings;      -- Count all sightings
SELECT * FROM uploads;               -- List uploads

# Check a specific upload's data
SELECT common_name, COUNT(*) as cnt
FROM sightings
WHERE upload_id = 'your-uuid-here'
GROUP BY common_name
ORDER BY cnt DESC
LIMIT 10;
```

## API debugging

You can debug endpoints directly with curl:

```bash
# Health check
curl http://localhost:3001/health

# Get upload metadata
curl http://localhost:3001/api/single/{upload_id}

# Get sightings (paginated)
curl "http://localhost:3001/api/single/{upload_id}/sightings?limit=10"

# Get filtered count
curl "http://localhost:3001/api/single/{upload_id}/count?filter={json}"

# Get a tile
curl http://localhost:3001/api/tiles/{upload_id}/5/16/12.pbf --output tile.pbf
```

### Benchmarks

If you believe your change may affect performance, it may make sense to run
benchmarks. You can do this with:

```bash
cd backend
cargo bench --bench api_benchmarks --features disable-rate-limits
```
