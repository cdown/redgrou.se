# API reference

All API endpoints are defined in `backend/src/api_constants.rs` and exported to
`frontend/src/lib/generated/api_constants.ts` for type-safe URL construction.

## Base URL

In development, the backend runs on `http://localhost:3001`. In production, it
runs on the same domain as the frontend (configured via `NEXT_PUBLIC_API_URL`).

## Response format

All responses use Protocol Buffer encoding. Error responses include an
`ApiErrorBody` message with an `error` field and optional `code` field.

The `x-build-version` header is included on all responses and contains the git
commit hash of the deployed version.

## Dataset versions

Each upload maintains a monotonically increasing `data_version`. The backend
includes this value in every metadata, count, field values, bounding box, and
`SightingsResponse`. Tile responses also expose it via the `x-upload-version`
header. Clients should treat the value as opaque and refresh any cached data
whenever it changes to ensure viewers see the latest dataset contents (or learn
when an upload has been deleted).

## Authentication

Most endpoints are public. Upload modification and deletion require an edit token
provided via the `Authorization: Bearer <token>` header. Edit tokens are
returned when creating an upload and can be shared via URL parameters.

## Endpoints

### Health check

```
GET /health
```

Returns `OK` if the server is running. Useful for monitoring and load balancer
health checks.

### Version information

```
GET /api/version
```

Returns build metadata including git hash, build date, and Rust compiler
version.

### Upload CSV

```
POST /api/uploads
Content-Type: multipart/form-data
```

Uploads a new CSV file. The request body must be multipart/form-data with a CSV
file field.

**Response**: `UploadResponse` containing `upload_id`, `filename`, `row_count`,
`data_version`, and `edit_token`.

**Rate limits**: 1 concurrent upload per IP, 3 uploads per minute per IP.

**Size limits**: 50 MB maximum file size, 250,000 rows maximum.

### Get upload metadata

```
GET /api/uploads/{upload_id}
```

Returns metadata for a specific upload including filename, row count, and display name.

**Response**: `UploadMetadata` containing `upload_id`, `filename`, `row_count`,
`title` (display name or filename if no display name is set), and
`data_version`.

### Rename upload

```
PATCH /api/uploads/{upload_id}
Authorization: Bearer <edit_token>
Content-Type: application/json
```

Updates the display name for an upload. Requires the edit token.

**Request body**: JSON object with `display_name` field (string, 1-128 characters).

**Response**: `UploadMetadata` containing updated metadata including the new title.

### Update upload

```
PUT /api/uploads/{upload_id}
Authorization: Bearer <edit_token>
Content-Type: multipart/form-data
```

Replaces all sightings in an upload with data from a new CSV file. Requires
the edit token.

**Response**: `UpdateResponse` with the new `data_version`.

### Delete upload

```
DELETE /api/uploads/{upload_id}
Authorization: Bearer <edit_token>
```

Deletes an upload and all associated sightings. Requires the edit token.

**Response**: `DeleteResponse`

### Tick filter query parameter

Many endpoints support a `tick_filter` parameter to control which sighting categories are returned.
Provide a comma-separated list of any of:

- `normal` &mdash; regular sightings
- `lifer` &mdash; first sighting of each species
- `year` &mdash; first sighting of each species in a calendar year
- `country` &mdash; first sighting of each species in a country

All four categories are included by default. Passing an empty string matches no sightings. When
`year_tick_year` or `country_tick_country` are provided, the backend automatically forces the
corresponding tick category to remain included even if it is omitted from `tick_filter`.

### Get filtered count

```
GET /api/uploads/{upload_id}/count?filter={json}&tick_filter={string}&year_tick_year={int}&country_tick_country={string}
```

Returns the count of sightings matching the provided filter criteria. The
`filter` parameter is a JSON-encoded filter group (see filter system
documentation).

**Response**: `CountResponse` (includes `data_version`)

### Get bounding box

```
GET /api/uploads/{upload_id}/bbox?filter={json}&tick_filter={string}&year_tick_year={int}&country_tick_country={string}
```

Returns the bounding box (min/max latitude and longitude) of all sightings
matching the filter criteria.

**Response**: `BboxResponse` (includes `data_version`)

### Get sightings

```
GET /api/uploads/{upload_id}/sightings?page_size={int}&cursor={string}&filter={json}&sort={string}&tick_filter={string}&year_tick_year={int}&country_tick_country={string}
```

Returns paginated sightings. Default page size is 100, maximum is 500.

**Pagination**: The default response uses cursor/keyset pagination. Omit the `cursor`
parameter to fetch the first chunk, then send the `next_cursor` value from the
previous response to fetch subsequent chunks. When `group_by` is provided the
response falls back to page/offset pagination, so `page` must be supplied in
those requests.

**Response**: `SightingsResponse` containing `sightings`, `groups`, `total`,
`total`, `data_version`, and `next_cursor` (for cursor-based pagination).

### Get vector tile

```
GET /api/tiles/{upload_id}/{z}/{x}/{y}[.pbf]?filter={json}&tick_filter={string}&year_tick_year={int}&country_tick_country={string}
```

Returns a Mapbox Vector Tile (MVT) in Protobuf format for the specified tile
coordinates. The `.pbf` extension is optional. Tiles are filtered based on
query parameters (same as sightings endpoint).

**Response**: Binary Protobuf MVT data

**Content-Type**: `application/x-protobuf`

**Caching**: Tiles are cached in memory using an LRU cache (~50MB limit) to improve performance for frequently accessed tiles, especially at low zoom levels. Responses also include an `x-upload-version` header so clients can detect stale tiles; append `data_version=<value>` to tile URLs to force browsers to revalidate when a dataset changes.

### Get field metadata

```
GET /api/fields
```

Returns metadata about all filterable fields including name, label, and type.

**Response**: `FieldMetadataList`

### Get field values

```
GET /api/uploads/{upload_id}/fields/{field}
```

Returns all distinct values for a specific field within an upload. Useful for
populating filter dropdowns.

**Response**: `FieldValues` (includes `data_version`)

## Rate limiting

All endpoints are rate-limited to 20,000 requests per minute per IP address.
Upload endpoints have additional limits: 1 concurrent upload and 3 uploads per
minute per IP.

Rate limiting uses the client IP address, which is extracted from CloudFront
or Cloudflare headers when behind those proxies, or falls back to the peer
address.

## Error handling

Errors are returned as Protocol Buffer messages with appropriate HTTP status
codes:

- `400 Bad Request` - Invalid request parameters or data
- `401 Unauthorised` - Missing edit token
- `403 Forbidden` - Invalid edit token
- `404 Not Found` - Upload not found
- `429 Too Many Requests` - Rate limit exceeded
- `503 Service Unavailable` - Request timeout

Request timeouts are set to 3 seconds for all endpoints except uploads.
Upload requests have a 30 second timeout to accommodate large file uploads
and processing.

## Data retention

redgrou.se implements a "view-to-renew" retention policy for GDPR compliance:

- Uploads are retained for 365 days from last access (configurable via
  `REDGROUSE_DATA_RETENTION_DAYS` environment variable, default: 365)
- Accessing an upload (via `GET /api/uploads/{upload_id}`) automatically
  updates its `last_accessed_at` timestamp, renewing the retention period
- A background task runs daily to automatically delete uploads where
  `last_accessed_at` is older than the retention period
- Deletion cascades to all associated sightings and tick bitmaps

This ensures abandoned location data is automatically removed while preserving
actively-viewed uploads.
