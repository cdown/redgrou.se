-- no-transaction

CREATE VIRTUAL TABLE IF NOT EXISTS sightings_geo
USING rtree(
    id,
    min_lat,
    max_lat,
    min_lon,
    max_lon
);

INSERT OR REPLACE INTO sightings_geo (id, min_lat, max_lat, min_lon, max_lon)
SELECT id, latitude, latitude, longitude, longitude
FROM sightings;

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
