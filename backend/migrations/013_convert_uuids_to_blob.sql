-- Convert UUID columns from TEXT to BLOB to save space
-- Text UUID: "123e4567-e89b-12d3-a456-426614174000" (36 bytes)
-- Binary UUID: 16 bytes
-- This saves 40 bytes per row (2 UUIDs per sighting)

-- 0. CLEANUP TRIGGERS AND R-TREE FIRST
-- We must drop the triggers explicitly. Otherwise, if the cascade from modifying 'uploads'
-- touches 'sightings', the triggers will fire and try to write to the missing sightings_geo table.
DROP TRIGGER IF EXISTS sightings_geo_insert;
DROP TRIGGER IF EXISTS sightings_geo_update;
DROP TRIGGER IF EXISTS sightings_geo_delete;
DROP TABLE IF EXISTS sightings_geo;

-- 1. Convert uploads.id from TEXT to BLOB
CREATE TABLE IF NOT EXISTS uploads_new (
    id BLOB PRIMARY KEY,
    filename TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    row_count INTEGER DEFAULT 0,
    edit_token_hash TEXT
) STRICT;

INSERT INTO uploads_new (id, filename, created_at, row_count, edit_token_hash)
SELECT
    CAST('X' || UPPER(REPLACE(id, '-', '')) AS BLOB) AS id,
    filename,
    created_at,
    row_count,
    edit_token_hash
FROM uploads;

DROP TABLE uploads;
ALTER TABLE uploads_new RENAME TO uploads;

-- 2. Convert sightings.upload_id and sightings.sighting_uuid from TEXT to BLOB
CREATE TABLE IF NOT EXISTS sightings_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id BLOB NOT NULL,
    sighting_uuid BLOB NOT NULL,

    species_id INTEGER NOT NULL,
    count INTEGER DEFAULT 1,

    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    country_code TEXT,
    region_code TEXT,

    observed_at TEXT NOT NULL,
    year INTEGER,
    lifer INTEGER DEFAULT 0,
    year_tick INTEGER DEFAULT 0,
    country_tick INTEGER DEFAULT 0,
    vis_rank INTEGER DEFAULT 0,

    FOREIGN KEY(upload_id) REFERENCES uploads(id) ON DELETE CASCADE,
    FOREIGN KEY(species_id) REFERENCES species(id)
) STRICT;

INSERT INTO sightings_new (
    id, upload_id, sighting_uuid, species_id, count,
    latitude, longitude, country_code, region_code,
    observed_at, year, lifer, year_tick, country_tick, vis_rank
)
SELECT
    id,
    CAST('X' || UPPER(REPLACE(upload_id, '-', '')) AS BLOB) AS upload_id,
    CAST('X' || UPPER(REPLACE(sighting_uuid, '-', '')) AS BLOB) AS sighting_uuid,
    species_id, count,
    latitude, longitude, country_code, region_code,
    observed_at, year, lifer, year_tick, country_tick, vis_rank
FROM sightings;

DROP TABLE sightings;
ALTER TABLE sightings_new RENAME TO sightings;

-- 3. Recreate R-tree Table and Backfill
CREATE VIRTUAL TABLE IF NOT EXISTS sightings_geo
USING rtree(
    id,
    min_lat,
    max_lat,
    min_lon,
    max_lon
);

INSERT INTO sightings_geo (id, min_lat, max_lat, min_lon, max_lon)
SELECT id, latitude, latitude, longitude, longitude
FROM sightings;

-- 4. Recreate R-tree triggers
CREATE TRIGGER sightings_geo_insert
AFTER INSERT ON sightings
BEGIN
    INSERT OR REPLACE INTO sightings_geo (id, min_lat, max_lat, min_lon, max_lon)
    VALUES (NEW.id, NEW.latitude, NEW.latitude, NEW.longitude, NEW.longitude);
END;

CREATE TRIGGER sightings_geo_update
AFTER UPDATE OF latitude, longitude ON sightings
BEGIN
    INSERT OR REPLACE INTO sightings_geo (id, min_lat, max_lat, min_lon, max_lon)
    VALUES (NEW.id, NEW.latitude, NEW.latitude, NEW.longitude, NEW.longitude);
END;

CREATE TRIGGER sightings_geo_delete
AFTER DELETE ON sightings
BEGIN
    DELETE FROM sightings_geo WHERE id = OLD.id;
END;

-- 5. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_sightings_lookup
    ON sightings(upload_id, species_id, observed_at);

CREATE INDEX IF NOT EXISTS idx_sightings_geo
    ON sightings(upload_id, latitude, longitude, species_id, count);

CREATE INDEX IF NOT EXISTS idx_sightings_lifer ON sightings(upload_id, lifer);
CREATE INDEX IF NOT EXISTS idx_sightings_year ON sightings(upload_id, year);

CREATE INDEX IF NOT EXISTS idx_sightings_vis_rank
    ON sightings(upload_id, vis_rank, latitude, longitude, species_id, count, observed_at, lifer, year_tick, country_tick);
