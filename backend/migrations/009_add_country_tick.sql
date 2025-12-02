ALTER TABLE sightings ADD COLUMN country_tick INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sightings_country_tick ON sightings(upload_id, country_tick, country_code);
