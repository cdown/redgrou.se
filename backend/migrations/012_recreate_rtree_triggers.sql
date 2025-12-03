-- Recreate R-tree triggers that were dropped during species normalisation
-- When the sightings table was dropped and recreated in migration 011, the
-- R-tree triggers were also dropped. This migration recreates them so new
-- uploads are properly indexed in the spatial R-Tree.

DROP TRIGGER IF EXISTS sightings_geo_insert;
CREATE TRIGGER sightings_geo_insert
AFTER INSERT ON sightings
BEGIN
    INSERT OR REPLACE INTO sightings_geo (id, min_lat, max_lat, min_lon, max_lon)
    VALUES (NEW.id, NEW.latitude, NEW.latitude, NEW.longitude, NEW.longitude);
END;

DROP TRIGGER IF EXISTS sightings_geo_update;
CREATE TRIGGER sightings_geo_update
AFTER UPDATE OF latitude, longitude ON sightings
BEGIN
    INSERT OR REPLACE INTO sightings_geo (id, min_lat, max_lat, min_lon, max_lon)
    VALUES (NEW.id, NEW.latitude, NEW.latitude, NEW.longitude, NEW.longitude);
END;

DROP TRIGGER IF EXISTS sightings_geo_delete;
CREATE TRIGGER sightings_geo_delete
AFTER DELETE ON sightings
BEGIN
    DELETE FROM sightings_geo WHERE id = OLD.id;
END;

-- Backfill any sightings that were inserted between migration 011 and this one
-- (they would have been missed because the triggers were missing)
INSERT OR REPLACE INTO sightings_geo (id, min_lat, max_lat, min_lon, max_lon)
SELECT id, latitude, latitude, longitude, longitude
FROM sightings
WHERE id NOT IN (SELECT id FROM sightings_geo);
