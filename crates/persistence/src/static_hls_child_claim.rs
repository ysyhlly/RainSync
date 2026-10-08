//! One-shot Stage B child intent and parent-read revocation.
//!
//! This transaction persists a claim before stopping its parent. It does not
//! admit a capture, reconstruct a local owner, acknowledge drainage, release a
//! reservation, or publish a child. Those require the original Worker's positive
//! receipts and a fresh, independently verified child capture. Migration 0046
//! supplies the immutable, unique `static_hls_parent_capture_id` reference.
use anyhow::{Result, ensure};
use media_core::static_hls::contracts::{
    graph::RootGraphStatement,
    input::{FrozenInput, IdentityStatement, OperationKind},
    validate_input_ciphertext_size,
};
use serde::Deserialize;
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgRow};
use uuid::Uuid;

use crate::static_hls_pending::CatalogSnapshot;

#[derive(Deserialize)]
struct ClockProjection {
    root_admitted_at_ms: u64,
    prepare_started_at_ms: u64,
}

/// Validated/encrypted private input, with its retained parent/root statement.
/// A graph statement proves equality, not live ownership or physical disposal.
/// No Debug or serialization exposes source configuration or login material.
pub struct PreparedChildInput {
    input: FrozenInput,
    parent: FrozenInput,
    ciphertext: String,
    catalog: CatalogSnapshot,
    identity: IdentityStatement,
    parent_identity: IdentityStatement,
    root_digest: String,
    root_admitted_ms: i64,
    started_ms: i64,
    root_ms: i64,
    prepare_ms: i64,
}

impl PreparedChildInput {
    pub fn seal(
        input: FrozenInput,
        parent: FrozenInput,
        root: &RootGraphStatement,
        catalog: CatalogSnapshot,
        seal: impl FnOnce(&[u8]) -> Result<String>,
    ) -> Result<Self> {
        ensure!(
            input.kind() == OperationKind::Child && parent.kind() == OperationKind::Parent,
            "static_hls_child_input_required"
        );
        root.require_parent_input(&parent)?;
        input.require_child_of(&parent, root.root_digest(), root.selected_audio_statement())?;
        let identity = input.identity_statement();
        ensure!(
            identity.media_id == catalog.media.to_string()
                && identity.source_id == catalog.source.to_string()
                && catalog.kind == "http"
                && i64::try_from(identity.source_policy_revision)? == catalog.source_revision
                && i64::try_from(identity.media_source_generation)? == catalog.source_generation,
            "static_hls_catalog_input_mismatch"
        );
        let clock: ClockProjection = serde_json::from_slice(input.private_storage_plaintext())?;
        let parent_clock: ClockProjection =
            serde_json::from_slice(parent.private_storage_plaintext())?;
        ensure!(
            clock.root_admitted_at_ms == parent_clock.root_admitted_at_ms
                && clock.prepare_started_at_ms >= clock.root_admitted_at_ms,
            "static_hls_child_clock_required"
        );
        let ciphertext = seal(input.private_storage_plaintext())?;
        validate_input_ciphertext_size(ciphertext.as_bytes())?;
        let root_admitted_ms = i64::try_from(clock.root_admitted_at_ms)?;
        let started_ms = i64::try_from(clock.prepare_started_at_ms)?;
        let root_ms = i64::try_from(input.root_deadline_ms())?;
        let prepare_ms = i64::try_from(input.preparation_deadline_ms())?;
        let parent_identity = parent.identity_statement();
        Ok(Self {
            input,
            parent,
            ciphertext,
            catalog,
            identity,
            parent_identity,
            root_digest: root.root_digest().into(),
            root_admitted_ms,
            started_ms,
            root_ms,
            prepare_ms,
        })
    }

    pub fn input(&self) -> &FrozenInput {
        &self.input
    }
}

/// Closed qualifying report classifications. The Server must map only native
/// MEDIA_ERR_DECODE (3), or fatal HLS media/decode with authorization, network and
/// timeout classifications absent. A report expresses intent, never ownership.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecoderFailure {
    NativeDecode,
    FatalHlsMediaDecode,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExistingChild {
    InProgress,
    /// Replay candidate only; child-output/current authority must still pass.
    PublishedChild,
    Failed {
        status: i16,
        code: String,
    },
}

pub struct RetainedChildStatement<'a> {
    pub input_version: Option<i16>,
    pub parent_capture: Option<Uuid>,
    pub request_hash: &'a str,
    pub login: Option<&'a str>,
    pub status: &'a str,
    pub error_status: Option<i16>,
    pub error_code: Option<&'a str>,
    pub response_present: bool,
    pub capture_phase: Option<&'a str>,
}

/// Exact key scope is compared before retained status, regardless of current
/// parent state, clocks, or custody. A failed claim is never reset or re-owned.
pub fn retained_result(
    stored: RetainedChildStatement<'_>,
    request_hash: &str,
    login: &str,
    parent_capture: Uuid,
) -> Result<ExistingChild> {
    ensure!(
        stored.input_version == Some(1) && stored.parent_capture == Some(parent_capture),
        "static_hls_child_linkage_required"
    );
    ensure!(
        stored.login == Some(login),
        "static_hls_exact_login_required"
    );
    ensure!(
        stored.request_hash == request_hash,
        "playback_request_conflict"
    );
    ensure!(
        stored
            .capture_phase
            .is_none_or(|phase| matches!(phase, "pending_child" | "published_child")),
        "static_hls_child_linkage_required"
    );
    match stored.status {
        "pending"
            if !stored.response_present && stored.capture_phase != Some("published_child") =>
        {
            Ok(ExistingChild::InProgress)
        }
        "completed"
            if stored.response_present && stored.capture_phase == Some("published_child") =>
        {
            Ok(ExistingChild::PublishedChild)
        }
        "failed" if !stored.response_present => {
            let status = stored
                .error_status
                .filter(|status| (400..=599).contains(status));
            let code = stored
                .error_code
                .filter(|code| !code.is_empty() && code.len() <= 128);
            Ok(ExistingChild::Failed {
                status: status
                    .ok_or_else(|| anyhow::anyhow!("static_hls_child_linkage_required"))?,
                code: code
                    .ok_or_else(|| anyhow::anyhow!("static_hls_child_linkage_required"))?
                    .into(),
            })
        }
        _ => anyhow::bail!("static_hls_child_linkage_required"),
    }
}

fn existing_row(
    row: &PgRow,
    hash: &str,
    login: &str,
    parent_capture: Uuid,
) -> Result<ExistingChild> {
    let stored_hash: String = row.try_get("request_hash")?;
    let stored_login: Option<String> = row.try_get("auth_login_hash")?;
    let status: String = row.try_get("status")?;
    let error_code: Option<String> = row.try_get("error_code")?;
    let phase: Option<String> = row.try_get("capture_phase")?;
    retained_result(
        RetainedChildStatement {
            input_version: row.try_get("static_hls_input_version")?,
            parent_capture: row.try_get("static_hls_parent_capture_id")?,
            request_hash: &stored_hash,
            login: stored_login.as_deref(),
            status: &status,
            error_status: row.try_get("error_status")?,
            error_code: error_code.as_deref(),
            response_present: row.try_get("response_present")?,
            capture_phase: phase.as_deref(),
        },
        hash,
        login,
        parent_capture,
    )
}

/// Cheap retained-key lookup before a caller decrypts/rebuilds a new input.
/// This read cannot issue a grant, restart a deadline, or authorize parent stop.
pub async fn existing(
    pool: &PgPool,
    user: Uuid,
    key: Uuid,
    hash: &str,
    login: &str,
    parent_capture: Uuid,
) -> Result<Option<ExistingChild>> {
    let row = sqlx::query("SELECT r.*,r.response_encrypted IS NOT NULL AS response_present,(SELECT publication_phase FROM static_hls_captures WHERE session_id=r.session_id AND publication_phase<>'stage_a') AS capture_phase FROM playback_requests r WHERE r.user_id=$1 AND r.idempotency_key=$2")
        .bind(user).bind(key).fetch_optional(pool).await?;
    row.map(|row| existing_row(&row, hash, login, parent_capture))
        .transpose()
}

fn uuid(value: &str) -> Result<Uuid> {
    Ok(Uuid::parse_str(value)?)
}

/// Shared authority prefix, before capture/session/job/cache suffixes. Request
/// rows precede viewer; source precedes media. It deliberately does not compare
/// viewer generation: the parent generation remains current until a new claim
/// and preparation have both been inserted. Callers apply their exact final
/// phase-specific authority predicate after locking their suffix.
pub(crate) async fn lock_authority(
    tx: &mut Transaction<'_, Postgres>,
    i: &IdentityStatement,
    key: Option<Uuid>,
) -> Result<bool> {
    let room = uuid(&i.room_id)?;
    let user = uuid(&i.user_id)?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(room)
        .fetch_optional(&mut **tx)
        .await?;
    sqlx::query("SELECT room_id FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
        .bind(room)
        .fetch_optional(&mut **tx)
        .await?;
    let member = crate::media_authorization::capture(tx, user, room, &i.auth_login_hash).await?;
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
        .bind(user)
        .fetch_optional(&mut **tx)
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
    let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rooms room JOIN room_snapshots snap ON snap.room_id=room.id JOIN media_items m ON m.id=$6 JOIN sources source ON source.id=m.source_id JOIN static_hls_database_binding db ON db.singleton WHERE room.id=$1 AND room.lifecycle='active' AND room.lifecycle_epoch=$2 AND playback_origin_allowed($3,$1,$4,$5) AND (snap.state->>'media_id')::uuid=m.id AND (snap.state->>'media_generation')::bigint=$7 AND m.available AND source.id=$8 AND source.kind='http' AND source.access_policy_revision=$9 AND m.preview_generation=$10 AND db.id=$11)")
        .bind(room).bind(i64::try_from(i.lifecycle_epoch)?).bind(user).bind(&i.auth_login_hash)
        .bind(uuid(&i.auth_membership_epoch)?).bind(uuid(&i.media_id)?).bind(i64::try_from(i.media_generation)?)
        .bind(uuid(&i.source_id)?).bind(i64::try_from(i.source_policy_revision)?)
        .bind(i64::try_from(i.media_source_generation)?).bind(uuid(&i.database)?)
        .fetch_one(&mut **tx).await?;
    Ok(live && member == Some(uuid(&i.auth_membership_epoch)?))
}

fn request_identity(row: &PgRow) -> Result<IdentityStatement> {
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

/// Target statement for cancellation on the already-bound actual Worker. These
/// UUIDs cannot mint a local owner or acknowledge its disposal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParentStopStatement {
    pub session: Uuid,
    pub capture: Uuid,
    pub worker_instance: Uuid,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Claim {
    Claimed(ParentStopStatement),
    Existing(ExistingChild),
}

/// Atomically freeze one child/preparation, revoke parent reads, and advance the
/// exact login's viewer. No I/O or positive cleanup evidence is made here.
pub async fn claim(
    pool: &PgPool,
    key: Uuid,
    prepared: &PreparedChildInput,
    _failure: DecoderFailure,
    quota: i64,
) -> Result<Claim> {
    ensure!(
        !key.is_nil() && quota > 0,
        "static_hls_child_intent_required"
    );
    let i = &prepared.identity;
    let p = &prepared.parent_identity;
    let user = uuid(&i.user_id)?;
    let parent_capture = uuid(&p.operation_id)?;
    let parent_session = uuid(&p.session_id)?;
    if let Some(existing) = existing(
        pool,
        user,
        key,
        &i.request_sha256,
        &i.auth_login_hash,
        parent_capture,
    )
    .await?
    {
        return Ok(Claim::Existing(existing));
    }
    let mut tx = pool.begin().await?;
    crate::static_hls_pending::fence(&mut tx).await?;
    let live = lock_authority(&mut tx, i, Some(key)).await?;
    // The quota/user lock serializes a same-key creation race. Retained scope
    // wins before parent liveness, including after the first claim revoked it.
    let row = sqlx::query("SELECT r.*,r.response_encrypted IS NOT NULL AS response_present,(SELECT publication_phase FROM static_hls_captures WHERE session_id=r.session_id AND publication_phase<>'stage_a') AS capture_phase FROM playback_requests r WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE")
        .bind(user).bind(key).fetch_optional(&mut *tx).await?;
    if let Some(row) = row {
        return Ok(Claim::Existing(existing_row(
            &row,
            &i.request_sha256,
            &i.auth_login_hash,
            parent_capture,
        )?));
    }
    ensure!(live, "static_hls_child_authority_required");
    let parent = sqlx::query("SELECT r.*,floor(extract(epoch FROM r.created_at)*1000)::bigint AS created_ms,floor(extract(epoch FROM r.static_hls_root_expires_at)*1000)::bigint AS root_ms,floor(extract(epoch FROM r.static_hls_prepare_expires_at)*1000)::bigint AS prepare_ms FROM playback_requests r WHERE session_id=$1")
        .bind(parent_session).fetch_optional(&mut *tx).await?
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_parent_required"))?;
    ensure!(
        parent.try_get::<Option<i16>, _>("static_hls_input_version")? == Some(1)
            && parent
                .try_get::<Option<Uuid>, _>("static_hls_parent_capture_id")?
                .is_none()
            && parent.try_get::<String, _>("status")? == "completed",
        "static_hls_child_parent_required"
    );
    prepared
        .parent
        .require_identity_statement(&request_identity(&parent)?)?;
    ensure!(
        parent.try_get::<i64, _>("created_ms")? == prepared.root_admitted_ms
            && parent.try_get::<i64, _>("root_ms")? == prepared.root_ms
            && parent.try_get::<i64, _>("prepare_ms")?
                == i64::try_from(prepared.parent.preparation_deadline_ms())?,
        "static_hls_child_parent_clock_required"
    );
    let current = sqlx::query("SELECT m.id AS media_id,m.source_id,m.resource,m.source_version,m.preview_generation,s.kind,s.config_encrypted,s.access_policy_revision FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND m.available")
        .bind(prepared.catalog.media).fetch_one(&mut *tx).await?;
    ensure!(
        CatalogSnapshot::from_row(&current) == prepared.catalog,
        "static_hls_source_changed"
    );
    // Capture then session, in the same group order as parent publication.
    sqlx::query("SELECT id FROM static_hls_captures WHERE id=$1 FOR UPDATE")
        .bind(parent_capture)
        .fetch_optional(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM playback_sessions WHERE id=$1 FOR UPDATE")
        .bind(parent_session)
        .fetch_optional(&mut *tx)
        .await?;
    let parent_live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM static_hls_captures c JOIN playback_requests r ON r.session_id=c.session_id WHERE c.id=$1 AND c.session_id=$2 AND c.root_digest=$3 AND c.input_sha256=$4 AND c.worker_instance=$5 AND c.database_id=$6 AND c.request_owner_epoch=$7 AND c.user_id=$8 AND c.reader_version=2 AND c.recipe_version=1 AND c.inventory_encrypted IS NOT NULL AND floor(extract(epoch FROM c.expires_at)*1000)::bigint=$9 AND static_hls_published_parent_authority_allowed(c.id) AND NOT EXISTS(SELECT 1 FROM playback_requests child WHERE child.static_hls_parent_capture_id=c.id))")
        .bind(parent_capture).bind(parent_session).bind(&prepared.root_digest).bind(prepared.parent.input_sha256())
        .bind(uuid(&p.worker_instance)?).bind(uuid(&p.database)?).bind(uuid(&p.request_owner_epoch)?)
        .bind(user).bind(prepared.root_ms).fetch_one(&mut *tx).await?;
    ensure!(parent_live, "static_hls_child_parent_unavailable");
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM (SELECT id FROM playback_sessions WHERE user_id=$1 AND id<>$2 AND NOT stopped AND expires_at>clock_timestamp() UNION SELECT session_id FROM playback_requests WHERE user_id=$1 AND status='pending' AND lease_until>clock_timestamp()) active")
        .bind(user).bind(parent_session).fetch_one(&mut *tx).await?;
    let quota = crate::admin_settings::effective(
        &mut tx,
        crate::admin_settings::Limit::PlaybackSessions,
        quota,
    )
    .await?;
    ensure!(active < quota, "too_many_playback_sessions");
    // The unique parent reference is persisted before parent stop or high-water
    // changes. Root lifetime is copied, never restarted at child preparation.
    let inserted = sqlx::query("INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,created_at,room_id,lifecycle_epoch,viewer_id,plan_generation,auth_login_hash,auth_membership_epoch,static_hls_input_version,static_hls_input_encrypted,static_hls_input_sha256,static_hls_operation_id,static_hls_root_expires_at,static_hls_prepare_expires_at,static_hls_media_id,static_hls_media_generation,static_hls_source_id,static_hls_source_revision,static_hls_source_generation,static_hls_worker_instance,static_hls_database_id,static_hls_parent_capture_id) SELECT $1,$2,$3,$4,$5,'pending',to_timestamp($6::double precision/1000),to_timestamp($7::double precision/1000)+interval '48 hours',to_timestamp($7::double precision/1000),$8,$9,$10,$11,$12,$13,1,$14,$15,$16,to_timestamp($17::double precision/1000),to_timestamp($6::double precision/1000),$18,$19,$20,$21,$22,$23,$24,$25 WHERE clock_timestamp()>=to_timestamp($7::double precision/1000) AND clock_timestamp()<to_timestamp($6::double precision/1000) AND clock_timestamp()<to_timestamp($17::double precision/1000) AND static_hls_published_parent_authority_allowed($25) AND playback_origin_allowed($1,$8,$12,$13)")
        .bind(user).bind(key).bind(&i.request_sha256).bind(uuid(&i.session_id)?)
        .bind(uuid(&i.request_owner_epoch)?).bind(prepared.prepare_ms).bind(prepared.started_ms)
        .bind(uuid(&i.room_id)?).bind(i64::try_from(i.lifecycle_epoch)?).bind(uuid(&i.viewer_id)?)
        .bind(i64::try_from(i.plan_generation)?).bind(&i.auth_login_hash).bind(uuid(&i.auth_membership_epoch)?)
        .bind(&prepared.ciphertext).bind(&i.input_sha256).bind(uuid(&i.operation_id)?).bind(prepared.root_ms)
        .bind(uuid(&i.media_id)?).bind(i64::try_from(i.media_generation)?).bind(uuid(&i.source_id)?)
        .bind(i64::try_from(i.source_policy_revision)?).bind(i64::try_from(i.media_source_generation)?)
        .bind(uuid(&i.worker_instance)?).bind(uuid(&i.database)?).bind(parent_capture)
        .execute(&mut *tx).await?.rows_affected();
    ensure!(inserted == 1, "static_hls_child_claim_unconfirmed");
    let inserted = sqlx::query("INSERT INTO playback_preparations(session_id,user_id,room_id,lifecycle_epoch,owner_epoch,created_at) VALUES($1,$2,$3,$4,$5,to_timestamp($6::double precision/1000))")
        .bind(uuid(&i.session_id)?).bind(user).bind(uuid(&i.room_id)?)
        .bind(i64::try_from(i.lifecycle_epoch)?).bind(uuid(&i.request_owner_epoch)?).bind(prepared.started_ms)
        .execute(&mut *tx).await?.rows_affected();
    ensure!(inserted == 1, "static_hls_child_preparation_unconfirmed");
    let stopped = sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1 AND static_hls_capture_id=$2 AND NOT stopped AND expires_at>clock_timestamp()")
        .bind(parent_session).bind(parent_capture).execute(&mut *tx).await?.rows_affected();
    ensure!(stopped == 1, "static_hls_child_parent_stop_unconfirmed");
    let revoked = sqlx::query("UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=409,error_code='static_hls_parent_claimed' WHERE session_id=$1 AND owner_epoch=$2 AND status='completed' AND static_hls_operation_id=$3 AND static_hls_parent_capture_id IS NULL")
        .bind(parent_session).bind(uuid(&p.request_owner_epoch)?).bind(parent_capture)
        .execute(&mut *tx).await?.rows_affected();
    ensure!(revoked == 1, "static_hls_child_parent_stop_unconfirmed");
    let advanced = sqlx::query("UPDATE playback_viewer_plans SET plan_generation=$4,updated_at=clock_timestamp() WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3 AND auth_login_hash=$5 AND plan_generation=$6 AND plan_generation<$4")
        .bind(user).bind(uuid(&i.room_id)?).bind(uuid(&i.viewer_id)?).bind(i64::try_from(i.plan_generation)?)
        .bind(&i.auth_login_hash).bind(i64::try_from(p.plan_generation)?)
        .execute(&mut *tx).await?.rows_affected();
    ensure!(advanced == 1, "static_hls_child_viewer_unconfirmed");
    let allowed: bool =
        sqlx::query_scalar("SELECT static_hls_pending_request_authority_allowed($1)")
            .bind(uuid(&i.session_id)?)
            .fetch_one(&mut *tx)
            .await?;
    ensure!(allowed, "static_hls_child_authority_required");
    tx.commit().await?;
    Ok(Claim::Claimed(ParentStopStatement {
        session: parent_session,
        capture: parent_capture,
        worker_instance: uuid(&p.worker_instance)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored<'a>(status: &'a str) -> RetainedChildStatement<'a> {
        RetainedChildStatement {
            input_version: Some(1),
            parent_capture: Some(Uuid::from_u128(1)),
            request_hash: "request",
            login: Some("exact-login"),
            status,
            error_status: Some(409),
            error_code: Some("blocked"),
            response_present: false,
            capture_phase: None,
        }
    }

    fn read(statement: RetainedChildStatement<'_>) -> Result<ExistingChild> {
        retained_result(statement, "request", "exact-login", Uuid::from_u128(1))
    }

    #[test]
    fn replay_retains_pending_and_terminal_without_parent_liveness_or_clocks() {
        assert_eq!(read(stored("pending")).unwrap(), ExistingChild::InProgress);
        assert_eq!(
            read(stored("failed")).unwrap(),
            ExistingChild::Failed {
                status: 409,
                code: "blocked".into(),
            }
        );
        let mut disposed_child = stored("failed");
        disposed_child.capture_phase = Some("pending_child");
        assert!(matches!(
            read(disposed_child).unwrap(),
            ExistingChild::Failed { .. }
        ));
    }

    #[test]
    fn key_hash_login_and_parent_are_checked_even_for_failed_claims() {
        for status in ["pending", "failed", "completed"] {
            assert!(
                retained_result(
                    stored(status),
                    "different",
                    "exact-login",
                    Uuid::from_u128(1)
                )
                .is_err()
            );
            assert!(
                retained_result(stored(status), "request", "other-login", Uuid::from_u128(1))
                    .is_err()
            );
            assert!(
                retained_result(stored(status), "request", "exact-login", Uuid::from_u128(2))
                    .is_err()
            );
        }
    }

    #[test]
    fn unknown_version_or_parent_phase_cannot_fall_through_legacy() {
        for version in [None, Some(0), Some(2)] {
            let mut statement = stored("pending");
            statement.input_version = version;
            assert!(read(statement).is_err());
        }
        for phase in ["stage_a", "pending_parent", "published_parent", "unknown"] {
            let mut statement = stored("pending");
            statement.capture_phase = Some(phase);
            assert!(read(statement).is_err());
        }
    }

    #[test]
    fn completed_is_only_a_published_child_replay_candidate() {
        let mut statement = stored("completed");
        statement.response_present = true;
        assert!(read(statement).is_err());
        let mut statement = stored("completed");
        statement.response_present = true;
        statement.capture_phase = Some("published_child");
        assert_eq!(read(statement).unwrap(), ExistingChild::PublishedChild);
        let mut statement = stored("pending");
        statement.capture_phase = Some("published_child");
        assert!(read(statement).is_err());
    }

    #[test]
    fn missing_or_invalid_terminal_error_is_not_a_new_intent() {
        for code in [None, Some("")] {
            let mut statement = stored("failed");
            statement.error_code = code;
            assert!(read(statement).is_err());
        }
        for status in [None, Some(200), Some(600)] {
            let mut statement = stored("failed");
            statement.error_status = status;
            assert!(read(statement).is_err());
        }
        for status in ["unknown", "cancelled", "disposed"] {
            assert!(read(stored(status)).is_err());
        }
    }
}
