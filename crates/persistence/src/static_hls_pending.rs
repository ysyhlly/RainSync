//! Inactive pending-parent storage. These transactions mint no playback grant,
//! job, public marker, or scanner/file proof. PostgreSQL acceptance is pending.
use anyhow::{Result, ensure};
use media_core::static_hls::contracts::{
    graph::RootGraphStatement,
    input::{FrozenInput, IdentityStatement, OperationKind},
    validate_input_ciphertext_size,
};
use media_core::static_hls::{CaptureOwnerIdentity, DisposalProof, ProcessDisposition};
use serde::Deserialize;
use serde_json::json;
use sqlx::{Connection, PgPool, Postgres, Row, Transaction, postgres::PgRow};
use std::time::Duration;
use uuid::Uuid;

/// Candidate catalog/configuration bytes used before encryption. No Debug or
/// serialization: source configuration and resource can contain credentials.
#[derive(Clone, PartialEq)]
pub struct CatalogSnapshot {
    pub media: Uuid,
    pub source: Uuid,
    pub kind: String,
    pub config_encrypted: String,
    pub resource: String,
    pub source_version: Option<String>,
    pub source_revision: i64,
    pub source_generation: i64,
}
impl CatalogSnapshot {
    pub fn from_row(row: &PgRow) -> Self {
        Self {
            media: row.get("media_id"),
            source: row.get("source_id"),
            kind: row.get("kind"),
            config_encrypted: row.get("config_encrypted"),
            resource: row.get("resource"),
            source_version: row.get("source_version"),
            source_revision: row.get("access_policy_revision"),
            source_generation: row.get("preview_generation"),
        }
    }
}

#[derive(Deserialize)]
struct ClockProjection {
    root_admitted_at_ms: u64,
    prepare_started_at_ms: u64,
}
/// Mirrors always come from the very same validated canonical input handed to
/// the sealer. Neither a supplied digest nor a validated=true flag is accepted.
/// The sealer is a trusted private encryption boundary, never a JSON endpoint.
pub struct PreparedParentInput {
    input: FrozenInput,
    ciphertext: String,
    catalog: CatalogSnapshot,
    identity: IdentityStatement,
    admitted_ms: i64,
    root_ms: i64,
    prepare_ms: i64,
}
impl PreparedParentInput {
    pub fn seal(
        input: FrozenInput,
        catalog: CatalogSnapshot,
        seal: impl FnOnce(&[u8]) -> Result<String>,
    ) -> Result<Self> {
        ensure!(
            input.kind() == OperationKind::Parent,
            "static_hls_parent_input_required"
        );
        let identity = input.identity_statement();
        let clock: ClockProjection = serde_json::from_slice(input.private_storage_plaintext())?;
        // This parent slice starts preparation at the original clock sample.
        ensure!(
            clock.root_admitted_at_ms == clock.prepare_started_at_ms,
            "static_hls_pending_clock_required"
        );
        ensure!(
            identity.media_id == catalog.media.to_string()
                && identity.source_id == catalog.source.to_string()
                && catalog.kind == "http"
                && i64::try_from(identity.source_policy_revision)? == catalog.source_revision
                && i64::try_from(identity.media_source_generation)? == catalog.source_generation,
            "static_hls_catalog_input_mismatch"
        );
        let ciphertext = seal(input.private_storage_plaintext())?;
        validate_input_ciphertext_size(ciphertext.as_bytes())?;
        let admitted_ms = i64::try_from(clock.root_admitted_at_ms)?;
        let root_ms = i64::try_from(input.root_deadline_ms())?;
        let prepare_ms = i64::try_from(input.preparation_deadline_ms())?;
        Ok(Self {
            input,
            ciphertext,
            catalog,
            identity,
            admitted_ms,
            root_ms,
            prepare_ms,
        })
    }
    pub fn input(&self) -> &FrozenInput {
        &self.input
    }
    pub fn input_sha256(&self) -> &str {
        self.input.input_sha256()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Existing {
    /// No pending input: leave this key on its existing legacy path.
    Legacy,
    InProgress,
    Failed {
        status: i16,
        code: String,
    },
    RetainedCustody,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Freeze {
    Frozen,
    Existing(Existing),
}

/// Exact key/hash/login checks precede terminal state, even for expired rows.
/// No pending row is ever retried, re-owned, re-encrypted or renewed.
pub struct RetainedResultStatement<'a> {
    pub input_version: Option<i16>,
    pub request_hash: &'a str,
    pub login: Option<&'a str>,
    pub status: &'a str,
    pub error_status: Option<i16>,
    pub error_code: Option<&'a str>,
    pub custody: bool,
}
/// Pure projection only, with no clock-based retry or ownership replacement.
pub fn retained_result(
    statement: RetainedResultStatement<'_>,
    request_hash: &str,
    login: &str,
) -> Result<Existing> {
    if statement.input_version.is_none() {
        return Ok(Existing::Legacy);
    }
    ensure!(
        statement.input_version == Some(1),
        "static_hls_pending_linkage_required"
    );
    ensure!(
        statement.login == Some(login),
        "static_hls_exact_login_required"
    );
    ensure!(
        statement.request_hash == request_hash,
        "playback_request_conflict"
    );
    match statement.status {
        "pending" => Ok(Existing::InProgress),
        "failed" if statement.custody => Ok(Existing::RetainedCustody),
        "failed" => Ok(Existing::Failed {
            status: statement
                .error_status
                .ok_or_else(|| anyhow::anyhow!("static_hls_pending_linkage_required"))?,
            code: statement
                .error_code
                .ok_or_else(|| anyhow::anyhow!("static_hls_pending_linkage_required"))?
                .into(),
        }),
        _ => anyhow::bail!("static_hls_pending_publication_forbidden"),
    }
}
pub fn existing_result(row: &PgRow, request_hash: &str, login: &str) -> Result<Existing> {
    let stored_hash: String = row.get("request_hash");
    let stored_login: Option<String> = row.get("auth_login_hash");
    let status: String = row.get("status");
    let error_code: Option<String> = row.get("error_code");
    retained_result(
        RetainedResultStatement {
            input_version: row.get("static_hls_input_version"),
            request_hash: &stored_hash,
            login: stored_login.as_deref(),
            status: &status,
            error_status: row.get("error_status"),
            error_code: error_code.as_deref(),
            custody: row.get("custody"),
        },
        request_hash,
        login,
    )
}

async fn fence(tx: &mut Transaction<'_, Postgres>) -> Result<()> {
    sqlx::query("SELECT set_config('rainsync.static_hls_reader','2',true),set_config('rainsync.static_hls_pending_recipe','1',true)")
        .execute(&mut **tx).await?;
    Ok(())
}

/// A cheap private preflight avoids rebuilding a retained key. The final freeze
/// repeats this check under request locks to close concurrent creation races.
pub async fn existing(
    pool: &PgPool,
    user: Uuid,
    key: Uuid,
    hash: &str,
    login: &str,
) -> Result<Option<Existing>> {
    let row = sqlx::query("SELECT r.*,EXISTS(SELECT 1 FROM static_hls_captures WHERE session_id=r.session_id) AS custody FROM playback_requests r WHERE user_id=$1 AND idempotency_key=$2")
        .bind(user).bind(key).fetch_optional(pool).await?;
    row.map(|row| existing_result(&row, hash, login))
        .transpose()
}

fn uuid(value: &str) -> Result<Uuid> {
    Ok(Uuid::parse_str(value)?)
}

/// Full authority prefix. It never locks budget/capture/reservation. Source
/// precedes media to match configuration invalidation. Rechecks use new SQL
/// statements after every contended lock has been obtained.
async fn lock_authority(
    tx: &mut Transaction<'_, Postgres>,
    i: &IdentityStatement,
    key: Option<Uuid>,
    freezing: bool,
) -> Result<bool> {
    let room = uuid(&i.room_id)?;
    let user = uuid(&i.user_id)?;
    let room_row =
        sqlx::query("SELECT lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
            .bind(room)
            .fetch_optional(&mut **tx)
            .await?;
    if room_row.is_none() {
        return Ok(false);
    }
    sqlx::query("SELECT room_id FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
        .bind(room)
        .fetch_optional(&mut **tx)
        .await?;
    if crate::media_authorization::capture(tx, user, room, &i.auth_login_hash).await?
        != Some(uuid(&i.auth_membership_epoch)?)
    {
        return Ok(false);
    }
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
        .bind(user)
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query("SELECT session_id FROM playback_requests WHERE user_id=$1 AND (room_id=$2 OR session_id=$3 OR idempotency_key=$4) ORDER BY session_id FOR UPDATE")
        .bind(user).bind(room).bind(uuid(&i.session_id)?).bind(key).fetch_all(&mut **tx).await?;
    sqlx::query("SELECT viewer_id FROM playback_viewer_plans WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3 FOR UPDATE")
        .bind(user).bind(room).bind(uuid(&i.viewer_id)?).fetch_optional(&mut **tx).await?;
    sqlx::query("SELECT id FROM sources WHERE id=$1 FOR SHARE")
        .bind(uuid(&i.source_id)?)
        .fetch_optional(&mut **tx)
        .await?;
    sqlx::query("SELECT id FROM media_items WHERE id=$1 FOR SHARE")
        .bind(uuid(&i.media_id)?)
        .fetch_optional(&mut **tx)
        .await?;
    let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rooms room JOIN room_snapshots s ON s.room_id=room.id LEFT JOIN playback_viewer_plans v ON v.room_id=room.id AND v.user_id=$3 AND v.viewer_id=$4 JOIN media_items m ON m.id=$7 JOIN sources source ON source.id=m.source_id JOIN static_hls_database_binding db ON db.singleton WHERE room.id=$1 AND room.lifecycle='active' AND room.lifecycle_epoch=$2 AND (s.state->>'media_id')::uuid=m.id AND (s.state->>'media_generation')::bigint=$8 AND ($14 OR (v.plan_generation=$5 AND v.auth_login_hash=$6)) AND playback_origin_allowed($3,$1,$6,$9) AND m.available AND source.id=$10 AND source.kind='http' AND source.access_policy_revision=$11 AND m.preview_generation=$12 AND db.id=$13)")
        .bind(room).bind(i64::try_from(i.lifecycle_epoch)?).bind(user).bind(uuid(&i.viewer_id)?)
        .bind(i64::try_from(i.plan_generation)?).bind(&i.auth_login_hash).bind(uuid(&i.media_id)?)
        .bind(i64::try_from(i.media_generation)?).bind(uuid(&i.auth_membership_epoch)?)
        .bind(uuid(&i.source_id)?).bind(i64::try_from(i.source_policy_revision)?)
        .bind(i64::try_from(i.media_source_generation)?).bind(uuid(&i.database)?).bind(freezing)
        .fetch_one(&mut **tx).await?;
    Ok(live)
}

pub async fn freeze(
    pool: &PgPool,
    key: Uuid,
    prepared: &PreparedParentInput,
    quota: i64,
) -> Result<Freeze> {
    let i = &prepared.identity;
    let mut tx = pool.begin().await?;
    fence(&mut tx).await?;
    let live = lock_authority(&mut tx, i, Some(key), true).await?;
    let row = sqlx::query("SELECT r.*,EXISTS(SELECT 1 FROM static_hls_captures WHERE session_id=r.session_id) AS custody FROM playback_requests r WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE")
        .bind(uuid(&i.user_id)?).bind(key).fetch_optional(&mut *tx).await?;
    if let Some(row) = row {
        return Ok(Freeze::Existing(existing_result(
            &row,
            &i.request_sha256,
            &i.auth_login_hash,
        )?));
    }
    ensure!(live, "static_hls_pending_authority_required");
    let current = sqlx::query("SELECT m.id AS media_id,m.source_id,m.resource,m.source_version,m.preview_generation,s.kind,s.config_encrypted,s.access_policy_revision FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND m.available")
        .bind(prepared.catalog.media).fetch_one(&mut *tx).await?;
    ensure!(
        CatalogSnapshot::from_row(&current) == prepared.catalog,
        "static_hls_source_changed"
    );
    // Only a genuinely new key can advance the same-login high-water. All
    // obsolete request locks were acquired before the viewer/source/media set.
    let viewer = sqlx::query("SELECT plan_generation,auth_login_hash FROM playback_viewer_plans WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3")
        .bind(uuid(&i.user_id)?).bind(uuid(&i.room_id)?).bind(uuid(&i.viewer_id)?).fetch_optional(&mut *tx).await?;
    if let Some(viewer) = viewer {
        ensure!(
            viewer
                .get::<Option<String>, _>("auth_login_hash")
                .as_deref()
                == Some(&i.auth_login_hash),
            "stale_playback_plan"
        );
        ensure!(
            viewer.get::<i64, _>("plan_generation") < i64::try_from(i.plan_generation)?,
            "stale_playback_plan"
        );
    } else {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM playback_viewer_plans WHERE user_id=$1 AND room_id=$2",
        )
        .bind(uuid(&i.user_id)?)
        .bind(uuid(&i.room_id)?)
        .fetch_one(&mut *tx)
        .await?;
        ensure!(count < 1024, "playback_viewer_limit_exceeded");
    }
    let obsolete: Vec<Uuid> = sqlx::query_scalar("SELECT session_id FROM playback_requests WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3 AND plan_generation<$4 AND status='pending' UNION SELECT id FROM playback_sessions WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3 AND plan_generation<$4 AND NOT stopped ORDER BY 1")
        .bind(uuid(&i.user_id)?).bind(uuid(&i.room_id)?).bind(uuid(&i.viewer_id)?).bind(i64::try_from(i.plan_generation)?).fetch_all(&mut *tx).await?;
    // This slice does not rewrite the old Stage A immutable completed result.
    let retained_stage_a: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM static_hls_captures WHERE session_id=ANY($1) AND publication_phase='stage_a')")
        .bind(&obsolete).fetch_one(&mut *tx).await?;
    ensure!(!retained_stage_a, "static_hls_stage_a_custody_retained");
    let n = sqlx::query("INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation,auth_login_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,room_id,viewer_id) DO UPDATE SET plan_generation=EXCLUDED.plan_generation,updated_at=clock_timestamp() WHERE playback_viewer_plans.auth_login_hash=EXCLUDED.auth_login_hash AND playback_viewer_plans.plan_generation<EXCLUDED.plan_generation")
        .bind(uuid(&i.user_id)?).bind(uuid(&i.room_id)?).bind(uuid(&i.viewer_id)?).bind(i64::try_from(i.plan_generation)?).bind(&i.auth_login_hash).execute(&mut *tx).await?.rows_affected();
    ensure!(n == 1, "static_hls_pending_viewer_unconfirmed");
    let mut job_health = media_core::job_health::PendingJobHealth::default();
    // Legacy retirement keeps its existing session/job/upstream semantics.
    // Pending custody is terminalized separately and retains all history.
    for session in obsolete {
        if terminalize_locked(&mut tx, session, 409, "stale_playback_plan").await? {
            continue;
        }
        sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
            .bind(session)
            .execute(&mut *tx)
            .await?;
        job_health.merge(
            crate::media_job_timing::cancel_jobs(
                &mut *tx,
                crate::media_job_timing::CancellationScope::Session(session),
            )
            .await?,
        );
        sqlx::query("UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=409,error_code='stale_playback_plan',lease_until=clock_timestamp() WHERE session_id=$1 AND static_hls_input_version IS NULL")
            .bind(session).execute(&mut *tx).await?;
        crate::upstream_reservations::close(&mut tx, session, "stale_playback_plan").await?;
    }
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM (SELECT id FROM playback_sessions WHERE user_id=$1 AND NOT stopped AND expires_at>clock_timestamp() UNION SELECT session_id FROM playback_requests WHERE user_id=$1 AND status='pending' AND lease_until>clock_timestamp()) active")
        .bind(uuid(&i.user_id)?).fetch_one(&mut *tx).await?;
    ensure!(active < quota, "too_many_playback_sessions");
    let n = sqlx::query("INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,created_at,room_id,lifecycle_epoch,viewer_id,plan_generation,auth_login_hash,auth_membership_epoch,static_hls_input_version,static_hls_input_encrypted,static_hls_input_sha256,static_hls_operation_id,static_hls_root_expires_at,static_hls_prepare_expires_at,static_hls_media_id,static_hls_media_generation,static_hls_source_id,static_hls_source_revision,static_hls_source_generation,static_hls_worker_instance,static_hls_database_id) SELECT $1,$2,$3,$4,$5,'pending',to_timestamp($6::double precision/1000),to_timestamp($7::double precision/1000)+interval '48 hours',to_timestamp($7::double precision/1000),$8,$9,$10,$11,$12,$13,1,$14,$15,$16,to_timestamp($17::double precision/1000),to_timestamp($6::double precision/1000),$18,$19,$20,$21,$22,$23,$24 WHERE clock_timestamp()<to_timestamp($6::double precision/1000) AND clock_timestamp()<to_timestamp($17::double precision/1000) AND playback_origin_allowed($1,$8,$12,$13)")
        .bind(uuid(&i.user_id)?).bind(key).bind(&i.request_sha256).bind(uuid(&i.session_id)?)
        .bind(uuid(&i.request_owner_epoch)?).bind(prepared.prepare_ms).bind(prepared.admitted_ms)
        .bind(uuid(&i.room_id)?).bind(i64::try_from(i.lifecycle_epoch)?).bind(uuid(&i.viewer_id)?)
        .bind(i64::try_from(i.plan_generation)?).bind(&i.auth_login_hash).bind(uuid(&i.auth_membership_epoch)?)
        .bind(&prepared.ciphertext).bind(&i.input_sha256).bind(uuid(&i.operation_id)?).bind(prepared.root_ms)
        .bind(uuid(&i.media_id)?).bind(i64::try_from(i.media_generation)?).bind(uuid(&i.source_id)?)
        .bind(i64::try_from(i.source_policy_revision)?).bind(i64::try_from(i.media_source_generation)?)
        .bind(uuid(&i.worker_instance)?).bind(uuid(&i.database)?).execute(&mut *tx).await?.rows_affected();
    ensure!(n == 1, "static_hls_pending_freeze_unconfirmed");
    let n = sqlx::query("INSERT INTO playback_preparations(session_id,user_id,room_id,lifecycle_epoch,owner_epoch,created_at) VALUES($1,$2,$3,$4,$5,to_timestamp($6::double precision/1000))")
        .bind(uuid(&i.session_id)?).bind(uuid(&i.user_id)?).bind(uuid(&i.room_id)?)
        .bind(i64::try_from(i.lifecycle_epoch)?).bind(uuid(&i.request_owner_epoch)?).bind(prepared.admitted_ms)
        .execute(&mut *tx).await?.rows_affected();
    ensure!(n == 1, "static_hls_pending_preparation_unconfirmed");
    let live: bool = sqlx::query_scalar("SELECT static_hls_pending_request_authority_allowed($1)")
        .bind(uuid(&i.session_id)?)
        .fetch_one(&mut *tx)
        .await?;
    ensure!(live, "static_hls_pending_authority_required");
    let observation = job_health.into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
    Ok(Freeze::Frozen)
}

/// Process-local responsibility, minted only after this admission commits. It
/// has no serialization, public constructor, or restart reconstruction path.
pub struct PendingCapturePermit {
    capture: Uuid,
    owner: Uuid,
    session: Uuid,
    input: Box<FrozenInput>,
}
impl PendingCapturePermit {
    pub fn identity(&self) -> CaptureOwnerIdentity {
        CaptureOwnerIdentity {
            capture_id: self.capture.to_string(),
            owner_id: self.owner.to_string(),
            relative_key: format!("static-hls/{}", self.capture),
        }
    }
}
pub enum Admission {
    Acquired(PendingCapturePermit),
    Changed,
    Full,
    Stale,
}

fn stored_identity(row: &PgRow) -> IdentityStatement {
    IdentityStatement {
        operation_id: row.get::<Uuid, _>("static_hls_operation_id").to_string(),
        session_id: row.get::<Uuid, _>("session_id").to_string(),
        request_owner_epoch: row.get::<Uuid, _>("owner_epoch").to_string(),
        request_sha256: row.get("request_hash"),
        input_sha256: row.get("static_hls_input_sha256"),
        user_id: row.get::<Uuid, _>("user_id").to_string(),
        room_id: row.get::<Uuid, _>("room_id").to_string(),
        auth_login_hash: row.get("auth_login_hash"),
        auth_membership_epoch: row.get::<Uuid, _>("auth_membership_epoch").to_string(),
        lifecycle_epoch: row.get::<i64, _>("lifecycle_epoch") as u64,
        media_id: row.get::<Uuid, _>("static_hls_media_id").to_string(),
        media_generation: row.get::<i64, _>("static_hls_media_generation") as u64,
        viewer_id: row.get::<Uuid, _>("viewer_id").to_string(),
        plan_generation: row.get::<i64, _>("plan_generation") as u64,
        worker_instance: row.get::<Uuid, _>("static_hls_worker_instance").to_string(),
        database: row.get::<Uuid, _>("static_hls_database_id").to_string(),
        source_id: row.get::<Uuid, _>("static_hls_source_id").to_string(),
        source_policy_revision: row.get::<i64, _>("static_hls_source_revision") as u64,
        media_source_generation: row.get::<i64, _>("static_hls_source_generation") as u64,
    }
}
async fn exact_request(tx: &mut Transaction<'_, Postgres>, input: &FrozenInput) -> Result<bool> {
    let row = sqlx::query("SELECT r.*,floor(extract(epoch FROM created_at)*1000)::bigint AS admitted_ms,floor(extract(epoch FROM static_hls_root_expires_at)*1000)::bigint AS root_ms,floor(extract(epoch FROM static_hls_prepare_expires_at)*1000)::bigint AS prepare_ms FROM playback_requests r WHERE session_id=$1 AND static_hls_input_version=1 FOR UPDATE")
        .bind(uuid(&input.identity_statement().session_id)?).fetch_optional(&mut **tx).await?;
    let Some(row) = row else { return Ok(false) };
    input.require_identity_statement(&stored_identity(&row))?;
    let clock: ClockProjection = serde_json::from_slice(input.private_storage_plaintext())?;
    Ok(row.get::<String, _>("status") == "pending"
        && row.get::<i64, _>("admitted_ms") == i64::try_from(clock.root_admitted_at_ms)?
        && row.get::<i64, _>("root_ms") == i64::try_from(input.root_deadline_ms())?
        && row.get::<i64, _>("prepare_ms") == i64::try_from(input.preparation_deadline_ms())?)
}

pub async fn admit(
    pool: &PgPool,
    prepared: &PreparedParentInput,
    owner: Uuid,
    revision: i64,
    headroom: u64,
) -> Result<Admission> {
    let mut tx = pool.begin().await?;
    fence(&mut tx).await?;
    if !lock_authority(&mut tx, &prepared.identity, None, false).await?
        || !exact_request(&mut tx, &prepared.input).await?
    {
        return Ok(Admission::Stale);
    }
    let storage: bool = sqlx::query_scalar("SELECT static_hls_input_encrypted=$2 AND static_hls_pending_request_authority_allowed(session_id) FROM playback_requests WHERE session_id=$1")
        .bind(uuid(&prepared.identity.session_id)?).bind(&prepared.ciphertext).fetch_one(&mut *tx).await?;
    if !storage {
        return Ok(Admission::Stale);
    }
    let current: i64 =
        sqlx::query_scalar("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    if current != revision {
        return Ok(Admission::Changed);
    }
    // The budget serializes unresolved capacity and positive disposal. Lock
    // only this operation: a global capture scan would invert a room's
    // budget-free multi-request cancellation order against other admission.
    sqlx::query("SELECT id FROM static_hls_captures WHERE id=$1 FOR UPDATE")
        .bind(uuid(&prepared.identity.operation_id)?)
        .fetch_optional(&mut *tx)
        .await?;
    let capacity: bool = sqlx::query_scalar("SELECT (SELECT count(*) FROM static_hls_captures WHERE disposed_at IS NULL)<2 AND NOT EXISTS(SELECT 1 FROM static_hls_captures WHERE user_id=$1 AND disposed_at IS NULL) AND NOT EXISTS(SELECT 1 FROM static_hls_captures WHERE session_id=$2)")
        .bind(uuid(&prepared.identity.user_id)?).bind(uuid(&prepared.identity.session_id)?).fetch_one(&mut *tx).await?;
    let held: String =
        sqlx::query_scalar("SELECT COALESCE(sum(bytes),0)::text FROM cache_write_reservations")
            .fetch_one(&mut *tx)
            .await?;
    if !capacity
        || held.parse::<u128>()? + u128::from(crate::static_hls::CAPTURE_BYTES)
            > u128::from(headroom)
    {
        return Ok(Admission::Full);
    }
    let i = &prepared.identity;
    let capture = uuid(&i.operation_id)?;
    let session = uuid(&i.session_id)?;
    let resource = json!({"media_id":i.media_id,"source_id":i.source_id,"source_policy_revision":i.source_policy_revision,"media_source_generation":i.media_source_generation});
    let n = sqlx::query("INSERT INTO static_hls_captures(id,session_id,user_id,owner_id,resource_authority,request_owner_epoch,expires_at,publication_phase,input_sha256,worker_instance,database_id,reader_version,recipe_version) SELECT $1,$2,$3,$4,$5,$6,r.static_hls_root_expires_at,'pending_parent',$7,$8,$9,2,1 FROM playback_requests r WHERE r.session_id=$2 AND static_hls_pending_request_authority_allowed(r.session_id)")
        .bind(capture).bind(session).bind(uuid(&i.user_id)?).bind(owner).bind(resource).bind(uuid(&i.request_owner_epoch)?)
        .bind(&i.input_sha256).bind(uuid(&i.worker_instance)?).bind(uuid(&i.database)?).execute(&mut *tx).await?.rows_affected();
    ensure!(n == 1, "static_hls_pending_admission_unconfirmed");
    let n = sqlx::query("INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose) VALUES($1,$2,0,134217728,'static_hls_capture')")
        .bind(capture).bind(owner).execute(&mut *tx).await?.rows_affected();
    ensure!(n == 1, "static_hls_pending_reservation_unconfirmed");
    let n =
        sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton AND revision=$1")
            .bind(revision)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    ensure!(n == 1, "static_hls_pending_budget_unconfirmed");
    tx.commit().await?;
    Ok(Admission::Acquired(PendingCapturePermit {
        capture,
        owner,
        session,
        input: Box::new(prepared.input.clone()),
    }))
}

/// Validated graph data is still a statement, not scanner or local custody
/// evidence. The private caller encrypts these exact validated bytes; binding
/// is required again here immediately before the still-pending SQL mutation.
pub async fn verify(
    pool: &PgPool,
    permit: &PendingCapturePermit,
    root: &RootGraphStatement,
    seal: impl FnOnce(&[u8]) -> Result<String>,
) -> Result<bool> {
    root.require_parent_input(&permit.input)?;
    let encrypted = seal(root.private_storage_plaintext())?;
    ensure!(
        !encrypted.is_empty() && encrypted.len() <= 262_144,
        "static_hls_inventory_bounds"
    );
    let mut tx = pool.begin().await?;
    fence(&mut tx).await?;
    if !lock_authority(&mut tx, &permit.input.identity_statement(), None, false).await?
        || !exact_request(&mut tx, &permit.input).await?
    {
        return Ok(false);
    }
    root.require_parent_input(&permit.input)?;
    sqlx::query("SELECT id FROM static_hls_captures WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase='pending_parent' FOR UPDATE")
        .bind(permit.capture).bind(permit.owner).bind(permit.session).fetch_optional(&mut *tx).await?;
    let n = sqlx::query("UPDATE static_hls_captures SET state='verified',inventory_encrypted=$4,root_digest=$5 WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase='pending_parent' AND state='capturing' AND inventory_encrypted IS NULL AND root_digest IS NULL AND static_hls_pending_capture_authority_allowed(id)")
        .bind(permit.capture).bind(permit.owner).bind(permit.session).bind(encrypted).bind(root.root_digest()).execute(&mut *tx).await?.rows_affected();
    if n != 1 {
        return Ok(false);
    }
    tx.commit().await?;
    Ok(true)
}

/// Caller holds room/request locks. A failed result remains stable for every
/// reason, including retryable transport failures. This never touches budget.
pub async fn terminalize_locked(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    status: i16,
    code: &str,
) -> Result<bool> {
    let row = sqlx::query("SELECT status FROM playback_requests WHERE session_id=$1 AND static_hls_input_version=1 FOR UPDATE")
        .bind(session).fetch_optional(&mut **tx).await?;
    let Some(row) = row else { return Ok(false) };
    if row.get::<String, _>("status") == "pending" {
        let n = sqlx::query("UPDATE playback_requests SET status='failed',error_status=$2,error_code=$3 WHERE session_id=$1 AND static_hls_input_version=1 AND status='pending'")
            .bind(session).bind(status).bind(code).execute(&mut **tx).await?.rows_affected();
        ensure!(n == 1, "static_hls_pending_terminalization_unconfirmed");
    } else {
        ensure!(
            row.get::<String, _>("status") == "failed",
            "static_hls_pending_publication_forbidden"
        );
    }
    // Request revocation is sufficient authority loss, but make capture state
    // monotonic too. This trigger path deliberately does not acquire budget.
    let capture: Option<Uuid> = sqlx::query_scalar("SELECT id FROM static_hls_captures WHERE session_id=$1 AND publication_phase='pending_parent' AND state IN ('capturing','verified') FOR UPDATE")
        .bind(session).fetch_optional(&mut **tx).await?;
    if let Some(capture) = capture {
        let n = sqlx::query("UPDATE static_hls_captures SET state='cancelled' WHERE id=$1 AND publication_phase='pending_parent' AND state IN ('capturing','verified')")
            .bind(capture).execute(&mut **tx).await?.rows_affected();
        ensure!(n == 1, "static_hls_pending_cancellation_unconfirmed");
    }
    Ok(true)
}

pub async fn cancel(
    pool: &PgPool,
    permit: &PendingCapturePermit,
    status: i16,
    code: &str,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    fence(&mut tx).await?;
    let i = permit.input.identity_statement();
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(uuid(&i.room_id)?)
        .fetch_one(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT * FROM playback_requests WHERE session_id=$1 AND static_hls_input_version=1 FOR UPDATE")
        .bind(permit.session).fetch_one(&mut *tx).await?;
    permit
        .input
        .require_identity_statement(&stored_identity(&row))?;
    ensure!(
        terminalize_locked(&mut tx, permit.session, status, code).await?,
        "static_hls_pending_cancellation_unconfirmed"
    );
    tx.commit().await?;
    Ok(())
}

/// Only the original local owner can present the opaque, all-positive proof.
/// Cleanup remains authorized after room/login/source revocation. No authority
/// locks follow this budget -> capture -> reservation suffix.
pub async fn acknowledge_disposal(
    pool: &PgPool,
    permit: &PendingCapturePermit,
    proof: DisposalProof,
) -> Result<()> {
    ensure!(
        proof.identity() == &permit.identity() && proof.all_positive(),
        "static_hls_disposal_identity_required"
    );
    let disposition = match proof.process_disposition() {
        ProcessDisposition::NeverStarted => "never_started",
        ProcessDisposition::Reaped => "reaped",
    };
    let mut tx = pool.begin().await?;
    fence(&mut tx).await?;
    sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT disposed_at IS NOT NULL AS disposed,process_disposition FROM static_hls_captures WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase='pending_parent' FOR UPDATE")
        .bind(permit.capture).bind(permit.owner).bind(permit.session).fetch_one(&mut *tx).await?;
    let reservation = sqlx::query("SELECT owner_id,attempt,bytes,purpose FROM cache_write_reservations WHERE job_id=$1 FOR UPDATE")
        .bind(permit.capture).fetch_optional(&mut *tx).await?;
    if row.get::<bool, _>("disposed") {
        ensure!(
            reservation.is_none() && row.get::<String, _>("process_disposition") == disposition,
            "static_hls_disposal_unconfirmed"
        );
        return Ok(());
    }
    let reservation =
        reservation.ok_or_else(|| anyhow::anyhow!("static_hls_disposal_reservation_required"))?;
    ensure!(
        reservation.get::<Uuid, _>("owner_id") == permit.owner
            && reservation.get::<i64, _>("attempt") == 0
            && reservation.get::<i64, _>("bytes") == crate::static_hls::CAPTURE_BYTES as i64
            && reservation.get::<String, _>("purpose") == "static_hls_capture",
        "static_hls_disposal_reservation_required"
    );
    let n = sqlx::query("UPDATE static_hls_captures SET state='disposed',streams_closed_at=clock_timestamp(),process_closed_at=clock_timestamp(),process_disposition=$4,files_removed_at=clock_timestamp(),disposed_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase='pending_parent' AND disposed_at IS NULL")
        .bind(permit.capture).bind(permit.owner).bind(permit.session).bind(disposition).execute(&mut *tx).await?.rows_affected();
    ensure!(n == 1, "static_hls_disposal_unconfirmed");
    let n = sqlx::query("DELETE FROM cache_write_reservations WHERE job_id=$1 AND owner_id=$2 AND attempt=0 AND purpose='static_hls_capture'")
        .bind(permit.capture).bind(permit.owner).execute(&mut *tx).await?.rows_affected();
    ensure!(n == 1, "static_hls_disposal_release_unconfirmed");
    let n = sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton")
        .execute(&mut *tx)
        .await?
        .rows_affected();
    ensure!(n == 1, "static_hls_pending_budget_unconfirmed");
    tx.commit().await?;
    Ok(())
}

/// Original executor, after positive Server preparation closure. Request must
/// be locked first, then its exact preparation; both writes are checked.
pub async fn acknowledge_preparation(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    owner: Uuid,
) -> Result<bool> {
    let row = sqlx::query("SELECT owner_epoch FROM playback_requests WHERE session_id=$1 AND static_hls_input_version=1 FOR UPDATE")
        .bind(session).fetch_optional(&mut **tx).await?;
    let Some(row) = row else { return Ok(false) };
    ensure!(
        row.get::<Uuid, _>("owner_epoch") == owner,
        "static_hls_preparation_owner_required"
    );
    sqlx::query("SELECT session_id FROM playback_preparations WHERE session_id=$1 AND owner_epoch=$2 FOR UPDATE")
        .bind(session).bind(owner).fetch_one(&mut **tx).await?;
    // Preserve an already-positive time on a same-owner replay.
    let n = sqlx::query("UPDATE playback_requests SET preparation_drained_at=COALESCE(preparation_drained_at,date_trunc('milliseconds',clock_timestamp())) WHERE session_id=$1 AND owner_epoch=$2 AND static_hls_input_version=1")
        .bind(session).bind(owner).execute(&mut **tx).await?.rows_affected();
    ensure!(n == 1, "static_hls_preparation_ack_unconfirmed");
    let n = sqlx::query("UPDATE playback_preparations p SET drained_at=r.preparation_drained_at FROM playback_requests r WHERE p.session_id=$1 AND p.owner_epoch=$2 AND r.session_id=p.session_id AND r.owner_epoch=p.owner_epoch AND r.static_hls_input_version=1")
        .bind(session).bind(owner).execute(&mut **tx).await?.rows_affected();
    ensure!(n == 1, "static_hls_preparation_ack_unconfirmed");
    Ok(true)
}

/// Startup recovery is separate from the unchanged legacy transaction. Each
/// transaction holds one room and at most 128 sorted request rows; no authority
/// lock is acquired after a capture. There is no closure evidence at startup.
pub async fn recover_pending(pool: &PgPool) -> Result<()> {
    loop {
        let room: Option<Uuid> = sqlx::query_scalar("SELECT room_id FROM playback_requests WHERE status='pending' AND static_hls_input_version=1 ORDER BY room_id LIMIT 1")
            .fetch_optional(pool).await?.flatten();
        let Some(room) = room else { return Ok(()) };
        let mut tx = pool.begin().await?;
        sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
            .bind(room)
            .fetch_one(&mut *tx)
            .await?;
        let pending: Vec<Uuid> = sqlx::query_scalar("SELECT session_id FROM playback_requests WHERE room_id=$1 AND static_hls_input_version=1 AND status='pending' ORDER BY session_id LIMIT 128 FOR UPDATE")
            .bind(room).fetch_all(&mut *tx).await?;
        for session in pending {
            ensure!(
                terminalize_locked(&mut tx, session, 409, "playback_request_interrupted").await?,
                "static_hls_pending_recovery_unconfirmed"
            );
        }
        tx.commit().await?;
    }
}

/// Dedicated ordered pruning. A missing capture is acceptable only under its
/// original request lock and after positive preparation closure. Known or
/// uncertain admission never becomes disposal merely because a row is absent.
pub async fn prune(pool: &PgPool, session: Uuid) -> Result<bool> {
    let mut tx = pool.begin().await?;
    fence(&mut tx).await?;
    let room: Option<Uuid> = sqlx::query_scalar(
        "SELECT room_id FROM playback_requests WHERE session_id=$1 AND static_hls_input_version=1",
    )
    .bind(session)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    let Some(room) = room else { return Ok(false) };
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    let operation: Option<Uuid> = sqlx::query_scalar("SELECT static_hls_operation_id FROM playback_requests WHERE session_id=$1 AND room_id=$2 AND static_hls_input_version=1 FOR UPDATE")
        .bind(session).bind(room).fetch_optional(&mut *tx).await?.flatten();
    let Some(operation) = operation else {
        return Ok(false);
    };
    sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    let capture: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM static_hls_captures WHERE session_id=$1 ORDER BY id FOR UPDATE",
    )
    .bind(session)
    .fetch_optional(&mut *tx)
    .await?;
    sqlx::query("SELECT job_id FROM cache_write_reservations WHERE job_id IN ($1,$2) ORDER BY job_id FOR UPDATE").bind(operation).bind(session).fetch_all(&mut *tx).await?;
    sqlx::query("SELECT session_id FROM playback_preparations WHERE session_id=$1 FOR UPDATE")
        .bind(session)
        .fetch_optional(&mut *tx)
        .await?;
    // Fresh READ COMMITTED statement and DB clock after locks, for both the
    // positively disposed and atomically never-admitted branches.
    let eligible: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_requests r JOIN playback_preparations p ON p.session_id=r.session_id WHERE r.session_id=$1 AND r.static_hls_input_version=1 AND r.status='failed' AND r.expires_at<clock_timestamp() AND r.preparation_drained_at IS NOT NULL AND p.drained_at=r.preparation_drained_at AND p.owner_epoch=r.owner_epoch AND NOT EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.session_id=r.session_id AND (c.publication_phase<>'pending_parent' OR c.id<>r.static_hls_operation_id OR c.disposed_at IS NULL OR c.streams_closed_at IS NULL OR c.process_closed_at IS NULL OR c.files_removed_at IS NULL)) AND static_hls_pending_prune_dependencies_absent(r.session_id,r.static_hls_operation_id,r.room_id))")
        .bind(session).fetch_one(&mut *tx).await?;
    if !eligible {
        return Ok(false);
    }
    sqlx::query("SELECT set_config('rainsync.static_hls_pending_prune','1',true)")
        .execute(&mut *tx)
        .await?;
    if let Some(capture) = capture {
        let n = sqlx::query("DELETE FROM static_hls_captures WHERE id=$1 AND session_id=$2 AND publication_phase='pending_parent'").bind(capture).bind(session).execute(&mut *tx).await?.rows_affected();
        ensure!(n == 1, "static_hls_pending_prune_unconfirmed");
    }
    let n = sqlx::query("DELETE FROM playback_preparations WHERE session_id=$1")
        .bind(session)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    ensure!(n == 1, "static_hls_pending_prune_unconfirmed");
    let n = sqlx::query(
        "DELETE FROM playback_requests WHERE session_id=$1 AND static_hls_input_version=1",
    )
    .bind(session)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    ensure!(n == 1, "static_hls_pending_prune_unconfirmed");
    tx.commit().await?;
    Ok(true)
}

/// Bounded live check for the local owner. Compatibility is checked separately
/// from actual revocation, so an unsupported reader produces unknown authority.
pub async fn authority_remaining(
    pool: &PgPool,
    permit: &PendingCapturePermit,
) -> Result<Option<Duration>> {
    tokio::time::timeout(Duration::from_millis(750), async {
        let mut connection = pool.acquire().await?;
        // Timeout cancellation cannot return a still-running connection as
        // a fresh authority observation on a subsequent pool checkout.
        connection.close_on_drop();
        let mut tx = connection.begin().await?;
        fence(&mut tx).await?;
        let remaining: Option<f64> = sqlx::query_scalar("SELECT extract(epoch FROM LEAST(c.expires_at,r.lease_until,r.static_hls_prepare_expires_at)-clock_timestamp())::float8 FROM static_hls_captures c JOIN playback_requests r ON r.session_id=c.session_id WHERE c.id=$1 AND c.owner_id=$2 AND c.session_id=$3 AND c.publication_phase='pending_parent' AND static_hls_pending_capture_authority_allowed(c.id)")
            .bind(permit.capture).bind(permit.owner).bind(permit.session).fetch_optional(&mut *tx).await?;
        remaining.map(Duration::try_from_secs_f64).transpose().map_err(Into::into)
    }).await.map_err(|_| anyhow::anyhow!("static_hls_authority_unknown"))?
}

/// The default application activation remains closed. This adapter accepts
/// only an admission-minted local permit and opaque disposal proof.
pub struct PersistedPendingCapturePermit {
    pool: PgPool,
    permit: PendingCapturePermit,
    activation: std::sync::Arc<dyn crate::static_hls::ActivationCheck>,
}
impl PersistedPendingCapturePermit {
    pub fn new(
        pool: PgPool,
        permit: PendingCapturePermit,
        activation: std::sync::Arc<dyn crate::static_hls::ActivationCheck>,
    ) -> Self {
        Self {
            pool,
            permit,
            activation,
        }
    }
}
impl media_core::static_hls::CapturePermit for PersistedPendingCapturePermit {
    fn identity(&self) -> CaptureOwnerIdentity {
        self.permit.identity()
    }
    fn check(&self) -> media_core::static_hls::CaptureFuture<'_, ()> {
        Box::pin(async {
            tokio::time::timeout(Duration::from_millis(750), self.activation.check())
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_activation_unknown"))??;
            let started = std::time::Instant::now();
            let remaining = authority_remaining(&self.pool, &self.permit)
                .await?
                .ok_or_else(|| anyhow::anyhow!("static_hls_capture_authority_revoked"))?;
            tokio::time::timeout(Duration::from_millis(750), self.activation.check())
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_activation_unknown"))??;
            ensure!(
                remaining > started.elapsed(),
                "static_hls_capture_authority_expired"
            );
            Ok(())
        })
    }
    fn acknowledge_disposal(
        &self,
        proof: DisposalProof,
    ) -> media_core::static_hls::CaptureFuture<'_, ()> {
        Box::pin(async move { acknowledge_disposal(&self.pool, &self.permit, proof).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> FrozenInput {
        FrozenInput::parse_private_plaintext(include_bytes!(
            "../../media-core/src/static_hls/contracts/golden_input_v1.json"
        ))
        .unwrap()
    }
    fn catalog() -> CatalogSnapshot {
        let i = input().identity_statement();
        CatalogSnapshot {
            media: uuid(&i.media_id).unwrap(),
            source: uuid(&i.source_id).unwrap(),
            kind: "http".into(),
            config_encrypted: "synthetic".into(),
            resource: "synthetic".into(),
            source_version: None,
            source_revision: 1,
            source_generation: 1,
        }
    }
    #[test]
    fn mirrors_and_sealing_share_the_canonical_validated_bytes() {
        let frozen = input();
        let bytes = frozen.private_storage_plaintext().to_vec();
        let prepared = PreparedParentInput::seal(frozen, catalog(), |canonical| {
            assert_eq!(canonical, bytes);
            Ok("synthetic-ciphertext".into())
        })
        .unwrap();
        assert!(prepared.identity == prepared.input.identity_statement());
        assert_eq!(prepared.admitted_ms, 1000);
        assert_eq!(prepared.root_ms, 1_801_000);
        assert_eq!(prepared.prepare_ms, 46_000);
    }
    #[test]
    fn catalog_identity_and_encryption_bounds_fail_closed() {
        for mutate in [0, 1, 2, 3] {
            let mut candidate = catalog();
            match mutate {
                0 => candidate.source = Uuid::nil(),
                1 => candidate.media = Uuid::nil(),
                2 => candidate.source_revision += 1,
                _ => candidate.source_generation += 1,
            }
            assert!(
                PreparedParentInput::seal(input(), candidate, |_| panic!(
                    "must not encrypt a mismatch"
                ))
                .is_err()
            );
        }
        assert!(PreparedParentInput::seal(input(), catalog(), |_| Ok(String::new())).is_err());
        assert!(PreparedParentInput::seal(input(), catalog(), |_| Ok("x".repeat(65_537))).is_err());
    }
    #[test]
    fn retained_pending_and_retryable_failures_are_stable() {
        let statement = |status, custody| RetainedResultStatement {
            input_version: Some(1),
            request_hash: "hash",
            login: Some("login"),
            status,
            error_status: Some(502),
            error_code: Some("upstream_failed"),
            custody,
        };
        assert_eq!(
            retained_result(statement("pending", false), "hash", "login").unwrap(),
            Existing::InProgress
        );
        assert_eq!(
            retained_result(statement("failed", false), "hash", "login").unwrap(),
            Existing::Failed {
                status: 502,
                code: "upstream_failed".into()
            }
        );
        assert_eq!(
            retained_result(statement("failed", true), "hash", "login").unwrap(),
            Existing::RetainedCustody
        );
        assert!(retained_result(statement("completed", true), "hash", "login").is_err());
        assert!(retained_result(statement("failed", true), "different-hash", "login").is_err());
        assert!(retained_result(statement("failed", true), "hash", "different-login").is_err());
        let mut legacy = statement("pending", false);
        legacy.input_version = None;
        assert_eq!(
            retained_result(legacy, "different-hash", "different-login").unwrap(),
            Existing::Legacy
        );
        for version in [Some(0), Some(2)] {
            let mut value = statement("failed", false);
            value.input_version = version;
            assert!(retained_result(value, "hash", "login").is_err());
        }
    }
    #[test]
    fn identity_mismatch_cannot_pass_projection() {
        let frozen = input();
        for field in 0..8 {
            let mut observed = frozen.identity_statement();
            match field {
                0 => observed.auth_login_hash = "cd".repeat(32),
                1 => observed.request_owner_epoch = Uuid::from_u128(30).to_string(),
                2 => observed.source_id = Uuid::from_u128(31).to_string(),
                3 => observed.media_id = Uuid::from_u128(32).to_string(),
                4 => observed.worker_instance = Uuid::from_u128(33).to_string(),
                5 => observed.database = Uuid::from_u128(34).to_string(),
                6 => observed.source_policy_revision += 1,
                _ => observed.media_source_generation += 1,
            }
            assert!(frozen.require_identity_statement(&observed).is_err());
        }
    }
    #[test]
    fn unsupported_version_and_original_deadline_extensions_are_refused() {
        let raw: serde_json::Value =
            serde_json::from_slice(input().private_storage_plaintext()).unwrap();
        for field in [
            "input_version",
            "root_hard_expires_at_ms",
            "prepare_expires_at_ms",
        ] {
            let mut value = raw.clone();
            value[field] = json!(value[field].as_u64().unwrap() + 1);
            assert!(
                FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).is_err()
            );
        }
    }
}
