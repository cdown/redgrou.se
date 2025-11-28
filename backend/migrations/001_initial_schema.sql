CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    row_count INTEGER DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS sightings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id TEXT NOT NULL,
    sighting_uuid TEXT NOT NULL,

    common_name TEXT NOT NULL,
    scientific_name TEXT,
    count INTEGER DEFAULT 1,

    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    country_code TEXT,

    observed_at TEXT NOT NULL,
    notes TEXT,
    trip_name TEXT,

    FOREIGN KEY(upload_id) REFERENCES uploads(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sightings_lookup
    ON sightings(upload_id, common_name, observed_at);

CREATE INDEX IF NOT EXISTS idx_sightings_geo
    ON sightings(upload_id, latitude, longitude);
