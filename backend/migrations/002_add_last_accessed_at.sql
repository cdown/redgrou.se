ALTER TABLE uploads ADD COLUMN last_accessed_at TEXT;

UPDATE uploads SET last_accessed_at = created_at WHERE last_accessed_at IS NULL;

