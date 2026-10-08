//! Same-startup child scheduling backed by the original sealed input owner.
//!
//! This is a separate typed queue consumer, never a generic `media_jobs::Claim`.
//! Migration 0048 permits only one queued -> running attempt, bounded renewal,
//! terminal stop and its independent execution receipt. It does not admit an
//! output writer, publication, successful completion or public output reader.
use anyhow::{Result, ensure};
use media_core::{
    job_health::{PendingJobHealth, TimingKind},
    static_hls::{
        CaptureOwnerIdentity, EncoderInputLease, PublicationLease, VerifiedCapture,
        child_recipe::{CandidateChildRecipe, MAX_ENCODE_TIME},
        contracts::{
            graph::RootGraphStatement,
            input::{FrozenInput, IdentityStatement, OperationKind, SelectedAudioStatement},
            worker::{ChildJobSpec, Task, WorkerStatement, require_task_statement},
        },
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgRow};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;
use tokio::time::Instant;
use uuid::Uuid;

use crate::media_job_timing::{OLD_PHASE_SQL, SINGLE_PHASE_SQL, record_single};

#[derive(Deserialize)]
struct ClockProjection {
    root_admitted_at_ms: u64,
    prepare_started_at_ms: u64,
    position_ms: f64,
}

// Every member is derived from an actual original capture, its non-rebuildable
// publication witness and the complete frozen child/parent/root. Equal UUIDs or
// serialized observations cannot create this owner.
struct Owner {
    capture: Arc<VerifiedCapture>,
    witness: PublicationLease,
    child: FrozenInput,
    parent: FrozenInput,
    root: Arc<RootGraphStatement>,
    capture_owner: CaptureOwnerIdentity,
    spec: ChildJobSpec,
    stored_spec: Value,
    actual_worker: Uuid,
    job_owner: Uuid,
    execution: Uuid,
    hard_until: Instant,
    // One mapping of the original immutable root epoch, never refreshed.
    root_until: Instant,
}
impl Owner {
    fn check_local(&self) -> Result<()> {
        ensure!(
            Instant::now() < self.hard_until,
            "static_hls_child_encode_deadline"
        );
        self.capture.live_evidence()?;
        self.witness.live_evidence()?;
        ensure!(
            self.capture.control()?.identity() == &self.capture_owner
                && self.witness.identity() == self.capture_owner,
            "static_hls_original_child_owner_required"
        );
        self.spec.require_input_statement(&self.child)?;
        Ok(())
    }
    async fn configure(&self, tx: &mut Transaction<'_, Postgres>) -> Result<()> {
        crate::static_hls_pending::fence(tx).await?;
        sqlx::query("SET LOCAL lock_timeout='750ms'")
            .execute(&mut **tx)
            .await?;
        sqlx::query("SET LOCAL statement_timeout='750ms'")
            .execute(&mut **tx)
            .await?;
        sqlx::query("SELECT set_config('rainsync.static_hls_worker_instance',$1,true),set_config('rainsync.static_hls_child_capture_owner',$2,true),set_config('rainsync.static_hls_child_job_owner',$3,true),set_config('rainsync.static_hls_child_execution_id',$4,true)")
            .bind(self.actual_worker.to_string()).bind(&self.capture_owner.owner_id)
            .bind(self.job_owner.to_string()).bind(self.execution.to_string())
            .execute(&mut **tx).await?;
        Ok(())
    }
    async fn lock_prefix(&self, tx: &mut Transaction<'_, Postgres>) -> Result<bool> {
        let identity = self.child.identity_statement();
        Ok(
            crate::static_hls_child_claim::lock_authority(tx, &identity, None).await?
                && exact_requests(tx, self).await?,
        )
    }
    async fn lock_current(&self, tx: &mut Transaction<'_, Postgres>) -> Result<bool> {
        if !self.lock_prefix(tx).await? {
            return Ok(false);
        }
        self.lock_suffix(tx).await
    }
    async fn lock_suffix(&self, tx: &mut Transaction<'_, Postgres>) -> Result<bool> {
        let identity = self.child.identity_statement();
        sqlx::query(
            "SELECT id FROM static_hls_captures WHERE id IN ($1,$2) ORDER BY id FOR UPDATE",
        )
        .bind(uuid(&identity.operation_id)?)
        .bind(uuid(&self.parent.identity_statement().operation_id)?)
        .fetch_all(&mut **tx)
        .await?;
        sqlx::query("SELECT id FROM playback_sessions WHERE id IN ($1,$2) ORDER BY id FOR UPDATE")
            .bind(uuid(&identity.session_id)?)
            .bind(uuid(&self.parent.identity_statement().session_id)?)
            .fetch_all(&mut **tx)
            .await?;
        self.exact_binding(tx).await
    }
    // Read-only relational fence. It must not acquire prefix/custody locks:
    // output callers already hold the ordered prefix through COMMIT.
    async fn exact_binding(&self, tx: &mut Transaction<'_, Postgres>) -> Result<bool> {
        let identity = self.child.identity_statement();
        let exact: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM static_hls_captures c JOIN playback_requests r ON r.session_id=c.session_id JOIN static_hls_database_binding db ON db.singleton WHERE c.id=$1 AND c.owner_id=$2 AND c.session_id=$3 AND c.input_sha256=$4 AND c.root_digest=$5 AND c.worker_instance=$6 AND c.database_id=$7 AND db.id=$7 AND c.expires_at=to_timestamp($8::double precision/1000) AND r.static_hls_parent_capture_id=$9 AND static_hls_child_queue_authority_allowed(r.session_id))")
            .bind(uuid(&identity.operation_id)?).bind(uuid(&self.capture_owner.owner_id)?)
            .bind(uuid(&identity.session_id)?).bind(self.child.input_sha256())
            .bind(self.root.root_digest()).bind(self.actual_worker).bind(uuid(&identity.database)?)
            .bind(i64::try_from(self.child.root_deadline_ms())?)
            .bind(uuid(&self.parent.identity_statement().operation_id)?)
            .fetch_one(&mut **tx).await?;
        Ok(exact)
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum AttemptState {
    Ready,
    InFlight,
    CommitUnknown,
    Consumed,
}

/// Install this exact object in the original registry before awaiting `claim`.
/// Cancellation or uncertain COMMIT leaves it retained without execution rights.
/// No Clone, serialization, public fields or ID-based reconstruction is provided.
pub struct ChildJobAttempt {
    owner: Option<Owner>,
    state: AttemptState,
}
impl ChildJobAttempt {
    pub async fn prepare(
        capture: Arc<VerifiedCapture>,
        child: FrozenInput,
        parent: FrozenInput,
        root: Arc<RootGraphStatement>,
        actual_startup_worker: Uuid,
        observed: Option<&WorkerStatement>,
    ) -> Result<Self> {
        // Start the one immutable encode budget before any revalidation await.
        let mapped_at = Instant::now();
        let hard_until = mapped_at + MAX_ENCODE_TIME;
        let wall_ms = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
        let root_until =
            mapped_at + Duration::from_millis(child.root_deadline_ms().saturating_sub(wall_ms));
        ensure!(root_until > mapped_at, "static_hls_child_root_expired");
        ensure!(
            child.kind() == OperationKind::Child && parent.kind() == OperationKind::Parent,
            "static_hls_child_input_required"
        );
        require_task_statement(observed, Task::ChildEncode, &child)?;
        ensure!(
            !actual_startup_worker.is_nil()
                && uuid(&child.identity_statement().worker_instance)? == actual_startup_worker
                && uuid(&parent.identity_statement().worker_instance)? == actual_startup_worker,
            "static_hls_original_worker_required"
        );
        root.require_parent_input(&parent)?;
        child.require_child_of(&parent, root.root_digest(), root.selected_audio_statement())?;
        let witness = capture.prepare_publication().await?;
        let capture_owner = witness.identity();
        ensure!(
            capture_owner.capture_id == child.identity_statement().operation_id
                && !uuid(&capture_owner.owner_id)?.is_nil()
                && capture.control()?.identity() == &capture_owner,
            "static_hls_original_child_owner_required"
        );
        let evidence = witness.live_evidence()?;
        let recapture = RootGraphStatement::parse_private_plaintext(&serde_json::to_vec(
            &json!({
                "graph_version":1,"parent_input_sha256":parent.input_sha256(),
                "inventory":evidence.inventory,"closure":evidence.closure,"timeline":evidence.timeline
            }),
        )?)?;
        root.require_child_recapture(&recapture, &child)?;
        // The candidate recipe itself reads the original sealed manifest and
        // scanner proof. JSON compatibility or a caller's bool is insufficient.
        let clock: ClockProjection = serde_json::from_slice(child.private_storage_plaintext())?;
        ensure!(
            clock.position_ms.is_finite()
                && clock.position_ms >= 0.0
                && clock.position_ms <= 9_007_199_254_740_991.0,
            "static_hls_child_recipe_position_required"
        );
        let recipe = CandidateChildRecipe::from_capture(&capture, clock.position_ms).await?;
        ensure!(
            root.selected_audio_statement()
                == SelectedAudioStatement::Single {
                    stream_index: recipe.selected_audio()
                },
            "static_hls_child_recipe_audio_required"
        );
        let spec = ChildJobSpec::from_child_input(&child)?;
        let stored_spec = serde_json::from_slice(&spec.private_storage_plaintext()?)?;
        let owner = Owner {
            capture,
            witness,
            child,
            parent,
            root,
            capture_owner,
            spec,
            stored_spec,
            actual_worker: actual_startup_worker,
            job_owner: Uuid::new_v4(),
            execution: Uuid::new_v4(),
            hard_until,
            root_until,
        };
        owner.check_local()?;
        Ok(Self {
            owner: Some(owner),
            state: AttemptState::Ready,
        })
    }
}

pub enum ClaimResult {
    Acquired(Box<ChildJobClaim>),
    /// No job/attempt/fairness/receipt changed. Keep its original local owner.
    Unavailable,
    /// Retain the original attempt. It grants no execution or filesystem rights;
    /// a fresh attempt cannot adopt the possibly committed owner or restart it.
    CommitUnknown,
}

/// A confirmed, private-field child claim. It cannot become a generic Claim.
pub struct ChildJobClaim {
    owner: Owner,
    attempt: i64,
    lease_until: Instant,
    active: bool,
}
impl ChildJobClaim {
    /// Identity is observation only. Typed mutation APIs must also borrow this
    /// actual claim and repeat its live/local/database gates.
    pub fn job_id(&self) -> Uuid {
        uuid(&self.owner.child.identity_statement().session_id).expect("validated child session")
    }
    pub fn owner_id(&self) -> Uuid {
        self.owner.job_owner
    }
    pub fn attempt(&self) -> i64 {
        self.attempt
    }
    pub fn execution_id(&self) -> Uuid {
        self.owner.execution
    }
    pub fn hard_until(&self) -> Instant {
        self.owner.hard_until
    }
    pub fn input(&self) -> &FrozenInput {
        &self.owner.child
    }
    pub fn parent_input(&self) -> &FrozenInput {
        &self.owner.parent
    }
    pub fn root_statement(&self) -> &RootGraphStatement {
        &self.owner.root
    }
    pub fn spec(&self) -> &ChildJobSpec {
        &self.owner.spec
    }
    pub fn capture(&self) -> &VerifiedCapture {
        &self.owner.capture
    }
    pub fn until(&self) -> Instant {
        self.lease_until.min(self.owner.hard_until)
    }
    pub fn check_local(&self) -> Result<()> {
        ensure!(
            self.active && Instant::now() < self.until(),
            "static_hls_child_job_lease_expired"
        );
        self.owner.check_local()
    }
    /// Output-admission transaction ENTRY only: call before holding any budget,
    /// capture/session/job/output/reservation/cache suffix lock. Lock order is
    /// authority/source prefix -> cache_budget -> capture/session -> exact job.
    /// Later helpers may re-lock this same held budget row, but must not acquire
    /// a new prefix or other owner's custody lock from an output suffix.
    /// This does not grant a writer, reservation, publication or generic Claim.
    pub(crate) async fn lock_current_attempt(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<()> {
        self.check_local()?;
        self.owner.configure(tx).await?;
        ensure!(
            self.owner.lock_prefix(tx).await?,
            "static_hls_child_job_authority_required"
        );
        sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
            .fetch_one(&mut **tx)
            .await?;
        ensure!(
            self.owner.lock_suffix(tx).await?,
            "static_hls_child_job_authority_required"
        );
        let job: Option<Uuid> = sqlx::query_scalar("SELECT id FROM media_jobs WHERE id=$1 AND session_id=$1 AND logical_queue='static_hls_v1' AND owner_id=$2 AND attempt=$3 AND status='running' FOR UPDATE")
            .bind(self.job_id()).bind(self.owner_id()).bind(self.attempt)
            .fetch_optional(&mut **tx).await?;
        ensure!(
            job == Some(self.job_id()),
            "static_hls_child_job_original_attempt_required"
        );
        self.check_before_commit(tx).await
    }

    /// Final fence for a transaction that ALREADY holds this exact claim's
    /// ordered locks from lock_current_attempt. SELECTs only: never reconfigure,
    /// perform owner/network/filesystem work, or acquire an authority prefix
    /// from job/output/cache suffix locks. Repeat after the caller's last await;
    /// the synchronous local deadline/witness check is the final operation.
    pub(crate) async fn check_before_commit(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<()> {
        self.check_local()?;
        ensure!(
            exact_requests(tx, &self.owner).await? && self.owner.exact_binding(tx).await?,
            "static_hls_child_job_authority_required"
        );
        let stored: Option<Value> = sqlx::query_scalar("SELECT spec FROM media_jobs WHERE id=$1 AND session_id=$1 AND logical_queue='static_hls_v1' AND owner_id=$2 AND attempt=$3 AND status='running'")
            .bind(self.job_id()).bind(self.owner_id()).bind(self.attempt)
            .fetch_optional(&mut **tx).await?;
        let stored = stored
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_job_original_attempt_required"))?;
        ensure!(
            stored == self.owner.stored_spec,
            "static_hls_child_job_spec_mismatch"
        );
        let spec = ChildJobSpec::parse_private_plaintext(&serde_json::to_vec(&stored)?)?;
        self.owner.spec.require_same_spec_statement(&spec)?;
        spec.require_input_statement(&self.owner.child)?;
        let allowed: bool =
            sqlx::query_scalar("SELECT static_hls_child_job_attempt_authority_allowed($1,$2,$3)")
                .bind(self.job_id())
                .bind(self.owner_id())
                .bind(self.attempt)
                .fetch_one(&mut **tx)
                .await?;
        ensure!(allowed, "static_hls_child_job_authority_required");
        self.check_local()
    }

    /// Cleanup-only identity configuration for this retained original claim.
    /// It deliberately allows expired/revoked claims so their real owners can
    /// finish bookkeeping. GUCs, expiry and a successful return are NOT a live
    /// claim, a drain proof, or permission to release reservation/files. The
    /// typed cleanup caller still needs its actual writer/process positive drain.
    /// No room/capture/session/job/cache row locks are acquired here.
    pub(crate) async fn configure_cleanup(&self, tx: &mut Transaction<'_, Postgres>) -> Result<()> {
        self.owner.configure(tx).await
    }

    /// The fixed original root deadline mapping, retained before any attempt
    /// await. Publication never obtains a new TTL from a later observation.
    pub(crate) fn publication_root_until(&self) -> Instant {
        self.owner.root_until
    }

    pub(crate) fn check_retention_local(&self) -> Result<()> {
        ensure!(
            Instant::now() < self.owner.root_until,
            "static_hls_child_root_expired"
        );
        ensure!(
            self.owner.capture.control()?.identity() == &self.owner.capture_owner,
            "static_hls_original_child_owner_required"
        );
        self.owner.spec.require_input_statement(&self.owner.child)?;
        Ok(())
    }

    /// Successful mutation final fence. The original local attempt/lease is
    /// still live, but SQL must now prove the exact succeeded/full-output tuple.
    /// No new prefix/suffix locks are acquired here.
    pub(crate) async fn check_published_before_commit(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<()> {
        self.check_local()?;
        self.check_retention_before_commit(tx).await?;
        self.check_local()
    }

    /// Independent published retention authority, allowing actual input
    /// disposal. It cannot grant a public read or revive the encode attempt.
    pub(crate) async fn lock_published_current(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<()> {
        self.check_retention_local()?;
        self.owner.configure(tx).await?;
        ensure!(
            self.owner.lock_prefix(tx).await?,
            "static_hls_child_output_retention_required"
        );
        sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
            .fetch_one(&mut **tx)
            .await?;
        let identity = self.owner.child.identity_statement();
        sqlx::query(
            "SELECT id FROM static_hls_captures WHERE id IN ($1,$2) ORDER BY id FOR UPDATE",
        )
        .bind(uuid(&identity.operation_id)?)
        .bind(uuid(&self.owner.parent.identity_statement().operation_id)?)
        .fetch_all(&mut **tx)
        .await?;
        sqlx::query("SELECT id FROM playback_sessions WHERE id IN ($1,$2) ORDER BY id FOR UPDATE")
            .bind(self.job_id())
            .bind(uuid(&self.owner.parent.identity_statement().session_id)?)
            .fetch_all(&mut **tx)
            .await?;
        sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
            .bind(self.job_id())
            .fetch_one(&mut **tx)
            .await?;
        self.check_retention_before_commit(tx).await
    }

    pub(crate) async fn check_retention_before_commit(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<()> {
        self.check_retention_local()?;
        ensure!(
            exact_requests(tx, &self.owner).await?,
            "static_hls_child_output_retention_required"
        );
        let identity = self.owner.child.identity_statement();
        let exact: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_jobs j JOIN static_hls_captures c ON c.session_id=j.session_id JOIN static_hls_child_output_publications proof ON proof.job_id=j.id AND proof.attempt=j.attempt AND proof.owner_id=j.owner_id WHERE j.id=$1 AND j.session_id=$1 AND j.attempt=$2 AND j.owner_id=$3 AND j.spec=$4 AND c.id=$5 AND c.owner_id=$6 AND c.input_sha256=$7 AND c.root_digest=$8 AND c.worker_instance=$9 AND c.database_id=$10 AND c.expires_at=to_timestamp($11::double precision/1000) AND proof.execution_id=$12 AND static_hls_child_output_retention_authority_allowed(j.id,j.owner_id,j.attempt))")
            .bind(self.job_id()).bind(self.attempt).bind(self.owner_id()).bind(&self.owner.stored_spec)
            .bind(uuid(&identity.operation_id)?).bind(uuid(&self.owner.capture_owner.owner_id)?)
            .bind(self.owner.child.input_sha256()).bind(self.owner.root.root_digest())
            .bind(self.owner.actual_worker).bind(uuid(&identity.database)?)
            .bind(i64::try_from(self.owner.child.root_deadline_ms())?).bind(self.execution_id())
            .fetch_one(&mut **tx).await?;
        ensure!(exact, "static_hls_child_output_retention_required");
        self.check_retention_local()
    }

    /// Move synchronously into the registry before any input-admission await.
    /// A canceled prepare waiter cannot discard this original claim identity.
    pub fn into_execution(self) -> ChildJobExecution {
        ChildJobExecution {
            claim: self,
            lease: None,
            preparation: None,
            input_issued: false,
        }
    }
}

enum InputPreparationResult {
    Pending,
    Ready(Arc<EncoderInputLease>),
    Unknown,
}

// The independently supervised preparation task writes the actual lease into
// this original slot before notifying any observer. An abandoned public waiter
// cannot lose, transfer or remint its real descriptor/scope owner.
struct InputPreparation {
    result: Mutex<InputPreparationResult>,
    finished: watch::Sender<bool>,
    cancel_requested: AtomicBool,
    hard_until: Instant,
}
impl InputPreparation {
    fn ready(&self) -> Result<Arc<EncoderInputLease>> {
        match &*self.result.lock().expect("child input preparation owner") {
            InputPreparationResult::Ready(lease) => Ok(Arc::clone(lease)),
            InputPreparationResult::Pending | InputPreparationResult::Unknown => {
                anyhow::bail!("static_hls_child_input_owner_unknown")
            }
        }
    }
    fn request_cancel(&self) {
        self.cancel_requested.store(true, Ordering::SeqCst);
        if let InputPreparationResult::Ready(lease) =
            &*self.result.lock().expect("child input preparation owner")
        {
            lease.cancel();
        }
    }
}

/// Non-authorizing observation of one original preparation token. It exposes
/// neither a capture, descriptor, process scope nor an input lease. Waiting may
/// happen outside the execution registry mutex while its original claim renews.
pub struct InputPreparationHandle {
    token: Arc<InputPreparation>,
}
impl InputPreparationHandle {
    pub async fn wait(&self) -> Result<()> {
        let mut finished = self.token.finished.subscribe();
        loop {
            if *finished.borrow_and_update() {
                return match &*self
                    .token
                    .result
                    .lock()
                    .expect("child input preparation owner")
                {
                    InputPreparationResult::Ready(_) => Ok(()),
                    InputPreparationResult::Pending | InputPreparationResult::Unknown => {
                        Err(anyhow::anyhow!("static_hls_child_input_owner_unknown"))
                    }
                };
            }
            // This is the original fixed encode deadline, never a restarted
            // observation budget. Timeout does not remove the retained slot or
            // prove that the independent preparation/scope has drained.
            tokio::time::timeout_at(self.token.hard_until, finished.changed())
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_child_input_owner_unknown"))?
                .map_err(|_| anyhow::anyhow!("static_hls_child_input_owner_unknown"))?;
        }
    }
}

fn require_original_preparation(
    original: &Arc<InputPreparation>,
    observed: &InputPreparationHandle,
) -> Result<()> {
    ensure!(
        Arc::ptr_eq(original, &observed.token),
        "static_hls_child_original_input_preparation_required"
    );
    Ok(())
}

/// Store this actual execution owner until its input/process scope drains.
/// Its receipt ID/claim identity remain private even after logical cancellation.
pub struct ChildJobExecution {
    claim: ChildJobClaim,
    lease: Option<Arc<EncoderInputLease>>,
    preparation: Option<Arc<InputPreparation>>,
    input_issued: bool,
}
impl ChildJobExecution {
    pub fn claim(&self) -> &ChildJobClaim {
        &self.claim
    }
    /// Install the original pending token and launch its independent owner
    /// BEFORE returning. Run once on the execution already in the registry.
    /// Network/full-graph revalidation then runs without that registry mutex;
    /// background renewal still borrows the same original opaque claim.
    pub fn begin_input_preparation(&mut self) -> Result<InputPreparationHandle> {
        ensure!(!self.input_issued, "static_hls_child_input_already_issued");
        self.claim.check_local()?;
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| anyhow::anyhow!("static_hls_child_input_owner_unknown"))?;
        let (finished, _) = watch::channel(false);
        let token = Arc::new(InputPreparation {
            result: Mutex::new(InputPreparationResult::Pending),
            finished,
            cancel_requested: AtomicBool::new(false),
            hard_until: self.claim.owner.hard_until,
        });
        // Issuance and the slot survive cancellation of ANY public observer.
        self.input_issued = true;
        self.preparation = Some(Arc::clone(&token));
        let original = Arc::clone(&token);
        let capture = Arc::clone(&self.claim.owner.capture);
        runtime.spawn(async move {
            let result = capture.prepare_encoder_input(original.hard_until).await;
            let stored = match result {
                Ok(lease) => {
                    let lease = Arc::new(lease);
                    if original.cancel_requested.load(Ordering::SeqCst) {
                        lease.cancel();
                    }
                    InputPreparationResult::Ready(lease)
                }
                Err(_) => InputPreparationResult::Unknown,
            };
            *original
                .result
                .lock()
                .expect("child input preparation owner") = stored;
            // Close the cancel-vs-store race while retaining the SAME lease.
            if original.cancel_requested.load(Ordering::SeqCst) {
                original.request_cancel();
            }
            original.finished.send_replace(true);
        });
        Ok(InputPreparationHandle { token })
    }

    /// Recover an observer for this SAME installed token after a waiter drop.
    /// No new input preparation, scope, lease or execution authority is issued.
    pub fn input_preparation_handle(&self) -> Result<InputPreparationHandle> {
        Ok(InputPreparationHandle {
            token: Arc::clone(
                self.preparation
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("static_hls_child_input_owner_unknown"))?,
            ),
        })
    }

    /// Called after wait, back under the registry mutex. Only this original
    /// token may install its original result. Save the real lease before any
    /// fallible live fence so cancellation/expiry cannot lose physical custody.
    pub fn finish_input_preparation(&mut self, observed: &InputPreparationHandle) -> Result<()> {
        let original = self
            .preparation
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_input_owner_unknown"))?;
        require_original_preparation(original, observed)?;
        let lease = original.ready()?;
        if let Some(existing) = &self.lease {
            ensure!(
                Arc::ptr_eq(existing, &lease),
                "static_hls_child_original_input_preparation_required"
            );
        } else {
            self.lease = Some(lease);
        }
        self.claim.check_local()?;
        self.input_lease()?
            .check_live_for(&self.claim.owner.capture)
    }

    /// Convenience for an independently owned execution. Shared-registry
    /// runtimes must instead begin under lock, wait OUTSIDE it, and finish under
    /// lock, so the 1-second observation lease can continue renewing meanwhile.
    pub async fn prepare_input(&mut self, pool: &PgPool) -> Result<()> {
        ensure!(
            renew(pool, &mut self.claim).await?,
            "static_hls_child_job_authority_required"
        );
        let observed = self.begin_input_preparation()?;
        observed.wait().await?;
        self.finish_input_preparation(&observed)
    }
    pub fn input_lease(&self) -> Result<&EncoderInputLease> {
        self.lease
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_input_owner_unknown"))
    }
    /// Share only this SAME original managed input scope with the output owner.
    /// This cannot create a new lease, scope, permit or execution authority. The
    /// output owner must observe its positive close_and_drain before deleting
    /// output files, even when an outer scope has no registered child of its own.
    pub fn input_lease_handle(&self) -> Result<Arc<EncoderInputLease>> {
        self.lease
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_input_owner_unknown"))
    }
    pub async fn renew(&mut self, pool: &PgPool) -> Result<bool> {
        renew(pool, &mut self.claim).await
    }
    pub async fn cancel(&mut self, pool: &PgPool) -> Result<bool> {
        if let Some(preparation) = &self.preparation {
            preparation.request_cancel();
        }
        if let Some(lease) = &self.lease {
            lease.cancel();
        }
        cancel(pool, &mut self.claim).await
    }
    /// A timeout, status row or canceled waiter cannot reach this acknowledgment.
    /// The same actual encoder scope must positively reap first. The claim is
    /// terminalized separately and an uncertain receipt update stays an error.
    pub async fn close_and_acknowledge(&mut self, pool: &PgPool) -> Result<()> {
        self.claim.active = false;
        if let Some(preparation) = &self.preparation {
            preparation.request_cancel();
        }
        if self.lease.is_none() {
            // Observe the exact retained task even when the public preparation
            // waiter was canceled. Pending/Unknown is never NeverStarted proof.
            let observed = self.input_preparation_handle()?;
            observed.wait().await?;
            let original = self
                .preparation
                .as_ref()
                .expect("installed input preparation");
            require_original_preparation(original, &observed)?;
            self.lease = Some(original.ready()?);
        }
        self.input_lease()?.close_and_drain().await?;
        cancel(pool, &mut self.claim).await?;
        let owner = &self.claim.owner;
        let mut tx = pool.begin().await?;
        owner.configure(&mut tx).await?;
        let changed = sqlx::query("UPDATE media_executions SET reaped_at=COALESCE(reaped_at,clock_timestamp()) WHERE id=$1 AND job_id=$2 AND attempt=$3 AND owner_id=$4 AND kind='job'")
            .bind(owner.execution).bind(uuid(&owner.child.identity_statement().session_id)?)
            .bind(self.claim.attempt).bind(owner.job_owner).execute(&mut *tx).await?.rows_affected();
        ensure!(changed == 1, "static_hls_child_execution_ack_unconfirmed");
        tx.commit().await?;
        Ok(())
    }
}

/// No normalization of other jobs, no owner replacement, no retry or output row.
/// A cancellation of this future leaves the original attempt InFlight/Unknown.
pub async fn claim(pool: &PgPool, attempt: &mut ChildJobAttempt) -> Result<ClaimResult> {
    ensure!(
        attempt.state != AttemptState::Consumed,
        "static_hls_child_original_attempt_required"
    );
    if attempt.state != AttemptState::Ready {
        return Ok(ClaimResult::CommitUnknown);
    }
    let owner = attempt
        .owner
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_original_attempt_required"))?;
    owner.witness.check().await?;
    owner.check_local()?;
    attempt.state = AttemptState::InFlight;
    let started = Instant::now();
    let mut tx = pool.begin().await?;
    owner.configure(&mut tx).await?;
    if !owner.lock_current(&mut tx).await? {
        tx.rollback().await?;
        attempt.state = AttemptState::Ready;
        return Ok(ClaimResult::Unavailable);
    }
    // The existing durable fairness lock/turn are shared with both older queues.
    sqlx::query("SELECT pg_advisory_xact_lock(72614933)")
        .execute(&mut *tx)
        .await?;
    let candidate: Option<Uuid> = sqlx::query_scalar("SELECT j.id FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id LEFT JOIN media_queue_turns turn ON turn.user_id IS NOT DISTINCT FROM p.user_id WHERE j.logical_queue='static_hls_v1' AND j.spec->>'kind'='static_hls_child' AND j.status='queued' AND j.attempt=0 AND j.available_at<=clock_timestamp() AND static_hls_child_job_worker_authority_allowed(j.id) ORDER BY turn.last_turn NULLS FIRST,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1")
        .fetch_optional(&mut *tx).await?;
    let job = uuid(&owner.child.identity_statement().session_id)?;
    if candidate != Some(job) {
        tx.rollback().await?;
        attempt.state = AttemptState::Ready;
        return Ok(ClaimResult::Unavailable);
    }
    let stored: Value = sqlx::query_scalar("SELECT spec FROM media_jobs WHERE id=$1")
        .bind(job)
        .fetch_one(&mut *tx)
        .await?;
    ensure!(
        stored == owner.stored_spec,
        "static_hls_child_job_spec_mismatch"
    );
    let exact_spec = ChildJobSpec::parse_private_plaintext(&serde_json::to_vec(&stored)?)?;
    owner.spec.require_same_spec_statement(&exact_spec)?;
    exact_spec.require_input_statement(&owner.child)?;
    owner.check_local()?;
    let remaining = owner
        .hard_until
        .saturating_duration_since(Instant::now())
        .as_secs_f64();
    let query = format!(
        r#"WITH locked AS MATERIALIZED (
        SELECT {OLD_PHASE_SQL} FROM media_jobs j WHERE j.id=$1 FOR UPDATE OF j
    ), tick AS MATERIALIZED (SELECT CASE WHEN count(*)>=0 THEN clock_timestamp() END AS ended_at FROM locked)
    UPDATE media_jobs j SET status='running',owner_id=$2,attempt=1,
        lease_until=LEAST(t.ended_at+interval '1 second',t.ended_at+$3::double precision*interval '1 second',r.lease_until,r.static_hls_prepare_expires_at,r.static_hls_root_expires_at,p.expires_at),
        timing_version=1,timing_attempt=1,queue_entered_at=NULL,run_started_at=t.ended_at
    FROM locked l CROSS JOIN tick t,playback_requests r,playback_sessions p
    WHERE j.id=l.id AND r.session_id=j.session_id AND p.id=j.session_id
        AND j.status='queued' AND j.attempt=0 AND j.attempt<j.max_attempts AND j.available_at<=clock_timestamp()
        AND static_hls_child_job_claim_authority_allowed(j.id)
    RETURNING j.attempt,p.user_id,extract(epoch FROM j.lease_until-clock_timestamp())::float8 AS remaining,
        extract(epoch FROM LEAST(t.ended_at+$3::double precision*interval '1 second',r.lease_until,r.static_hls_prepare_expires_at,r.static_hls_root_expires_at,p.expires_at)-clock_timestamp())::float8 AS hard_remaining,
        extract(epoch FROM LEAST(r.static_hls_root_expires_at,p.expires_at)-clock_timestamp())::float8 AS root_remaining,
        {SINGLE_PHASE_SQL}"#
    );
    let row = sqlx::query(&query)
        .bind(job)
        .bind(owner.job_owner)
        .bind(remaining)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(row) = row else {
        tx.rollback().await?;
        attempt.state = AttemptState::Ready;
        return Ok(ClaimResult::Unavailable);
    };
    let number: i64 = row.try_get("attempt")?;
    ensure!(number == 1, "static_hls_child_job_attempt_required");
    sqlx::query("INSERT INTO media_executions(id,session_id,kind,job_id,attempt,owner_id,created_at) SELECT $1,j.session_id,'job',j.id,j.attempt,j.owner_id,clock_timestamp() FROM media_jobs j WHERE j.id=$2 AND j.owner_id=$3 AND j.attempt=$4 AND j.status='running' AND static_hls_child_job_claim_authority_allowed(j.id)")
        .bind(owner.execution).bind(job).bind(owner.job_owner).bind(number).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO media_queue_turns(user_id,last_turn) VALUES($1,nextval('media_queue_turn_seq')) ON CONFLICT(user_id) DO UPDATE SET last_turn=EXCLUDED.last_turn")
        .bind(row.try_get::<Option<Uuid>, _>("user_id")?).execute(&mut *tx).await?;
    let allowed: bool =
        sqlx::query_scalar("SELECT static_hls_child_job_attempt_authority_allowed($1,$2,$3)")
            .bind(job)
            .bind(owner.job_owner)
            .bind(number)
            .fetch_one(&mut *tx)
            .await?;
    ensure!(allowed, "static_hls_child_job_authority_required");
    owner.check_local()?;
    let mut health = PendingJobHealth::default();
    record_single(&mut health, &row, "queue_seconds", TimingKind::QueueStarted);
    let observation = health.into_commit_observation();
    let lease_remaining: f64 = row.try_get("remaining")?;
    let hard_remaining: f64 = row.try_get("hard_remaining")?;
    let root_remaining: f64 = row.try_get("root_remaining")?;
    attempt.state = AttemptState::CommitUnknown;
    if tx.commit().await.is_err() {
        return Ok(ClaimResult::CommitUnknown);
    }
    observation.confirmed();
    let hard_deadline = deadline_after_roundtrip(started, hard_remaining)?;
    let lease_deadline = deadline_after_roundtrip(started, lease_remaining)?;
    let root_deadline = deadline_after_roundtrip(started, root_remaining)?;
    let mut owner = attempt.owner.take().expect("original child attempt owner");
    // Subtract the WHOLE transaction/commit round trip, including lock waits.
    // A fresh database deadline can only shorten the original local hard fence.
    owner.hard_until = owner.hard_until.min(hard_deadline);
    // The ACTUAL original claim COMMIT shortens the frozen root mapping using
    // the immutable database root epoch and the WHOLE admission round trip.
    // Worker/server wall-clock skew cannot extend original output retention.
    owner.root_until = owner.root_until.min(root_deadline);
    owner.hard_until = owner.hard_until.min(owner.root_until);
    let lease_until = lease_deadline.min(owner.hard_until);
    attempt.state = AttemptState::Consumed;
    Ok(ClaimResult::Acquired(Box::new(ChildJobClaim {
        owner,
        attempt: number,
        lease_until,
        active: Instant::now() < lease_until,
    })))
}

/// Errors revoke local execution immediately. Neither a late positive nor a new
/// database timestamp may revive an expired local lease or reset encode budget.
pub async fn renew(pool: &PgPool, claim: &mut ChildJobClaim) -> Result<bool> {
    claim.check_local()?;
    let started = Instant::now();
    let result = renew_inner(pool, claim).await;
    match result {
        Ok(Some(remaining)) if Instant::now() < claim.lease_until => {
            let next = match deadline_after_roundtrip(started, remaining) {
                Ok(next) => next.min(claim.owner.hard_until),
                Err(error) => {
                    claim.active = false;
                    return Err(error);
                }
            };
            if Instant::now() >= next {
                claim.active = false;
                return Ok(false);
            }
            claim.lease_until = next;
            claim.check_local()?;
            Ok(true)
        }
        Ok(_) => {
            claim.active = false;
            Ok(false)
        }
        Err(error) => {
            claim.active = false;
            Err(error)
        }
    }
}
async fn renew_inner(pool: &PgPool, claim: &ChildJobClaim) -> Result<Option<f64>> {
    let owner = &claim.owner;
    owner.witness.check().await?;
    let mut tx = pool.begin().await?;
    owner.configure(&mut tx).await?;
    if !owner.lock_current(&mut tx).await? {
        return Ok(None);
    }
    let remaining = owner
        .hard_until
        .saturating_duration_since(Instant::now())
        .as_secs_f64();
    let row: Option<f64> = sqlx::query_scalar("UPDATE media_jobs j SET lease_until=LEAST(clock_timestamp()+interval '1 second',clock_timestamp()+$4::double precision*interval '1 second',j.run_started_at+interval '20 seconds',r.lease_until,r.static_hls_prepare_expires_at,r.static_hls_root_expires_at,p.expires_at) FROM playback_requests r,playback_sessions p WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND r.session_id=j.session_id AND p.id=j.session_id AND static_hls_child_job_attempt_authority_allowed(j.id,$2,$3) RETURNING extract(epoch FROM j.lease_until-clock_timestamp())::float8")
        .bind(uuid(&owner.child.identity_statement().session_id)?).bind(owner.job_owner)
        .bind(claim.attempt).bind(remaining).fetch_optional(&mut *tx).await?;
    owner.check_local()?;
    tx.commit().await?;
    Ok(row)
}

/// Logical cancellation retains the independent receipt and original owner.
/// It is never requeue, physical drainage, disposal or output success.
pub async fn cancel(pool: &PgPool, claim: &mut ChildJobClaim) -> Result<bool> {
    claim.active = false;
    let owner = &claim.owner;
    let mut tx = pool.begin().await?;
    owner.configure(&mut tx).await?;
    let job = uuid(&owner.child.identity_statement().session_id)?;
    let changed = sqlx::query("UPDATE media_jobs SET status='cancelled',error='static_hls_child_cancelled',lease_until=NULL,timing_version=NULL,timing_attempt=NULL,queue_entered_at=NULL,run_started_at=NULL WHERE id=$1 AND owner_id=$2 AND attempt=$3 AND status='running'")
        .bind(job).bind(owner.job_owner).bind(claim.attempt).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    Ok(changed == 1)
}

fn deadline_after_roundtrip(started: Instant, seconds: f64) -> Result<Instant> {
    ensure!(
        seconds.is_finite(),
        "static_hls_child_job_authority_unknown"
    );
    let duration = Duration::try_from_secs_f64(seconds.max(0.0))
        .map_err(|_| anyhow::anyhow!("static_hls_child_job_authority_unknown"))?;
    // started + DB remainder is conservative even though the database sample was
    // taken later; no round-trip time is silently granted again on the caller.
    Ok(started + duration)
}
fn uuid(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| anyhow::anyhow!("static_hls_child_identity_invalid"))
}
fn stored_identity(row: &PgRow) -> Result<IdentityStatement> {
    Ok(IdentityStatement {
        operation_id: row
            .try_get::<Uuid, _>("static_hls_operation_id")?
            .to_string(),
        session_id: row.try_get::<Uuid, _>("session_id")?.to_string(),
        request_owner_epoch: row.try_get::<Uuid, _>("owner_epoch")?.to_string(),
        request_sha256: row.try_get("request_hash")?,
        input_sha256: row.try_get("static_hls_input_sha256")?,
        user_id: row.try_get::<Uuid, _>("user_id")?.to_string(),
        room_id: row.try_get::<Uuid, _>("room_id")?.to_string(),
        auth_login_hash: row.try_get("auth_login_hash")?,
        auth_membership_epoch: row.try_get::<Uuid, _>("auth_membership_epoch")?.to_string(),
        lifecycle_epoch: u64::try_from(row.try_get::<i64, _>("lifecycle_epoch")?)?,
        media_id: row.try_get::<Uuid, _>("static_hls_media_id")?.to_string(),
        media_generation: u64::try_from(row.try_get::<i64, _>("static_hls_media_generation")?)?,
        viewer_id: row.try_get::<Uuid, _>("viewer_id")?.to_string(),
        plan_generation: u64::try_from(row.try_get::<i64, _>("plan_generation")?)?,
        worker_instance: row
            .try_get::<Uuid, _>("static_hls_worker_instance")?
            .to_string(),
        database: row
            .try_get::<Uuid, _>("static_hls_database_id")?
            .to_string(),
        source_id: row.try_get::<Uuid, _>("static_hls_source_id")?.to_string(),
        source_policy_revision: u64::try_from(
            row.try_get::<i64, _>("static_hls_source_revision")?,
        )?,
        media_source_generation: u64::try_from(
            row.try_get::<i64, _>("static_hls_source_generation")?,
        )?,
    })
}
async fn exact_requests(tx: &mut Transaction<'_, Postgres>, owner: &Owner) -> Result<bool> {
    for input in [&owner.parent, &owner.child] {
        let row = sqlx::query("SELECT r.*,floor(extract(epoch FROM created_at)*1000)::bigint AS created_ms,floor(extract(epoch FROM static_hls_root_expires_at)*1000)::bigint AS root_ms,floor(extract(epoch FROM static_hls_prepare_expires_at)*1000)::bigint AS prepare_ms FROM playback_requests r WHERE session_id=$1 AND static_hls_input_version=1")
            .bind(uuid(&input.identity_statement().session_id)?)
            .fetch_optional(&mut **tx).await?;
        let Some(row) = row else { return Ok(false) };
        input.require_identity_statement(&stored_identity(&row)?)?;
        let clock: ClockProjection = serde_json::from_slice(input.private_storage_plaintext())?;
        let child = input.kind() == OperationKind::Child;
        let status: String = row.try_get("status")?;
        if (child && status != "completed")
            || (!child && !matches!(status.as_str(), "completed" | "failed"))
            || row.try_get::<Option<Uuid>, _>("static_hls_parent_capture_id")?
                != if child {
                    Some(uuid(&owner.parent.identity_statement().operation_id)?)
                } else {
                    None
                }
            || row.try_get::<i64, _>("created_ms")?
                != i64::try_from(if child {
                    clock.prepare_started_at_ms
                } else {
                    clock.root_admitted_at_ms
                })?
            || row.try_get::<i64, _>("root_ms")? != i64::try_from(input.root_deadline_ms())?
            || row.try_get::<i64, _>("prepare_ms")?
                != i64::try_from(input.preparation_deadline_ms())?
            || row
                .try_get::<Option<String>, _>("http_file_context_encrypted")?
                .is_some()
            || row
                .try_get::<Option<Uuid>, _>("http_file_parent")?
                .is_some()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_attempt_claim_and_execution_cannot_be_cloned_or_serialized() {
        trait AmbiguousClone<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousClone<()> for T {}
        impl<T: Clone> AmbiguousClone<u8> for T {}
        trait AmbiguousSerialize<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousSerialize<()> for T {}
        impl<T: serde::Serialize> AmbiguousSerialize<u8> for T {}
        let _ = <ChildJobAttempt as AmbiguousClone<_>>::check;
        let _ = <ChildJobClaim as AmbiguousClone<_>>::check;
        let _ = <ChildJobExecution as AmbiguousClone<_>>::check;
        let _ = <ChildJobAttempt as AmbiguousSerialize<_>>::check;
        let _ = <ChildJobClaim as AmbiguousSerialize<_>>::check;
        let _ = <ChildJobExecution as AmbiguousSerialize<_>>::check;
    }
    fn pending_preparation() -> Arc<InputPreparation> {
        let (finished, _) = watch::channel(false);
        Arc::new(InputPreparation {
            result: Mutex::new(InputPreparationResult::Pending),
            finished,
            cancel_requested: AtomicBool::new(false),
            hard_until: Instant::now() + MAX_ENCODE_TIME,
        })
    }
    #[test]
    fn preparation_observer_requires_same_original_token_and_cannot_grant_pending_input() {
        let original = pending_preparation();
        let same = InputPreparationHandle {
            token: Arc::clone(&original),
        };
        require_original_preparation(&original, &same).unwrap();
        let foreign = InputPreparationHandle {
            token: pending_preparation(),
        };
        assert!(require_original_preparation(&original, &foreign).is_err());
        assert!(original.ready().is_err());
        original.request_cancel();
        assert!(original.cancel_requested.load(Ordering::SeqCst));
        assert!(original.ready().is_err());
    }
    #[tokio::test]
    async fn abandoned_observer_cannot_abort_original_preparation_result_retention() {
        let original = pending_preparation();
        let observer = InputPreparationHandle {
            token: Arc::clone(&original),
        };
        let task_owner = Arc::clone(&original);
        let (release, released) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            released.await.unwrap();
            *task_owner.result.lock().unwrap() = InputPreparationResult::Unknown;
            task_owner.finished.send_replace(true);
        });
        drop(observer);
        release.send(()).unwrap();
        task.await.unwrap();
        assert!(matches!(
            *original.result.lock().unwrap(),
            InputPreparationResult::Unknown
        ));
        let recovered = InputPreparationHandle {
            token: Arc::clone(&original),
        };
        assert!(recovered.wait().await.is_err());
        assert!(original.ready().is_err());
    }

    #[test]
    fn roundtrip_deadline_cannot_restart_at_return_time() {
        let started = Instant::now() - Duration::from_secs(2);
        assert!(deadline_after_roundtrip(started, 1.0).unwrap() < Instant::now());
        assert_eq!(deadline_after_roundtrip(started, 0.0).unwrap(), started);
        assert!(deadline_after_roundtrip(started, f64::INFINITY).is_err());
        assert!(deadline_after_roundtrip(started, f64::NAN).is_err());
    }
    #[test]
    fn output_fences_keep_budget_before_custody_and_final_check_read_only() {
        let source = include_str!("static_hls_child_jobs.rs");
        let start = source
            .find("pub(crate) async fn lock_current_attempt(")
            .unwrap();
        let final_start = source
            .find("pub(crate) async fn check_before_commit(")
            .unwrap();
        let cleanup_start = source
            .find("pub(crate) async fn configure_cleanup(")
            .unwrap();
        let admission = &source[start..final_start];
        let prefix = admission.find("self.owner.lock_prefix(tx)").unwrap();
        let budget = admission.find("SELECT revision FROM cache_budget").unwrap();
        let suffix = admission.find("self.owner.lock_suffix(tx)").unwrap();
        let job = admission.find("SELECT id FROM media_jobs").unwrap();
        assert!(prefix < budget && budget < suffix && suffix < job);
        let final_fence = &source[final_start..cleanup_start];
        assert!(!final_fence.contains("FOR UPDATE"));
        assert!(!final_fence.contains(".configure("));
        assert!(!final_fence.contains(".lock_prefix("));
        assert!(!final_fence.contains("witness.check()"));
        assert!(final_fence.contains("self.owner.exact_binding(tx)"));
        assert!(final_fence.contains("static_hls_child_job_attempt_authority_allowed"));
        assert!(
            final_fence.rfind("self.check_local()").unwrap()
                > final_fence.rfind(".await?").unwrap()
        );
    }

    #[test]
    fn migration_stays_one_shot_without_output_authority() {
        let migration = include_str!("../../../migrations/0048_static_hls_child_job_claim.sql");
        assert!(migration.contains("OLD.attempt=0 AND NEW.attempt=1"));
        assert!(migration.contains("interval '20 seconds'"));
        assert!(migration.contains("static_hls_child_job_attempt_receipt_required"));
        assert!(
            !migration
                .contains("CREATE OR REPLACE FUNCTION static_hls_child_output_authority_allowed")
        );
        assert!(!migration.contains("DROP TRIGGER static_hls_00_child_output_guard"));
        assert!(!migration.contains("DROP TRIGGER static_hls_00_child_reservation_guard"));
    }
}
