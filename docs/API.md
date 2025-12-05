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
and `edit_token`.

**Rate limits**: 1 concurrent upload per IP, 3 uploads per minute per IP.

**Size limits**: 200 MB maximum file size, 250,000 rows maximum.

### Get upload metadata

```
GET /api/uploads/{upload_id}
```

Returns metadata for a specific upload including filename and row count.

**Response**: `UploadMetadata`

### Update upload

```
PUT /api/uploads/{upload_id}
Authorization: Bearer <edit_token>
Content-Type: multipart/form-data
```

Replaces all sightings in an upload with data from a new CSV file. Requires
the edit token.

**Response**: `UpdateResponse`

### Delete upload

```
DELETE /api/uploads/{upload_id}
Authorization: Bearer <edit_token>
```

Deletes an upload and all associated sightings. Requires the edit token.

**Response**: `DeleteResponse`

### Get filtered count

```
GET /api/uploads/{upload_id}/count?filter={json}&lifers_only={bool}&year_tick_year={int}&country_tick_country={string}
```

Returns the count of sightings matching the provided filter criteria. The
`filter` parameter is a JSON-encoded filter group (see filter system
documentation).

**Response**: `CountResponse`

### Get bounding box

```
GET /api/uploads/{upload_id}/bbox?filter={json}&lifers_only={bool}&year_tick_year={int}&country_tick_country={string}
```

Returns the bounding box (min/max latitude and longitude) of all sightings
matching the filter criteria.

**Response**: `BboxResponse`

### Get sightings

```
GET /api/uploads/{upload_id}/sightings?page={int}&page_size={int}&filter={json}&sort={string}&lifers_only={bool}&year_tick_year={int}&country_tick_country={string}
```

Returns paginated sightings. Default page size is 100, maximum is 500.

**Response**: `SightingsResponse` containing `sightings`, `groups`, `total`,
`page`, `page_size`, and `total_pages`.

### Get vector tile

```
GET /api/tiles/{upload_id}/{z}/{x}/{y}
```

Returns a Mapbox Vector Tile (MVT) in Protobuf format for the specified tile
coordinates. Tiles are filtered based on query parameters (same as sightings
endpoint).

**Response**: Binary Protobuf MVT data

**Content-Type**: `application/x-protobuf`

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

**Response**: `FieldValues`

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

Request timeouts are set to 30 seconds for all endpoints. Upload body timeouts
are 60 seconds to accommodate slow connections.
