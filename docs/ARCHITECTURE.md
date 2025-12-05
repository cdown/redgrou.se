# Architecture

redgrou.se consists of a Rust backend and Next.js frontend.

## Design constraints

I run redgrou.se on a single CPU, 1GB memory server, so it is designed to be
efficient, but also work well within resource constraints. Perhaps that will
help explain some of the design decisions. :-)

## Design decisions

### Why Rust + SQLite?

A few reasons. SQLite with WAL mode handles concurrent reads excellently. The
entire dataset lives on a single machine with no network round-trips to a
database server. It also means we get single binary deployment, there's no
external database to configure, and in general operationally things are
relatively simple. R-tree support also helps.

Of course, there are specialised spatial databases which could help for some of
the tile queries, but these are a) fast enough in reality that it doesn't
matter, and b) that would require even more resources.

### Why MVT, not GeoJSON?

The frontend never receives a JSON array of all points. Instead:

1. MapLibre requests tiles at `GET /api/tiles/{upload_id}/{z}/{x}/{y}.pbf`
2. Backend queries only points within the tile's bounding box using an R-tree
   spatial index
3. Points are encoded as Protobuf in MVT format and streamed to the client

This scales quite nicely and avoids sucking all the browser memory.

### Type sharing

All API payloads are defined once in `proto/redgrouse_api.proto`. The backend
compiles the schema with `prost`, and the frontend consumes the exact same
definitions via `ts-proto`. See [HACKING.md](./HACKING.md#shared-api-schema) for
the regeneration workflow.

### Filter system

The query builder supports nested AND/OR groups that compile to parameterised
SQL. The `FilterGroup` struct in Rust is the source of truth, exported to
TypeScript for the UI.

Filters apply to both the map (via tile query parameters) and the table view
(via the sightings endpoint). Although sometimes there are some inconsistencies
because things are... complicated. If you find them, please feel free to file
an issue or PR :-)

## Database schema

We use SQLite with `STRICT` tables. Dates are stored as ISO 8601 `TEXT` (STRICT
mode disallows `DATETIME`). In practice that's not a problem.

The key tables are:

- uploads - Metadata for each CSV upload (id, filename, row_count)
- sightings - Individual bird sightings with location, taxonomy, and metadata
- sightings_geo - R-tree virtual table for spatial queries

Indices are tuned for tile generation (we have a covering index on upload_id +
coordinates) and filtering (we have a lookup index on common fields).

## Frontend

We use:

- MapLibre GL JS with OpenFreeMap vector tiles as the base layer. Originally
  OSM tiles were used, that looked really bad on mobile.
- shadcn/ui components
- The Next.JS app router with client-side state for filters and view mode

## API Design

All routes are defined in `backend/src/api_constants.rs` and exported to
`frontend/src/lib/generated/api_constants.ts`. On the frontend you then use
`buildApiUrl()` to construct URLs with path parameters.

Rate limiting is per-IP to prevent abuse without penalising legitimate users.
Limits are generous (20,000 requests/minute) to handle tile bursts during map
interactions. In general the goal is to protect legitimate requests. During
testing you may want to enable the `disable-rate-limits` feature.

We also download CloudFront/CloudFlare IPs at startup and trust their
forwarding headers.

## Constraints

- Maximum upload size is 50 MB, which is enforced at multipart parsing level
- We also limit nesting depth and rule count to prevent DoS via expensive
  queries
- There is no authentication, anyone with the upload URL can view things.
  Edit/delete requires an edit token. That gets stored in the creating
  browser's localStorage, and can also be shared via URL with the copy edit
  link button.
