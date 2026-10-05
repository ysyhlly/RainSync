//! Original-owner child recapture admission, verification and disposal.
//!
//! Migration 0047 is required. This module does not activate public HLS or
//! dispatch an encoder. A claimed child has an independent 128 MiB reservation;
//! its retired parent's positive receipt is required before that reservation.
//! Statements, UUIDs, expiry and cancellation cannot reconstruct a permit.
use anyhow::{Result, ensure};
use media_core::static_hls::{
    CaptureEvidence, CaptureFuture, CaptureOwnerIdentity, CapturePermit, DisposalProof,
    ProcessDisposition, ResourceIdentity, VerifiedCapture,
    contracts::{
        graph::RootGraphStatement,
        input::{FrozenInput, IdentityStatement, OperationKind, SelectedAudioStatement},
        worker::{Task, WorkerStatement, require_task_statement},
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Connection, PgPool, Postgres, Row, Transaction, postgres::PgRow};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::time::Instant;
use uuid::Uuid;

use crate::static_hls_child_claim::PreparedChildInput;

#[derive(Deserialize)]
struct InputProjection {
    root_admitted_at_ms: u64,
    prepare_started_at_ms: u64,
    position_ms: f64,
}

struct BoundInput {
    child: FrozenInput,
    parent: FrozenInput,
    root: Arc<RootGraphStatement>,
    identity: IdentityStatement,
    parent_identity: IdentityStatement,
    started_ms: i64,
    root_ms: i64,
    prepare_ms: i64,
    parent_created_ms: i64,
    parent_prepare_ms: i64,
    position_ms: f64,
    selected_audio: Value,
    resource: Value,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AttemptState {
    Ready,
    InFlight,
    CommitUnknown,
    Consumed,
}

/// Store this object in the original Worker's registry BEFORE awaiting admit.
/// Even cancellation of the admission future leaves this exact owner/input
/// available for recovery. It has no Clone, serialization or UUID constructor.
/// Dropping it does not dispose a possibly committed reservation.
pub struct ChildCaptureAdmission {
    owner: Uuid,
    bound: Arc<BoundInput>,
    state: AttemptState,
}

impl ChildCaptureAdmission {
    /// Compatibility and immutable statement preparation only. The caller
    /// supplies its actual startup instance and freshly authenticated Worker
    /// declaration, not a client-selected target or ownership assertion. No
    /// permit exists until the short admission transaction is confirmed.
    pub fn prepare(
        prepared: &PreparedChildInput,
        parent: FrozenInput,
        retained_root: Arc<RootGraphStatement>,
        actual_startup_worker: Uuid,
        observed: Option<&WorkerStatement>,
    ) -> Result<Self> {
        Self::from_frozen(
            prepared.input().clone(),
            parent,
            retained_root,
            actual_startup_worker,
            observed,
        )
    }

    /// For a Worker that loaded/decrypted the already-claimed immutable input.
    /// Canonical hashes and all durable mirrors are checked again by admission;
    /// this constructor alone grants no authority or local file access.
    pub fn from_frozen(
        child: FrozenInput,
        parent: FrozenInput,
        retained_root: Arc<RootGraphStatement>,
        actual_startup_worker: Uuid,
        observed: Option<&WorkerStatement>,
    ) -> Result<Self> {
        ensure!(
            child.kind() == OperationKind::Child && parent.kind() == OperationKind::Parent,
            "static_hls_child_input_required"
        );
        require_task_statement(observed, Task::ChildEncode, &child)?;
        retained_root.require_parent_input(&parent)?;
        child.require_child_of(
            &parent,
            retained_root.root_digest(),
            retained_root.selected_audio_statement(),
        )?;
        let identity = child.identity_statement();
        let parent_identity = parent.identity_statement();
        ensure!(
            !actual_startup_worker.is_nil()
                && uuid(&identity.worker_instance)? == actual_startup_worker
                && uuid(&parent_identity.worker_instance)? == actual_startup_worker,
            "static_hls_original_worker_required"
        );
        let clock: InputProjection = serde_json::from_slice(child.private_storage_plaintext())
            .map_err(|_| anyhow::anyhow!("static_hls_child_input_required"))?;
        let parent_clock: InputProjection =
            serde_json::from_slice(parent.private_storage_plaintext())
                .map_err(|_| anyhow::anyhow!("static_hls_child_input_required"))?;
        ensure!(
            clock.root_admitted_at_ms == parent_clock.root_admitted_at_ms
                && clock.prepare_started_at_ms >= clock.root_admitted_at_ms
                && clock.position_ms.is_finite()
                && clock.position_ms >= 0.0,
            "static_hls_child_clock_required"
        );
        let selected_audio = serde_json::to_value(retained_root.selected_audio_statement())?;
        ensure!(
            matches!(
                retained_root.selected_audio_statement(),
                SelectedAudioStatement::Single { .. }
            ),
            "static_hls_child_audio_required"
        );
        let resource = json!({"media_id":identity.media_id,"source_id":identity.source_id,
            "source_policy_revision":identity.source_policy_revision,
            "media_source_generation":identity.media_source_generation});
        let bound = BoundInput {
            started_ms: i64::try_from(clock.prepare_started_at_ms)?,
            root_ms: i64::try_from(child.root_deadline_ms())?,
            prepare_ms: i64::try_from(child.preparation_deadline_ms())?,
            parent_created_ms: i64::try_from(parent_clock.root_admitted_at_ms)?,
            parent_prepare_ms: i64::try_from(parent.preparation_deadline_ms())?,
            position_ms: clock.position_ms,
            selected_audio,
            resource,
            child,
            parent,
            root: retained_root,
            identity,
            parent_identity,
        };
        Ok(Self {
            owner: Uuid::new_v4(),
            bound: Arc::new(bound),
            state: AttemptState::Ready,
        })
    }

    pub fn input(&self) -> &FrozenInput {
        &self.bound.child
    }
    pub fn parent_input(&self) -> &FrozenInput {
        &self.bound.parent
    }
    pub fn root_statement(&self) -> &RootGraphStatement {
        &self.bound.root
    }

    /// Revoke the already-claimed request without inferring whether this
    /// admission committed. The original object and every reservation remain
    /// retained; recover is still required after an uncertain attempt.
    pub async fn cancel_child(&self, pool: &PgPool, status: i16, code: &str) -> Result<()> {
        cancel_bound(pool, &self.bound, self.owner, status, code).await
    }

    fn known_no_commit(&mut self, result: Admission) -> Admission {
        self.state = AttemptState::Ready;
        result
    }
    fn mint(&mut self) -> Result<ChildCapturePermit> {
        ensure!(
            matches!(
                self.state,
                AttemptState::InFlight | AttemptState::CommitUnknown
            ),
            "static_hls_child_original_admission_required"
        );
        self.state = AttemptState::Consumed;
        Ok(ChildCapturePermit {
            owner: self.owner,
            bound: self.bound.clone(),
        })
    }
}

/// Only an original admission object can mint this after a confirmed COMMIT,
/// or after exact same-owner recovery of that object's uncertain COMMIT.
pub struct ChildCapturePermit {
    owner: Uuid,
    bound: Arc<BoundInput>,
}
impl ChildCapturePermit {
    pub fn identity(&self) -> CaptureOwnerIdentity {
        CaptureOwnerIdentity {
            capture_id: self.bound.identity.operation_id.clone(),
            owner_id: self.owner.to_string(),
            relative_key: format!("static-hls/{}", self.bound.identity.operation_id),
        }
    }
    pub fn input(&self) -> &FrozenInput {
        &self.bound.child
    }
    pub fn parent_input(&self) -> &FrozenInput {
        &self.bound.parent
    }
    pub fn root_statement(&self) -> &RootGraphStatement {
        &self.bound.root
    }
    /// Complete retained inventory, for independent full-body recapture. This
    /// cannot be used as a scanner receipt; verify_capture compares live evidence.
    pub fn expected_inventory(&self) -> Result<Vec<ResourceIdentity>> {
        #[derive(Deserialize)]
        struct Projection {
            inventory: Vec<ResourceIdentity>,
        }
        let projection: Projection =
            serde_json::from_slice(self.bound.root.private_storage_plaintext())
                .map_err(|_| anyhow::anyhow!("static_hls_child_root_required"))?;
        Ok(projection.inventory)
    }
}

pub enum Admission {
    Acquired(ChildCapturePermit),
    /// Definitely no COMMIT was sent by this invocation.
    Changed,
    Full,
    Stale,
    /// A retained capture exists; a new attempt cannot adopt its owner.
    RetainedCustody,
    /// Keep the original ChildCaptureAdmission. Never retry admission until
    /// recover has positively resolved that same object's transaction.
    CommitUnknown,
}
pub enum Recovery {
    Acquired(ChildCapturePermit),
    /// Ordered serialization proves the original transaction left no capture
    /// or reservation. The same object may attempt admission again.
    NotCommitted,
    CommitUnknown,
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

async fn exact_requests(
    tx: &mut Transaction<'_, Postgres>,
    bound: &BoundInput,
    live: bool,
) -> Result<bool> {
    for (input, is_child) in [(&bound.parent, false), (&bound.child, true)] {
        let row = sqlx::query("SELECT r.*,floor(extract(epoch FROM created_at)*1000)::bigint AS created_ms,floor(extract(epoch FROM static_hls_root_expires_at)*1000)::bigint AS root_ms,floor(extract(epoch FROM static_hls_prepare_expires_at)*1000)::bigint AS prepare_ms FROM playback_requests r WHERE session_id=$1 AND static_hls_input_version=1")
            .bind(uuid(&input.identity_statement().session_id)?).fetch_optional(&mut **tx).await?;
        let Some(row) = row else { return Ok(false) };
        input.require_identity_statement(&stored_identity(&row)?)?;
        let status: String = row.try_get("status")?;
        let status_matches = if is_child {
            status == "pending" || (!live && status == "failed")
        } else {
            status == "failed"
        };
        if !status_matches
            || row.try_get::<Option<Uuid>, _>("static_hls_parent_capture_id")?
                != if is_child {
                    Some(uuid(&bound.parent_identity.operation_id)?)
                } else {
                    None
                }
            || row.try_get::<i64, _>("created_ms")?
                != if is_child {
                    bound.started_ms
                } else {
                    bound.parent_created_ms
                }
            || row.try_get::<i64, _>("root_ms")? != bound.root_ms
            || row.try_get::<i64, _>("prepare_ms")?
                != if is_child {
                    bound.prepare_ms
                } else {
                    bound.parent_prepare_ms
                }
            || row
                .try_get::<Option<String>, _>("response_encrypted")?
                .is_some()
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

async fn lock_captures_sessions(
    tx: &mut Transaction<'_, Postgres>,
    bound: &BoundInput,
) -> Result<()> {
    sqlx::query("SELECT id FROM static_hls_captures WHERE id IN ($1,$2) ORDER BY id FOR UPDATE")
        .bind(uuid(&bound.identity.operation_id)?)
        .bind(uuid(&bound.parent_identity.operation_id)?)
        .fetch_all(&mut **tx)
        .await?;
    sqlx::query("SELECT id FROM playback_sessions WHERE id IN ($1,$2) ORDER BY id FOR UPDATE")
        .bind(uuid(&bound.identity.session_id)?)
        .bind(uuid(&bound.parent_identity.session_id)?)
        .fetch_all(&mut **tx)
        .await?;
    Ok(())
}

// A stopped/expired parent alone is insufficient. Every retained receipt,
// including expired cache-read leases and delivery executions, stays blocking.
const EXACT_PARENT: &str = r#"
SELECT EXISTS(SELECT 1 FROM static_hls_captures parent
 JOIN playback_requests original ON original.session_id=parent.session_id
 JOIN playback_sessions retired ON retired.id=parent.session_id
 JOIN playback_requests child ON child.static_hls_parent_capture_id=parent.id
 JOIN static_hls_database_binding db ON db.singleton
 WHERE parent.id=$1 AND parent.session_id=$2 AND parent.root_digest=$3
 AND parent.input_sha256=$4 AND parent.worker_instance=$5 AND parent.database_id=$6 AND db.id=$6
 AND parent.user_id=$7 AND parent.request_owner_epoch=$8 AND parent.reader_version=2 AND parent.recipe_version=1
 AND parent.publication_phase='published_parent' AND parent.state='disposed'
 AND parent.disposed_at IS NOT NULL AND parent.streams_closed_at IS NOT NULL
 AND parent.process_closed_at IS NOT NULL AND parent.files_removed_at IS NOT NULL
 AND parent.process_disposition IN ('never_started','reaped') AND parent.inventory_encrypted IS NOT NULL
 AND floor(extract(epoch FROM parent.expires_at)*1000)::bigint=$9
 AND original.status='failed' AND original.static_hls_parent_capture_id IS NULL
 AND original.static_hls_operation_id=parent.id AND original.static_hls_input_sha256=parent.input_sha256
 AND original.owner_epoch=parent.request_owner_epoch AND original.static_hls_root_expires_at=parent.expires_at
 AND retired.stopped AND retired.static_hls_capture_id=parent.id
 AND child.session_id=$10 AND child.static_hls_operation_id=$11
 AND child.static_hls_root_expires_at=parent.expires_at AND child.static_hls_worker_instance=parent.worker_instance
 AND child.static_hls_database_id=parent.database_id AND child.static_hls_input_sha256=$12
 AND static_hls_child_parent_binding_allowed(child.session_id)
 AND NOT EXISTS(SELECT 1 FROM cache_write_reservations reservation WHERE reservation.job_id IN (parent.id,parent.session_id))
 AND NOT EXISTS(SELECT 1 FROM cache_read_leases lease WHERE lease.cache_id IN (parent.id,parent.session_id))
 AND NOT EXISTS(SELECT 1 FROM media_executions execution WHERE execution.session_id=parent.session_id AND execution.reaped_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM upstream_reservations upstream WHERE upstream.id=parent.session_id AND upstream.closed_at IS NULL))
"#;
async fn exact_parent(tx: &mut Transaction<'_, Postgres>, bound: &BoundInput) -> Result<bool> {
    let p = &bound.parent_identity;
    Ok(sqlx::query_scalar(EXACT_PARENT)
        .bind(uuid(&p.operation_id)?)
        .bind(uuid(&p.session_id)?)
        .bind(bound.root.root_digest())
        .bind(bound.parent.input_sha256())
        .bind(uuid(&p.worker_instance)?)
        .bind(uuid(&p.database)?)
        .bind(uuid(&p.user_id)?)
        .bind(uuid(&p.request_owner_epoch)?)
        .bind(bound.root_ms)
        .bind(uuid(&bound.identity.session_id)?)
        .bind(uuid(&bound.identity.operation_id)?)
        .bind(bound.child.input_sha256())
        .fetch_one(&mut **tx)
        .await?)
}

/// The measured headroom/revision must come from this actual Worker's cache
/// context before the call. All filesystem/network/process work happens outside
/// locks. Budget precedes captures/reservations, matching positive disposal.
pub async fn admit(
    pool: &PgPool,
    attempt: &mut ChildCaptureAdmission,
    revision: i64,
    headroom: u64,
) -> Result<Admission> {
    ensure!(
        attempt.state != AttemptState::Consumed,
        "static_hls_child_original_admission_required"
    );
    if attempt.state != AttemptState::Ready {
        return Ok(Admission::CommitUnknown);
    }
    attempt.state = AttemptState::InFlight;
    let bound = attempt.bound.clone();
    let mut tx = pool.begin().await?;
    crate::static_hls_pending::fence(&mut tx).await?;
    sqlx::query("SET LOCAL lock_timeout='750ms'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='750ms'")
        .execute(&mut *tx)
        .await?;
    if !crate::static_hls_child_claim::lock_authority(&mut tx, &bound.identity, None).await?
        || !exact_requests(&mut tx, &bound, true).await?
    {
        return Ok(attempt.known_no_commit(Admission::Stale));
    }
    let current: i64 =
        sqlx::query_scalar("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    if current != revision {
        return Ok(attempt.known_no_commit(Admission::Changed));
    }
    lock_captures_sessions(&mut tx, &bound).await?;
    sqlx::query("SELECT job_id FROM cache_write_reservations WHERE job_id IN ($1,$2) ORDER BY job_id FOR UPDATE")
        .bind(uuid(&bound.identity.operation_id)?).bind(uuid(&bound.parent_identity.operation_id)?)
        .fetch_all(&mut *tx).await?;
    let retained: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM static_hls_captures WHERE id=$1 OR session_id=$2)",
    )
    .bind(uuid(&bound.identity.operation_id)?)
    .bind(uuid(&bound.identity.session_id)?)
    .fetch_one(&mut *tx)
    .await?;
    if retained {
        return Ok(attempt.known_no_commit(Admission::RetainedCustody));
    }
    if !exact_parent(&mut tx, &bound).await? {
        return Ok(attempt.known_no_commit(Admission::Stale));
    }
    let capacity: bool = sqlx::query_scalar("SELECT (SELECT count(*) FROM static_hls_captures WHERE disposed_at IS NULL)<2 AND NOT EXISTS(SELECT 1 FROM static_hls_captures WHERE user_id=$1 AND disposed_at IS NULL)")
        .bind(uuid(&bound.identity.user_id)?).fetch_one(&mut *tx).await?;
    let held: String =
        sqlx::query_scalar("SELECT COALESCE(sum(bytes),0)::text FROM cache_write_reservations")
            .fetch_one(&mut *tx)
            .await?;
    if !capacity
        || held.parse::<u128>()? + u128::from(crate::static_hls::CAPTURE_BYTES)
            > u128::from(headroom)
    {
        return Ok(attempt.known_no_commit(Admission::Full));
    }
    // Fresh predicate after contended locks. Parent's preparation lease is
    // historical; only the child's original preparation/root fences apply.
    let live: bool =
        sqlx::query_scalar("SELECT static_hls_pending_child_request_authority_allowed($1)")
            .bind(uuid(&bound.identity.session_id)?)
            .fetch_one(&mut *tx)
            .await?;
    if !live {
        return Ok(attempt.known_no_commit(Admission::Stale));
    }
    let i = &bound.identity;
    let inserted = sqlx::query("INSERT INTO static_hls_captures(id,session_id,user_id,owner_id,resource_authority,request_owner_epoch,expires_at,publication_phase,input_sha256,worker_instance,database_id,reader_version,recipe_version,child_position_ms,child_selected_audio) SELECT $1,$2,$3,$4,$5,$6,r.static_hls_root_expires_at,'pending_child',$7,$8,$9,2,1,$10,$11 FROM playback_requests r WHERE r.session_id=$2 AND static_hls_pending_child_request_authority_allowed(r.session_id)")
        .bind(uuid(&i.operation_id)?).bind(uuid(&i.session_id)?).bind(uuid(&i.user_id)?)
        .bind(attempt.owner).bind(&bound.resource).bind(uuid(&i.request_owner_epoch)?)
        .bind(bound.child.input_sha256()).bind(uuid(&i.worker_instance)?).bind(uuid(&i.database)?)
        .bind(bound.position_ms).bind(&bound.selected_audio).execute(&mut *tx).await?.rows_affected();
    ensure!(inserted == 1, "static_hls_child_admission_unconfirmed");
    let inserted = sqlx::query("INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose) VALUES($1,$2,0,134217728,'static_hls_capture')")
        .bind(uuid(&i.operation_id)?).bind(attempt.owner).execute(&mut *tx).await?.rows_affected();
    ensure!(inserted == 1, "static_hls_child_reservation_unconfirmed");
    let changed =
        sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton AND revision=$1")
            .bind(revision)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    ensure!(changed == 1, "static_hls_child_budget_unconfirmed");
    let live: bool =
        sqlx::query_scalar("SELECT static_hls_pending_child_capture_authority_allowed($1)")
            .bind(uuid(&i.operation_id)?)
            .fetch_one(&mut *tx)
            .await?;
    ensure!(
        live && exact_parent(&mut tx, &bound).await?,
        "static_hls_child_authority_required"
    );
    // Set BEFORE the await. Cancellation cannot make the registry's original
    // object look unadmitted or permit retry with a different owner.
    attempt.state = AttemptState::CommitUnknown;
    if tx.commit().await.is_err() {
        return Ok(Admission::CommitUnknown);
    }
    Ok(Admission::Acquired(attempt.mint()?))
}

/// Resolve only a retained original attempt. This cannot create new database
/// rows, adopt another owner, renew authority or perform physical side effects.
/// Revocation does not prevent recovering responsibility for NeverStarted drain.
pub async fn recover(pool: &PgPool, attempt: &mut ChildCaptureAdmission) -> Result<Recovery> {
    ensure!(
        attempt.state != AttemptState::Consumed,
        "static_hls_child_original_admission_required"
    );
    if attempt.state == AttemptState::Ready {
        return Ok(Recovery::NotCommitted);
    }
    let bound = attempt.bound.clone();
    let mut tx = pool.begin().await?;
    crate::static_hls_pending::fence(&mut tx).await?;
    sqlx::query("SET LOCAL lock_timeout='750ms'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='750ms'")
        .execute(&mut *tx)
        .await?;
    // Historical prefix, with no requirement for a still-live login, room or
    // parent. No authority locks are acquired after the budget suffix.
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(uuid(&bound.identity.room_id)?)
        .fetch_optional(&mut *tx)
        .await?;
    sqlx::query("SELECT session_id FROM playback_requests WHERE session_id IN ($1,$2) ORDER BY session_id FOR UPDATE")
        .bind(uuid(&bound.identity.session_id)?).bind(uuid(&bound.parent_identity.session_id)?)
        .fetch_all(&mut *tx).await?;
    sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    lock_captures_sessions(&mut tx, &bound).await?;
    let row = sqlx::query("SELECT *,floor(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms,disposed_at IS NOT NULL AS disposed FROM static_hls_captures WHERE id=$1")
        .bind(uuid(&bound.identity.operation_id)?).fetch_optional(&mut *tx).await?;
    let reservation = sqlx::query("SELECT owner_id,attempt,bytes,purpose FROM cache_write_reservations WHERE job_id=$1 FOR UPDATE")
        .bind(uuid(&bound.identity.operation_id)?).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        ensure!(
            reservation.is_none(),
            "static_hls_child_recovery_unconfirmed"
        );
        let another: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM static_hls_captures WHERE session_id=$1)",
        )
        .bind(uuid(&bound.identity.session_id)?)
        .fetch_one(&mut *tx)
        .await?;
        ensure!(!another, "static_hls_child_recovery_unconfirmed");
        // Budget serialization completes only after the prior admission's
        // COMMIT/abort released it, even if that response was lost.
        tx.commit().await?;
        attempt.state = AttemptState::Ready;
        return Ok(Recovery::NotCommitted);
    };
    ensure!(
        exact_requests(&mut tx, &bound, false).await? && exact_parent(&mut tx, &bound).await?,
        "static_hls_child_recovery_unconfirmed"
    );
    require_capture_row(&row, &bound, attempt.owner)?;
    ensure!(
        row.try_get::<String, _>("publication_phase")? == "pending_child"
            && matches!(
                row.try_get::<String, _>("state")?.as_str(),
                "capturing" | "cancelled"
            )
            && row.try_get::<Option<String>, _>("root_digest")?.is_none()
            && row
                .try_get::<Option<String>, _>("inventory_encrypted")?
                .is_none()
            && !row.try_get::<bool, _>("disposed")?,
        "static_hls_child_recovery_unconfirmed"
    );
    let reservation =
        reservation.ok_or_else(|| anyhow::anyhow!("static_hls_child_recovery_unconfirmed"))?;
    require_reservation(&reservation, attempt.owner)?;
    // No changes were made, but do not report an unresolved connection/commit
    // observation as a confirmed recovery receipt.
    if tx.commit().await.is_err() {
        return Ok(Recovery::CommitUnknown);
    }
    Ok(Recovery::Acquired(attempt.mint()?))
}

fn require_capture_row(row: &PgRow, bound: &BoundInput, owner: Uuid) -> Result<()> {
    let i = &bound.identity;
    ensure!(
        row.try_get::<Uuid, _>("id")? == uuid(&i.operation_id)?
            && row.try_get::<Uuid, _>("owner_id")? == owner
            && row.try_get::<Uuid, _>("session_id")? == uuid(&i.session_id)?
            && row.try_get::<Uuid, _>("user_id")? == uuid(&i.user_id)?
            && row.try_get::<Uuid, _>("request_owner_epoch")? == uuid(&i.request_owner_epoch)?
            && row.try_get::<String, _>("input_sha256")? == bound.child.input_sha256()
            && row.try_get::<Uuid, _>("worker_instance")? == uuid(&i.worker_instance)?
            && row.try_get::<Uuid, _>("database_id")? == uuid(&i.database)?
            && row.try_get::<i16, _>("reader_version")? == 2
            && row.try_get::<i16, _>("recipe_version")? == 1
            && row.try_get::<Value, _>("resource_authority")? == bound.resource
            && row.try_get::<f64, _>("child_position_ms")? == bound.position_ms
            && row.try_get::<Value, _>("child_selected_audio")? == bound.selected_audio
            && row.try_get::<i64, _>("expires_ms")? == bound.root_ms,
        "static_hls_original_child_owner_required"
    );
    Ok(())
}
fn require_reservation(row: &PgRow, owner: Uuid) -> Result<()> {
    ensure!(
        row.try_get::<Uuid, _>("owner_id")? == owner
            && row.try_get::<i64, _>("attempt")? == 0
            && row.try_get::<i64, _>("bytes")? == i64::try_from(crate::static_hls::CAPTURE_BYTES)?
            && row.try_get::<String, _>("purpose")? == "static_hls_capture",
        "static_hls_child_reservation_required"
    );
    Ok(())
}

fn graph_from_live_evidence(
    bound: &BoundInput,
    evidence: &CaptureEvidence,
) -> Result<RootGraphStatement> {
    // Keep the parent's canonical digest when recomputing the entire child
    // graph; the child has its own independent input hash and local owner.
    let recapture = RootGraphStatement::parse_private_plaintext(&serde_json::to_vec(&json!({
        "graph_version":1,"parent_input_sha256":bound.parent.input_sha256(),
        "inventory":evidence.inventory,"closure":evidence.closure,"timeline":evidence.timeline
    }))?)?;
    bound
        .root
        .require_child_recapture(&recapture, &bound.child)?;
    Ok(recapture)
}

async fn verify_live_capture(
    pool: &PgPool,
    permit: &ChildCapturePermit,
    capture: &VerifiedCapture,
    root: &RootGraphStatement,
    encrypted: &str,
) -> Result<bool> {
    let bound = &permit.bound;
    let mut tx = pool.begin().await?;
    crate::static_hls_pending::fence(&mut tx).await?;
    sqlx::query("SET LOCAL lock_timeout='750ms'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='750ms'")
        .execute(&mut *tx)
        .await?;
    if !crate::static_hls_child_claim::lock_authority(&mut tx, &bound.identity, None).await?
        || !exact_requests(&mut tx, bound, true).await?
    {
        return Ok(false);
    }
    lock_captures_sessions(&mut tx, bound).await?;
    if !exact_parent(&mut tx, bound).await? {
        return Ok(false);
    }
    let row = sqlx::query("SELECT *,floor(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms,disposed_at IS NOT NULL AS disposed FROM static_hls_captures WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase='pending_child'")
        .bind(uuid(&bound.identity.operation_id)?).bind(permit.owner).bind(uuid(&bound.identity.session_id)?)
        .fetch_optional(&mut *tx).await?;
    let Some(row) = row else { return Ok(false) };
    require_capture_row(&row, bound, permit.owner)?;
    let state: String = row.try_get("state")?;
    if state == "verified" {
        // A lost verification acknowledgment can be observed by the same
        // actual capture without replacing immutable ciphertext with a nonce.
        ensure!(
            row.try_get::<Option<String>, _>("root_digest")?.as_deref() == Some(root.root_digest())
                && row
                    .try_get::<Option<String>, _>("inventory_encrypted")?
                    .is_some(),
            "static_hls_child_verification_unconfirmed"
        );
        let live: bool =
            sqlx::query_scalar("SELECT static_hls_pending_child_capture_authority_allowed($1)")
                .bind(uuid(&bound.identity.operation_id)?)
                .fetch_one(&mut *tx)
                .await?;
        capture.live_evidence()?;
        return Ok(live);
    }
    if state != "capturing" {
        return Ok(false);
    }
    capture.live_evidence()?;
    let changed = sqlx::query("UPDATE static_hls_captures SET state='verified',inventory_encrypted=$4,root_digest=$5 WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase='pending_child' AND state='capturing' AND inventory_encrypted IS NULL AND root_digest IS NULL AND static_hls_pending_child_capture_authority_allowed(id)")
        .bind(uuid(&bound.identity.operation_id)?).bind(permit.owner).bind(uuid(&bound.identity.session_id)?)
        .bind(encrypted).bind(root.root_digest()).execute(&mut *tx).await?.rows_affected();
    if changed != 1 {
        return Ok(false);
    }
    capture.live_evidence()?;
    tx.commit().await?;
    capture.live_evidence()?;
    Ok(true)
}

/// Terminal request/capture revocation never releases the reservation. This
/// prefix stays budget-free and still works after the original live authority.
pub async fn cancel(
    pool: &PgPool,
    permit: &ChildCapturePermit,
    status: i16,
    code: &str,
) -> Result<()> {
    cancel_bound(pool, &permit.bound, permit.owner, status, code).await
}

async fn cancel_bound(
    pool: &PgPool,
    bound: &BoundInput,
    owner: Uuid,
    status: i16,
    code: &str,
) -> Result<()> {
    ensure!(
        (400..=599).contains(&status) && !code.is_empty() && code.len() <= 128,
        "static_hls_child_failure_required"
    );
    let mut tx = pool.begin().await?;
    crate::static_hls_pending::fence(&mut tx).await?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(uuid(&bound.identity.room_id)?)
        .fetch_optional(&mut *tx)
        .await?;
    sqlx::query("SELECT session_id FROM playback_requests WHERE session_id IN ($1,$2) ORDER BY session_id FOR UPDATE")
        .bind(uuid(&bound.identity.session_id)?).bind(uuid(&bound.parent_identity.session_id)?)
        .fetch_all(&mut *tx).await?;
    let row = sqlx::query("SELECT * FROM playback_requests WHERE session_id=$1 AND static_hls_input_version=1 AND static_hls_parent_capture_id=$2")
        .bind(uuid(&bound.identity.session_id)?).bind(uuid(&bound.parent_identity.operation_id)?)
        .fetch_one(&mut *tx).await?;
    bound
        .child
        .require_identity_statement(&stored_identity(&row)?)?;
    lock_captures_sessions(&mut tx, bound).await?;
    let state: String = row.try_get("status")?;
    ensure!(
        matches!(state.as_str(), "pending" | "completed" | "failed"),
        "static_hls_child_failure_required"
    );
    if state != "failed" {
        let changed = sqlx::query("UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=$2,error_code=$3 WHERE session_id=$1 AND static_hls_input_version=1 AND status IN ('pending','completed')")
            .bind(uuid(&bound.identity.session_id)?).bind(status).bind(code).execute(&mut *tx).await?.rows_affected();
        ensure!(changed == 1, "static_hls_child_cancellation_unconfirmed");
    }
    sqlx::query("UPDATE static_hls_captures SET state='cancelled' WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase IN ('pending_child','published_child') AND state IN ('capturing','verified')")
        .bind(uuid(&bound.identity.operation_id)?).bind(owner).bind(uuid(&bound.identity.session_id)?)
        .execute(&mut *tx).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1 AND NOT stopped")
        .bind(uuid(&bound.identity.session_id)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Accept only the core's original all-positive proof. The ordered suffix
/// remains valid after revocation; retries preserve the original receipt times.
pub async fn acknowledge_disposal(
    pool: &PgPool,
    permit: &ChildCapturePermit,
    proof: Arc<DisposalProof>,
) -> Result<()> {
    ensure!(
        proof.identity() == &permit.identity() && proof.all_positive(),
        "static_hls_disposal_identity_required"
    );
    let disposition = match proof.process_disposition() {
        ProcessDisposition::NeverStarted => "never_started",
        ProcessDisposition::Reaped => "reaped",
    };
    let bound = &permit.bound;
    let mut tx = pool.begin().await?;
    crate::static_hls_pending::fence(&mut tx).await?;
    sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT *,floor(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms,disposed_at IS NOT NULL AS disposed,streams_closed_at IS NOT NULL AS streams_positive,process_closed_at IS NOT NULL AS process_positive,files_removed_at IS NOT NULL AS files_positive FROM static_hls_captures WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase IN ('pending_child','published_child') FOR UPDATE")
        .bind(uuid(&bound.identity.operation_id)?).bind(permit.owner).bind(uuid(&bound.identity.session_id)?)
        .fetch_one(&mut *tx).await?;
    require_capture_row(&row, bound, permit.owner)?;
    let reservation = sqlx::query("SELECT owner_id,attempt,bytes,purpose FROM cache_write_reservations WHERE job_id=$1 FOR UPDATE")
        .bind(uuid(&bound.identity.operation_id)?).fetch_optional(&mut *tx).await?;
    if row.try_get::<bool, _>("disposed")? {
        ensure!(
            reservation.is_none()
                && row.try_get::<String, _>("state")? == "disposed"
                && row.try_get::<String, _>("process_disposition")? == disposition
                && row.try_get::<bool, _>("streams_positive")?
                && row.try_get::<bool, _>("process_positive")?
                && row.try_get::<bool, _>("files_positive")?,
            "static_hls_disposal_unconfirmed"
        );
        return Ok(());
    }
    let reservation =
        reservation.ok_or_else(|| anyhow::anyhow!("static_hls_disposal_reservation_required"))?;
    require_reservation(&reservation, permit.owner)?;
    let changed = sqlx::query("UPDATE static_hls_captures SET state='disposed',streams_closed_at=clock_timestamp(),process_closed_at=clock_timestamp(),process_disposition=$4,files_removed_at=clock_timestamp(),disposed_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase IN ('pending_child','published_child') AND disposed_at IS NULL")
        .bind(uuid(&bound.identity.operation_id)?).bind(permit.owner).bind(uuid(&bound.identity.session_id)?)
        .bind(disposition).execute(&mut *tx).await?.rows_affected();
    ensure!(changed == 1, "static_hls_disposal_unconfirmed");
    let changed = sqlx::query("DELETE FROM cache_write_reservations WHERE job_id=$1 AND owner_id=$2 AND attempt=0 AND bytes=134217728 AND purpose='static_hls_capture'")
        .bind(uuid(&bound.identity.operation_id)?).bind(permit.owner).execute(&mut *tx).await?.rows_affected();
    ensure!(changed == 1, "static_hls_disposal_release_unconfirmed");
    let changed = sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton")
        .execute(&mut *tx)
        .await?
        .rows_affected();
    ensure!(changed == 1, "static_hls_child_budget_unconfirmed");
    tx.commit().await?;
    Ok(())
}

const AUTHORITY_TIME: Duration = Duration::from_millis(750);
struct AuthorityDeadline {
    started: Instant,
    last: Instant,
    until: Instant,
}
impl AuthorityDeadline {
    fn new(started: Instant) -> Result<Self> {
        Ok(Self {
            started,
            last: started,
            until: started
                .checked_add(AUTHORITY_TIME)
                .ok_or_else(|| anyhow::anyhow!("static_hls_authority_unknown"))?,
        })
    }
    fn elapsed(&mut self, now: Instant) -> Result<Duration> {
        ensure!(
            now >= self.last && now < self.until,
            "static_hls_authority_unknown"
        );
        let elapsed = now
            .checked_duration_since(self.started)
            .ok_or_else(|| anyhow::anyhow!("static_hls_authority_unknown"))?;
        self.last = now;
        Ok(elapsed)
    }
    async fn observe<T>(
        &mut self,
        work: impl Future<Output = Result<T>>,
        clock: &impl Fn() -> Instant,
    ) -> Result<T> {
        self.elapsed(clock())?;
        let result = tokio::time::timeout_at(self.until, work)
            .await
            .map_err(|_| anyhow::anyhow!("static_hls_authority_unknown"))?;
        self.elapsed(clock())?;
        result
    }
    fn remaining(&mut self, remaining: Duration, now: Instant) -> Result<Duration> {
        remaining
            .checked_sub(self.elapsed(now)?)
            .filter(|value| !value.is_zero())
            .ok_or_else(|| anyhow::anyhow!("static_hls_capture_authority_expired"))
    }
}

async fn read_authority_remaining(
    pool: &PgPool,
    permit: &ChildCapturePermit,
) -> Result<Option<Duration>> {
    let bound = &permit.bound;
    let mut connection = pool.acquire().await?;
    connection.close_on_drop();
    let mut tx = connection.begin().await?;
    crate::static_hls_pending::fence(&mut tx).await?;
    sqlx::query("SET LOCAL statement_timeout='750ms'")
        .execute(&mut *tx)
        .await?;
    // Serialize phase observation with publication, then use a fresh snapshot.
    let locked: Option<Uuid> = sqlx::query_scalar("SELECT id FROM static_hls_captures WHERE id=$1 AND owner_id=$2 AND session_id=$3 FOR SHARE")
        .bind(uuid(&bound.identity.operation_id)?).bind(permit.owner).bind(uuid(&bound.identity.session_id)?)
        .fetch_optional(&mut *tx).await?;
    if locked.is_none() {
        return Ok(None);
    }
    let supported: bool = sqlx::query_scalar("SELECT static_hls_pending_reader_supported()")
        .fetch_one(&mut *tx)
        .await?;
    ensure!(supported, "static_hls_authority_unknown");
    let remaining: Option<f64> = sqlx::query_scalar("SELECT extract(epoch FROM (CASE WHEN c.publication_phase='pending_child' THEN LEAST(c.expires_at,r.lease_until,r.static_hls_prepare_expires_at) ELSE LEAST(c.expires_at,p.expires_at,r.lease_until,r.static_hls_prepare_expires_at) END)-clock_timestamp())::float8 FROM static_hls_captures c JOIN playback_requests r ON r.session_id=c.session_id LEFT JOIN playback_sessions p ON p.id=c.session_id WHERE c.id=$1 AND c.owner_id=$2 AND c.session_id=$3 AND ((c.publication_phase='pending_child' AND static_hls_pending_child_capture_authority_allowed(c.id)) OR (c.publication_phase='published_child' AND static_hls_child_queue_authority_allowed(c.session_id)))")
        .bind(uuid(&bound.identity.operation_id)?).bind(permit.owner).bind(uuid(&bound.identity.session_id)?)
        .fetch_optional(&mut *tx).await?;
    let remaining = remaining.map(Duration::try_from_secs_f64).transpose()?;
    // Only a fully observed read and completed rollback can return this
    // connection. Cancellation/error still closes it via close_on_drop.
    tx.rollback().await?;
    connection.return_to_pool().await;
    Ok(remaining)
}

pub async fn authority_remaining(
    pool: &PgPool,
    permit: &ChildCapturePermit,
) -> Result<Option<Duration>> {
    let mut deadline = AuthorityDeadline::new(Instant::now())?;
    let remaining = deadline
        .observe(read_authority_remaining(pool, permit), &Instant::now)
        .await?;
    remaining
        .map(|value| deadline.remaining(value, Instant::now()))
        .transpose()
}

fn authority_check<'a>(
    started: Instant,
    activation: &'a dyn crate::static_hls::ActivationCheck,
    read: impl Future<Output = Result<Option<Duration>>> + Send + 'a,
    clock: impl Fn() -> Instant + Send + Sync + 'a,
) -> CaptureFuture<'a, ()> {
    let deadline = AuthorityDeadline::new(started);
    Box::pin(async move {
        let mut deadline = deadline?;
        deadline.observe(activation.check(), &clock).await?;
        let remaining = deadline
            .observe(read, &clock)
            .await?
            .ok_or_else(|| anyhow::anyhow!("static_hls_capture_authority_revoked"))?;
        deadline.observe(activation.check(), &clock).await?;
        deadline.remaining(remaining, clock())?;
        Ok(())
    })
}

/// Original child adapter. The activation contract remains independently
/// fail-closed; a SQL receipt never bypasses startup/cache/operation validation.
pub struct PersistedChildCapturePermit {
    pool: PgPool,
    permit: ChildCapturePermit,
    activation: Arc<dyn crate::static_hls::ActivationCheck>,
}
impl PersistedChildCapturePermit {
    pub fn new(
        pool: PgPool,
        permit: ChildCapturePermit,
        activation: Arc<dyn crate::static_hls::ActivationCheck>,
    ) -> Self {
        Self {
            pool,
            permit,
            activation,
        }
    }
    pub fn input(&self) -> &FrozenInput {
        self.permit.input()
    }
    pub fn parent_input(&self) -> &FrozenInput {
        self.permit.parent_input()
    }
    pub fn root_statement(&self) -> &RootGraphStatement {
        self.permit.root_statement()
    }
    pub fn expected_inventory(&self) -> Result<Vec<ResourceIdentity>> {
        self.permit.expected_inventory()
    }
    /// Actual sealed child snapshot only. Full resource/validator/target,
    /// closure/timeline/selected-audio equality precedes encryption and SQL.
    /// No public bool, catalog probe or caller JSON can assert verification.
    pub async fn verify_capture(
        &self,
        capture: &VerifiedCapture,
        seal: impl FnOnce(&[u8]) -> Result<String>,
    ) -> Result<bool> {
        ensure!(
            capture.control()?.identity() == &self.permit.identity(),
            "static_hls_original_child_owner_required"
        );
        <Self as CapturePermit>::check(self).await?;
        let recapture = graph_from_live_evidence(&self.permit.bound, capture.live_evidence()?)?;
        let encrypted = seal(recapture.private_storage_plaintext())?;
        ensure!(
            !encrypted.is_empty() && encrypted.len() <= 262_144,
            "static_hls_inventory_bounds"
        );
        capture.live_evidence()?;
        verify_live_capture(&self.pool, &self.permit, capture, &recapture, &encrypted).await
    }
    pub async fn cancel_child(&self, status: i16, code: &str) -> Result<()> {
        cancel(&self.pool, &self.permit, status, code).await
    }
}
impl CapturePermit for PersistedChildCapturePermit {
    fn identity(&self) -> CaptureOwnerIdentity {
        self.permit.identity()
    }
    fn check(&self) -> CaptureFuture<'_, ()> {
        // Anchor at invocation, not first polling; all activation and SQL
        // observation shares one strict 750 ms budget and only shortens fences.
        authority_check(
            Instant::now(),
            self.activation.as_ref(),
            read_authority_remaining(&self.pool, &self.permit),
            Instant::now,
        )
    }
    fn acknowledge_disposal(&self, proof: Arc<DisposalProof>) -> CaptureFuture<'_, ()> {
        Box::pin(async move { acknowledge_disposal(&self.pool, &self.permit, proof).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PARENT: &[u8] =
        include_bytes!("../../media-core/src/static_hls/contracts/golden_input_v1.json");
    const ROOT: &[u8] =
        include_bytes!("../../media-core/src/static_hls/contracts/golden_root_v1.json");
    fn statements() -> (
        FrozenInput,
        FrozenInput,
        RootGraphStatement,
        WorkerStatement,
    ) {
        let parent = FrozenInput::parse_private_plaintext(PARENT).unwrap();
        let root = RootGraphStatement::parse_private_plaintext(ROOT).unwrap();
        let mut value: Value = serde_json::from_slice(PARENT).unwrap();
        value["kind"] = json!("child");
        value["operation_id"] = json!("00000000-0000-0000-0000-00000000000d");
        value["session_id"] = json!("00000000-0000-0000-0000-00000000000e");
        value["request_owner_epoch"] = json!("00000000-0000-0000-0000-00000000000f");
        value["request_sha256"] = json!("2".repeat(64));
        value["plan_generation"] = json!(2);
        value["prepare_started_at_ms"] = json!(2000);
        value["prepare_expires_at_ms"] = json!(47000);
        value["position_ms"] = json!(1234.125);
        value["root"] = json!({"parent_session_id":parent.identity_statement().session_id,
            "parent_capture_id":parent.identity_statement().operation_id,"parent_input_sha256":parent.input_sha256(),
            "root_digest":root.root_digest(),"root_admitted_at_ms":1000,"root_hard_expires_at_ms":1801000,
            "selected_audio":{"kind":"single","stream_index":1}});
        let child =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
        let i = child.identity_statement();
        let worker = WorkerStatement::parse_private_plaintext(
            &serde_json::to_vec(&json!({
                "reader_version":2,"recipe_version":1,"input_version":1,"graph_version":1,
                "worker_instance":i.worker_instance,"database":i.database,"tasks":["child_encode"]
            }))
            .unwrap(),
        )
        .unwrap();
        (parent, child, root, worker)
    }
    fn attempt() -> ChildCaptureAdmission {
        let (parent, child, root, worker) = statements();
        let instance = uuid(&child.identity_statement().worker_instance).unwrap();
        ChildCaptureAdmission::from_frozen(child, parent, Arc::new(root), instance, Some(&worker))
            .unwrap()
    }
    #[test]
    fn statements_never_mint_a_permit_or_extend_original_deadlines() {
        let mut attempt = attempt();
        assert!(attempt.mint().is_err());
        assert_eq!(attempt.bound.started_ms, 2000);
        assert_eq!(attempt.bound.root_ms, 1801000);
        assert_eq!(attempt.bound.prepare_ms, 47000);
        assert_eq!(attempt.bound.parent_prepare_ms, 46000);
        assert_eq!(attempt.bound.position_ms, 1234.125);
        assert_eq!(
            attempt.bound.selected_audio,
            json!({"kind":"single","stream_index":1})
        );
        assert_eq!(attempt.bound.resource.as_object().unwrap().len(), 4);
    }
    #[test]
    fn wrong_startup_missing_capability_and_changed_unread_resource_are_refused() {
        let (parent, child, root, worker) = statements();
        assert!(
            ChildCaptureAdmission::from_frozen(
                child,
                parent,
                Arc::new(root),
                Uuid::new_v4(),
                Some(&worker)
            )
            .is_err()
        );
        let (parent, child, root, _) = statements();
        let instance = uuid(&child.identity_statement().worker_instance).unwrap();
        assert!(
            ChildCaptureAdmission::from_frozen(child, parent, Arc::new(root), instance, None)
                .is_err()
        );
        let (_, child, root, _) = statements();
        let mut changed: Value = serde_json::from_slice(ROOT).unwrap();
        changed["inventory"][2]["final_target_sha256"] = json!("7".repeat(64));
        let recapture =
            RootGraphStatement::parse_private_plaintext(&serde_json::to_vec(&changed).unwrap())
                .unwrap();
        assert!(root.require_child_recapture(&recapture, &child).is_err());
    }
    #[test]
    fn original_attempt_consumes_once_and_keeps_an_independent_full_inventory() {
        let mut attempt = attempt();
        attempt.state = AttemptState::CommitUnknown;
        let permit = attempt.mint().unwrap();
        assert!(attempt.mint().is_err());
        let inventory = permit.expected_inventory().unwrap();
        assert_eq!(inventory.len(), 3);
        assert_eq!(
            permit.identity().capture_id,
            permit.input().identity_statement().operation_id
        );
        assert_ne!(
            permit.input().input_sha256(),
            permit.parent_input().input_sha256()
        );
    }
    #[test]
    fn authority_observations_charge_the_whole_round_trip_and_reject_late_ready_results() {
        let start = Instant::now();
        let mut deadline = AuthorityDeadline::new(start).unwrap();
        assert_eq!(
            deadline
                .remaining(Duration::from_secs(2), start + Duration::from_millis(700))
                .unwrap(),
            Duration::from_millis(1300)
        );
        assert!(
            deadline
                .elapsed(start + Duration::from_millis(699))
                .is_err()
        );
        let mut deadline = AuthorityDeadline::new(start).unwrap();
        assert!(deadline.elapsed(start + AUTHORITY_TIME).is_err());
        let mut deadline = AuthorityDeadline::new(start).unwrap();
        assert!(
            deadline
                .remaining(
                    Duration::from_millis(700),
                    start + Duration::from_millis(700)
                )
                .is_err()
        );
    }
    #[test]
    fn parent_disposal_never_uses_expiry_as_positive_read_or_execution_evidence() {
        for fence in [
            "parent.state='disposed'",
            "parent.disposed_at IS NOT NULL",
            "retired.stopped",
            "parent.process_disposition IN ('never_started','reaped')",
            "execution.reaped_at IS NULL",
            "cache_write_reservations",
            "cache_read_leases",
            "original.status='failed'",
            "db.id=$6",
        ] {
            assert!(EXACT_PARENT.contains(fence));
        }
        assert!(!EXACT_PARENT.contains("lease.expires_at"));
        assert!(!EXACT_PARENT.contains("static_hls_published_parent_authority_allowed"));
    }
    #[test]
    fn permit_and_uncertain_attempt_have_no_clone_or_serialization_route() {
        trait AmbiguousSerialize<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousSerialize<()> for T {}
        impl<T: ?Sized + serde::Serialize> AmbiguousSerialize<u8> for T {}
        let _ = <ChildCapturePermit as AmbiguousSerialize<_>>::check;
        let _ = <ChildCaptureAdmission as AmbiguousSerialize<_>>::check;
        trait AmbiguousClone<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousClone<()> for T {}
        impl<T: Clone> AmbiguousClone<u8> for T {}
        let _ = <ChildCapturePermit as AmbiguousClone<_>>::check;
        let _ = <ChildCaptureAdmission as AmbiguousClone<_>>::check;
    }
}
