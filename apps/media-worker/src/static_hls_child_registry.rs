//! Inactive, same-startup child capture custody.
//!
//! A caller must first commit the one-shot child claim. The bound Worker then
//! obtains the actual parent's already-retained control from its original local
//! entry, even if the claim has cancelled or disposed that parent. This handle
//! observes/disposes the original owner; it grants no new reads or publication.
//! Missing local custody stays missing, never reconstructed from SQL or UUIDs.
//! The registry waits for that actual owner's positive disposal before admission.
//! It neither creates an endpoint nor enables the generic encoder path.
//! Stored identifiers, graph statements and SQL statuses cannot mint owners.
#![allow(dead_code)]

use super::App;
use aes_gcm::aead::Aead;
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use media_core::static_hls::{
    CaptureControl, CaptureFuture, CaptureOptions, CapturePermit, DisposalState, ResourceIdentity,
    VerifiedCapture,
    contracts::{
        graph::RootGraphStatement,
        input::{FrozenInput, OperationKind, SelectedAudioStatement},
        worker::WorkerStatement,
    },
};
use persistence::{
    static_hls_child_capture::{
        self as admission, ChildCaptureAdmission, PersistedChildCapturePermit,
    },
    static_hls_child_claim::PreparedChildInput,
};
use providers::{SourceConfig, static_hls::RegisteredSource};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        Arc, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::Mutex, time::Instant};
use uuid::Uuid;

const MAX_LOCAL_CHILDREN: usize = 4096;
const OWNER_PULSE: Duration = Duration::from_millis(100);
const SHUTDOWN_STEP_TIME: Duration = Duration::from_secs(6);
const SHUTDOWN_BACKOFF_INITIAL: Duration = Duration::from_millis(250);
const SHUTDOWN_BACKOFF_MAX: Duration = Duration::from_secs(2);

#[derive(Clone, Default)]
pub(super) struct Registry(Arc<Owners>);
#[derive(Default)]
struct Owners {
    accepting: AtomicBool,
    entries: Mutex<HashMap<Uuid, Arc<Entry>>>,
}

/// Internal post-claim inputs only. `parent_control` is cloned from the actual
/// parent's retained local entry on this startup. It may already be cancelled
/// or positively disposed when obtained after the durable claim. It is never a
/// cross-service serialized owner or a newly minted read grant. Equality of its
/// identifiers is checked below, but cannot construct that opaque control.
/// A missing original entry/control must fail closed. The child admission still
/// independently checks its durable claim, whole root and current authority.
pub(super) struct Create<'a> {
    pub(super) prepared: &'a PreparedChildInput,
    pub(super) parent: FrozenInput,
    pub(super) root: Arc<RootGraphStatement>,
    pub(super) parent_control: CaptureControl,
    pub(super) observed: Option<&'a WorkerStatement>,
    pub(super) accept_until_ms: u64,
}

struct Entry {
    // Intentional same-process retention: dropping an HTTP/App waiter cannot
    // lose an uncertain admission token. This bounded cycle is broken only by
    // a future ordered positive-disposal/retention pruning implementation.
    // No lookup API can turn its identity back into an owner.
    _registry_keepalive: Arc<Owners>,
    input: FrozenInput,
    parent: FrozenInput,
    root: Arc<RootGraphStatement>,
    parent_control: CaptureControl,
    // Install the original token before the first admission await. A failed
    // COMMIT acknowledgment never loses this token or permits replacement.
    admission: Mutex<ChildCaptureAdmission>,
    admission_attempted: AtomicBool,
    cancelled: AtomicBool,
    owner: OnceLock<Arc<PersistedChildCapturePermit>>,
    control: OnceLock<CaptureControl>,
    state: Mutex<EntryState>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    preparation_scope: media_core::child_process::Scope,
    preparation_drained: AtomicBool,
    fence: WorkFence,
    accept_until_ms: u64,
    source: CaptureSource,
}

enum EntryState {
    WaitingParent,
    Capturing,
    AdmissionUnknown,
    Recovering,
    Verified {
        snapshot: Arc<VerifiedCapture>,
        at_ms: u64,
    },
    Refused(Refusal),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Refusal {
    Cancelled,
    PreparationExpired,
    AdmissionChanged,
    Capacity,
    AuthorityRevoked,
    RetainedCustody,
    AdmissionNotCommitted,
    CaptureUnconfirmed,
    Unavailable,
}

/// Bounded observations only. CancelRequested, Unknown and elapsed work fences
/// do not acknowledge disposal or release a database/cache reservation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum Status {
    WaitingParent {
        disposal: DisposalState,
    },
    Capturing,
    CommitUnknown,
    Recovering,
    Verified {
        root_digest: String,
        verified_at_ms: u64,
        selected_audio: SelectedAudioStatement,
    },
    Refused(Refusal),
    CancelRequested {
        parent_disposal: DisposalState,
        child_disposal: Option<DisposalState>,
        admission_unknown: bool,
    },
    Disposed,
    LocalOwnerMissing,
}

/// Still-held obligations after a single shutdown observation. There is no
/// timeout-to-disposed transition and close/drain never clear the registry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct Standby {
    pub(super) retained_entries: usize,
    pub(super) unresolved_owners: usize,
    pub(super) unknown_admissions: usize,
    pub(super) pending_tasks: usize,
}
impl Standby {
    fn confirmed(&self) -> bool {
        self.unresolved_owners == 0 && self.unknown_admissions == 0 && self.pending_tasks == 0
    }
}

/// Original child capture, input and full root proof, all from one retained
/// entry. This is not an encoder lease, output reservation or SQL job attempt.
/// Consumers still require the dedicated closed child execution contract.
pub(super) struct HeldChildCapture {
    entry: Arc<Entry>,
    registry: Weak<Owners>,
    snapshot: Arc<VerifiedCapture>,
    owner: Arc<PersistedChildCapturePermit>,
}
impl HeldChildCapture {
    pub(super) fn input(&self) -> &FrozenInput {
        &self.entry.input
    }
    pub(super) fn parent_input(&self) -> &FrozenInput {
        &self.entry.parent
    }
    pub(super) fn root_statement(&self) -> &RootGraphStatement {
        &self.entry.root
    }
    pub(super) fn capture(&self) -> &VerifiedCapture {
        &self.snapshot
    }
    pub(super) fn capture_handle(&self) -> Arc<VerifiedCapture> {
        self.snapshot.clone()
    }
    pub(super) fn root_handle(&self) -> Arc<RootGraphStatement> {
        self.entry.root.clone()
    }
    pub(super) fn preparation_until(&self) -> Instant {
        self.entry.fence.preparation_until
    }
    pub(super) fn root_until(&self) -> Instant {
        self.entry.fence.root_until
    }
    pub(super) async fn check(&self) -> Result<()> {
        require_active(&self.registry, &self.entry)?;
        self.snapshot.live_evidence()?;
        self.owner.check().await?;
        require_active(&self.registry, &self.entry)?;
        self.snapshot.live_evidence()?;
        Ok(())
    }
}

impl Registry {
    pub(super) fn open(&self) {
        self.0.accepting.store(true, Ordering::SeqCst);
    }

    /// Close new work, signal only retained actual owners, and keep all tokens,
    /// immutable inputs and graph proofs for unresolved disposal/recovery.
    pub(super) async fn close(&self) {
        self.0.accepting.store(false, Ordering::SeqCst);
        let entries: Vec<_> = self.0.entries.lock().await.values().cloned().collect();
        for entry in entries {
            entry.cancelled.store(true, Ordering::SeqCst);
            entry.parent_control.cancel();
            if let Some(control) = entry.control.get() {
                control.cancel();
            }
            // Seal task registration against the standby drain snapshot.
            let _registration = entry.task.lock().await;
        }
    }

    pub(super) async fn create_owned(&self, app: &App, create: Create<'_>) -> Result<Status> {
        let input = create.prepared.input();
        let operation = operation_id(input)?;
        let mut entries = self.0.entries.lock().await;
        if let Some(entry) = entries.get(&operation).cloned() {
            // An idempotent observation never installs the new caller's token,
            // control, owner, source or renewed stopwatch over the original.
            entry.input.require_same_frozen_input(input)?;
            entry.parent.require_same_frozen_input(&create.parent)?;
            ensure!(
                entry.root.private_storage_plaintext() == create.root.private_storage_plaintext(),
                "static_hls_child_operation_conflict"
            );
            drop(entries);
            return status(&entry).await;
        }
        ensure!(
            self.0.accepting.load(Ordering::SeqCst),
            "static_hls_worker_closing"
        );
        ensure!(
            entries.len() < MAX_LOCAL_CHILDREN,
            "static_hls_child_operation_capacity"
        );
        require_lineage(input, &create.parent, &create.root, &create.parent_control)?;
        ensure!(
            now_ms()? < create.accept_until_ms,
            "static_hls_child_acceptance_expired"
        );
        let fence = WorkFence::from_input(input)?;
        let source = CaptureSource::from_input(input, &create.root)?;
        let attempt = ChildCaptureAdmission::prepare(
            create.prepared,
            create.parent.clone(),
            create.root.clone(),
            *super::static_hls_contract::INSTANCE,
            create.observed,
        )?;
        let entry = Arc::new(Entry {
            _registry_keepalive: self.0.clone(),
            input: input.clone(),
            parent: create.parent,
            root: create.root,
            parent_control: create.parent_control,
            admission: Mutex::new(attempt),
            admission_attempted: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            owner: OnceLock::new(),
            control: OnceLock::new(),
            state: Mutex::new(EntryState::WaitingParent),
            task: Mutex::new(None),
            preparation_scope: Default::default(),
            preparation_drained: AtomicBool::new(false),
            fence,
            accept_until_ms: create.accept_until_ms,
            source,
        });
        entries.insert(operation, entry.clone());
        // Registration and original-token retention precede all admission IO.
        let mut registration = entry.task.lock().await;
        let own = entry.clone();
        let registry = Arc::downgrade(&self.0);
        let app = app.clone();
        *registration = Some(tokio::spawn(async move {
            let outcome = own
                .preparation_scope
                .run(prepare_owned(&app, &registry, &own))
                .await;
            finish(&own, outcome).await;
        }));
        drop(registration);
        drop(entries);
        status(&entry).await
    }

    /// Query observes only this startup's retained original entry. A missing
    /// entry stays missing even if SQL says capturing, verified or disposed.
    pub(super) async fn query(&self, input: &FrozenInput) -> Result<Status> {
        let Some(entry) = self.entry(input).await? else {
            return Ok(Status::LocalOwnerMissing);
        };
        reap_failed_task(&entry).await;
        status(&entry).await
    }

    /// Terminalize the exact original child request and signal its retained
    /// owners. Request cancellation is separate from physical disposal.
    pub(super) async fn cancel(&self, app: &App, input: &FrozenInput) -> Result<Status> {
        let Some(entry) = self.entry(input).await? else {
            return Ok(Status::LocalOwnerMissing);
        };
        entry.cancelled.store(true, Ordering::SeqCst);
        entry.parent_control.cancel();
        if let Some(control) = entry.control.get() {
            control.cancel();
        }
        if let Some(owner) = entry.owner.get() {
            owner
                .cancel_child(410, "static_hls_child_cancelled")
                .await?;
        } else {
            entry
                .admission
                .lock()
                .await
                .cancel_child(&app.db, 410, "static_hls_child_cancelled")
                .await?;
        }
        status(&entry).await
    }

    /// Recover only an uncertain original COMMIT using its retained opaque
    /// mutable token. This cannot re-admit after a known refusal or replace a
    /// lost local owner. A late acquired permit is still retained for cleanup.
    pub(super) async fn recover_original(&self, app: &App, input: &FrozenInput) -> Result<Status> {
        let Some(entry) = self.entry(input).await? else {
            return Ok(Status::LocalOwnerMissing);
        };
        let mut registration = entry.task.lock().await;
        if registration
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            drop(registration);
            return status(&entry).await;
        }
        if let Some(task) = registration.take()
            && task.await.is_err()
        {
            tracing::warn!("static_hls_child_task_unconfirmed");
            finish(
                &entry,
                Err(anyhow::anyhow!("static_hls_child_task_unconfirmed")),
            )
            .await;
        }
        let mut state = entry.state.lock().await;
        if !matches!(*state, EntryState::AdmissionUnknown) || entry.owner.get().is_some() {
            drop(state);
            drop(registration);
            return status(&entry).await;
        }
        // No renewed work fence is installed during recovery, including after
        // cancellation/standby. Closed activation yields real NeverStarted proof.
        *state = EntryState::Recovering;
        drop(state);
        let app = app.clone();
        let registry = Arc::downgrade(&self.0);
        let own = entry.clone();
        *registration = Some(tokio::spawn(async move {
            let outcome = recover_owned(&app, &registry, &own).await;
            finish(&own, outcome).await;
        }));
        drop(registration);
        status(&entry).await
    }

    pub(super) async fn original_capture(&self, input: &FrozenInput) -> Result<HeldChildCapture> {
        let entry = self
            .entry(input)
            .await?
            .context("static_hls_local_child_owner_missing")?;
        let registry = Arc::downgrade(&self.0);
        require_active(&registry, &entry)?;
        let snapshot = match &*entry.state.lock().await {
            EntryState::Verified { snapshot, .. } => snapshot.clone(),
            _ => anyhow::bail!("static_hls_child_snapshot_unavailable"),
        };
        let owner = entry
            .owner
            .get()
            .context("static_hls_local_child_owner_missing")?
            .clone();
        let held = HeldChildCapture {
            entry,
            registry,
            snapshot,
            owner,
        };
        held.check().await?;
        Ok(held)
    }

    pub(super) async fn drain(&self) -> Standby {
        let entries: Vec<_> = self.0.entries.lock().await.values().cloned().collect();
        for entry in &entries {
            if let Some(task) = entry.task.lock().await.take()
                && task.await.is_err()
            {
                tracing::warn!("static_hls_child_task_unconfirmed");
                finish(
                    entry,
                    Err(anyhow::anyhow!("static_hls_child_task_unconfirmed")),
                )
                .await;
            }
            if let Some(control) = entry.control.get() {
                control.cancel();
                if control.disposal_retry_available() {
                    let _ = control.retry_disposal().await;
                }
            }
            if entry.parent_control.disposal_retry_available() {
                let _ = entry.parent_control.retry_disposal().await;
            }
        }
        for entry in &entries {
            if entry.preparation_scope.shutdown().await.is_ok() {
                entry.preparation_drained.store(true, Ordering::SeqCst);
            }
        }
        self.standby().await
    }

    /// Actual shutdown, not a bounded observation pretending to release owners.
    /// Unknown admissions stay in this process until same-token recovery proves
    /// no COMMIT or supplies their original permit for real NeverStarted drain.
    /// Physical/DB nonresponse keeps the process in standby, with bounded retries.
    pub(super) async fn drain_until_confirmed(&self, app: &App) {
        self.close().await;
        self.shutdown_until_confirmed(|entry| {
            let registry = self.clone();
            let app = app.clone();
            async move {
                let _ = registry.recover_original(&app, &entry.input).await?;
                Ok(())
            }
        })
        .await;
    }

    async fn shutdown_until_confirmed<F, Fut>(&self, mut recover: F) -> Standby
    where
        F: FnMut(Arc<Entry>) -> Fut,
        Fut: std::future::Future<Output = Result<()>>,
    {
        let mut backoff = SHUTDOWN_BACKOFF_INITIAL;
        let mut previous = None;
        let mut cursor = 0usize;
        loop {
            let entries: Vec<_> = self.0.entries.lock().await.values().cloned().collect();
            let round_until = Instant::now() + SHUTDOWN_STEP_TIME;
            let count = entries.len();
            for offset in 0..count {
                let index = (cursor + offset) % count;
                let entry = entries[index].clone();
                // Timeout drops only this observation/retry. The original task,
                // mutable admission, control and opaque proof remain retained.
                let step = async {
                    reap_failed_task(&entry).await;
                    // A cancelled blocking waiter is not physical completion.
                    // This actual scope retains and retries its original receipt.
                    entry.preparation_scope.shutdown().await?;
                    entry.preparation_drained.store(true, Ordering::SeqCst);
                    entry.parent_control.cancel();
                    if entry.parent_control.disposal_retry_available() {
                        let _ = entry.parent_control.retry_disposal().await?;
                    }
                    if let Some(control) = entry.control.get() {
                        control.cancel();
                        if control.disposal_retry_available() {
                            let _ = control.retry_disposal().await?;
                        }
                    }
                    let needs_recovery = entry.owner.get().is_none()
                        && matches!(*entry.state.lock().await, EntryState::AdmissionUnknown);
                    if needs_recovery {
                        recover(entry.clone()).await?;
                    }
                    Ok::<_, anyhow::Error>(())
                };
                if !tokio::time::timeout_at(round_until, step)
                    .await
                    .is_ok_and(|result| result.is_ok())
                {
                    // No source/input/private error formatting in diagnostics.
                    tracing::warn!("static_hls_child_shutdown_observation_unconfirmed");
                }
                if Instant::now() >= round_until {
                    // Rotate the next bounded round rather than letting one
                    // unavailable owner starve every later retained obligation.
                    cursor = (index + 1) % count;
                    break;
                }
            }
            let retained = self.standby().await;
            if retained.confirmed() {
                return retained;
            }
            if previous != Some(retained) {
                tracing::warn!(
                    unresolved_owners = retained.unresolved_owners,
                    unknown_admissions = retained.unknown_admissions,
                    pending_tasks = retained.pending_tasks,
                    "static_hls_child_shutdown_standby"
                );
                previous = Some(retained);
            }
            tokio::time::sleep(backoff).await;
            backoff = backoff.saturating_mul(2).min(SHUTDOWN_BACKOFF_MAX);
        }
    }

    async fn standby(&self) -> Standby {
        let entries: Vec<_> = self.0.entries.lock().await.values().cloned().collect();
        let mut retained = Standby {
            retained_entries: entries.len(),
            unresolved_owners: 0,
            unknown_admissions: 0,
            pending_tasks: 0,
        };
        for entry in entries {
            if !entry.preparation_drained.load(Ordering::SeqCst)
                || entry.parent_control.disposal_state() != DisposalState::Disposed
                || entry
                    .control
                    .get()
                    .is_some_and(|control| control.disposal_state() != DisposalState::Disposed)
                || (entry.owner.get().is_some() && entry.control.get().is_none())
            {
                retained.unresolved_owners += 1;
            }
            if matches!(
                *entry.state.lock().await,
                EntryState::AdmissionUnknown | EntryState::Recovering
            ) {
                retained.unknown_admissions += 1;
            }
            // A finished-but-unjoined task may have panicked before recording
            // its COMMIT uncertainty. Do not declare clean until JoinResult is
            // actually observed and the retained state is updated.
            if entry.task.lock().await.is_some() {
                retained.pending_tasks += 1;
            }
        }
        retained
    }

    async fn entry(&self, input: &FrozenInput) -> Result<Option<Arc<Entry>>> {
        require_startup(input)?;
        let entry = self
            .0
            .entries
            .lock()
            .await
            .get(&operation_id(input)?)
            .cloned();
        if let Some(entry) = &entry {
            entry.input.require_same_frozen_input(input)?;
        }
        Ok(entry)
    }
}

async fn finish(entry: &Entry, result: Result<EntryState>) {
    *entry.state.lock().await = result.unwrap_or_else(|_| {
        if entry.owner.get().is_some() {
            EntryState::Refused(Refusal::CaptureUnconfirmed)
        } else if entry.admission_attempted.load(Ordering::SeqCst) {
            EntryState::AdmissionUnknown
        } else {
            EntryState::Refused(Refusal::Unavailable)
        }
    });
}

async fn reap_failed_task(entry: &Entry) {
    let mut registration = entry.task.lock().await;
    if registration
        .as_ref()
        .is_some_and(tokio::task::JoinHandle::is_finished)
        && let Some(task) = registration.take()
        && task.await.is_err()
    {
        tracing::warn!("static_hls_child_task_unconfirmed");
        finish(
            entry,
            Err(anyhow::anyhow!("static_hls_child_task_unconfirmed")),
        )
        .await;
    }
}

async fn prepare_owned(
    app: &App,
    registry: &Weak<Owners>,
    entry: &Arc<Entry>,
) -> Result<EntryState> {
    loop {
        if entry.cancelled.load(Ordering::SeqCst) {
            return Ok(EntryState::Refused(Refusal::Cancelled));
        }
        require_active(registry, entry)?;
        if parent_disposed(&entry.parent_control) {
            break;
        }
        if entry.parent_control.disposal_retry_available() {
            let _ = entry.parent_control.retry_disposal().await;
        }
        tokio::time::sleep_until((Instant::now() + OWNER_PULSE).min(entry.fence.until())).await;
    }
    // Only a positive actual parent receipt permits the new entire reservation.
    ensure!(
        parent_disposed(&entry.parent_control),
        "static_hls_parent_disposal_unconfirmed"
    );
    let revision = tokio::time::timeout_at(
        entry.fence.until(),
        persistence::cache_budget::snapshot(&app.db),
    )
    .await
    .context("static_hls_child_preparation_expired")??;
    let cache = app.cache.clone();
    let headroom = tokio::time::timeout_at(
        entry.fence.until(),
        media_core::child_process::blocking(move || super::cache::reservation_headroom(&cache)),
    )
    .await
    .context("static_hls_child_preparation_expired")???;
    require_active(registry, entry)?;
    ensure!(
        now_ms()? < entry.accept_until_ms,
        "static_hls_child_acceptance_expired"
    );
    let mut attempt = entry.admission.lock().await;
    entry.admission_attempted.store(true, Ordering::SeqCst);
    let admitted = tokio::time::timeout_at(
        entry.fence.until(),
        admission::admit(&app.db, &mut attempt, revision, headroom),
    )
    .await
    .context("static_hls_child_admission_unconfirmed")??;
    drop(attempt);
    match admitted {
        admission::Admission::Acquired(permit) => capture_owned(app, registry, entry, permit).await,
        admission::Admission::CommitUnknown => Ok(EntryState::AdmissionUnknown),
        admission::Admission::Changed => Ok(EntryState::Refused(Refusal::AdmissionChanged)),
        admission::Admission::Full => Ok(EntryState::Refused(Refusal::Capacity)),
        admission::Admission::Stale => Ok(EntryState::Refused(Refusal::AuthorityRevoked)),
        admission::Admission::RetainedCustody => Ok(EntryState::Refused(Refusal::RetainedCustody)),
    }
}

async fn recover_owned(
    app: &App,
    registry: &Weak<Owners>,
    entry: &Arc<Entry>,
) -> Result<EntryState> {
    ensure!(
        parent_disposed(&entry.parent_control),
        "static_hls_parent_disposal_unconfirmed"
    );
    let recovered = tokio::time::timeout(SHUTDOWN_STEP_TIME, async {
        let mut original = entry.admission.lock().await;
        admission::recover(&app.db, &mut original).await
    })
    .await
    .context("static_hls_child_recovery_unconfirmed")??;
    match recovered {
        admission::Recovery::Acquired(permit) => capture_owned(app, registry, entry, permit).await,
        admission::Recovery::NotCommitted => {
            Ok(EntryState::Refused(Refusal::AdmissionNotCommitted))
        }
        admission::Recovery::CommitUnknown => Ok(EntryState::AdmissionUnknown),
    }
}

async fn capture_owned(
    app: &App,
    registry: &Weak<Owners>,
    entry: &Arc<Entry>,
    permit: admission::ChildCapturePermit,
) -> Result<EntryState> {
    let admission_fresh = now_ms().is_ok_and(|now| now < entry.accept_until_ms);
    let owner = Arc::new(PersistedChildCapturePermit::new(
        app.db.clone(),
        permit,
        Arc::new(Activation {
            registry: registry.clone(),
            entry: Arc::downgrade(entry),
            admission_fresh,
        }),
    ));
    entry
        .owner
        .set(owner.clone())
        .map_err(|_| anyhow::anyhow!("static_hls_original_child_permit_replaced"))?;
    // Even late admission/cancellation goes through the actual core owner.
    // Closed activation prevents I/O and yields its genuine NeverStarted proof.
    let handle = media_core::static_hls::start_capture(
        owner.clone(),
        Arc::new(RegisteredSource::new(
            entry.source.config.clone(),
            entry.source.config.headers.clone(),
        )),
        CaptureOptions {
            cache_root: app.cache.clone(),
            manifest_url: entry.source.manifest.clone(),
            selected_audio: entry.source.selected_audio,
            expected_inventory: Some(entry.source.inventory.clone()),
        },
    )?;
    entry
        .control
        .set(handle.control()?)
        .map_err(|_| anyhow::anyhow!("static_hls_original_child_control_replaced"))?;
    if require_active(registry, entry).is_err() || !admission_fresh {
        entry
            .control
            .get()
            .expect("installed original child control")
            .cancel();
    }
    *entry.state.lock().await = EntryState::Capturing;
    let remaining = entry.fence.remaining().unwrap_or(Duration::from_millis(1));
    let captured = handle
        .wait_with_budget(remaining.min(media_core::static_hls::CAPTURE_WAITER_TIME))
        .await?;
    ensure!(
        owner
            .verify_capture(&captured, |plain| seal_storage(app, plain))
            .await?,
        "static_hls_child_verification_unconfirmed"
    );
    require_active(registry, entry)?;
    captured.live_evidence()?;
    Ok(EntryState::Verified {
        snapshot: Arc::new(captured),
        at_ms: now_ms()?,
    })
}

async fn status(entry: &Entry) -> Result<Status> {
    if entry
        .control
        .get()
        .is_some_and(|control| control.disposal_state() == DisposalState::Disposed)
    {
        return Ok(Status::Disposed);
    }
    let state = entry.state.lock().await;
    if entry.cancelled.load(Ordering::SeqCst) {
        return Ok(Status::CancelRequested {
            parent_disposal: entry.parent_control.disposal_state(),
            child_disposal: entry.control.get().map(CaptureControl::disposal_state),
            admission_unknown: matches!(
                *state,
                EntryState::AdmissionUnknown | EntryState::Recovering
            ),
        });
    }
    Ok(match &*state {
        EntryState::WaitingParent => Status::WaitingParent {
            disposal: entry.parent_control.disposal_state(),
        },
        EntryState::Capturing => Status::Capturing,
        EntryState::AdmissionUnknown => Status::CommitUnknown,
        EntryState::Recovering => Status::Recovering,
        EntryState::Verified { snapshot, at_ms } => {
            let live = snapshot.live_evidence().is_ok()
                && entry.fence.remaining().is_ok()
                && match entry.owner.get() {
                    Some(owner) => owner.check().await.is_ok(),
                    None => false,
                }
                && snapshot.live_evidence().is_ok()
                && entry.fence.remaining().is_ok()
                && !entry.cancelled.load(Ordering::SeqCst);
            if live {
                Status::Verified {
                    root_digest: entry.root.root_digest().into(),
                    verified_at_ms: *at_ms,
                    selected_audio: entry.root.selected_audio_statement(),
                }
            } else {
                Status::Refused(Refusal::AuthorityRevoked)
            }
        }
        EntryState::Refused(reason) => Status::Refused(*reason),
    })
}

struct Activation {
    registry: Weak<Owners>,
    entry: Weak<Entry>,
    admission_fresh: bool,
}
impl persistence::static_hls::ActivationCheck for Activation {
    fn check(&self) -> CaptureFuture<'_, ()> {
        Box::pin(async {
            ensure!(self.admission_fresh, "static_hls_child_admission_expired");
            let entry = self
                .entry
                .upgrade()
                .context("static_hls_local_child_owner_missing")?;
            require_active(&self.registry, &entry)
        })
    }
}

fn require_active(registry: &Weak<Owners>, entry: &Entry) -> Result<()> {
    ensure!(
        registry
            .upgrade()
            .is_some_and(|owners| owners.accepting.load(Ordering::SeqCst)),
        "static_hls_worker_closing"
    );
    ensure!(
        !entry.cancelled.load(Ordering::SeqCst),
        "static_hls_child_cancelled"
    );
    entry.fence.remaining()?;
    Ok(())
}
fn parent_disposed(control: &CaptureControl) -> bool {
    control.disposal_state() == DisposalState::Disposed
}
fn require_startup(input: &FrozenInput) -> Result<()> {
    ensure!(
        input.kind() == OperationKind::Child,
        "static_hls_child_input_required"
    );
    ensure!(
        Uuid::parse_str(&input.identity_statement().worker_instance)?
            == *super::static_hls_contract::INSTANCE,
        "static_hls_worker_changed"
    );
    Ok(())
}
fn operation_id(input: &FrozenInput) -> Result<Uuid> {
    require_startup(input)?;
    Ok(Uuid::parse_str(&input.identity_statement().operation_id)?)
}
fn require_lineage(
    child: &FrozenInput,
    parent: &FrozenInput,
    root: &RootGraphStatement,
    control: &CaptureControl,
) -> Result<()> {
    require_startup(child)?;
    ensure!(
        parent.kind() == OperationKind::Parent,
        "static_hls_parent_input_required"
    );
    root.require_parent_input(parent)?;
    child.require_child_of(parent, root.root_digest(), root.selected_audio_statement())?;
    ensure!(
        control.identity().capture_id == parent.identity_statement().operation_id,
        "static_hls_original_parent_control_required"
    );
    Ok(())
}

#[derive(Clone, Copy)]
struct WorkFence {
    preparation_until: Instant,
    root_until: Instant,
}
impl WorkFence {
    fn from_input(input: &FrozenInput) -> Result<Self> {
        let began = Instant::now();
        Self::at(
            began,
            now_ms()?,
            input.preparation_deadline_ms(),
            input.root_deadline_ms(),
        )
    }
    fn at(began: Instant, observed_ms: u64, preparation_ms: u64, root_ms: u64) -> Result<Self> {
        let deadline = |expires: u64| -> Result<Instant> {
            let remaining = expires
                .checked_sub(observed_ms)
                .filter(|remaining| *remaining > 0)
                .context("static_hls_child_preparation_expired")?;
            began
                .checked_add(Duration::from_millis(remaining))
                .context("static_hls_child_clock_overflow")
        };
        Ok(Self {
            preparation_until: deadline(preparation_ms)?,
            root_until: deadline(root_ms)?,
        })
    }
    fn until(&self) -> Instant {
        self.preparation_until.min(self.root_until)
    }
    fn remaining(&self) -> Result<Duration> {
        self.until()
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .context("static_hls_child_preparation_expired")
    }
}

struct CaptureSource {
    config: SourceConfig,
    manifest: String,
    inventory: Vec<ResourceIdentity>,
    selected_audio: Option<u32>,
}
impl CaptureSource {
    fn from_input(input: &FrozenInput, root: &RootGraphStatement) -> Result<Self> {
        #[derive(Deserialize)]
        struct InputProjection {
            source: SourceProjection,
        }
        #[derive(Deserialize)]
        struct SourceProjection {
            configured_base_url: String,
            canonical_target: String,
            headers: Vec<Header>,
            access_policy: Option<serde_json::Value>,
        }
        #[derive(Deserialize)]
        struct Header {
            name: String,
            value: String,
        }
        #[derive(Deserialize)]
        struct GraphProjection {
            inventory: Vec<ResourceIdentity>,
        }
        let projection: InputProjection = serde_json::from_slice(input.private_storage_plaintext())
            .map_err(|_| anyhow::anyhow!("static_hls_child_source_invalid"))?;
        let source = projection.source;
        let headers: std::collections::BTreeMap<String, String> = source
            .headers
            .into_iter()
            .map(|header| (header.name, header.value))
            .collect();
        let config = serde_json::from_value(json!({ "url": source.configured_base_url, "headers": headers, "access_policy": source.access_policy })).map_err(|_| anyhow::anyhow!("static_hls_child_source_invalid"))?;
        let graph: GraphProjection = serde_json::from_slice(root.private_storage_plaintext())
            .map_err(|_| anyhow::anyhow!("static_hls_child_graph_invalid"))?;
        let selected_audio = match root.selected_audio_statement() {
            SelectedAudioStatement::None {} => None,
            SelectedAudioStatement::Single { stream_index } => Some(stream_index),
        };
        Ok(Self {
            config,
            manifest: source.canonical_target,
            inventory: graph.inventory,
            selected_audio,
        })
    }
}

fn now_ms() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}
fn seal_storage(app: &App, plain: &[u8]) -> Result<String> {
    let random = Uuid::new_v4();
    let bytes = random.as_bytes();
    let nonce: [u8; 12] = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13].map(|i| bytes[i]);
    let encrypted = app
        .key
        .encrypt((&nonce).into(), plain)
        .map_err(|_| anyhow::anyhow!("static_hls_cipher_authentication"))?;
    Ok(STANDARD.encode([nonce.as_slice(), encrypted.as_slice()].concat()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_core::static_hls::{
        CaptureBody, CaptureOwnerIdentity, CaptureTransport, DisposalProof,
    };
    use serde_json::Value;
    use std::sync::atomic::AtomicUsize;

    const PARENT: &[u8] =
        include_bytes!("../../../crates/media-core/src/static_hls/contracts/golden_input_v1.json");
    const ROOT: &[u8] =
        include_bytes!("../../../crates/media-core/src/static_hls/contracts/golden_root_v1.json");

    // These tests use actual core NeverStarted owners and immutable statement
    // fixtures. They make no production source, admission or PostgreSQL claim.
    struct NeverStartedPermit {
        identity: CaptureOwnerIdentity,
        allow_ack: AtomicBool,
        acknowledgments: AtomicUsize,
    }
    impl CapturePermit for NeverStartedPermit {
        fn identity(&self) -> CaptureOwnerIdentity {
            self.identity.clone()
        }
        fn check(&self) -> CaptureFuture<'_, ()> {
            Box::pin(async { anyhow::bail!("fixture activation closed") })
        }
        fn acknowledge_disposal(&self, proof: Arc<DisposalProof>) -> CaptureFuture<'_, ()> {
            Box::pin(async move {
                assert_eq!(proof.identity(), &self.identity);
                assert!(proof.all_positive());
                self.acknowledgments.fetch_add(1, Ordering::SeqCst);
                ensure!(
                    self.allow_ack.load(Ordering::SeqCst),
                    "fixture acknowledgment unknown"
                );
                Ok(())
            })
        }
    }
    struct NeverTransport;
    impl CaptureTransport for NeverTransport {
        fn get<'a>(&'a self, _: &'a str) -> CaptureFuture<'a, Box<dyn CaptureBody>> {
            Box::pin(async { panic!("closed fixture must never read upstream") })
        }
    }

    fn statements() -> (
        FrozenInput,
        FrozenInput,
        Arc<RootGraphStatement>,
        WorkerStatement,
    ) {
        let mut parent: Value = serde_json::from_slice(PARENT).unwrap();
        parent["operation_id"] = json!(Uuid::new_v4().to_string());
        parent["session_id"] = json!(Uuid::new_v4().to_string());
        parent["worker_instance"] = json!(super::super::static_hls_contract::INSTANCE.to_string());
        let parent =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&parent).unwrap()).unwrap();
        let mut graph: Value = serde_json::from_slice(ROOT).unwrap();
        graph["parent_input_sha256"] = json!(parent.input_sha256());
        let root = Arc::new(
            RootGraphStatement::parse_private_plaintext(&serde_json::to_vec(&graph).unwrap())
                .unwrap(),
        );
        let mut child: Value = serde_json::from_slice(parent.private_storage_plaintext()).unwrap();
        child["kind"] = json!("child");
        child["operation_id"] = json!(Uuid::new_v4().to_string());
        child["session_id"] = json!(Uuid::new_v4().to_string());
        child["request_owner_epoch"] = json!(Uuid::new_v4().to_string());
        child["request_sha256"] = json!("2".repeat(64));
        child["plan_generation"] = json!(2);
        child["prepare_started_at_ms"] = json!(2000);
        child["prepare_expires_at_ms"] = json!(47000);
        child["root"] = json!({
            "parent_session_id": parent.identity_statement().session_id,
            "parent_capture_id": parent.identity_statement().operation_id,
            "parent_input_sha256": parent.input_sha256(),
            "root_digest": root.root_digest(),
            "root_admitted_at_ms": 1000,
            "root_hard_expires_at_ms": 1801000,
            "selected_audio": { "kind": "single", "stream_index": 1 }
        });
        let child =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&child).unwrap()).unwrap();
        let identity = child.identity_statement();
        let worker = WorkerStatement::parse_private_plaintext(
            &serde_json::to_vec(&json!({
                "reader_version":2, "recipe_version":1, "input_version":1, "graph_version":1,
                "worker_instance": identity.worker_instance, "database": identity.database,
                "tasks":["child_encode"]
            }))
            .unwrap(),
        )
        .unwrap();
        (parent, child, root, worker)
    }

    fn parent_owner(
        parent: &FrozenInput,
        allow_ack: bool,
    ) -> (
        Arc<NeverStartedPermit>,
        media_core::static_hls::CaptureHandle,
        CaptureControl,
    ) {
        let capture_id = parent.identity_statement().operation_id;
        let permit = Arc::new(NeverStartedPermit {
            identity: CaptureOwnerIdentity {
                owner_id: Uuid::new_v4().to_string(),
                relative_key: format!("static-hls/{capture_id}"),
                capture_id,
            },
            allow_ack: AtomicBool::new(allow_ack),
            acknowledgments: AtomicUsize::new(0),
        });
        let handle = media_core::static_hls::start_capture(
            permit.clone(),
            Arc::new(NeverTransport),
            CaptureOptions {
                cache_root: std::env::temp_dir()
                    .join(format!("rainsync-child-registry-{}", Uuid::new_v4())),
                manifest_url: "https://fixture.invalid/never-read.m3u8".into(),
                selected_audio: Some(1),
                expected_inventory: None,
            },
        )
        .unwrap();
        let control = handle.control().unwrap();
        (permit, handle, control)
    }

    async fn observe(control: &CaptureControl, desired: DisposalState) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while control.disposal_state() != desired {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fixture core owner disposition");
    }

    #[tokio::test]
    async fn cancellation_and_unknown_ack_never_open_parent_admission_gate() {
        let (parent, _, _, _) = statements();
        let (permit, handle, control) = parent_owner(&parent, false);
        assert!(!parent_disposed(&control));
        control.cancel();
        assert!(!parent_disposed(&control));
        assert!(handle.wait().await.is_err());
        observe(&control, DisposalState::Unresolved).await;
        assert!(!parent_disposed(&control));
        assert_eq!(permit.acknowledgments.load(Ordering::SeqCst), 1);
        permit.allow_ack.store(true, Ordering::SeqCst);
        assert_eq!(
            control.retry_disposal().await.unwrap(),
            DisposalState::Disposed
        );
        assert!(parent_disposed(&control));
        assert_eq!(permit.acknowledgments.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn lineage_requires_same_startup_whole_root_and_actual_parent_control() {
        let (parent, child, root, _) = statements();
        let (_, handle, control) = parent_owner(&parent, true);
        assert!(require_lineage(&child, &parent, &root, &control).is_ok());
        let (other_parent, _, _, _) = statements();
        let (_, other_handle, other_control) = parent_owner(&other_parent, true);
        assert!(require_lineage(&child, &parent, &root, &other_control).is_err());
        let mut changed: Value = serde_json::from_slice(child.private_storage_plaintext()).unwrap();
        changed["worker_instance"] = json!(Uuid::new_v4().to_string());
        let changed =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(require_lineage(&changed, &parent, &root, &control).is_err());
        let mut changed: Value = serde_json::from_slice(root.private_storage_plaintext()).unwrap();
        changed["inventory"][2]["strong_etag"] = json!("\"changed-unread-future-resource\"");
        let changed =
            RootGraphStatement::parse_private_plaintext(&serde_json::to_vec(&changed).unwrap())
                .unwrap();
        assert!(require_lineage(&child, &parent, &changed, &control).is_err());
        control.cancel();
        other_control.cancel();
        assert!(handle.wait().await.is_err());
        assert!(other_handle.wait().await.is_err());
        observe(&control, DisposalState::Disposed).await;
        observe(&other_control, DisposalState::Disposed).await;
    }

    #[tokio::test]
    async fn query_never_reconstructs_owner_from_known_ids_or_a_reopened_registry() {
        let (_, child, _, _) = statements();
        let registry = Registry::default();
        assert_eq!(
            registry.query(&child).await.unwrap(),
            Status::LocalOwnerMissing
        );
        registry.open();
        assert_eq!(
            registry.query(&child).await.unwrap(),
            Status::LocalOwnerMissing
        );
        registry.close().await;
        registry.open();
        assert_eq!(
            registry.query(&child).await.unwrap(),
            Status::LocalOwnerMissing
        );
    }

    #[tokio::test]
    async fn standby_retains_original_unknown_token_graph_and_fixed_fences() {
        let (parent, child, root, worker) = statements();
        let (_, handle, parent_control) = parent_owner(&parent, true);
        parent_control.cancel();
        assert!(handle.wait().await.is_err());
        observe(&parent_control, DisposalState::Disposed).await;
        let registry = Registry::default();
        registry.open();
        let began = Instant::now();
        let fence = WorkFence::at(began, 2000, 47000, 1801000).unwrap();
        let attempt = ChildCaptureAdmission::from_frozen(
            child.clone(),
            parent.clone(),
            root.clone(),
            *super::super::static_hls_contract::INSTANCE,
            Some(&worker),
        )
        .unwrap();
        let entry = Arc::new(Entry {
            _registry_keepalive: registry.0.clone(),
            input: child.clone(),
            parent,
            root: root.clone(),
            parent_control,
            admission: Mutex::new(attempt),
            admission_attempted: AtomicBool::new(true),
            cancelled: AtomicBool::new(false),
            owner: OnceLock::new(),
            control: OnceLock::new(),
            // Pure state-retention witness, not a PostgreSQL COMMIT claim.
            state: Mutex::new(EntryState::AdmissionUnknown),
            task: Mutex::new(None),
            preparation_scope: Default::default(),
            preparation_drained: AtomicBool::new(false),
            fence,
            accept_until_ms: 8000,
            source: CaptureSource::from_input(&child, &root).unwrap(),
        });
        registry
            .0
            .entries
            .lock()
            .await
            .insert(operation_id(&child).unwrap(), entry.clone());
        assert_eq!(registry.query(&child).await.unwrap(), Status::CommitUnknown);
        let mut conflicting: Value =
            serde_json::from_slice(child.private_storage_plaintext()).unwrap();
        conflicting["position_ms"] = json!(1234.125);
        let conflicting =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&conflicting).unwrap())
                .unwrap();
        assert!(
            registry.query(&conflicting).await.is_err(),
            "same UUID cannot replace original frozen input"
        );
        registry.close().await;
        assert!(matches!(
            registry.query(&child).await.unwrap(),
            Status::CancelRequested {
                admission_unknown: true,
                child_disposal: None,
                ..
            }
        ));
        let retained = registry.drain().await;
        assert_eq!(
            retained,
            Standby {
                retained_entries: 1,
                unresolved_owners: 0,
                unknown_admissions: 1,
                pending_tasks: 0,
            }
        );
        let held = registry.entry(&child).await.unwrap().unwrap();
        assert!(Arc::ptr_eq(&held, &entry));
        assert!(Arc::ptr_eq(&held.root, &root));
        assert_eq!(
            held.fence.preparation_until,
            began + Duration::from_secs(45)
        );
        assert_eq!(
            held.fence.root_until,
            began + Duration::from_millis(1799000)
        );
        assert!(
            held.admission
                .lock()
                .await
                .input()
                .require_same_frozen_input(&child)
                .is_ok()
        );
        let weak = Arc::downgrade(&registry.0);
        drop(held);
        drop(entry);
        drop(registry);
        assert!(
            weak.upgrade().is_some(),
            "uncertain original token survives waiter drop"
        );
    }

    async fn retained_fixture(registry: &Registry, state: EntryState) -> Arc<Entry> {
        let (parent, child, root, worker) = statements();
        let (_, handle, parent_control) = parent_owner(&parent, true);
        parent_control.cancel();
        assert!(handle.wait().await.is_err());
        observe(&parent_control, DisposalState::Disposed).await;
        let attempt = ChildCaptureAdmission::from_frozen(
            child.clone(),
            parent.clone(),
            root.clone(),
            *super::super::static_hls_contract::INSTANCE,
            Some(&worker),
        )
        .unwrap();
        let entry = Arc::new(Entry {
            _registry_keepalive: registry.0.clone(),
            input: child.clone(),
            parent,
            root: root.clone(),
            parent_control,
            admission: Mutex::new(attempt),
            admission_attempted: AtomicBool::new(true),
            cancelled: AtomicBool::new(false),
            owner: OnceLock::new(),
            control: OnceLock::new(),
            state: Mutex::new(state),
            task: Mutex::new(None),
            preparation_scope: Default::default(),
            preparation_drained: AtomicBool::new(false),
            fence: WorkFence::at(Instant::now(), 2000, 47000, 1801000).unwrap(),
            accept_until_ms: 8000,
            source: CaptureSource::from_input(&child, &root).unwrap(),
        });
        registry
            .0
            .entries
            .lock()
            .await
            .insert(operation_id(&child).unwrap(), entry.clone());
        entry
    }

    #[tokio::test]
    async fn shutdown_empty_registry_confirms_without_recovery() {
        let registry = Registry::default();
        registry.close().await;
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            registry.shutdown_until_confirmed(|_| async {
                panic!("empty registry cannot recover or admit")
            }),
        )
        .await
        .unwrap();
        assert!(result.confirmed());
        assert_eq!(result.retained_entries, 0);
    }

    #[tokio::test]
    async fn shutdown_known_closed_owner_retries_actual_disposal_receipt() {
        let registry = Registry::default();
        let entry =
            retained_fixture(&registry, EntryState::Refused(Refusal::CaptureUnconfirmed)).await;
        let (permit, handle, control) = parent_owner(&entry.input, false);
        control.cancel();
        assert!(handle.wait().await.is_err());
        observe(&control, DisposalState::Unresolved).await;
        assert!(entry.control.set(control.clone()).is_ok());
        permit.allow_ack.store(true, Ordering::SeqCst);
        registry.close().await;
        let retained = tokio::time::timeout(
            Duration::from_secs(2),
            registry.shutdown_until_confirmed(|_| async {
                panic!("known original control must not recover a new permit")
            }),
        )
        .await
        .unwrap();
        assert!(retained.confirmed());
        assert_eq!(retained.retained_entries, 1);
        assert_eq!(control.disposal_state(), DisposalState::Disposed);
        assert_eq!(permit.acknowledgments.load(Ordering::SeqCst), 2);
        assert!(Arc::ptr_eq(
            &registry.entry(&entry.input).await.unwrap().unwrap(),
            &entry
        ));
    }

    #[tokio::test]
    async fn shutdown_unknown_admission_keeps_retrying_same_token_without_false_exit() {
        let registry = Registry::default();
        let entry = retained_fixture(&registry, EntryState::AdmissionUnknown).await;
        registry.close().await;
        let attempts = Arc::new(AtomicUsize::new(0));
        let seen = attempts.clone();
        let original = entry.clone();
        // Inject observation failure only. No test receipt claims a DB COMMIT,
        // admission, adoption or release; the original token remains unknown.
        let result = tokio::time::timeout(
            Duration::from_millis(600),
            registry.shutdown_until_confirmed(move |next| {
                let seen = seen.clone();
                let original = original.clone();
                async move {
                    assert!(Arc::ptr_eq(&next, &original));
                    assert!(
                        next.admission
                            .lock()
                            .await
                            .input()
                            .require_same_frozen_input(&original.input)
                            .is_ok()
                    );
                    seen.fetch_add(1, Ordering::SeqCst);
                    anyhow::bail!("fixture recovery observation unknown")
                }
            }),
        )
        .await;
        assert!(
            result.is_err(),
            "unknown custody must hold shutdown in standby"
        );
        assert!(
            attempts.load(Ordering::SeqCst) >= 2,
            "unknown recovery must be retried"
        );
        assert!(matches!(
            *entry.state.lock().await,
            EntryState::AdmissionUnknown
        ));
        assert!(entry.owner.get().is_none());
        assert!(entry.control.get().is_none());
        let retained = registry.standby().await;
        assert_eq!(retained.unknown_admissions, 1);
        assert!(!retained.confirmed());
        assert!(Arc::ptr_eq(
            &registry.entry(&entry.input).await.unwrap().unwrap(),
            &entry
        ));
    }

    #[tokio::test]
    async fn shutdown_waits_for_real_blocking_scope_after_waiter_loss() {
        let registry = Registry::default();
        let entry = retained_fixture(&registry, EntryState::Refused(Refusal::Cancelled)).await;
        let started = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        struct ReleaseOnDrop(Arc<AtomicBool>);
        impl Drop for ReleaseOnDrop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let _release_on_panic = ReleaseOnDrop(release.clone());
        let own = entry.clone();
        let begun = started.clone();
        let free = release.clone();
        *entry.task.lock().await = Some(tokio::spawn(async move {
            let _ = own
                .preparation_scope
                .run(media_core::child_process::blocking(move || {
                    begun.store(true, Ordering::SeqCst);
                    while !free.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }))
                .await;
        }));
        while !started.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        registry.close().await;
        let result = tokio::time::timeout(
            Duration::from_millis(50),
            registry.shutdown_until_confirmed(|_| async {
                panic!("a blocking scope cannot authorize recovery or new admission")
            }),
        )
        .await;
        assert!(result.is_err());
        assert!(!entry.preparation_drained.load(Ordering::SeqCst));
        assert!(!registry.standby().await.confirmed());
        release.store(true, Ordering::SeqCst);
        let retained = tokio::time::timeout(
            Duration::from_secs(2),
            registry.shutdown_until_confirmed(|_| async {
                panic!("known cancelled scope cannot authorize recovery")
            }),
        )
        .await
        .unwrap();
        assert!(retained.confirmed());
        assert!(entry.preparation_drained.load(Ordering::SeqCst));
        assert_eq!(retained.pending_tasks, 0);
    }

    #[test]
    fn original_preparation_and_root_expiry_cannot_restart() {
        let began = Instant::now();
        let fence = WorkFence::at(began, 2000, 47000, 1801000).unwrap();
        assert_eq!(fence.until(), began + Duration::from_secs(45));
        let held_through_capture = fence;
        assert_eq!(held_through_capture.until(), fence.until());
        let root_shorter = WorkFence::at(began, 2000, 47000, 3000).unwrap();
        assert_eq!(root_shorter.until(), began + Duration::from_secs(1));
        for (observed, preparation, root) in [
            (47000, 47000, 1801000),
            (48000, 47000, 1801000),
            (3000, 47000, 3000),
        ] {
            assert!(WorkFence::at(began, observed, preparation, root).is_err());
        }
    }
}
