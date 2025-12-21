use crate::error::ApiError;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::future::Future;
use std::str::FromStr;
use std::time::Duration;
use tokio::time;
use tracing::{error, info};

const WAL_AUTOCHECKPOINT_PAGES: usize = 1024;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const DB_TIMEOUT_MESSAGE: &str = "Database is busy, please retry";

// SQLite is single writer only, having more in the pool just results in locking and other issues.
// So instead just queue it on our side until SQLite is free again.
const WRITE_POOL_MAX_CONNECTIONS: u32 = 1;
const READ_POOL_MAX_CONNECTIONS: u32 = 100;

#[derive(Clone)]
pub struct DbPools {
    read: SqlitePool,
    write: SqlitePool,
}

impl DbPools {
    pub fn read(&self) -> &SqlitePool {
        &self.read
    }

    pub fn write(&self) -> &SqlitePool {
        &self.write
    }
}

fn build_connection_options(database_url: &str) -> Result<SqliteConnectOptions, sqlx::Error> {
    Ok(SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .pragma("foreign_keys", "ON")
        .pragma("mmap_size", "314572800")
        .pragma("wal_autocheckpoint", WAL_AUTOCHECKPOINT_PAGES.to_string())
        .busy_timeout(BUSY_TIMEOUT))
}

pub async fn init_pool(database_url: &str) -> Result<DbPools, sqlx::Error> {
    let options = build_connection_options(database_url)?;

    let read_pool = SqlitePoolOptions::new()
        .max_connections(READ_POOL_MAX_CONNECTIONS)
        .acquire_timeout(Duration::from_secs(30))
        .connect_with(options.clone())
        .await?;

    let write_pool = SqlitePoolOptions::new()
        .max_connections(WRITE_POOL_MAX_CONNECTIONS)
        .acquire_timeout(Duration::from_secs(30))
        .connect_with(options)
        .await?;

    info!(
        "DB pools initialised (read: {}, write: {})",
        READ_POOL_MAX_CONNECTIONS, WRITE_POOL_MAX_CONNECTIONS
    );

    Ok(DbPools {
        read: read_pool,
        write: write_pool,
    })
}

pub async fn run_migrations(pools: &DbPools) -> Result<(), sqlx::Error> {
    sqlx::migrate!("./migrations").run(pools.write()).await?;
    info!("Database migrations completed");
    Ok(())
}

pub async fn vacuum_database(pools: &DbPools) {
    info!("Running database vacuum");
    let start = std::time::Instant::now();

    match sqlx::query("VACUUM").execute(pools.write()).await {
        Ok(_) => {
            let duration = start.elapsed();
            info!("Database vacuum completed in {:?}", duration);
        }
        Err(err) => {
            error!("Database vacuum failed: {}", err);
        }
    }
}

#[derive(Debug)]
pub enum DbQueryError {
    Timeout,
    Sqlx(sqlx::Error),
}

impl From<sqlx::Error> for DbQueryError {
    fn from(err: sqlx::Error) -> Self {
        Self::Sqlx(err)
    }
}

pub async fn query_with_timeout<F, T>(future: F) -> Result<T, DbQueryError>
where
    F: Future<Output = Result<T, sqlx::Error>>,
{
    match time::timeout(QUERY_TIMEOUT, future).await {
        Ok(result) => result.map_err(Into::into),
        Err(_) => Err(DbQueryError::Timeout),
    }
}

impl DbQueryError {
    pub fn into_api_error(self, context: &'static str, client_message: &'static str) -> ApiError {
        match self {
            Self::Timeout => {
                error!("Database timeout while {}", context);
                ApiError::service_unavailable(DB_TIMEOUT_MESSAGE)
            }
            Self::Sqlx(err) => {
                error!("Database error while {}: {}", context, err);
                ApiError::internal(client_message)
            }
        }
    }

    pub fn log(self, context: &'static str) {
        match self {
            DbQueryError::Timeout => error!("Database timeout while {}", context),
            DbQueryError::Sqlx(err) => error!("Database error while {}: {}", context, err),
        }
    }
}
