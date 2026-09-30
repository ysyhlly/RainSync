//! Cached runtime evidence, not a liveness or physical-drain claim.
//!
//! The HTTP path only reads memory. Probes own their resources independently of
//! callers, and a missed deadline never starts another overlapping cache scan.
use axum::response::{IntoResponse, Response};
use sqlx::{Connection, PgPool, Postgres, pool::PoolConnection};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

#[path = "readiness_cache.rs"]
mod cache;

const PROBE_AGE: Duration = Duration::from_secs(6);
const WORK_AGE: Duration = Duration::from_secs(15);
const TOOL_AGE: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ready,
    Failed,
    Unknown,
    Stale,
}

#[derive(Clone, Copy)]
struct Observation {
    outcome: Outcome,
    checked_at: Instant,
}
impl Observation {
    fn outcome(self, now: Instant, max_age: Duration) -> Outcome {
        match now.checked_duration_since(self.checked_at) {
            Some(age) if age <= max_age => self.outcome,
            _ => Outcome::Stale,
        }
    }
}
#[derive(Default)]
struct Evidence {
    probes: BTreeMap<&'static str, Observation>,
    claim: Option<Observation>,
    // No Worker singleton lock exists. None is idle; Some is an actual task
    // lease, conservatively translated from the database's remaining lifetime.
    owned_until: Option<Instant>,
    ownership: Option<Observation>,
}
#[derive(Default)]
struct Inner {
    evidence: Mutex<Evidence>,
    accepting: AtomicBool,
    receipt_pending: AtomicBool,
    drain_failed: AtomicBool,
}
#[derive(Clone, Default)]
pub struct Runtime(Arc<Inner>);

#[derive(Debug, serde::Serialize)]
pub struct Snapshot {
    pub ready: bool,
    pub checks: BTreeMap<&'static str, Outcome>,
}
impl Runtime {
    pub fn accepting(&self, accepting: bool) {
        self.0.accepting.store(accepting, Ordering::Release);
    }
    /// Keep this guard for the entire real queue task. Exit/panic/cancellation
    /// immediately removes readiness; a detached periodic heartbeat cannot hide it.
    pub fn claim_loop_guard(&self) -> ClaimLoopGuard {
        ClaimLoopGuard(self.clone())
    }
    /// This observes task lifetime only, not queue progress or a physical drain.
    pub fn background_task_guard(&self, task: BackgroundTask) -> BackgroundTaskGuard {
        self.observe(task.check(), true);
        BackgroundTaskGuard {
            runtime: self.clone(),
            task,
        }
    }
    pub fn claim_succeeded(&self, has_job: bool) {
        if let Ok(mut e) = self.0.evidence.lock() {
            let now = Instant::now();
            e.claim = Some(Observation {
                outcome: Outcome::Ready,
                checked_at: now,
            });
            e.owned_until = None;
            e.ownership = Some(Observation {
                outcome: if has_job {
                    Outcome::Unknown
                } else {
                    Outcome::Ready
                },
                checked_at: now,
            });
        }
    }
    pub fn claim_failed(&self) {
        if let Ok(mut e) = self.0.evidence.lock() {
            e.claim = Some(Observation {
                outcome: Outcome::Failed,
                checked_at: Instant::now(),
            });
        }
    }
    /// Dropping a pending real renewal (timeout, shutdown or cancellation) is
    /// unknown ownership, even when the supervision timeout lives outside it.
    pub async fn check_lease<E>(
        &self,
        check: impl std::future::Future<Output = Result<Option<tokio::time::Instant>, E>>,
    ) -> Result<Option<tokio::time::Instant>, E> {
        let mut observation = LeaseObservation(Some(self.clone()));
        let result = check.await;
        self.observe_lease(&result);
        observation.0 = None;
        result
    }
    /// Call on the real pre-spawn confirmation and every renewal result. The
    /// supplied deadline already deducts pool/SQL/network time. Errors and None
    /// fail closed; they do not alter execution leases or durable drain receipts.
    pub fn observe_lease<E>(&self, result: &Result<Option<tokio::time::Instant>, E>) {
        if let Ok(mut e) = self.0.evidence.lock() {
            let now = Instant::now();
            let previous_expired = e.owned_until.is_some_and(|until| now >= until);
            let candidate = result.as_ref().ok().and_then(|v| *v).map(|v| v.into_std());
            let outcome = if !previous_expired && candidate.is_some_and(|until| until > now) {
                e.owned_until = candidate;
                Outcome::Ready
            } else {
                // Unknown renewal retains the old cutoff. A confirmed loss or
                // late reply cannot revive the old task before a fresh claim.
                if matches!(result, Ok(None)) {
                    e.owned_until = Some(now);
                }
                Outcome::Failed
            };
            let observation = Observation {
                outcome,
                checked_at: now,
            };
            e.ownership = Some(observation);
            e.claim = Some(observation);
        }
    }
    /// This reports waiting for real resource/receipt disposal; it never writes
    /// an ACK or treats a cancelled job as proof that its resources were drained.
    pub fn receipt_pending(&self, pending: bool) {
        self.0.receipt_pending.store(pending, Ordering::Release);
    }
    pub fn drain_failed(&self) {
        // Once a scope cannot prove disposal, later successful polls cannot
        // erase that fact. Restart/recovery belongs to the resource owner.
        self.0.drain_failed.store(true, Ordering::Release);
    }
    fn observe(&self, check: &'static str, ready: bool) {
        if let Ok(mut e) = self.0.evidence.lock() {
            e.probes.insert(
                check,
                Observation {
                    outcome: if ready {
                        Outcome::Ready
                    } else {
                        Outcome::Failed
                    },
                    checked_at: Instant::now(),
                },
            );
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot_at(Instant::now())
    }
    fn snapshot_at(&self, now: Instant) -> Snapshot {
        let mut checks = BTreeMap::new();
        let evidence = self.0.evidence.lock().ok();
        for (name, age) in [
            ("database", PROBE_AGE),
            ("writable_cache", PROBE_AGE),
            ("ffmpeg", TOOL_AGE),
            ("ffprobe", TOOL_AGE),
        ] {
            checks.insert(
                name,
                evidence
                    .as_ref()
                    .and_then(|e| e.probes.get(name))
                    .map_or(Outcome::Unknown, |o| o.outcome(now, age)),
            );
        }
        for name in ["preview_queue_running", "cache_cleaner_running"] {
            checks.insert(
                name,
                evidence
                    .as_ref()
                    .and_then(|e| e.probes.get(name))
                    .map_or(Outcome::Unknown, |o| o.outcome),
            );
        }
        checks.insert(
            "claim_loop",
            evidence
                .as_ref()
                .and_then(|e| e.claim)
                .map_or(Outcome::Unknown, |o| o.outcome(now, WORK_AGE)),
        );
        let ownership = evidence.as_ref().map_or(Outcome::Unknown, |e| {
            if e.owned_until.is_some_and(|until| now >= until) {
                Outcome::Failed
            } else {
                e.ownership
                    .map_or(Outcome::Unknown, |o| o.outcome(now, WORK_AGE))
            }
        });
        checks.insert("task_ownership", ownership);
        checks.insert(
            "accepting_work",
            if self.0.accepting.load(Ordering::Acquire) {
                Outcome::Ready
            } else {
                Outcome::Failed
            },
        );
        checks.insert(
            "resource_drain",
            if self.0.drain_failed.load(Ordering::Acquire)
                || self.0.receipt_pending.load(Ordering::Acquire)
            {
                Outcome::Failed
            } else {
                Outcome::Ready
            },
        );
        Snapshot {
            ready: checks.values().all(|v| *v == Outcome::Ready),
            checks,
        }
    }
    pub fn response(&self) -> Response {
        let snapshot = self.snapshot();
        (
            if snapshot.ready {
                axum::http::StatusCode::OK
            } else {
                axum::http::StatusCode::SERVICE_UNAVAILABLE
            },
            [(axum::http::header::CACHE_CONTROL, "no-store")],
            axum::Json(snapshot),
        )
            .into_response()
    }
}
#[derive(Clone, Copy)]
pub enum BackgroundTask {
    PreviewQueue,
    CacheCleaner,
}
impl BackgroundTask {
    fn check(self) -> &'static str {
        match self {
            Self::PreviewQueue => "preview_queue_running",
            Self::CacheCleaner => "cache_cleaner_running",
        }
    }
}
pub struct BackgroundTaskGuard {
    runtime: Runtime,
    task: BackgroundTask,
}
impl Drop for BackgroundTaskGuard {
    fn drop(&mut self) {
        self.runtime.observe(self.task.check(), false);
    }
}
struct LeaseObservation(Option<Runtime>);
impl Drop for LeaseObservation {
    fn drop(&mut self) {
        if let Some(runtime) = self.0.take() {
            runtime.observe_lease(&Err::<Option<tokio::time::Instant>, _>(()));
        }
    }
}
pub struct ClaimLoopGuard(Runtime);
impl Drop for ClaimLoopGuard {
    fn drop(&mut self) {
        self.0.claim_failed();
        self.0.accepting(false);
    }
}

/// Dropping the public handle requests shutdown but does not cancel the owner.
/// The owner retains file-work/process receipts until Scope::shutdown succeeds.
pub struct Monitor {
    stop: watch::Sender<bool>,
    runtime: Runtime,
    owner: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
}
impl Monitor {
    pub fn stop(&self) {
        self.stop.send_replace(true);
        for check in ["database", "writable_cache", "ffmpeg", "ffprobe"] {
            self.runtime.observe(check, false);
        }
    }
    pub async fn shutdown(mut self) -> std::io::Result<()> {
        self.stop();
        self.owner
            .take()
            .expect("probe owner")
            .await
            .map_err(std::io::Error::other)?
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Startup returns immediately with unknown dependencies. A first successful
/// probe enables only its own check; all required evidence must independently pass.
pub fn start(runtime: Runtime, pool: PgPool, root: PathBuf) -> Monitor {
    let (stop, receiver) = watch::channel(false);
    let monitor_runtime = runtime.clone();
    let owner = tokio::spawn(async move {
        let (_, cache, tools) = tokio::join!(
            database_loop(runtime.clone(), pool, receiver.clone()),
            cache_loop(runtime.clone(), root, receiver.clone()),
            tools_loop(runtime.clone(), receiver),
        );
        let result = cache.and(tools);
        if result.is_err() {
            runtime.drain_failed();
        }
        result
    });
    Monitor {
        stop,
        runtime: monitor_runtime,
        owner: Some(owner),
    }
}
async fn stopped(stop: &mut watch::Receiver<bool>) {
    while !*stop.borrow_and_update() {
        if stop.changed().await.is_err() {
            break;
        }
    }
}
async fn pause(stop: &mut watch::Receiver<bool>, duration: Duration) -> bool {
    tokio::select! { biased; _ = stopped(stop) => false, _ = tokio::time::sleep(duration) => true }
}

/// Errors/cancellation force socket closure instead of returning a connection
/// still executing SQL to the shared pool. Success commits and returns it normally.
struct CheckConnection(Option<PoolConnection<Postgres>>);
impl Drop for CheckConnection {
    fn drop(&mut self) {
        if let Some(c) = &mut self.0 {
            c.close_on_drop();
        }
    }
}
async fn database_query(pool: &PgPool, sql: &str) -> Result<bool, sqlx::Error> {
    let mut connection = CheckConnection(Some(pool.acquire().await?));
    let mut tx = connection.0.as_mut().expect("owned check").begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '750ms'")
        .execute(&mut *tx)
        .await?;
    let ready = sqlx::query_scalar(sql).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    drop(connection.0.take());
    Ok(ready)
}
async fn database_loop(runtime: Runtime, pool: PgPool, mut stop: watch::Receiver<bool>) {
    loop {
        let ready = tokio::select! { biased;
            _ = stopped(&mut stop) => break,
            result = tokio::time::timeout(Duration::from_secs(1), database_query(&pool, "SELECT true")) => matches!(result, Ok(Ok(true))),
        };
        runtime.observe("database", ready);
        if !pause(&mut stop, Duration::from_secs(2)).await {
            break;
        }
    }
}
async fn cache_loop(
    runtime: Runtime,
    root: PathBuf,
    mut stop: watch::Receiver<bool>,
) -> std::io::Result<()> {
    let max = std::env::var("CACHE_MAX_BYTES")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(20 * 1024 * 1024 * 1024);
    loop {
        let root = root.clone();
        let scope = media_core::child_process::Scope::new();
        let keep_running = scope.run(async {
            let probe = media_core::child_process::blocking(move || cache::check(&root, max, Duration::from_secs(1), 100_000));
            tokio::pin!(probe);
            let result = tokio::select! { biased;
                _ = stopped(&mut stop) => return false,
                result = &mut probe => Some(result),
                _ = tokio::time::sleep(Duration::from_secs(2)) => None,
            };
            runtime.observe("writable_cache", matches!(&result, Some(Ok(Ok(())))));
            if result.is_none() {
                // An OS file call may be uninterruptible. Keep exactly one owner,
                // remain unready, and wait for disposal before another scan starts.
                tokio::select! { biased; _ = stopped(&mut stop) => return false, _ = &mut probe => {} }
            }
            true
        }).await;
        // Explicitly retain blocking-operation receipts through shutdown, even
        // when the async waiter was cancelled at the stop/deadline boundary.
        if let Err(error) = scope.shutdown().await {
            runtime.drain_failed();
            return Err(error);
        }
        if !keep_running || !pause(&mut stop, Duration::from_secs(2)).await {
            return Ok(());
        }
    }
}
async fn tool_check(program: &str) -> bool {
    let mut command = tokio::process::Command::new(program);
    media_core::input_policy::clean_environment(&mut command);
    command.arg("-version");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    matches!(media_core::child_process::capture(command, Duration::from_secs(2), 64 * 1024).await, Ok((status, _)) if status.success())
}
async fn tools_loop(runtime: Runtime, mut stop: watch::Receiver<bool>) -> std::io::Result<()> {
    loop {
        for tool in ["ffmpeg", "ffprobe"] {
            let scope = media_core::child_process::Scope::new();
            let ready = scope
                .run(async {
                    tokio::select! { biased;
                        _ = stopped(&mut stop) => None,
                        ready = tool_check(tool) => Some(ready),
                    }
                })
                .await;
            if let Err(error) = scope.shutdown().await {
                runtime.drain_failed();
                return Err(error);
            }
            let Some(ready) = ready else {
                return Ok(());
            };
            runtime.observe(tool, ready);
        }
        if !pause(&mut stop, Duration::from_secs(5)).await {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn positive() -> Runtime {
        let r = Runtime::default();
        r.accepting(true);
        for check in ["database", "writable_cache", "ffmpeg", "ffprobe"] {
            r.observe(check, true);
        }
        r.claim_succeeded(false);
        r.observe("preview_queue_running", true);
        r.observe("cache_cleaner_running", true);
        r
    }
    #[test]
    fn startup_missing_stale_and_future_evidence_fail_closed() {
        let r = Runtime::default();
        assert!(!r.snapshot().ready);
        assert_eq!(r.snapshot().checks["database"], Outcome::Unknown);
        let r = positive();
        assert!(r.snapshot().ready);
        assert!(!r.snapshot_at(Instant::now() + Duration::from_secs(7)).ready);
        assert!(!r.snapshot_at(Instant::now() - Duration::from_secs(1)).ready);
        r.0.evidence
            .lock()
            .unwrap()
            .claim
            .as_mut()
            .unwrap()
            .checked_at -= Duration::from_secs(16);
        assert_eq!(r.snapshot().checks["claim_loop"], Outcome::Stale);
        assert!(!r.snapshot().ready);
    }
    #[test]
    fn actual_idle_polls_and_unexpired_renewals_are_distinct_from_drain() {
        let r = positive();
        let guard = r.claim_loop_guard();
        r.claim_succeeded(true);
        assert_eq!(r.snapshot().checks["task_ownership"], Outcome::Unknown);
        assert!(!r.snapshot().ready);
        r.observe_lease(&Ok::<_, ()>(Some(
            tokio::time::Instant::now() + Duration::from_secs(30),
        )));
        assert!(r.snapshot().ready);
        r.observe_lease(&Err::<Option<tokio::time::Instant>, _>(()));
        assert!(!r.snapshot().ready);
        r.observe_lease(&Ok::<_, ()>(Some(
            tokio::time::Instant::now() - Duration::from_secs(1),
        )));
        assert_eq!(r.snapshot().checks["task_ownership"], Outcome::Failed);
        r.claim_succeeded(false);
        assert!(r.snapshot().ready);
        r.receipt_pending(true);
        assert_eq!(r.snapshot().checks["resource_drain"], Outcome::Failed);
        r.receipt_pending(false);
        assert!(r.snapshot().ready);
        r.drain_failed();
        r.claim_succeeded(false);
        r.receipt_pending(false);
        assert!(
            !r.snapshot().ready,
            "later success cannot fabricate an old drain receipt"
        );
        drop(guard);
        assert_eq!(r.snapshot().checks["accepting_work"], Outcome::Failed);
    }
    #[tokio::test]
    async fn cancelled_renewal_preserves_cutoff_and_immediately_fails_readiness() {
        let r = positive();
        r.claim_succeeded(true);
        r.observe_lease(&Ok::<_, ()>(Some(
            tokio::time::Instant::now() + Duration::from_secs(30),
        )));
        let cutoff = r.0.evidence.lock().unwrap().owned_until;
        assert!(r.snapshot().ready);
        let pending = r.check_lease(std::future::pending::<
            Result<Option<tokio::time::Instant>, ()>,
        >());
        assert!(
            tokio::time::timeout(Duration::from_millis(1), pending)
                .await
                .is_err()
        );
        assert_eq!(r.snapshot().checks["task_ownership"], Outcome::Failed);
        assert_eq!(r.0.evidence.lock().unwrap().owned_until, cutoff);
        assert!(!r.snapshot().ready);
        r.check_lease(async {
            Ok::<_, ()>(Some(tokio::time::Instant::now() + Duration::from_secs(30)))
        })
        .await
        .unwrap();
        assert!(r.snapshot().ready);
    }

    #[test]
    fn a_late_confirmation_cannot_revive_an_expired_task_lease() {
        let r = positive();
        r.claim_succeeded(true);
        r.observe_lease(&Ok::<_, ()>(Some(
            tokio::time::Instant::now() + Duration::from_secs(30),
        )));
        r.observe_lease(&Err::<Option<tokio::time::Instant>, _>(()));
        r.0.evidence.lock().unwrap().owned_until = Some(Instant::now() - Duration::from_millis(1));
        r.observe_lease(&Ok::<_, ()>(Some(
            tokio::time::Instant::now() + Duration::from_secs(30),
        )));
        assert_eq!(r.snapshot().checks["task_ownership"], Outcome::Failed);
        r.claim_succeeded(true);
        r.observe_lease(&Ok::<_, ()>(Some(
            tokio::time::Instant::now() + Duration::from_secs(30),
        )));
        assert!(r.snapshot().ready);
    }
    #[test]
    fn background_tasks_are_unknown_until_started_and_fail_on_exit() {
        let r = positive();
        r.0.evidence
            .lock()
            .unwrap()
            .probes
            .remove("preview_queue_running");
        assert_eq!(
            r.snapshot().checks["preview_queue_running"],
            Outcome::Unknown
        );
        let preview = r.background_task_guard(BackgroundTask::PreviewQueue);
        let cleaner = r.background_task_guard(BackgroundTask::CacheCleaner);
        assert!(r.snapshot().ready);
        drop(preview);
        assert_eq!(
            r.snapshot().checks["preview_queue_running"],
            Outcome::Failed
        );
        assert!(!r.snapshot().ready);
        drop(cleaner);
        assert_eq!(
            r.snapshot().checks["cache_cleaner_running"],
            Outcome::Failed
        );
    }
    #[test]
    fn stopped_queue_and_admission_close_are_immediate() {
        let r = positive();
        r.claim_failed();
        assert_eq!(r.snapshot().checks["claim_loop"], Outcome::Failed);
        r.claim_succeeded(false);
        assert!(r.snapshot().ready);
        drop(r.claim_loop_guard());
        assert!(!r.snapshot().ready);
        let response = r.response();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            response.headers()[axum::http::header::CACHE_CONTROL],
            "no-store"
        );
    }
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("rainsync-readiness-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn cache_probe_checks_actual_access_quota_and_bounded_traversal_without_eviction() {
        let root = Temp::new();
        let check = |max, count| cache::check(&root.0, max, Duration::from_secs(1), count);
        assert!(check(1024, 100).is_ok());
        assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 0);
        std::fs::write(root.0.join("owned-output"), [0u8; 256]).unwrap();
        assert!(check(256, 100).is_err());
        assert!(check(1024, 0).is_err());
        assert_eq!(
            std::fs::read(root.0.join("owned-output")).unwrap().len(),
            256
        );
        assert_eq!(
            std::fs::read_dir(&root.0).unwrap().count(),
            1,
            "probe files are removed on failure too"
        );
        assert!(cache::check(&root.0.join("missing"), 1024, Duration::from_secs(1), 100).is_err());
        assert!(
            cache::check(
                &root.0.join("owned-output"),
                1024,
                Duration::from_secs(1),
                100
            )
            .is_err()
        );
    }
    #[cfg(unix)]
    #[test]
    fn cache_scan_never_follows_source_symlinks() {
        let root = Temp::new();
        let outside = Temp::new();
        std::fs::write(outside.0.join("outside"), [0u8; 1024]).unwrap();
        std::os::unix::fs::symlink(&outside.0, root.0.join("link")).unwrap();
        assert!(cache::check(&root.0, 512, Duration::from_secs(1), 100).is_ok());
        assert!(cache::check(&root.0.join("link"), 2048, Duration::from_secs(1), 100).is_err());
        assert_eq!(std::fs::read_dir(&outside.0).unwrap().count(), 1);
    }
    #[tokio::test]
    async fn absent_tool_is_failed_and_real_tools_have_owned_bounded_probes() {
        assert!(!tool_check("rainsync-nonexistent-readiness-tool").await);
        for program in ["ffmpeg", "ffprobe"] {
            let scope = media_core::child_process::Scope::new();
            assert!(
                scope.run(tool_check(program)).await,
                "install the documented FFmpeg test prerequisite"
            );
            scope.shutdown().await.unwrap();
        }
    }
    #[tokio::test]
    #[ignore = "requires an isolated PostgreSQL URL provided by the readiness fixture"]
    async fn postgres_timeout_cancellation_and_pool_exhaustion_recover() {
        let url = std::env::var("RAINSYNC_READINESS_TEST_DATABASE_URL").unwrap();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        assert!(database_query(&pool, "SELECT true").await.unwrap());
        let began = Instant::now();
        assert!(
            database_query(&pool, "SELECT true FROM pg_sleep(20)")
                .await
                .is_err()
        );
        assert!(began.elapsed() < Duration::from_secs(2));
        for _ in 0..5 {
            assert!(
                tokio::time::timeout(
                    Duration::from_millis(30),
                    database_query(&pool, "SELECT true FROM pg_sleep(20)")
                )
                .await
                .is_err()
            );
            assert!(
                tokio::time::timeout(Duration::from_secs(1), database_query(&pool, "SELECT true"))
                    .await
                    .unwrap()
                    .unwrap()
            );
        }
        let held = pool.acquire().await.unwrap();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(30),
                database_query(&pool, "SELECT true")
            )
            .await
            .is_err()
        );
        drop(held);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), database_query(&pool, "SELECT true"))
                .await
                .unwrap()
                .unwrap()
        );
        // PostgreSQL may not notice socket closure while sleeping. The LOCAL
        // statement deadline bounds that backend too; pool reuse is tested above
        // independently, without pretending TCP close instantaneously kills SQL.
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let count: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT true FROM pg_sleep%' AND state='active'").fetch_one(&pool).await.unwrap();
                if count == 0 { break; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("cancelled server-side queries must finish within their statement budget");
        let runtime = positive();
        let root = Temp::new();
        let monitor = start(runtime.clone(), pool.clone(), root.0.clone());
        async fn until(mut predicate: impl FnMut() -> bool) {
            tokio::time::timeout(Duration::from_secs(8), async {
                while !predicate() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
        }
        until(|| runtime.snapshot().ready).await;
        let held = pool.acquire().await.unwrap();
        until(|| runtime.snapshot().checks["database"] == Outcome::Failed).await;
        assert!(!runtime.snapshot().ready);
        drop(held);
        until(|| runtime.snapshot().ready).await;
        monitor.stop();
        assert!(!runtime.snapshot().ready);
        monitor.shutdown().await.unwrap();
        assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 0);
        pool.close().await;
    }
}
