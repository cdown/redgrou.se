use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::spawn;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct UploadLimiter {
    max_concurrent: usize,
    rate_limit: u64,
    window: Duration,
    writer_budget: Duration,
    writer_window: Duration,
    sightings_limit: u64,
    sightings_window: Duration,
    state: Arc<Mutex<HashMap<String, UploadState>>>,
}

struct UploadState {
    active: usize,
    window_start: Instant,
    window_count: u64,
    writer_window_start: Instant,
    writer_usage: Duration,
    sightings_window_start: Instant,
    sightings_count: u64,
}

#[derive(Debug, Clone)]
pub enum UploadLimitError {
    ActiveUpload,
    RateLimited,
    WriterBudgetExceeded { retry_after: Duration },
    SightingsQuotaExceeded { retry_after: Duration },
}

#[derive(Clone)]
pub struct UploadUsageTracker {
    inner: UploadUsageTrackerInner,
}

#[derive(Clone)]
enum UploadUsageTrackerInner {
    Active { limiter: UploadLimiter, key: String },
    Disabled,
}

impl UploadUsageTracker {
    pub fn disabled() -> Self {
        Self {
            inner: UploadUsageTrackerInner::Disabled,
        }
    }

    pub(crate) fn new(limiter: UploadLimiter, key: String) -> Self {
        Self {
            inner: UploadUsageTrackerInner::Active { limiter, key },
        }
    }

    pub async fn record_writer_usage(&self, duration: Duration) {
        if duration.is_zero() {
            return;
        }

        if let UploadUsageTrackerInner::Active { limiter, key } = &self.inner {
            limiter.add_writer_usage(key, duration).await;
        }
    }

    pub async fn reserve_sightings(&self, count: u64) -> Result<(), UploadLimitError> {
        if count == 0 {
            return Ok(());
        }

        match &self.inner {
            UploadUsageTrackerInner::Active { limiter, key } => {
                limiter.try_add_sightings(key, count).await
            }
            UploadUsageTrackerInner::Disabled => Ok(()),
        }
    }
}

impl Default for UploadUsageTracker {
    fn default() -> Self {
        Self::disabled()
    }
}

impl UploadLimiter {
    pub fn new(
        max_concurrent: usize,
        rate_limit: u64,
        window: Duration,
        writer_budget: Duration,
        writer_window: Duration,
        sightings_limit: u64,
        sightings_window: Duration,
    ) -> Self {
        Self {
            max_concurrent,
            rate_limit,
            window,
            writer_budget,
            writer_window,
            sightings_limit,
            sightings_window,
            state: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn try_start(&self, key: &str) -> Result<UploadGuard, UploadLimitError> {
        let mut state = self.state.lock().await;
        let entry = state.entry(key.to_string()).or_insert(UploadState {
            active: 0,
            window_start: Instant::now(),
            window_count: 0,
            writer_window_start: Instant::now(),
            writer_usage: Duration::ZERO,
            sightings_window_start: Instant::now(),
            sightings_count: 0,
        });

        let now = Instant::now();
        Self::refresh_windows(
            entry,
            now,
            self.window,
            self.writer_window,
            self.sightings_window,
        );

        if entry.active >= self.max_concurrent {
            return Err(UploadLimitError::ActiveUpload);
        }

        if entry.window_count >= self.rate_limit {
            return Err(UploadLimitError::RateLimited);
        }

        if self.writer_budget != Duration::ZERO && entry.writer_usage >= self.writer_budget {
            let next_window = entry.writer_window_start + self.writer_window;
            let retry_after = next_window
                .checked_duration_since(now)
                .unwrap_or_else(|| Duration::from_secs(1))
                .max(Duration::from_secs(1));
            return Err(UploadLimitError::WriterBudgetExceeded { retry_after });
        }

        if self.sightings_limit > 0 && entry.sightings_count >= self.sightings_limit {
            let next_window = entry.sightings_window_start + self.sightings_window;
            let retry_after = next_window
                .checked_duration_since(now)
                .unwrap_or_else(|| Duration::from_secs(1))
                .max(Duration::from_secs(1));
            return Err(UploadLimitError::SightingsQuotaExceeded { retry_after });
        }

        entry.active += 1;
        entry.window_count += 1;

        Ok(UploadGuard {
            limiter: Arc::clone(&self.state),
            key: key.to_string(),
        })
    }

    pub fn tracker(&self, key: &str) -> UploadUsageTracker {
        UploadUsageTracker::new(self.clone(), key.to_string())
    }

    pub async fn add_writer_usage(&self, key: &str, duration: Duration) {
        if duration.is_zero() || self.writer_budget == Duration::ZERO {
            return;
        }

        let mut state = self.state.lock().await;
        if let Some(entry) = state.get_mut(key) {
            let now = Instant::now();
            Self::refresh_windows(
                entry,
                now,
                self.window,
                self.writer_window,
                self.sightings_window,
            );
            entry.writer_usage = entry.writer_usage.saturating_add(duration);
        }
    }

    pub async fn try_add_sightings(&self, key: &str, count: u64) -> Result<(), UploadLimitError> {
        if count == 0 || self.sightings_limit == 0 {
            return Ok(());
        }

        let mut state = self.state.lock().await;
        let entry = state.entry(key.to_string()).or_insert(UploadState {
            active: 0,
            window_start: Instant::now(),
            window_count: 0,
            writer_window_start: Instant::now(),
            writer_usage: Duration::ZERO,
            sightings_window_start: Instant::now(),
            sightings_count: 0,
        });

        let now = Instant::now();
        Self::refresh_windows(
            entry,
            now,
            self.window,
            self.writer_window,
            self.sightings_window,
        );

        if entry.sightings_count.saturating_add(count) > self.sightings_limit {
            let next_window = entry.sightings_window_start + self.sightings_window;
            let retry_after = next_window
                .checked_duration_since(now)
                .unwrap_or_else(|| Duration::from_secs(1))
                .max(Duration::from_secs(1));
            return Err(UploadLimitError::SightingsQuotaExceeded { retry_after });
        }

        entry.sightings_count = entry.sightings_count.saturating_add(count);
        Ok(())
    }

    fn refresh_windows(
        entry: &mut UploadState,
        now: Instant,
        request_window: Duration,
        writer_window: Duration,
        sightings_window: Duration,
    ) {
        if now.duration_since(entry.window_start) >= request_window {
            entry.window_start = now;
            entry.window_count = 0;
        }

        if now.duration_since(entry.writer_window_start) >= writer_window {
            entry.writer_window_start = now;
            entry.writer_usage = Duration::ZERO;
        }

        if now.duration_since(entry.sightings_window_start) >= sightings_window {
            entry.sightings_window_start = now;
            entry.sightings_count = 0;
        }
    }
}

pub struct UploadGuard {
    limiter: Arc<Mutex<HashMap<String, UploadState>>>,
    key: String,
}

impl Drop for UploadGuard {
    fn drop(&mut self) {
        let limiter = Arc::clone(&self.limiter);
        let key = self.key.clone();
        spawn(async move {
            let mut state = limiter.lock().await;
            if let Some(entry) = state.get_mut(&key) {
                entry.active = entry.active.saturating_sub(1);
            }
        });
    }
}
