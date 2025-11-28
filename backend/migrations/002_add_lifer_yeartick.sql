ALTER TABLE sightings ADD COLUMN lifer INTEGER DEFAULT 0;
ALTER TABLE sightings ADD COLUMN year_tick INTEGER DEFAULT 0;
ALTER TABLE sightings ADD COLUMN year INTEGER;

CREATE INDEX IF NOT EXISTS idx_sightings_lifer ON sightings(upload_id, lifer);
CREATE INDEX IF NOT EXISTS idx_sightings_year ON sightings(upload_id, year);
