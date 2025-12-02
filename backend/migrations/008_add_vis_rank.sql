-- Add a visibility rank column for efficient tile sampling.
-- This allows us to sample points using a simple range query (vis_rank < X)
-- instead of expensive window functions or random ordering at query time.

ALTER TABLE sightings ADD COLUMN vis_rank INTEGER DEFAULT 0;

-- Backfill existing data with random ranks (0-10000)
-- We use ABS(RANDOM()) % 10001 to generate a value between 0 and 10000
UPDATE sightings SET vis_rank = ABS(RANDOM()) % 10001 WHERE vis_rank = 0;

-- Boost visibility of existing lifers and year ticks (rank 0 = highest priority).
-- This ensures 'important' sightings are seen even at world-view zoom levels.
UPDATE sightings SET vis_rank = 0 WHERE lifer = 1 OR year_tick = 1;

-- Create a covering index for tile queries that includes all selected columns.
-- This allows SQLite to satisfy the entire query from the index without
-- touching the main table, dramatically improving performance.
-- Index order: filter columns first (upload_id, vis_rank), then all selected columns.
CREATE INDEX IF NOT EXISTS idx_sightings_vis_rank
    ON sightings(upload_id, vis_rank, latitude, longitude, common_name, scientific_name, count, observed_at, lifer, year_tick);
