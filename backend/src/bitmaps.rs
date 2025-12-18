use crate::db::{self, DbQueryError};
use crate::error::ApiError;
use roaring::RoaringBitmap;
use sqlx::SqlitePool;

pub async fn compute_and_store_bitmaps(
    pool: &SqlitePool,
    upload_id_blob: &[u8],
) -> Result<(), ApiError> {
    // Delete existing bitmaps for this upload (in case of update)
    db::query_with_timeout(
        sqlx::query("DELETE FROM tick_bitmaps WHERE upload_id = ?")
            .bind(upload_id_blob)
            .execute(pool),
    )
    .await
    .map_err(|e| e.into_api_error("deleting existing bitmaps", "Database error"))?;

    // Compute lifer bitmap
    let lifer_ids: Vec<i64> = db::query_with_timeout(
        sqlx::query_scalar::<_, i64>("SELECT id FROM sightings WHERE upload_id = ? AND lifer = 1")
            .bind(upload_id_blob)
            .fetch_all(pool),
    )
    .await
    .map_err(|e| e.into_api_error("querying lifer sightings", "Database error"))?;

    if !lifer_ids.is_empty() {
        let mut bitmap = RoaringBitmap::new();
        for id in lifer_ids {
            bitmap.insert(id as u32);
        }
        let mut bitmap_data = Vec::new();
        bitmap
            .serialize_into(&mut bitmap_data)
            .map_err(|e| ApiError::internal(format!("Failed to serialize bitmap: {}", e)))?;
        db::query_with_timeout(
            sqlx::query(
                "INSERT INTO tick_bitmaps (upload_id, bitmap_type, bitmap_key, bitmap_data) VALUES (?, 'lifer', '', ?)",
            )
            .bind(upload_id_blob)
            .bind(&bitmap_data)
            .execute(pool),
        )
        .await
        .map_err(|e| e.into_api_error("storing lifer bitmap", "Database error"))?;
    }

    // Compute year tick bitmaps (one per year)
    let year_tick_rows: Vec<(i32, i64)> = db::query_with_timeout(
        sqlx::query_as::<_, (i32, i64)>(
            "SELECT year, id FROM sightings WHERE upload_id = ? AND year_tick = 1",
        )
        .bind(upload_id_blob)
        .fetch_all(pool),
    )
    .await
    .map_err(|e| e.into_api_error("querying year tick sightings", "Database error"))?;

    // Group by year
    let mut year_bitmaps: std::collections::HashMap<i32, RoaringBitmap> =
        std::collections::HashMap::new();
    for (year, id) in year_tick_rows {
        year_bitmaps
            .entry(year)
            .or_insert_with(RoaringBitmap::new)
            .insert(id as u32);
    }

    for (year, bitmap) in year_bitmaps {
        let mut bitmap_data = Vec::new();
        bitmap
            .serialize_into(&mut bitmap_data)
            .map_err(|e| ApiError::internal(format!("Failed to serialize bitmap: {}", e)))?;
        db::query_with_timeout(
            sqlx::query(
                "INSERT INTO tick_bitmaps (upload_id, bitmap_type, bitmap_key, bitmap_data) VALUES (?, 'year_tick', ?, ?)",
            )
            .bind(upload_id_blob)
            .bind(year.to_string())
            .bind(&bitmap_data)
            .execute(pool),
        )
        .await
        .map_err(|e| e.into_api_error("storing year tick bitmap", "Database error"))?;
    }

    // Compute country tick bitmaps (one per country)
    let country_tick_rows: Vec<(String, i64)> = db::query_with_timeout(
        sqlx::query_as::<_, (String, i64)>(
            "SELECT country_code, id FROM sightings WHERE upload_id = ? AND country_tick = 1 AND country_code IS NOT NULL AND country_code != '' AND country_code != 'XX'",
        )
        .bind(upload_id_blob)
        .fetch_all(pool),
    )
    .await
    .map_err(|e| e.into_api_error("querying country tick sightings", "Database error"))?;

    // Group by country
    let mut country_bitmaps: std::collections::HashMap<String, RoaringBitmap> =
        std::collections::HashMap::new();
    for (country, id) in country_tick_rows {
        country_bitmaps
            .entry(country)
            .or_insert_with(RoaringBitmap::new)
            .insert(id as u32);
    }

    for (country, bitmap) in country_bitmaps {
        let mut bitmap_data = Vec::new();
        bitmap
            .serialize_into(&mut bitmap_data)
            .map_err(|e| ApiError::internal(format!("Failed to serialize bitmap: {}", e)))?;
        db::query_with_timeout(
            sqlx::query(
                "INSERT INTO tick_bitmaps (upload_id, bitmap_type, bitmap_key, bitmap_data) VALUES (?, 'country_tick', ?, ?)",
            )
            .bind(upload_id_blob)
            .bind(&country)
            .bind(&bitmap_data)
            .execute(pool),
        )
        .await
        .map_err(|e| e.into_api_error("storing country tick bitmap", "Database error"))?;
    }

    Ok(())
}

pub async fn load_bitmap(
    pool: &SqlitePool,
    upload_id_blob: &[u8],
    bitmap_type: &str,
    bitmap_key: Option<&str>,
) -> Result<Option<RoaringBitmap>, DbQueryError> {
    let row: Option<(Vec<u8>,)> = db::query_with_timeout(
        sqlx::query_as::<_, (Vec<u8>,)>(
            "SELECT bitmap_data FROM tick_bitmaps WHERE upload_id = ? AND bitmap_type = ? AND bitmap_key = ?",
        )
        .bind(upload_id_blob)
        .bind(bitmap_type)
        .bind(bitmap_key.unwrap_or(""))
        .fetch_optional(pool),
    )
    .await?;

    match row {
        Some((data,)) => {
            let bitmap = RoaringBitmap::deserialize_from(&data[..]).map_err(|e| {
                DbQueryError::Sqlx(sqlx::Error::Decode(
                    format!("Failed to deserialize bitmap: {}", e).into(),
                ))
            })?;
            Ok(Some(bitmap))
        }
        None => Ok(None),
    }
}
