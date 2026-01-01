use crate::db::{self, DbPools, DbQueryError};
use crate::error::ApiError;
use crate::filter::{build_filter_clause, CountQuery, FilterRequest, TableAliases};
use crate::proto::{pb, Proto};
use crate::upload::get_upload_data_version;
use axum::extract::{Path, Query, State};
use sqlx::Row;
use uuid::Uuid;

pub async fn get_stats(
    State(pools): State<DbPools>,
    Path(upload_id): Path<String>,
    Query(query): Query<CountQuery>,
) -> Result<Proto<pb::StatsResponse>, ApiError> {
    let upload_uuid = Uuid::parse_str(&upload_id)
        .map_err(|_| ApiError::bad_request("Invalid upload_id format"))?;
    let data_version = get_upload_data_version(pools.read(), &upload_uuid).await?;

    let needs_join = if let Some(filter_json) = &query.filter {
        let filter: crate::filter::FilterGroup = filter_json.try_into()?;
        filter.needs_species_join()
    } else {
        false
    };

    let aliases = if needs_join {
        TableAliases::new(Some("s"), Some("sp"))
    } else {
        TableAliases::new(None, None)
    };

    let tick_visibility = query.tick_visibility()?;
    let filter_sql = build_filter_clause(FilterRequest {
        pool: pools.read(),
        upload_id: &upload_uuid.as_bytes()[..],
        filter_json: query.filter.as_ref(),
        year_tick_year: query.year_tick_year,
        country_tick_country: query.country_tick_country.as_ref(),
        aliases,
        tick_visibility: &tick_visibility,
    })
    .await?;

    let (table_name, join_clause) = if needs_join {
        ("sightings s", " JOIN species sp ON s.species_id = sp.id")
    } else {
        ("sightings", "")
    };

    let sightings_prefix = if needs_join { "s." } else { "" };

    let base_query = format!(
        "SELECT
            COUNT(*) as total_sightings,
            SUM(CASE WHEN {prefix}lifer = 1 THEN 1 ELSE 0 END) as total_lifers,
            SUM(CASE WHEN {prefix}year_tick = 1 THEN 1 ELSE 0 END) as total_year_ticks,
            SUM(CASE WHEN {prefix}country_tick = 1 THEN 1 ELSE 0 END) as total_country_ticks,
            COUNT(DISTINCT {prefix}species_id) as total_species,
            COUNT(DISTINCT {prefix}country_code) as total_countries,
            COUNT(DISTINCT {prefix}region_code) as total_regions,
            MIN({prefix}observed_at) as first_sighting,
            MAX({prefix}observed_at) as latest_sighting,
            SUM({prefix}count) as total_individuals
         FROM {table}{join}
         WHERE {prefix}upload_id = ?{filter}",
        prefix = sightings_prefix,
        table = table_name,
        join = join_clause,
        filter = filter_sql.clause()
    );

    let mut db_query = sqlx::query(&base_query).bind(&upload_uuid.as_bytes()[..]);
    for param in filter_sql.params() {
        db_query = db_query.bind(param);
    }

    let row = db::query_with_timeout(db_query.fetch_one(pools.read()))
        .await
        .map_err(|e| e.into_api_error("computing stats", "Database error"))?;

    let total_sightings: i64 = row.get("total_sightings");
    let total_lifers: i64 = row.get("total_lifers");
    let total_year_ticks: i64 = row.get("total_year_ticks");
    let total_country_ticks: i64 = row.get("total_country_ticks");
    let total_species: i64 = row.get("total_species");
    let total_countries: i64 = row.get("total_countries");
    let total_regions: i64 = row.get("total_regions");
    let first_sighting: Option<String> = row.get("first_sighting");
    let latest_sighting: Option<String> = row.get("latest_sighting");
    let total_individuals: Option<i64> = row.get("total_individuals");

    let hours_birding_minutes =
        compute_birding_time(pools.read(), &upload_uuid, &filter_sql, needs_join)
            .await
            .map_err(|e| e.into_api_error("computing birding time", "Database error"))?;

    let top_species = get_top_species(pools.read(), &upload_uuid, &filter_sql, needs_join)
        .await
        .map_err(|e| e.into_api_error("loading top species", "Database error"))?;

    let country_stats = get_country_stats(pools.read(), &upload_uuid, &filter_sql, needs_join)
        .await
        .map_err(|e| e.into_api_error("loading country stats", "Database error"))?;

    let (lifers_timeline, sightings_timeline) =
        compute_timelines(pools.read(), &upload_uuid, &filter_sql, needs_join)
            .await
            .map_err(|e| e.into_api_error("computing timelines", "Database error"))?;

    let longest_streak_days =
        compute_longest_streak(pools.read(), &upload_uuid, &filter_sql, needs_join)
            .await
            .map_err(|e| e.into_api_error("computing longest streak", "Database error"))?;

    Ok(Proto::new(pb::StatsResponse {
        total_sightings,
        total_lifers,
        total_year_ticks,
        total_country_ticks,
        total_species,
        total_countries,
        total_regions,
        hours_birding_minutes,
        first_sighting_date: first_sighting,
        latest_sighting_date: latest_sighting,
        top_species,
        country_stats,
        data_version,
        total_individuals: total_individuals.unwrap_or(0),
        total_distance_km: None,
        lifers_timeline,
        sightings_timeline,
        longest_streak_days,
    }))
}

async fn compute_birding_time(
    pool: &sqlx::SqlitePool,
    upload_uuid: &Uuid,
    filter_sql: &crate::filter::FilterSql,
    needs_join: bool,
) -> Result<i64, DbQueryError> {
    let (table_name, join_clause) = if needs_join {
        ("sightings s", " JOIN species sp ON s.species_id = sp.id")
    } else {
        ("sightings", "")
    };

    let sightings_prefix = if needs_join { "s." } else { "" };

    let sql = format!(
        "SELECT
            CAST((strftime('%s', {prefix}observed_at) / 600) AS INTEGER) as time_bucket
         FROM {table}{join}
         WHERE {prefix}upload_id = ?{filter}
         GROUP BY time_bucket",
        prefix = sightings_prefix,
        table = table_name,
        join = join_clause,
        filter = filter_sql.clause()
    );

    let mut db_query = sqlx::query(&sql).bind(&upload_uuid.as_bytes()[..]);
    for param in filter_sql.params() {
        db_query = db_query.bind(param);
    }

    let rows = db::query_with_timeout(db_query.fetch_all(pool)).await?;

    Ok(rows.len() as i64 * 10)
}

async fn get_top_species(
    pool: &sqlx::SqlitePool,
    upload_uuid: &Uuid,
    filter_sql: &crate::filter::FilterSql,
    needs_join: bool,
) -> Result<Vec<pb::SpeciesCount>, DbQueryError> {
    let (table_name, join_clause) = if needs_join {
        ("sightings s", " JOIN species sp ON s.species_id = sp.id")
    } else {
        ("sightings s", " JOIN species sp ON s.species_id = sp.id")
    };

    let sql = format!(
        "SELECT sp.common_name, sp.scientific_name, COUNT(*) as cnt
         FROM {table}{join}
         WHERE s.upload_id = ?{filter}
         GROUP BY sp.id
         ORDER BY cnt DESC
         LIMIT 20",
        table = table_name,
        join = join_clause,
        filter = filter_sql.clause()
    );

    let mut db_query = sqlx::query(&sql).bind(&upload_uuid.as_bytes()[..]);
    for param in filter_sql.params() {
        db_query = db_query.bind(param);
    }

    let rows = db::query_with_timeout(db_query.fetch_all(pool)).await?;

    Ok(rows
        .iter()
        .map(|row| pb::SpeciesCount {
            common_name: row.get("common_name"),
            scientific_name: row.get("scientific_name"),
            count: row.get::<i64, _>("cnt"),
        })
        .collect())
}

async fn get_country_stats(
    pool: &sqlx::SqlitePool,
    upload_uuid: &Uuid,
    filter_sql: &crate::filter::FilterSql,
    needs_join: bool,
) -> Result<Vec<pb::CountryStats>, DbQueryError> {
    let (table_name, join_clause) = if needs_join {
        ("sightings s", " JOIN species sp ON s.species_id = sp.id")
    } else {
        ("sightings", "")
    };

    let sightings_prefix = if needs_join { "s." } else { "" };

    let sql = format!(
        "SELECT
            {prefix}country_code,
            COUNT(*) as sightings,
            SUM(CASE WHEN {prefix}lifer = 1 THEN 1 ELSE 0 END) as lifers
         FROM {table}{join}
         WHERE {prefix}upload_id = ?{filter}
           AND {prefix}country_code IS NOT NULL
         GROUP BY {prefix}country_code
         ORDER BY lifers DESC",
        prefix = sightings_prefix,
        table = table_name,
        join = join_clause,
        filter = filter_sql.clause()
    );

    let mut db_query = sqlx::query(&sql).bind(&upload_uuid.as_bytes()[..]);
    for param in filter_sql.params() {
        db_query = db_query.bind(param);
    }

    let rows = db::query_with_timeout(db_query.fetch_all(pool)).await?;

    Ok(rows
        .iter()
        .map(|row| pb::CountryStats {
            country_code: row.get("country_code"),
            sightings: row.get::<i64, _>("sightings"),
            lifers: row.get::<i64, _>("lifers"),
        })
        .collect())
}

async fn compute_timelines(
    pool: &sqlx::SqlitePool,
    upload_uuid: &Uuid,
    filter_sql: &crate::filter::FilterSql,
    needs_join: bool,
) -> Result<(Vec<pb::TimelinePoint>, Vec<pb::TimelinePoint>), DbQueryError> {
    let (table_name, join_clause) = if needs_join {
        ("sightings s", " JOIN species sp ON s.species_id = sp.id")
    } else {
        ("sightings", "")
    };

    let sightings_prefix = if needs_join { "s." } else { "" };

    let sql = format!(
        "SELECT
            DATE({prefix}observed_at) as date,
            {prefix}lifer
         FROM {table}{join}
         WHERE {prefix}upload_id = ?{filter}
         ORDER BY {prefix}observed_at",
        prefix = sightings_prefix,
        table = table_name,
        join = join_clause,
        filter = filter_sql.clause()
    );

    let mut db_query = sqlx::query(&sql).bind(&upload_uuid.as_bytes()[..]);
    for param in filter_sql.params() {
        db_query = db_query.bind(param);
    }

    let rows = db::query_with_timeout(db_query.fetch_all(pool)).await?;

    let mut lifers_by_date = std::collections::HashMap::new();
    let mut sightings_by_date = std::collections::HashMap::new();

    for row in rows {
        let date: String = row.get("date");
        let is_lifer: i64 = row.get("lifer");

        *sightings_by_date.entry(date.clone()).or_insert(0) += 1;
        if is_lifer == 1 {
            *lifers_by_date.entry(date).or_insert(0) += 1;
        }
    }

    let mut dates: Vec<String> = sightings_by_date.keys().cloned().collect();
    dates.sort();

    if dates.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }

    // Fill in missing dates to create continuous timeline
    let first_date = dates.first().unwrap();
    let last_date = dates.last().unwrap();

    let start = chrono::NaiveDate::parse_from_str(first_date, "%Y-%m-%d").unwrap();
    let end = chrono::NaiveDate::parse_from_str(last_date, "%Y-%m-%d").unwrap();

    let mut cumulative_lifers = 0i64;
    let mut cumulative_sightings = 0i64;

    let mut lifers_timeline = Vec::new();
    let mut sightings_timeline = Vec::new();

    let mut current = start;
    while current <= end {
        let date_str = current.format("%Y-%m-%d").to_string();

        cumulative_sightings += sightings_by_date.get(&date_str).copied().unwrap_or(0);
        cumulative_lifers += lifers_by_date.get(&date_str).copied().unwrap_or(0);

        lifers_timeline.push(pb::TimelinePoint {
            date: date_str.clone(),
            count: cumulative_lifers,
        });

        sightings_timeline.push(pb::TimelinePoint {
            date: date_str,
            count: cumulative_sightings,
        });

        current += chrono::Duration::days(1);
    }

    Ok((lifers_timeline, sightings_timeline))
}

async fn compute_longest_streak(
    pool: &sqlx::SqlitePool,
    upload_uuid: &Uuid,
    filter_sql: &crate::filter::FilterSql,
    needs_join: bool,
) -> Result<i64, DbQueryError> {
    let (table_name, join_clause) = if needs_join {
        ("sightings s", " JOIN species sp ON s.species_id = sp.id")
    } else {
        ("sightings", "")
    };

    let sightings_prefix = if needs_join { "s." } else { "" };

    let sql = format!(
        "SELECT DISTINCT DATE({prefix}observed_at) as date
         FROM {table}{join}
         WHERE {prefix}upload_id = ?{filter}
         ORDER BY date",
        prefix = sightings_prefix,
        table = table_name,
        join = join_clause,
        filter = filter_sql.clause()
    );

    let mut db_query = sqlx::query(&sql).bind(&upload_uuid.as_bytes()[..]);
    for param in filter_sql.params() {
        db_query = db_query.bind(param);
    }

    let rows = db::query_with_timeout(db_query.fetch_all(pool)).await?;

    if rows.is_empty() {
        return Ok(0);
    }

    let dates: Vec<chrono::NaiveDate> = rows
        .iter()
        .filter_map(|row| {
            let date_str: String = row.get("date");
            chrono::NaiveDate::parse_from_str(&date_str, "%Y-%m-%d").ok()
        })
        .collect();

    let mut longest_streak = 1i64;
    let mut current_streak = 1i64;

    for window in dates.windows(2) {
        let diff = window[1].signed_duration_since(window[0]).num_days();
        if diff == 1 {
            current_streak += 1;
            longest_streak = longest_streak.max(current_streak);
        } else {
            current_streak = 1;
        }
    }

    Ok(longest_streak)
}
