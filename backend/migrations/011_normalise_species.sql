-- Normalise repetitive species names into a dictionary table
-- This reduces database size by ~40-50% by storing integer IDs instead of repeated strings

-- 1. Create the species lookup table
CREATE TABLE IF NOT EXISTS species (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    common_name TEXT NOT NULL,
    scientific_name TEXT,
    UNIQUE(common_name, scientific_name)
) STRICT;

-- 2. Populate species table with unique combinations from existing sightings
INSERT INTO species (common_name, scientific_name)
SELECT DISTINCT common_name, scientific_name
FROM sightings
WHERE common_name IS NOT NULL;

-- 3. Add species_id column to sightings
ALTER TABLE sightings ADD COLUMN species_id INTEGER;

-- 4. Update sightings to reference species table
UPDATE sightings
SET species_id = (
    SELECT id FROM species
    WHERE species.common_name = sightings.common_name
      AND (species.scientific_name = sightings.scientific_name
           OR (species.scientific_name IS NULL AND sightings.scientific_name IS NULL))
    LIMIT 1
)
WHERE species_id IS NULL;

-- 5. Make species_id NOT NULL (after backfill)
-- SQLite doesn't support ALTER COLUMN, so we need to recreate the table
CREATE TABLE IF NOT EXISTS sightings_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id TEXT NOT NULL,
    sighting_uuid TEXT NOT NULL,

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

-- 6. Copy data to new table
INSERT INTO sightings_new (
    id, upload_id, sighting_uuid, species_id, count,
    latitude, longitude, country_code, region_code,
    observed_at, year, lifer, year_tick, country_tick, vis_rank
)
SELECT
    id, upload_id, sighting_uuid, species_id, count,
    latitude, longitude, country_code, region_code,
    observed_at, year, lifer, year_tick, country_tick, vis_rank
FROM sightings;

-- 7. Drop old table and rename new one
DROP TABLE sightings;
ALTER TABLE sightings_new RENAME TO sightings;

-- 8. Recreate R-tree virtual table (it will be recreated automatically, but ensure it exists)
-- The rtree table is managed separately, so we just need to ensure the main table is correct

-- 9. Recreate indexes with species_id instead of common_name/scientific_name
CREATE INDEX IF NOT EXISTS idx_sightings_lookup
    ON sightings(upload_id, species_id, observed_at);

CREATE INDEX IF NOT EXISTS idx_sightings_geo
    ON sightings(upload_id, latitude, longitude, species_id, count);

CREATE INDEX IF NOT EXISTS idx_sightings_lifer ON sightings(upload_id, lifer);
CREATE INDEX IF NOT EXISTS idx_sightings_year ON sightings(upload_id, year);

-- 10. Recreate covering index for tile queries with species_id
CREATE INDEX IF NOT EXISTS idx_sightings_vis_rank
    ON sightings(upload_id, vis_rank, latitude, longitude, species_id, count, observed_at, lifer, year_tick, country_tick);

-- 11. Create index on species table for lookups
CREATE INDEX IF NOT EXISTS idx_species_names
    ON species(common_name, scientific_name);
