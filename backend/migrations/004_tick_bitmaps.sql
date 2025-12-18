-- Roaring Bitmap storage for efficient tick filtering
-- Bitmaps store sighting.id values (INTEGER) for fast membership testing

CREATE TABLE IF NOT EXISTS tick_bitmaps (
    upload_id BLOB NOT NULL,
    bitmap_type TEXT NOT NULL, -- 'lifer', 'year_tick', 'country_tick'
    bitmap_key TEXT, -- '' for lifer, year (e.g., '2023') for year_tick, country_code for country_tick
    bitmap_data BLOB NOT NULL, -- Serialized Roaring bitmap
    PRIMARY KEY (upload_id, bitmap_type, bitmap_key),
    FOREIGN KEY(upload_id) REFERENCES uploads(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tick_bitmaps_upload
    ON tick_bitmaps(upload_id);

