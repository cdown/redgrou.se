-- Drop redundant indexes to reduce database size
-- This migration reduces database size by approximately 22-27%

-- 1. Drop IDX_SIGHTINGS_GEO
-- This index is redundant because:
--   - We already have an R-Tree (sightings_geo) for spatial bounding-box queries
--   - The IDX_SIGHTINGS_VIS_RANK index handles the tile generation queries
--   - The tile query uses the R-tree for spatial filtering, then joins back to sightings
-- Benefit: Saves approximately 12% of database size
DROP INDEX IF EXISTS idx_sightings_geo;

-- 2. Optimise IDX_SIGHTINGS_VIS_RANK
-- Current state: Covering index including latitude, longitude, species_id, count,
--                observed_at, lifer, year_tick, country_tick
-- New state: Standard index on just (upload_id, vis_rank)
-- Reason: The covering index duplicates nearly the entire table. SQLite is fast
--         enough to perform the row lookup (using the implicit rowid) after
--         filtering by vis_rank. The trade-off is one additional rowid lookup
--         per matching row, but the index size reduction is significant.
-- Benefit: Saves approximately 10-15% of database size
DROP INDEX IF EXISTS idx_sightings_vis_rank;

CREATE INDEX idx_sightings_vis_rank
    ON sightings(upload_id, vis_rank);
