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

pub async fn init_pool(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .pragma("foreign_keys", "ON")
        .pragma("mmap_size", "314572800")
        .pragma("wal_autocheckpoint", WAL_AUTOCHECKPOINT_PAGES.to_string())
        .busy_timeout(BUSY_TIMEOUT);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(30))
        .connect_with(options)
        .await?;

    info!("DB pool initialised");

    Ok(pool)
}

pub async fn run_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::migrate!("./migrations").run(pool).await?;
    info!("Database migrations completed");
    Ok(())
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
            DbQueryError::Timeout => {
                error!("Database timeout while {}", context);
                ApiError::service_unavailable(DB_TIMEOUT_MESSAGE)
            }
            DbQueryError::Sqlx(err) => {
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
