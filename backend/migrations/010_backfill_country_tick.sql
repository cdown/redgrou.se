-- Compute country_tick for all existing uploads
UPDATE sightings SET country_tick = 1 WHERE id IN (
    SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY upload_id, common_name, country_code ORDER BY observed_at) as rn
        FROM sightings WHERE country_code IS NOT NULL
    ) WHERE rn = 1
);
