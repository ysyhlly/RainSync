//! Opt-in original-owner child encoder, disabled in default deployment.
//!
//! Installed runtime custody connects queue admission, actual encoding, full
//! validation, typed atomic output publication and original proof cleanup.
//! An encoder exit or SQL row alone never grants playback/readiness. Unknown
//! outcomes retain the same original objects; only exact directory/process/read
//! disposal proof can release the independent 32 MiB output reservation.
#![allow(dead_code)]

use super::{App, static_hls_child_registry::HeldChildCapture};
use anyhow::{Result, ensure};
use media_core::{
    child_process::{Child, Scope},
    static_hls::{
        EncoderInputLease,
        child_output_owner::{ChildOutputDisposalProof, ChildOutputOwner},
        child_output_validation::{self, PublishedChildOutput, ValidatedChildOutput},
        child_recipe::{CandidateChildRecipe, ChildEncodeBudget, MAX_DIAGNOSTIC_PIPE_BYTES},
        contracts::{input::FrozenInput, worker::WorkerStatement},
    },
};
use persistence::{
    cache_budget,
    static_hls_child_jobs::{self as jobs, ChildJobAttempt, ChildJobExecution, ClaimResult},
    static_hls_child_output::{Admission, ChildOutputReservation, ChildOutputWritePermit},
    static_hls_child_output_cleanup::{ChildOutputCleanup, CleanupAcknowledgment},
    static_hls_child_output_publication::{PreparedChildOutputPublication, Publication},
};
use serde::Deserialize;
use sqlx::PgPool;
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    process::ExitStatus,
    sync::{
        Arc, Mutex as SyncMutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::{Mutex, watch},
    task::JoinHandle,
    time::Instant,
};
use uuid::Uuid;

const MAX_ENCODERS: usize = 4096;
const AUTHORITY_PULSE: Duration = Duration::from_millis(100);
const AUTHORITY_TIME: Duration = Duration::from_millis(750);
const CLEANUP_BACKOFF: Duration = Duration::from_secs(1);

#[derive(Clone, Default)]
pub(super) struct Registry(Arc<Owners>);
#[derive(Default)]
struct Owners {
    // App owns shutdown custody, but there is no production open method,
    // environment switch or HTTP caller granting execution qualification.
    accepting: AtomicBool,
    entries: SyncMutex<HashMap<Uuid, Arc<Entry>>>,
}

/// The actual installed child pipeline, not a media/proof qualification flag.
/// Only startup installation over this App's real registry/database can mint it.
/// Configuration requests installation; every job still repeats all original
/// capture, source, lease, recipe, validation and publication authority checks.
#[derive(Clone)]
pub(super) struct InstalledRuntime {
    registry: Registry,
    instance: Uuid,
    database: Uuid,
    queue_limit: i64,
    key: Arc<aes_gcm::Aes256Gcm>,
    pool_options: Arc<sqlx::postgres::PgConnectOptions>,
    cache: PathBuf,
}
impl InstalledRuntime {
    pub(super) async fn install(app: &App, queue_limit: i64) -> Result<Self> {
        ensure!(cfg!(target_os = "linux"), "static_hls_child_linux_required");
        ensure!((1..=10000).contains(&queue_limit), "invalid_queue_limit");
        ensure!(app.cache.is_dir(), "static_hls_child_cache_required");
        ensure!(
            std::path::Path::new("/usr/bin/ffmpeg").is_file()
                && std::path::Path::new("/usr/bin/ffprobe").is_file(),
            "static_hls_child_encoder_unavailable"
        );
        let until = Instant::now() + AUTHORITY_TIME;
        let database = tokio::time::timeout_at(until, async {
            use sqlx::Connection;
            let mut connection = app.db.acquire().await?;
            connection.close_on_drop();
            let mut tx = connection.begin().await?;
            sqlx::query("SET LOCAL statement_timeout='750ms'").execute(&mut *tx).await?;
            let id: Uuid = sqlx::query_scalar("SELECT id FROM static_hls_database_binding WHERE singleton AND to_regprocedure('static_hls_child_output_retention_authority_allowed(uuid,uuid,bigint)') IS NOT NULL AND to_regprocedure('static_hls_child_output_authority_allowed(uuid)') IS NOT NULL AND to_regprocedure('static_hls_child_output_disposal_allowed(uuid,uuid,bigint)') IS NOT NULL")
                .fetch_one(&mut *tx).await?;
            tx.commit().await?;
            Ok::<_,anyhow::Error>(id)
        }).await.map_err(|_| anyhow::anyhow!("static_hls_child_installation_unknown"))??;
        ensure!(
            Instant::now() < until && !database.is_nil(),
            "static_hls_child_installation_unknown"
        );
        ensure!(
            app.static_hls_child_encoders
                .0
                .accepting
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok(),
            "static_hls_child_executor_already_installed"
        );
        Ok(Self {
            registry: app.static_hls_child_encoders.clone(),
            instance: *super::static_hls_contract::INSTANCE,
            database,
            queue_limit,
            key: app.key.clone(),
            pool_options: app.db.connect_options(),
            cache: app.cache.clone(),
        })
    }
    pub(super) fn accepting(&self) -> bool {
        self.instance == *super::static_hls_contract::INSTANCE
            && self.registry.0.accepting.load(Ordering::SeqCst)
    }
    pub(super) fn database(&self) -> Uuid {
        self.database
    }
    pub(super) fn queue_limit(&self) -> i64 {
        self.queue_limit
    }
    pub(super) fn matches_app(&self, app: &App) -> bool {
        self.instance == *super::static_hls_contract::INSTANCE
            && Arc::ptr_eq(&self.registry.0, &app.static_hls_child_encoders.0)
            && Arc::ptr_eq(&self.key, &app.key)
            && Arc::ptr_eq(&self.pool_options, &app.db.connect_options())
            && self.cache == app.cache
    }
    pub(super) fn worker_statement(&self, input: &FrozenInput) -> Result<WorkerStatement> {
        ensure!(self.accepting(), "static_hls_child_executor_closed");
        let identity = input.identity_statement();
        ensure!(
            identity.worker_instance == self.instance.to_string()
                && identity.database == self.database.to_string(),
            "static_hls_child_executor_binding_changed"
        );
        Ok(WorkerStatement::parse_private_plaintext(
            &serde_json::to_vec(&serde_json::json!({
                "reader_version":2,"recipe_version":1,"input_version":1,"graph_version":1,
                "worker_instance":self.instance.to_string(),"database":self.database.to_string(),"tasks":["child_encode"]
            }))?,
        )?)
    }
    pub(super) fn start_owned(
        &self,
        app: &App,
        held: HeldChildCapture,
        observed: WorkerStatement,
    ) -> Result<()> {
        ensure!(
            self.matches_app(app),
            "static_hls_child_executor_binding_changed"
        );
        let _ = self.worker_statement(held.input())?;
        self.registry.start_owned(app, held, observed)
    }
    pub(super) fn cancel(&self, input: &FrozenInput) -> Result<()> {
        self.registry.cancel(input)
    }
}

struct Entry {
    // Intentional bounded retention, including all COMMIT-unknown identities.
    // Neither waiter loss nor a terminal task can prune this cycle.
    _registry_keepalive: Arc<Owners>,
    held: HeldChildCapture,
    observed: WorkerStatement,
    app: App,
    pool: PgPool,
    cache: PathBuf,
    original_budget: ChildEncodeBudget,
    hard_until: watch::Sender<Instant>,
    lease_until: watch::Sender<Option<Instant>>,
    stop: watch::Sender<bool>,
    reason: SyncMutex<Option<Failure>>,
    phase: SyncMutex<Phase>,
    attempt: OnceLock<Mutex<ChildJobAttempt>>,
    execution: OnceLock<Arc<Mutex<ChildJobExecution>>>,
    input: OnceLock<Arc<EncoderInputLease>>,
    reservation: OnceLock<Arc<Mutex<ChildOutputReservation>>>,
    permit: OnceLock<Arc<ChildOutputWritePermit>>,
    output: OnceLock<ChildOutputOwner>,
    process: OnceLock<Mutex<ProcessRun>>,
    candidate: OnceLock<CandidateEvidence>,
    // Install the real full-validation witness before any publication await.
    validated: OnceLock<Mutex<Option<ValidatedChildOutput>>>,
    publication_started: watch::Sender<bool>,
    publication: OnceLock<Mutex<PreparedChildOutputPublication>>,
    published: OnceLock<Arc<PublishedChildOutput>>,
    owner_task: SyncMutex<Option<JoinHandle<()>>>,
    lease_task: SyncMutex<Option<JoinHandle<()>>>,
    preparation_scope: Scope,
    preparation_drained: AtomicBool,
    execution_acknowledged: AtomicBool,
    output_disposal: OnceLock<Arc<ChildOutputDisposalProof>>,
    output_cleanup: OnceLock<Mutex<ChildOutputCleanup>>,
    // Conservative before the admission await; refined only by a known result.
    reservation_retained: AtomicBool,
    claim_unknown: AtomicBool,
    output_unknown: AtomicBool,
    child_request_cancelled: AtomicBool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Failure {
    Cancelled,
    Deadline,
    LeaseLost,
    Authority,
    ClaimUnavailable,
    ClaimUnknown,
    Input,
    Capacity,
    OutputStale,
    OutputUnknown,
    OutputOwner,
    Recipe,
    Spawn,
    Process,
    EncoderExit,
    DiagnosticMissing,
    DiagnosticBound,
    DiagnosticRead,
    DiagnosticJoin,
    Inspection,
    Validation,
    Publication,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Phase {
    Preparing,
    Claiming,
    PreparingInput,
    AdmittingOutput,
    Encoding,
    Validating,
    EncodedCandidate,
    Publishing,
    PublicationUnknown,
    Published,
    Draining,
    Retained,
}

/// Safe observations only. No raw stderr, file path, fd, permit or URL escapes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct FileObservation {
    pub(super) name: String,
    pub(super) bytes: u64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct DiagnosticReceipt {
    pub(super) bytes: usize,
}
struct CandidateEvidence {
    exit: ExitStatus,
    diagnostics: DiagnosticReceipt,
    files: Vec<FileObservation>,
}
struct ProcessRun {
    child: Child,
    diagnostics: Option<JoinHandle<std::result::Result<DiagnosticReceipt, Failure>>>,
    exit: Option<ExitStatus>,
    diagnostic_result: Option<std::result::Result<DiagnosticReceipt, Failure>>,
}

/// Retains the same actual entry/output owner. This cannot mark a job successful,
/// grant a file reader, authorize publication or acknowledge reservation release.
pub(super) struct EncodedCandidate {
    entry: Arc<Entry>,
}
impl EncodedCandidate {
    pub(super) async fn inspection(&self) -> Result<Vec<FileObservation>> {
        self.entry.check_local()?;
        let evidence = self
            .entry
            .candidate
            .get()
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_encoded_candidate_missing"))?;
        ensure!(evidence.exit.success(), "static_hls_child_encoder_exit");
        let output = self
            .entry
            .output
            .get()
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_original_output_owner_missing"))?;
        // The original process receipt is historical. Actual read-only output
        // authority/inventory is checked again through this SAME owner, so a
        // supervisor stop, removal or replaced directory cannot return a stale
        // candidate snapshot as though files were still available.
        let current = self.entry.guard(output.inspect_after_reap()).await;
        let files = match current {
            Ok(Ok(files)) => files
                .into_iter()
                .map(|file| FileObservation {
                    name: file.name,
                    bytes: file.bytes,
                })
                .collect::<Vec<_>>(),
            _ => {
                self.entry.request_stop(Failure::Inspection);
                anyhow::bail!("static_hls_child_candidate_inspection_unconfirmed");
            }
        };
        if files != evidence.files {
            self.entry.request_stop(Failure::Inspection);
            anyhow::bail!("static_hls_child_candidate_inventory_changed");
        }
        Ok(files)
    }
    pub(super) fn diagnostics(&self) -> Result<DiagnosticReceipt> {
        self.entry.check_local()?;
        self.entry
            .candidate
            .get()
            .map(|evidence| evidence.diagnostics)
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_encoded_candidate_missing"))
    }
    pub(super) fn exit_status(&self) -> Result<ExitStatus> {
        self.entry.check_local()?;
        self.entry
            .candidate
            .get()
            .map(|evidence| evidence.exit)
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_encoded_candidate_missing"))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct Observation {
    pub(super) phase: Phase,
    pub(super) failure: Option<Failure>,
    pub(super) claim_unknown: bool,
    pub(super) output_unknown: bool,
    pub(super) reservation_retained: bool,
    pub(super) preparation_drained: bool,
    pub(super) execution_acknowledged: bool,
    pub(super) output_removed: bool,
    pub(super) child_request_cancelled: bool,
    pub(super) capture_disposed: bool,
}

impl Registry {
    /// Pure fixture seam only; this does not mint any capture, job or writer.
    #[cfg(test)]
    fn for_owned_fixture() -> Self {
        Self(Arc::new(Owners {
            accepting: AtomicBool::new(true),
            ..Owners::default()
        }))
    }

    /// Install every original input/deadline before the first asynchronous call.
    /// A duplicate is observation only; it cannot create another attempt/owner.
    pub(super) fn start_owned(
        &self,
        app: &App,
        held: HeldChildCapture,
        observed: WorkerStatement,
    ) -> Result<()> {
        ensure!(
            self.0.accepting.load(Ordering::SeqCst),
            "static_hls_child_encoder_inactive"
        );
        let runtime = tokio::runtime::Handle::try_current()?;
        let id = Uuid::parse_str(&held.input().identity_statement().operation_id)?;
        let mut entries = self.0.entries.lock().expect("child encoder registry");
        ensure!(
            self.0.accepting.load(Ordering::SeqCst),
            "static_hls_child_encoder_inactive"
        );
        if let Some(original) = entries.get(&id) {
            original
                .held
                .input()
                .require_same_frozen_input(held.input())?;
            return Ok(());
        }
        ensure!(
            entries.len() < MAX_ENCODERS,
            "static_hls_child_encoder_registry_full"
        );
        let budget = ChildEncodeBudget::begin(held.preparation_until(), held.root_until())?;
        let until = budget.until();
        let entry = Arc::new(Entry {
            _registry_keepalive: self.0.clone(),
            held,
            observed,
            app: app.clone(),
            pool: app.db.clone(),
            cache: app.cache.clone(),
            original_budget: budget,
            hard_until: watch::channel(until).0,
            lease_until: watch::channel(None).0,
            stop: watch::channel(false).0,
            reason: SyncMutex::new(None),
            phase: SyncMutex::new(Phase::Preparing),
            attempt: OnceLock::new(),
            execution: OnceLock::new(),
            input: OnceLock::new(),
            reservation: OnceLock::new(),
            permit: OnceLock::new(),
            output: OnceLock::new(),
            process: OnceLock::new(),
            candidate: OnceLock::new(),
            validated: OnceLock::new(),
            publication_started: watch::channel(false).0,
            publication: OnceLock::new(),
            published: OnceLock::new(),
            owner_task: SyncMutex::new(None),
            lease_task: SyncMutex::new(None),
            preparation_scope: Scope::new(),
            preparation_drained: AtomicBool::new(false),
            execution_acknowledged: AtomicBool::new(false),
            output_disposal: OnceLock::new(),
            output_cleanup: OnceLock::new(),
            reservation_retained: AtomicBool::new(false),
            claim_unknown: AtomicBool::new(false),
            output_unknown: AtomicBool::new(false),
            child_request_cancelled: AtomicBool::new(false),
        });
        entries.insert(id, entry.clone());
        // Synchronous registration while the registry lock seals close/start.
        *entry.owner_task.lock().expect("child encoder task") =
            Some(runtime.spawn(run(entry.clone())));
        Ok(())
    }

    fn entry(&self, input: &FrozenInput) -> Result<Option<Arc<Entry>>> {
        let id = Uuid::parse_str(&input.identity_statement().operation_id)?;
        let entry = self
            .0
            .entries
            .lock()
            .expect("child encoder registry")
            .get(&id)
            .cloned();
        if let Some(entry) = &entry {
            entry.held.input().require_same_frozen_input(input)?;
        }
        Ok(entry)
    }
    pub(super) fn observe(&self, input: &FrozenInput) -> Result<Option<Observation>> {
        Ok(self.entry(input)?.map(|entry| entry.observation()))
    }
    pub(super) fn candidate(&self, input: &FrozenInput) -> Result<Option<EncodedCandidate>> {
        let Some(entry) = self.entry(input)? else {
            return Ok(None);
        };
        entry.check_local()?;
        Ok(entry
            .candidate
            .get()
            .is_some()
            .then_some(EncodedCandidate { entry }))
    }
    /// Lookup retains the original published physical owner; its dedicated
    /// read adapter still checks current identity/authority on every request.
    pub(super) fn published(
        &self,
        input: &FrozenInput,
    ) -> Result<Option<Arc<PublishedChildOutput>>> {
        let Some(entry) = self.entry(input)? else {
            return Ok(None);
        };
        match entry.published.get() {
            Some(output) => {
                output.require_same_frozen_input(input)?;
                Ok(Some(output.clone()))
            }
            None => Ok(None),
        }
    }

    pub(super) fn cancel(&self, input: &FrozenInput) -> Result<()> {
        if let Some(entry) = self.entry(input)? {
            entry.request_stop(Failure::Cancelled);
        }
        Ok(())
    }
    pub(super) fn close(&self) {
        self.0.accepting.store(false, Ordering::SeqCst);
        let entries = self.0.entries.lock().expect("child encoder registry");
        for entry in entries.values() {
            entry.request_stop(Failure::Cancelled);
        }
    }
    /// Call after close. Waits for real owners; it never aborts their JoinHandles.
    /// Returned reservations/unknown admissions are retained obligations, even
    /// when all physical owners have positively drained. No pruning or release.
    pub(super) async fn drain(&self) -> Vec<Observation> {
        let entries: Vec<_> = self
            .0
            .entries
            .lock()
            .expect("child encoder registry")
            .values()
            .cloned()
            .collect();
        for entry in &entries {
            let task = entry.owner_task.lock().expect("child encoder task").take();
            if let Some(task) = task
                && task.await.is_err()
            {
                entry.request_stop(Failure::Process);
                // A failed owner task must not be reported as physical cleanup.
                cleanup(entry).await;
            }
        }
        entries.iter().map(|entry| entry.observation()).collect()
    }
}

impl Entry {
    fn until(&self) -> Instant {
        (*self.hard_until.borrow()).min(self.original_budget.until())
    }
    fn check_local(&self) -> Result<()> {
        ensure!(
            !*self.stop.borrow() && Instant::now() < self.until(),
            "static_hls_child_encoder_closed"
        );
        if let Some(until) = *self.lease_until.borrow() {
            ensure!(Instant::now() < until, "static_hls_child_job_lease_expired");
        }
        Ok(())
    }
    fn phase(&self, phase: Phase) {
        *self.phase.lock().expect("child encoder phase") = phase;
    }
    fn request_stop(&self, reason: Failure) {
        self.reason
            .lock()
            .expect("child encoder reason")
            .get_or_insert(reason);
        self.stop.send_replace(true);
        if let Some(input) = self.input.get() {
            input.cancel();
        }
        if let Some(output) = self.output.get() {
            output.cancel();
        }
        if let Ok(control) = self.held.capture().control() {
            control.cancel();
        }
    }
    fn observation(&self) -> Observation {
        Observation {
            phase: *self.phase.lock().expect("child encoder phase"),
            failure: *self.reason.lock().expect("child encoder reason"),
            claim_unknown: self.claim_unknown.load(Ordering::SeqCst),
            output_unknown: self.output_unknown.load(Ordering::SeqCst),
            reservation_retained: self.reservation_retained.load(Ordering::SeqCst),
            preparation_drained: self.preparation_drained.load(Ordering::SeqCst),
            execution_acknowledged: self.execution_acknowledged.load(Ordering::SeqCst),
            output_removed: self.output_disposal.get().is_some(),
            child_request_cancelled: self.child_request_cancelled.load(Ordering::SeqCst),
            capture_disposed: self.held.capture().control().is_ok_and(|control| {
                control.disposal_state() == media_core::static_hls::DisposalState::Disposed
            }),
        }
    }
    /// Observe changing confirmed leases during ALL work, including pool/SQL,
    /// graph reads, disk measurement, spawn, diagnostic join and inspection.
    async fn authority<T>(&self, work: impl Future<Output = T>) -> std::result::Result<T, Failure> {
        self.guard(tokio::time::timeout(AUTHORITY_TIME, work))
            .await?
            .map_err(|_| Failure::Authority)
    }
    async fn guard<T>(&self, work: impl Future<Output = T>) -> std::result::Result<T, Failure> {
        let mut stop = self.stop.subscribe();
        let mut lease = self.lease_until.subscribe();
        let mut hard = self.hard_until.subscribe();
        tokio::pin!(work);
        loop {
            if *stop.borrow_and_update() {
                return Err(Failure::Cancelled);
            }
            let hard_until = (*hard.borrow_and_update()).min(self.original_budget.until());
            let until = lease
                .borrow_and_update()
                .map_or(hard_until, |lease| lease.min(hard_until));
            if Instant::now() >= until {
                let reason = if Instant::now() >= hard_until {
                    Failure::Deadline
                } else {
                    Failure::LeaseLost
                };
                self.request_stop(reason);
                return Err(reason);
            }
            tokio::select! {
                biased;
                _ = stop.changed() => {},
                _ = tokio::time::sleep_until(until) => {},
                _ = lease.changed() => {},
                _ = hard.changed() => {},
                value = &mut work => {
                    // A late response in the same poll cannot revive a fence.
                    if self.check_local().is_err() {
                        self.request_stop(if Instant::now() >= self.until() { Failure::Deadline } else { Failure::LeaseLost });
                    }
                    // Return a completed resource to its owner for synchronous
                    // installation even when a fence just expired. The next
                    // guarded side effect is refused; never discard its actual
                    // claim/child/pipe receipt before retaining it.
                    return Ok(value);
                },
            }
        }
    }
}

async fn run(entry: Arc<Entry>) {
    match encode(&entry).await {
        Ok(candidate) => {
            if entry.check_local().is_ok() && entry.candidate.set(candidate).is_ok() {
                entry.phase(Phase::EncodedCandidate);
                if publish_candidate(&entry).await.is_err() {
                    entry.request_stop(Failure::Publication);
                }
            } else {
                entry.request_stop(Failure::Inspection);
            }
        }
        Err(reason) => entry.request_stop(reason),
    }
    cleanup(&entry).await;
}

/// The original task, not an HTTP waiter, owns publication and uncertainty.
async fn publish_candidate(entry: &Arc<Entry>) -> Result<()> {
    entry.check_local()?;
    let proof = entry
        .validated
        .get()
        .ok_or_else(|| anyhow::anyhow!("child_validation_missing"))?
        .lock()
        .await
        .take()
        .ok_or_else(|| anyhow::anyhow!("child_validation_consumed"))?;
    let permit = entry
        .permit
        .get()
        .ok_or_else(|| anyhow::anyhow!("child_output_permit_missing"))?
        .clone();
    let publication = PreparedChildOutputPublication::prepare(permit, proof)?;
    entry
        .publication
        .set(Mutex::new(publication))
        .map_err(|_| anyhow::anyhow!("child_publication_already_installed"))?;
    entry.phase(Phase::Publishing);
    // Finish one ordinary same-attempt renewal before the handoff. This uses
    // the existing live one-second lease and immutable hard/root limits; it
    // cannot revive expiry or grant the publication a fresh preparation budget.
    entry
        .authority(async {
            let mut execution = entry
                .execution
                .get()
                .ok_or_else(|| anyhow::anyhow!("child_execution_missing"))?
                .lock()
                .await;
            ensure!(
                execution.renew(&entry.pool).await?,
                "child_publication_lease_lost"
            );
            entry
                .lease_until
                .send_replace(Some(execution.claim().until().min(entry.until())));
            // Signal under that same execution lock, before a competing running
            // renewal could mistake this job's successful COMMIT for lease loss.
            entry.publication_started.send_replace(true);
            Ok::<_, anyhow::Error>(())
        })
        .await
        .map_err(|_| anyhow::anyhow!("child_publication_renewal_unconfirmed"))??;
    let renewal = entry
        .lease_task
        .lock()
        .expect("child encoder lease task")
        .take();
    if let Some(task) = renewal {
        task.await?;
    }
    entry.check_local()?;
    loop {
        let (outcome, published) = {
            let mut operation = entry
                .publication
                .get()
                .expect("installed child publication")
                .lock()
                .await;
            let outcome = operation.commit().await;
            (outcome, operation.published_output())
        };
        match (outcome, published) {
            (Ok(Publication::Published), Some(output)) => {
                entry
                    .published
                    .set(output)
                    .map_err(|_| anyhow::anyhow!("child_output_already_published"))?;
                entry.execution_acknowledged.store(true, Ordering::SeqCst);
                entry.output_unknown.store(false, Ordering::SeqCst);
                entry.phase(Phase::Published);
                // Actual input disposal is required before any public read.
                // Do not cancel the child request or its successful job/grant.
                entry.held.capture().control()?.cancel();
                hold_published(entry).await;
                return Ok(());
            }
            _ => {
                entry.output_unknown.store(true, Ordering::SeqCst);
                entry.phase(Phase::PublicationUnknown);
            }
        }
        // A positive DB receipt may retry promotion of this SAME local owner.
        // A wholly unknown COMMIT cannot remint/retry the SQL transaction.
        let mut stop = entry.stop.subscribe();
        let remaining = entry.held.root_until();
        if *stop.borrow() || Instant::now() >= remaining {
            return Ok(());
        }
        tokio::select! {
            _ = stop.changed() => return Ok(()),
            _ = tokio::time::sleep_until(remaining) => return Ok(()),
            _ = tokio::time::sleep(CLEANUP_BACKOFF) => {},
        }
    }
}

async fn hold_published(entry: &Arc<Entry>) {
    let mut stop = entry.stop.subscribe();
    loop {
        if *stop.borrow() || Instant::now() >= entry.held.root_until() {
            return;
        }
        let Some(output) = entry.published.get() else {
            return;
        };
        if output.control().disposal_state()
            != media_core::static_hls::child_output_owner::OutputDisposalState::Pending
        {
            return;
        }
        if let Ok(control) = entry.held.capture().control()
            && control.disposal_retry_available()
        {
            let _ = control.retry_disposal().await;
        }
        tokio::select! {
            _ = stop.changed() => return,
            _ = tokio::time::sleep_until(entry.held.root_until()) => return,
            _ = tokio::time::sleep(AUTHORITY_PULSE) => {},
        }
    }
}

#[derive(Deserialize)]
struct Position {
    position_ms: f64,
}

async fn encode(entry: &Arc<Entry>) -> std::result::Result<CandidateEvidence, Failure> {
    entry
        .authority(entry.held.check())
        .await?
        .map_err(|_| Failure::Authority)?;
    let prepared = entry
        .guard(jobs::ChildJobAttempt::prepare(
            entry.held.capture_handle(),
            entry.held.input().clone(),
            entry.held.parent_input().clone(),
            entry.held.root_handle(),
            *super::static_hls_contract::INSTANCE,
            Some(&entry.observed),
        ))
        .await?
        .map_err(|_| Failure::Authority)?;
    // Installation precedes the claim transaction's first await.
    entry
        .attempt
        .set(Mutex::new(prepared))
        .map_err(|_| Failure::ClaimUnknown)?;
    entry.phase(Phase::Claiming);
    entry.claim_unknown.store(true, Ordering::SeqCst);
    let claim = entry
        .authority(async {
            let mut attempt = entry
                .attempt
                .get()
                .expect("installed child attempt")
                .lock()
                .await;
            jobs::claim(&entry.pool, &mut attempt).await
        })
        .await?
        .map_err(|_| Failure::ClaimUnknown)?;
    let claim = match claim {
        ClaimResult::Acquired(claim) => claim,
        ClaimResult::Unavailable => {
            entry.claim_unknown.store(false, Ordering::SeqCst);
            return Err(Failure::ClaimUnavailable);
        }
        ClaimResult::CommitUnknown => return Err(Failure::ClaimUnknown),
    };
    let hard = entry.until().min(claim.hard_until());
    let lease = claim.until().min(hard);
    // No asynchronous call may intervene between receipt and original install.
    let execution = Arc::new(Mutex::new((*claim).into_execution()));
    entry
        .execution
        .set(execution.clone())
        .map_err(|_| Failure::ClaimUnknown)?;
    entry.claim_unknown.store(false, Ordering::SeqCst);
    entry.hard_until.send_replace(hard);
    entry.lease_until.send_replace(Some(lease));
    let owner = entry.clone();
    *entry.lease_task.lock().expect("child encoder lease task") =
        Some(tokio::spawn(renew_owner(owner)));

    // The publication witness holds one reader and the actual encoder input
    // will hold the second. Qualify the recipe BEFORE minting that input, so
    // its manifest read never asks for an unauthorized third reader slot.
    let position: Position = serde_json::from_slice(entry.held.input().private_storage_plaintext())
        .map_err(|_| Failure::Recipe)?;
    if !position.position_ms.is_finite()
        || position.position_ms < 0.0
        || position.position_ms > media_core::static_hls::contracts::MAX_SAFE_INTEGER as f64
    {
        return Err(Failure::Recipe);
    }
    let recipe = entry
        .guard(CandidateChildRecipe::from_capture(
            entry.held.capture(),
            position.position_ms,
        ))
        .await?
        .map_err(|_| Failure::Recipe)?;
    entry.phase(Phase::PreparingInput);
    entry
        .guard(async {
            let preparation = {
                let mut execution = execution.lock().await;
                execution.begin_input_preparation()?
            };
            // The original pending slot is installed inside Execution. Its owner
            // task retains and installs the real lease before notifying this waiter.
            // Network graph revalidation runs OUTSIDE the execution mutex, leaving
            // renewal able to maintain the original one-second observation lease.
            preparation.wait().await?;
            let mut execution = execution.lock().await;
            execution.finish_input_preparation(&preparation)?;
            entry
                .input
                .set(execution.input_lease_handle()?)
                .map_err(|_| anyhow::anyhow!("static_hls_child_input_already_installed"))?;
            Ok::<_, anyhow::Error>(())
        })
        .await?
        .map_err(|_| Failure::Input)?;

    let input = entry.input.get().ok_or(Failure::Input)?.clone();
    let reservation = {
        let execution = execution.lock().await;
        ChildOutputReservation::prepare(execution.claim(), &input)
            .map_err(|_| Failure::OutputOwner)?
    };
    let reservation = Arc::new(Mutex::new(reservation));
    entry
        .reservation
        .set(reservation.clone())
        .map_err(|_| Failure::OutputOwner)?;
    entry.phase(Phase::AdmittingOutput);
    loop {
        // This uses the existing configuration/quota/ten-percent disk floor.
        // The measurement is outside BOTH database and execution/reservation locks.
        let revision = entry
            .authority(cache_budget::snapshot(&entry.pool))
            .await?
            .map_err(|_| Failure::Capacity)?;
        let root = entry.cache.clone();
        let headroom = entry
            .guard(
                entry
                    .preparation_scope
                    .run(media_core::child_process::blocking(move || {
                        super::cache::reservation_headroom(&root)
                    })),
            )
            .await?
            .map_err(|_| Failure::Capacity)?
            .map_err(|_| Failure::Capacity)?;
        entry.reservation_retained.store(true, Ordering::SeqCst);
        entry.output_unknown.store(true, Ordering::SeqCst);
        let admission = entry
            .authority(async {
                let execution = execution.lock().await;
                let mut reservation = reservation.lock().await;
                reservation
                    .admit(
                        &entry.pool,
                        execution.claim(),
                        execution.input_lease()?,
                        revision,
                        headroom,
                    )
                    .await
            })
            .await?
            .map_err(|_| Failure::OutputUnknown)?;
        match admission {
            Admission::Reserved => {
                entry.output_unknown.store(false, Ordering::SeqCst);
                break;
            }
            Admission::Changed => {
                entry.output_unknown.store(false, Ordering::SeqCst);
                entry.reservation_retained.store(false, Ordering::SeqCst);
                // Same original identity, no extra namespace/attempt. Yield so
                // renewal can proceed before another changed-revision snapshot.
                entry.guard(tokio::time::sleep(AUTHORITY_PULSE)).await?;
            }
            Admission::Full | Admission::Stale => {
                entry.output_unknown.store(false, Ordering::SeqCst);
                entry.reservation_retained.store(false, Ordering::SeqCst);
                return Err(if admission == Admission::Full {
                    Failure::Capacity
                } else {
                    Failure::OutputStale
                });
            }
            Admission::CommitUnknown => return Err(Failure::OutputUnknown),
        }
    }
    // This adapter's current-authority transaction can also become unknown;
    // keep the original reservation retained before awaiting its receipt.
    entry.output_unknown.store(true, Ordering::SeqCst);
    let permit = entry
        .authority(ChildOutputWritePermit::prepare(
            &entry.pool,
            execution.clone(),
            reservation,
        ))
        .await?
        .map_err(|_| Failure::OutputUnknown)?;
    entry
        .permit
        .set(permit.clone())
        .map_err(|_| Failure::OutputOwner)?;
    entry.output_unknown.store(false, Ordering::SeqCst);
    let output = ChildOutputOwner::prepare(permit, input, entry.until())
        .map_err(|_| Failure::OutputOwner)?;
    // Original owner and its partial-files state are retained BEFORE create IO.
    entry.output.set(output).map_err(|_| Failure::OutputOwner)?;
    let output = entry.output.get().ok_or(Failure::OutputOwner)?;
    entry
        .guard(output.create_in(&entry.cache))
        .await?
        .map_err(|_| Failure::OutputOwner)?;

    let budget =
        ChildEncodeBudget::begin(entry.until(), entry.until()).map_err(|_| Failure::Deadline)?;
    #[cfg(target_os = "linux")]
    let mut child = entry
        .guard(recipe.spawn_owned(output, &budget))
        .await?
        .map_err(|_| Failure::Spawn)?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (recipe, budget);
        return Err(Failure::Spawn);
    }
    #[cfg(target_os = "linux")]
    {
        let diagnostic_owner = entry.clone();
        let diagnostics = child.stderr.take().map(|stderr| {
            tokio::spawn(async move {
                let result = read_diagnostics(stderr, diagnostic_owner.stop.subscribe()).await;
                if let Err(reason) = result {
                    diagnostic_owner.request_stop(reason);
                }
                result
            })
        });
        // No await after spawn until the actual Child and pipe JoinHandle are
        // installed in the retained entry; HTTP waiter loss cannot drop them.
        entry
            .process
            .set(Mutex::new(ProcessRun {
                child,
                diagnostics,
                exit: None,
                diagnostic_result: None,
            }))
            .map_err(|_| Failure::Process)?;
        entry.phase(Phase::Encoding);
        let mut process = entry.process.get().ok_or(Failure::Process)?.lock().await;
        if process.diagnostics.is_none() {
            return Err(Failure::DiagnosticMissing);
        }
        let exit = entry
            .guard(process.child.wait())
            .await?
            .map_err(|_| Failure::Process)?;
        process.exit = Some(exit);
        let diagnostics = entry
            .guard(
                process
                    .diagnostics
                    .as_mut()
                    .expect("retained diagnostic owner"),
            )
            .await?
            .unwrap_or(Err(Failure::DiagnosticJoin));
        // Save every actual join outcome before an error can return, so cleanup
        // never polls an already-consumed JoinHandle a second time.
        process.diagnostic_result = Some(diagnostics);
        let diagnostics = diagnostics?;
        if !exit.success() {
            return Err(Failure::EncoderExit);
        }
        drop(process);
        let files = entry
            .guard(output.inspect_after_reap())
            .await?
            .map_err(|_| Failure::Inspection)?;
        entry.phase(Phase::Validating);
        let validated = entry
            .guard(child_output_validation::validate(output, &recipe))
            .await?
            .map_err(|_| Failure::Validation)?;
        // Retain this same opaque witness synchronously, including a result
        // arriving at the deadline. A late result cannot authorize publication;
        // the next guard refuses it and cleanup retains actual custody.
        entry
            .validated
            .set(Mutex::new(Some(validated)))
            .map_err(|_| Failure::Validation)?;
        Ok(CandidateEvidence {
            exit,
            diagnostics,
            files: files
                .into_iter()
                .map(|file| FileObservation {
                    name: file.name,
                    bytes: file.bytes,
                })
                .collect(),
        })
    }
}

async fn renew_owner(entry: Arc<Entry>) {
    let Some(execution) = entry.execution.get() else {
        entry.request_stop(Failure::LeaseLost);
        return;
    };
    let mut stop = entry.stop.subscribe();
    let mut publication = entry.publication_started.subscribe();
    loop {
        if *publication.borrow_and_update() {
            return;
        }
        if *stop.borrow_and_update() {
            return;
        }
        let Some(old_until) = *entry.lease_until.borrow() else {
            entry.request_stop(Failure::LeaseLost);
            return;
        };
        let now = Instant::now();
        let until = old_until.min(entry.until());
        if now >= until {
            entry.request_stop(Failure::LeaseLost);
            return;
        }
        tokio::select! {
            biased;
            _ = publication.changed() => return,
            _ = stop.changed() => continue,
            _ = tokio::time::sleep_until(until) => { entry.request_stop(Failure::LeaseLost); return; },
            _ = tokio::time::sleep(AUTHORITY_PULSE) => {},
        }
        // Includes queueing for the execution mutex, pool acquisition and all
        // SQL. Positive responses are charged from the original lease fence.
        let check_until = until.min(Instant::now() + AUTHORITY_TIME);
        let result = tokio::select! {
            biased;
            _ = publication.changed() => return,
            _ = stop.changed() => return,
            result = tokio::time::timeout_at(check_until, async {
                let mut execution = execution.lock().await;
                if !execution.renew(&entry.pool).await? { return Ok(None); }
                Ok::<_, anyhow::Error>(Some(execution.claim().until()))
            }) => result,
        };
        match result {
            Ok(Ok(Some(next)))
                if Instant::now() < until && next.min(entry.until()) > Instant::now() =>
            {
                entry
                    .lease_until
                    .send_replace(Some(next.min(entry.until())));
            }
            _ => {
                entry.request_stop(Failure::LeaseLost);
                return;
            }
        }
    }
}

/// The retained buffer is fixed at 4 KiB. No stderr text is saved/logged. One
/// extra byte detects overflow, immediately requests real stop, and never yields
/// a fabricated zero-byte receipt for a missing pipe, IO error or failed join.
async fn read_diagnostics(
    mut pipe: impl AsyncRead + Unpin,
    mut stop: watch::Receiver<bool>,
) -> std::result::Result<DiagnosticReceipt, Failure> {
    let mut bytes = 0usize;
    let mut buffer = [0; 4096];
    loop {
        if *stop.borrow_and_update() {
            return Err(Failure::Cancelled);
        }
        let room = (MAX_DIAGNOSTIC_PIPE_BYTES - bytes).min(buffer.len());
        let read = tokio::select! {
            biased;
            _ = stop.changed() => continue,
            read = pipe.read(&mut buffer[..room.max(1)]) => read.map_err(|_| Failure::DiagnosticRead)?,
        };
        if read == 0 {
            return Ok(DiagnosticReceipt { bytes });
        }
        if read > MAX_DIAGNOSTIC_PIPE_BYTES - bytes {
            return Err(Failure::DiagnosticBound);
        }
        bytes += read;
    }
}

async fn cleanup(entry: &Arc<Entry>) {
    entry.phase(Phase::Draining);
    entry.request_stop(Failure::Cancelled);
    let lease_task = entry
        .lease_task
        .lock()
        .expect("child encoder lease task")
        .take();
    if let Some(task) = lease_task {
        let _ = task.await;
    }
    // Never use a timeout as reap, pipe-join, input drain or output disposal.
    // Recoverable failures retry only these SAME real retained owners.
    loop {
        let mut positive = true;
        if let Some(process) = entry.process.get() {
            let mut process = process.lock().await;
            if process.exit.is_none() {
                match process.child.kill().await {
                    Ok(()) => match process.child.try_wait() {
                        Ok(Some(exit)) => process.exit = Some(exit),
                        _ => positive = false,
                    },
                    Err(_) => positive = false,
                }
            }
            if process.diagnostic_result.is_none() {
                if let Some(task) = process.diagnostics.as_mut() {
                    let observed = task.await.unwrap_or(Err(Failure::DiagnosticJoin));
                    process.diagnostic_result = Some(observed);
                }
                // Missing diagnostics stays explicit; it is not bytes=0.
                else {
                    process.diagnostic_result = Some(Err(Failure::DiagnosticMissing));
                }
            }
        }
        if entry.preparation_scope.shutdown().await.is_ok() {
            entry.preparation_drained.store(true, Ordering::SeqCst);
        } else {
            positive = false;
        }
        if let Some(input) = entry.input.get()
            && input.close_and_drain().await.is_err()
        {
            positive = false;
        }
        if let Some(output) = entry.output.get()
            && entry.output_disposal.get().is_none()
        {
            match output.close_and_dispose().await {
                Ok(proof) => {
                    let _ = entry.output_disposal.set(proof);
                }
                Err(_) => positive = false,
            }
        }
        if let Some(execution) = entry.execution.get() {
            let mut execution = execution.lock().await;
            // Logical terminalization is independent of positive drain. These
            // calls cannot release the 0049 accounting reservation.
            if entry.published.get().is_none() && execution.cancel(&entry.pool).await.is_err() {
                positive = false;
            }
            if execution.input_preparation_handle().is_ok()
                && !entry.execution_acknowledged.load(Ordering::SeqCst)
            {
                if execution.close_and_acknowledge(&entry.pool).await.is_ok() {
                    entry.execution_acknowledged.store(true, Ordering::SeqCst);
                } else {
                    positive = false;
                }
            }
            if let Some(reservation) = entry.reservation.get() {
                let mut reservation = reservation.lock().await;
                if reservation.must_retain() && !*entry.publication_started.borrow() {
                    entry.reservation_retained.store(true, Ordering::SeqCst);
                    match reservation
                        .record_failure(&entry.pool, execution.claim())
                        .await
                    {
                        Ok(persistence::static_hls_child_output::Failure::Recorded) => {
                            entry.output_unknown.store(false, Ordering::SeqCst);
                        }
                        Ok(persistence::static_hls_child_output::Failure::NotAdmitted) => {
                            entry.output_unknown.store(false, Ordering::SeqCst);
                            entry.reservation_retained.store(false, Ordering::SeqCst);
                        }
                        _ => {
                            entry.output_unknown.store(true, Ordering::SeqCst);
                            positive = false;
                        }
                    }
                }
            }
        }
        // Directory/process/reader disposal and accounting are separate facts.
        // Only the exact positive proof plus original permit may mint this
        // single retained cleanup operation. Unknown COMMIT retries that SAME
        // operation; never mint a fresh token from an equal job/attempt tuple.
        if entry.output_cleanup.get().is_none()
            && let (Some(permit), Some(proof)) = (entry.permit.get(), entry.output_disposal.get())
        {
            match ChildOutputCleanup::prepare(permit.clone(), proof.clone()) {
                Ok(operation) => {
                    if entry.output_cleanup.set(Mutex::new(operation)).is_err() {
                        positive = false;
                    }
                }
                Err(_) => positive = false,
            }
        }
        if let Some(operation) = entry.output_cleanup.get() {
            match operation.lock().await.acknowledge().await {
                Ok(CleanupAcknowledgment::Released) => {
                    entry.reservation_retained.store(false, Ordering::SeqCst);
                    entry.output_unknown.store(false, Ordering::SeqCst);
                }
                _ => {
                    entry.reservation_retained.store(true, Ordering::SeqCst);
                    entry.output_unknown.store(true, Ordering::SeqCst);
                    positive = false;
                }
            }
        }
        // Terminalize the exact capture/request through its retained child
        // registry, too. Stopping only the job would leave its separate 128 MiB
        // input capture logically active until natural preparation expiry.
        if entry.published.get().is_none() && !entry.child_request_cancelled.load(Ordering::SeqCst)
        {
            match entry
                .app
                .static_hls_children
                .cancel(&entry.app, entry.held.input())
                .await
            {
                Ok(super::static_hls_child_registry::Status::LocalOwnerMissing) | Err(_) => {
                    positive = false
                }
                Ok(_) => {
                    entry.child_request_cancelled.store(true, Ordering::SeqCst);
                }
            }
        }
        // An abandoned input-preparation waiter still has the capture's actual
        // reader/descriptor owner. Its positive disposal, not absence of a
        // returned lease, is the physical completion observation.
        match entry.held.capture().control() {
            Ok(control) => {
                if control.disposal_retry_available() {
                    let _ = control.retry_disposal().await;
                }
                if control.disposal_state() != media_core::static_hls::DisposalState::Disposed {
                    positive = false;
                }
            }
            Err(_) => positive = false,
        }
        if positive {
            entry.phase(Phase::Retained);
            return;
        }
        tokio::time::sleep(CLEANUP_BACKOFF).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_position_projection_preserves_fractional_numbers() {
        let position: Position = serde_json::from_str(r#"{"position_ms":1013.5}"#).unwrap();
        assert_eq!(position.position_ms.to_bits(), 1013.5f64.to_bits());
        for invalid in [
            r#"{"position_ms":"1013.5"}"#,
            r#"{"position_ms":"NaN"}"#,
            r#"{"position_ms":null}"#,
            r#"{"position_ms":true}"#,
            r#"{"position_ms":[]}"#,
            r#"{"position_ms":{}}"#,
            r#"{"position_ms":1e400}"#,
        ] {
            assert!(serde_json::from_str::<Position>(invalid).is_err());
        }
    }

    #[test]
    fn default_registry_cannot_activate_or_create_work() {
        let registry = Registry::default();
        assert!(!registry.0.accepting.load(Ordering::SeqCst));
        assert!(registry.0.entries.lock().unwrap().is_empty());
        let fixture = Registry::for_owned_fixture();
        fixture.close();
        assert!(!fixture.0.accepting.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn diagnostic_exact_bound_is_joined_eof_evidence() {
        let (_send, stop) = watch::channel(false);
        let bytes = vec![b'x'; MAX_DIAGNOSTIC_PIPE_BYTES];
        let result = read_diagnostics(bytes.as_slice(), stop).await.unwrap();
        assert_eq!(result.bytes, MAX_DIAGNOSTIC_PIPE_BYTES);
    }

    #[tokio::test]
    async fn diagnostic_one_extra_byte_refuses_success() {
        let (_send, stop) = watch::channel(false);
        let bytes = vec![b'x'; MAX_DIAGNOSTIC_PIPE_BYTES + 1];
        assert_eq!(
            read_diagnostics(bytes.as_slice(), stop).await,
            Err(Failure::DiagnosticBound)
        );
    }

    #[tokio::test]
    async fn diagnostic_cancellation_is_never_zero_byte_success() {
        let (_send, stop) = watch::channel(true);
        assert_eq!(
            read_diagnostics(&b""[..], stop).await,
            Err(Failure::Cancelled)
        );
    }

    #[test]
    fn encoding_module_requires_typed_publication_and_disposal() {
        let source = include_str!("static_hls_child_encoder.rs");
        let production = source.split("#[cfg(test)]\nmod tests").next().unwrap();
        for forbidden in [
            "cache_budget::release",
            "output_publish::",
            "static_hls_child_publication::",
            "status='ready'",
            "status='completed'",
            "public_url",
        ] {
            assert!(
                !production.contains(forbidden),
                "forbidden child completion shortcut: {forbidden}"
            );
        }
        assert!(production.contains("entry.output.set(output)"));
        assert!(production.contains("output.inspect_after_reap()"));
        assert!(production.contains("process.diagnostics.as_mut()"));
        assert!(production.contains("publish_candidate(&entry).await"));
        assert!(production.contains("ChildOutputCleanup::prepare"));
        assert!(production.contains("PreparedChildOutputPublication::prepare"));
        assert!(production.contains("pub(super) async fn inspection"));
    }
}
