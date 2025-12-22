-- Uploads table

CREATE TABLE IF NOT EXISTS uploads (
    id BLOB PRIMARY KEY,
    filename TEXT NOT NULL,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_accessed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    row_count INTEGER DEFAULT 0,
    edit_token_hash TEXT,
    data_version INTEGER NOT NULL DEFAULT 1
) STRICT;

-- Species dictionary

CREATE TABLE IF NOT EXISTS species (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    common_name TEXT NOT NULL,
    scientific_name TEXT NOT NULL DEFAULT '',
    UNIQUE(common_name, scientific_name)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_species_names
    ON species(common_name, scientific_name);

CREATE INDEX IF NOT EXISTS idx_species_scientific_name
    ON species(scientific_name);

-- Sightings table

CREATE TABLE IF NOT EXISTS sightings (
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

    -- Tick flags (computed after upload)
    lifer INTEGER DEFAULT 0,
    year_tick INTEGER DEFAULT 0,
    country_tick INTEGER DEFAULT 0,

    -- Visualization rank for tile sampling (0-10000)
    vis_rank INTEGER DEFAULT 0,

    FOREIGN KEY(upload_id) REFERENCES uploads(id) ON DELETE CASCADE,
    FOREIGN KEY(species_id) REFERENCES species(id)
) STRICT;

-- Spatial index
-- Virtual R-tree table for fast bounding-box queries (min/max lat/lon).

CREATE VIRTUAL TABLE IF NOT EXISTS sightings_geo
USING rtree(
    id,
    min_lat,
    max_lat,
    min_lon,
    max_lon
);

-- Triggers to keep the R-Tree in sync with the main table automatically

CREATE TRIGGER IF NOT EXISTS sightings_geo_insert
AFTER INSERT ON sightings
BEGIN
    INSERT OR REPLACE INTO sightings_geo (id, min_lat, max_lat, min_lon, max_lon)
    VALUES (NEW.id, NEW.latitude, NEW.latitude, NEW.longitude, NEW.longitude);
END;

CREATE TRIGGER IF NOT EXISTS sightings_geo_update
AFTER UPDATE OF latitude, longitude ON sightings
BEGIN
    INSERT OR REPLACE INTO sightings_geo (id, min_lat, max_lat, min_lon, max_lon)
    VALUES (NEW.id, NEW.latitude, NEW.latitude, NEW.longitude, NEW.longitude);
END;

CREATE TRIGGER IF NOT EXISTS sightings_geo_delete
AFTER DELETE ON sightings
BEGIN
    DELETE FROM sightings_geo WHERE id = OLD.id;
END;

-- Indexes

-- For sorting/filtering lists by date
CREATE INDEX IF NOT EXISTS idx_sightings_lookup
    ON sightings(upload_id, species_id, observed_at);

-- For filtering by lifer/year lists
CREATE INDEX IF NOT EXISTS idx_sightings_lifer
    ON sightings(upload_id, lifer);

CREATE INDEX IF NOT EXISTS idx_sightings_year
    ON sightings(upload_id, year);

-- For vector tile generation. Optimised to use `vis_rank` for sampling
-- density. Note that spatial filtering is handled by the R-tree, so this index
-- only needs to support the filter criteria, not the lat/lon coordinates.
CREATE INDEX IF NOT EXISTS idx_sightings_vis_rank
    ON sightings(upload_id, vis_rank);

-- Tick bitmap storage for efficient lifer/year/country filtering

CREATE TABLE IF NOT EXISTS tick_bitmaps (
    upload_id BLOB NOT NULL,
    bitmap_type TEXT NOT NULL, -- 'lifer', 'year_tick', 'country_tick'
    bitmap_key TEXT, -- '' for lifer, year (e.g., '2023') for year_tick, country_code for country_tick
    bitmap_data BLOB NOT NULL, -- Serialized Roaring bitmap
    PRIMARY KEY (upload_id, bitmap_type, bitmap_key),
    FOREIGN KEY(upload_id) REFERENCES uploads(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tick_bitmaps_upload
    ON tick_bitmaps(upload_id);
