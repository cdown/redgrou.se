--- Data backfill for stratified sampling of vis_rank

UPDATE sightings
SET vis_rank = 0
WHERE id IN (
    SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
            PARTITION BY upload_id, CAST(latitude AS INTEGER), CAST(longitude AS INTEGER)
            ORDER BY vis_rank ASC
        ) as rn
        FROM sightings
    ) WHERE rn = 1
);
