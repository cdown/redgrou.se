-- SQLite doesn't support DROP COLUMN directly, so we recreate the table
CREATE TABLE IF NOT EXISTS sightings_new (
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
    year INTEGER,
    lifer INTEGER DEFAULT 0,
    year_tick INTEGER DEFAULT 0,

    FOREIGN KEY(upload_id) REFERENCES uploads(id) ON DELETE CASCADE
) STRICT;

INSERT INTO sightings_new (
    id, upload_id, sighting_uuid, common_name, scientific_name, count,
    latitude, longitude, country_code, observed_at, year, lifer, year_tick
)
SELECT
    id, upload_id, sighting_uuid, common_name, scientific_name, count,
    latitude, longitude, country_code, observed_at, year, lifer, year_tick
FROM sightings;

DROP TABLE sightings;
ALTER TABLE sightings_new RENAME TO sightings;

CREATE INDEX IF NOT EXISTS idx_sightings_lookup
    ON sightings(upload_id, common_name, observed_at);

CREATE INDEX IF NOT EXISTS idx_sightings_geo
    ON sightings(upload_id, latitude, longitude);

CREATE INDEX IF NOT EXISTS idx_sightings_lifer ON sightings(upload_id, lifer);
CREATE INDEX IF NOT EXISTS idx_sightings_year ON sightings(upload_id, year);
