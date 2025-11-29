DROP INDEX IF EXISTS idx_sightings_geo;

CREATE INDEX idx_sightings_geo ON sightings(upload_id, latitude, longitude, common_name, count);
