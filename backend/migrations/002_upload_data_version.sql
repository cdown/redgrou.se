ALTER TABLE uploads
ADD COLUMN data_version INTEGER NOT NULL DEFAULT 1;

UPDATE uploads
SET data_version = 1
WHERE data_version IS NULL;

