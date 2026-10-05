//! Original-owner, atomic Stage B child publication and queue admission.
//!
//! This storage API does not activate public HLS or dispatch an encoder. The
//! original child PublicationLease and full recapture comparison are required
//! before entering a short SQL transaction. The stopped, positively disposed
//! parent is historical evidence, never the child's current publication grant.
//! Migration 0047 supplies child-only authority and immutable purpose anchors.
use anyhow::{Result, ensure};
use media_core::static_hls::contracts::{
    graph::RootGraphStatement,
    input::{FrozenInput, IdentityStatement, OperationKind, SelectedAudioStatement},
    worker::{ChildJobSpec, WorkerStatement},
};
use media_core::static_hls::{CaptureOwnerIdentity, PublicationLease};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Connection, PgPool, Postgres, Row, Transaction, postgres::PgRow};
use std::time::Duration;
use tokio::time::Instant;
use uuid::Uuid;

use crate::static_hls_child_queue::{self, Admission, PreparedChildJob};

/// Private prepared bytes retain the very same live local owner and typed job.
/// No exposed fields, Clone, Debug or serialization can mint a ticket.
pub struct ChildPublication<'a> {
    child: &'a FrozenInput,
    parent: &'a FrozenInput,
    root: &'a RootGraphStatement,
    witness: &'a PublicationLease,
    job: PreparedChildJob<'a>,
    owner: CaptureOwnerIdentity,
    purpose: PurposeProjection,
    stored_spec: Value,
    payload: PrivatePayload,
}

#[derive(Deserialize)]
struct PurposeProjection {
    position_ms: f64,
    selected_audio: SelectedAudioStatement,
}

struct PrivatePayload {
    resource: Value,
    response: String,
    token_hash: String,
}

impl<'a> ChildPublication<'a> {
    /// The authenticated same-Worker boundary supplies `observed`; it does not
    /// substitute for original local ownership or the durable authority checks.
    /// Sealers are the trusted private encryption boundary, never public JSON
    /// input. Source URLs/configuration, the graph and fallback markers are not
    /// copied into either generated plaintext delivery object.
    pub async fn prepare(
        child: &'a FrozenInput,
        parent: &'a FrozenInput,
        root: &'a RootGraphStatement,
        witness: &'a PublicationLease,
        observed: Option<&WorkerStatement>,
        seal_descriptor: impl FnOnce(&[u8]) -> Result<String>,
        seal_reply: impl FnOnce(&[u8]) -> Result<String>,
    ) -> Result<Self> {
        ensure!(
            child.kind() == OperationKind::Child && parent.kind() == OperationKind::Parent,
            "static_hls_child_input_required"
        );
        // This constructor checks the opaque lease, authenticated task binding,
        // full inventory/closure/timeline equality, audio and parent/child input.
        // In particular, it compares resources that the encoder may never read.
        let job = PreparedChildJob::prepare(child, parent, root, witness, observed).await?;
        let owner = witness.identity();
        require_owner(child, &owner, witness)?;
        let spec = ChildJobSpec::from_child_input(child)?;
        let bytes = spec.private_storage_plaintext()?;
        let purpose: PurposeProjection = serde_json::from_slice(&bytes)?;
        let stored_spec = serde_json::from_slice(&bytes)?;
        let timeline = serde_json::to_value(&witness.live_evidence()?.timeline)?;
        let origin = timeline["source_origin_ms"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_timeline_required"))?;
        ensure!(origin == 0, "static_hls_child_timeline_required");
        // This queued descriptor records the frozen requested trim origin.
        // It is not a verified playable-output timeline: actual recipe/encode
        // and output validation must establish frame/audio boundary semantics.
        let payload = private_payload(child, purpose.position_ms, seal_descriptor, seal_reply)?;
        witness.live_evidence()?;
        Ok(Self {
            child,
            parent,
            root,
            witness,
            job,
            owner,
            purpose,
            stored_spec,
            payload,
        })
    }
}

/// The reply is encrypted private storage, not a public playback response DTO.
/// Full/Stale carry no grant or queue receipt and leave the entire transaction
/// rolled back. Unknown COMMIT acknowledgement remains an error, never success.
pub enum Publication {
    Published { response_encrypted: String },
    Full,
    Stale,
}

/// Observation of the same immutable committed child receipt, not a local
/// encoder/output owner. States are distinct semantic contracts, never a
/// numerical validation-version comparison or a row-built read permit.
pub enum ChildAuthorityState {
    Queued,
    Running {
        owner_id: Uuid,
        execution_id: Uuid,
        lease_expires_at_ms: u64,
    },
    Published {
        owner_id: Uuid,
        execution_id: Uuid,
        evidence_sha256: String,
        output_published_at_ms: u64,
        timeline_origin_ms: f64,
        duration_ms: f64,
        input_disposed: bool,
        public_output_authority: bool,
    },
}

/// Private committed receipt facts. Ciphertexts remain inside the trusted
/// Server adapter. Published observes dedicated full-output evidence only;
/// positive local input disposal and the original output owner remain separate
/// requirements of the Worker read boundary. No source/path/owner is public.
pub struct ChildCommittedPlanMetadata {
    pub delivery_token_hash: String,
    pub descriptor_encrypted: String,
    pub inventory_encrypted: String,
    pub root_digest: String,
    pub published_at_ms: u64,
    pub expires_at_ms: u64,
    pub prepare_expires_at_ms: u64,
    pub pending_lease_expires_at_ms: u64,
    pub observed_at_ms: u64,
    pub pending_job_id: Uuid,
    pub authority: ChildAuthorityState,
}

/// Compatibility name for callers which originally consumed only queued facts.
/// It now preserves the original receipt across the real first execution.
pub type ChildQueuedPlanMetadata = ChildCommittedPlanMetadata;

/// Query the exact already committed child reply/job/input/root tuple through
/// queued, the one real running attempt, or dedicated full publication. Never
/// install owner GUCs from rows: observation cannot mint an original owner.
/// Acquisition, SQL and commit share one absolute 750 ms budget; canceled reads
/// close their connection rather than return it to the pool.
pub async fn published_child_committed_plan_metadata(
    pool: &PgPool,
    child: &FrozenInput,
    parent: &FrozenInput,
    root: &RootGraphStatement,
    original_reply_encrypted: &str,
) -> Result<Option<ChildCommittedPlanMetadata>> {
    let started = Instant::now();
    let until = started
        .checked_add(Duration::from_millis(750))
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_committed_authority_unknown"))?;
    let result = tokio::time::timeout_at(until, async {
        ensure!(
            child.kind() == OperationKind::Child && parent.kind() == OperationKind::Parent,
            "static_hls_child_input_required"
        );
        validate_reply_bounds(original_reply_encrypted)?;
        root.require_parent_input(parent)?;
        child.require_child_of(parent, root.root_digest(), root.selected_audio_statement())?;
        let spec = ChildJobSpec::from_child_input(child)?;
        let spec_bytes = spec.private_storage_plaintext()?;
        let stored_spec: Value = serde_json::from_slice(&spec_bytes)?;
        let purpose: PurposeProjection = serde_json::from_slice(&spec_bytes)?;
        let i = child.identity_statement();
        let original = parent.identity_statement();
        let mut connection = pool.acquire().await?;
        connection.close_on_drop();
        let mut tx = connection.begin().await?;
        crate::static_hls_pending::fence(&mut tx).await?;
        // Dedicated read-contract capability only. This semantic fence neither
        // activates source qualification nor reconstructs an original owner.
        sqlx::query("SELECT set_config('rainsync.static_hls_child_reader','original_published_child_v1',true)")
            .execute(&mut *tx).await?;
        sqlx::query("SET LOCAL statement_timeout='750ms'")
            .execute(&mut *tx)
            .await?;
        let row = sqlx::query(COMMITTED_METADATA)
            .bind(uuid(&i.session_id)?)
            .bind(uuid(&i.operation_id)?)
            .bind(child.input_sha256())
            .bind(original_reply_encrypted)
            .bind(root.root_digest())
            .bind(uuid(&original.operation_id)?)
            .bind(uuid(&original.session_id)?)
            .bind(parent.input_sha256())
            .bind(stored_spec)
            .bind(uuid(&original.request_owner_epoch)?)
            .bind(&original.request_sha256)
            .bind(purpose.position_ms)
            .bind(serde_json::to_value(purpose.selected_audio)?)
            .fetch_optional(&mut *tx)
            .await?;
        tx.commit().await?;
        let Some(row) = row else { return Ok(None) };
        child.require_identity_statement(&stored_identity(&row)?)?;
        let child_clock: ClockProjection =
            serde_json::from_slice(child.private_storage_plaintext())?;
        let parent_clock: ClockProjection =
            serde_json::from_slice(parent.private_storage_plaintext())?;
        ensure!(
            row.try_get::<i64, _>("created_ms")?
                == i64::try_from(child_clock.prepare_started_at_ms)?
                && row.try_get::<i64, _>("root_until_ms")?
                    == i64::try_from(child.root_deadline_ms())?
                && row.try_get::<i64, _>("prepare_until_ms")?
                    == i64::try_from(child.preparation_deadline_ms())?
                && row.try_get::<i64, _>("parent_created_ms")?
                    == i64::try_from(parent_clock.root_admitted_at_ms)?
                && row.try_get::<i64, _>("parent_prepare_ms")?
                    == i64::try_from(parent.preparation_deadline_ms())?,
            "static_hls_child_committed_input_mismatch"
        );
        let descriptor_encrypted: String = row.try_get("descriptor_encrypted")?;
        let inventory_encrypted: String = row.try_get("inventory_encrypted")?;
        let delivery_token_hash: String = row.try_get("delivery_token_hash")?;
        validate_metadata_ciphertexts(
            &descriptor_encrypted,
            &inventory_encrypted,
            &delivery_token_hash,
        )?;
        let authority = authority_state(&row)?;
        Ok(Some(ChildCommittedPlanMetadata {
            delivery_token_hash,
            descriptor_encrypted,
            inventory_encrypted,
            root_digest: row.try_get("root_digest")?,
            published_at_ms: u64::try_from(row.try_get::<i64, _>("published_at_ms")?)?,
            expires_at_ms: u64::try_from(row.try_get::<i64, _>("expires_at_ms")?)?,
            prepare_expires_at_ms: u64::try_from(row.try_get::<i64, _>("prepare_until_ms")?)?,
            pending_lease_expires_at_ms: u64::try_from(row.try_get::<i64, _>("lease_until_ms")?)?,
            observed_at_ms: u64::try_from(row.try_get::<i64, _>("observed_at_ms")?)?,
            pending_job_id: row.try_get("pending_job_id")?,
            authority,
        }))
    })
    .await
    .map_err(|_| anyhow::anyhow!("static_hls_child_committed_authority_unknown"))?;
    // timeout_at may poll a ready future before its timer. No ready-but-late
    // result can install a new freshness/lifetime mapping.
    ensure!(
        Instant::now() < until,
        "static_hls_child_committed_authority_unknown"
    );
    result
}

pub async fn published_child_queued_plan_metadata(
    pool: &PgPool,
    child: &FrozenInput,
    parent: &FrozenInput,
    root: &RootGraphStatement,
    original_reply_encrypted: &str,
) -> Result<Option<ChildQueuedPlanMetadata>> {
    published_child_committed_plan_metadata(pool, child, parent, root, original_reply_encrypted)
        .await
}

fn authority_state(row: &PgRow) -> Result<ChildAuthorityState> {
    let status: String = row.try_get("job_status")?;
    match status.as_str() {
        "queued" => Ok(ChildAuthorityState::Queued),
        "running" => Ok(ChildAuthorityState::Running {
            owner_id: row.try_get("job_owner")?,
            execution_id: row.try_get("execution_id")?,
            lease_expires_at_ms: u64::try_from(row.try_get::<i64, _>("job_lease_until_ms")?)?,
        }),
        "succeeded" => {
            let evidence_sha256: String = row.try_get("evidence_sha256")?;
            let timeline_origin_ms: f64 = row.try_get("output_origin_ms")?;
            let duration_ms: f64 = row.try_get("output_duration_ms")?;
            ensure!(
                evidence_sha256.len() == 64
                    && evidence_sha256
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    && timeline_origin_ms.is_finite()
                    && timeline_origin_ms >= 0.0
                    && duration_ms.is_finite()
                    && duration_ms > 0.0
                    && (timeline_origin_ms + duration_ms).is_finite()
                    && timeline_origin_ms + duration_ms
                        <= media_core::static_hls::contracts::MAX_SAFE_INTEGER as f64,
                "static_hls_child_complete_evidence_required"
            );
            Ok(ChildAuthorityState::Published {
                owner_id: row.try_get("job_owner")?,
                execution_id: row.try_get("execution_id")?,
                evidence_sha256,
                output_published_at_ms: u64::try_from(
                    row.try_get::<i64, _>("output_published_at_ms")?,
                )?,
                timeline_origin_ms,
                duration_ms,
                input_disposed: row.try_get("input_disposed")?,
                public_output_authority: row.try_get("public_output_authority")?,
            })
        }
        _ => anyhow::bail!("static_hls_child_committed_authority_unknown"),
    }
}

const COMMITTED_METADATA: &str = r#"
SELECT r.*,p.delivery_token_hash,c.published_resource->>'encrypted' AS descriptor_encrypted,
 c.inventory_encrypted,c.root_digest,j.id AS pending_job_id,j.status AS job_status,
 j.owner_id AS job_owner,e.id AS execution_id,proof.evidence_sha256,
 floor(extract(epoch FROM r.created_at)*1000)::bigint AS created_ms,
 floor(extract(epoch FROM r.static_hls_root_expires_at)*1000)::bigint AS root_until_ms,
 floor(extract(epoch FROM r.static_hls_prepare_expires_at)*1000)::bigint AS prepare_until_ms,
 floor(extract(epoch FROM r.lease_until)*1000)::bigint AS lease_until_ms,
 floor(extract(epoch FROM j.lease_until)*1000)::bigint AS job_lease_until_ms,
 floor(extract(epoch FROM original.created_at)*1000)::bigint AS parent_created_ms,
 floor(extract(epoch FROM original.static_hls_prepare_expires_at)*1000)::bigint AS parent_prepare_ms,
 floor(extract(epoch FROM c.published_at)*1000)::bigint AS published_at_ms,
 floor(extract(epoch FROM proof.published_at)*1000)::bigint AS output_published_at_ms,
 (proof.evidence->>'requested_position_ms')::double precision AS output_origin_ms,
 (proof.evidence->>'video_end_seconds')::double precision*1000 AS output_duration_ms,
 CASE WHEN j.status='succeeded' THEN static_hls_child_output_input_disposed(j.id) ELSE false END AS input_disposed,
 CASE WHEN j.status='succeeded' THEN static_hls_child_output_authority_allowed(j.id) ELSE false END AS public_output_authority,
 floor(extract(epoch FROM p.expires_at)*1000)::bigint AS expires_at_ms,
 floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS observed_at_ms
FROM playback_requests r JOIN static_hls_captures c ON c.session_id=r.session_id
 JOIN playback_sessions p ON p.id=r.session_id
 JOIN static_hls_captures parent ON parent.id=r.static_hls_parent_capture_id
 JOIN playback_requests original ON original.session_id=parent.session_id
 JOIN media_jobs j ON j.id=r.session_id AND j.session_id=r.session_id
 LEFT JOIN media_executions e ON e.job_id=j.id AND e.attempt=j.attempt AND e.owner_id=j.owner_id
 LEFT JOIN static_hls_child_output_publications proof ON proof.job_id=j.id AND proof.attempt=j.attempt
     AND proof.owner_id=j.owner_id AND proof.execution_id=e.id
WHERE r.session_id=$1 AND r.static_hls_operation_id=$2 AND r.static_hls_input_sha256=$3
 AND r.status='completed' AND r.response_encrypted=$4 AND c.root_digest=$5
 AND r.static_hls_input_version=1 AND c.id=$2 AND c.publication_phase='published_child'
 AND c.inventory_encrypted IS NOT NULL
 AND r.static_hls_parent_capture_id=$6 AND parent.session_id=$7
 AND original.static_hls_input_sha256=$8 AND original.owner_epoch=$10 AND original.request_hash=$11
 AND c.child_position_ms=$12 AND c.child_selected_audio=$13
 AND p.resource=c.published_resource||jsonb_build_object('static_hls_capture_id',c.id)
 AND r.http_file_context_encrypted IS NULL AND r.http_file_parent IS NULL
 AND original.http_file_context_encrypted IS NULL AND original.http_file_parent IS NULL
 AND j.logical_queue='static_hls_v1' AND j.spec=$9 AND j.error IS NULL
 AND static_hls_child_job_matches(j,r,c) AND static_hls_child_grant_authority_allowed(r.session_id)
 AND NOT EXISTS(SELECT 1 FROM media_jobs extra WHERE extra.session_id=r.session_id AND extra.id<>j.id)
 AND NOT EXISTS(SELECT 1 FROM media_output_files WHERE job_id=j.id)
 AND NOT EXISTS(SELECT 1 FROM cache_entries WHERE id=j.id OR cache_key=j.id::text)
 AND NOT EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id=j.id)
 AND NOT EXISTS(SELECT 1 FROM static_hls_child_output_disposals WHERE job_id=j.id)
 AND (
   (j.status='queued' AND j.attempt=0 AND j.owner_id IS NULL AND j.lease_until IS NULL
    AND j.timing_version=1 AND j.timing_attempt=0 AND j.queue_entered_at IS NOT NULL AND j.run_started_at IS NULL
    AND static_hls_child_queue_authority_allowed(r.session_id)
    AND NOT EXISTS(SELECT 1 FROM media_outputs WHERE job_id=j.id)
    AND NOT EXISTS(SELECT 1 FROM media_executions WHERE job_id=j.id OR session_id=r.session_id)
    AND NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id=j.id)
    AND NOT EXISTS(SELECT 1 FROM static_hls_child_output_publications WHERE job_id=j.id))
   OR (j.status='running' AND j.attempt=1 AND j.owner_id IS NOT NULL
    AND j.timing_version=1 AND j.timing_attempt=1 AND j.queue_entered_at IS NULL
    AND j.run_started_at IS NOT NULL AND j.run_started_at<=clock_timestamp()
    AND j.lease_until>clock_timestamp() AND j.lease_until<=j.run_started_at+interval '20 seconds'
    AND j.lease_until<=r.lease_until AND j.lease_until<=r.static_hls_prepare_expires_at
    AND j.lease_until<=r.static_hls_root_expires_at AND j.lease_until<=p.expires_at
    AND static_hls_child_queue_authority_allowed(r.session_id)
    AND e.session_id=j.session_id AND e.kind='job' AND e.reaped_at IS NULL AND e.created_at<=clock_timestamp()
    AND (SELECT count(*) FROM media_executions WHERE job_id=j.id OR session_id=r.session_id)=1
    AND NOT EXISTS(SELECT 1 FROM static_hls_child_output_publications WHERE job_id=j.id)
    AND NOT EXISTS(SELECT 1 FROM media_outputs o WHERE o.job_id=j.id
        AND (o.attempt<>1 OR o.owner_id<>j.owner_id OR o.relative_dir<>j.id::text||'/1'
          OR o.status<>'writing' OR o.validation_version<>0
          OR o.visible_manifest IS NOT NULL OR o.ready_segments<>0 OR o.manifest_sha256 IS NOT NULL
          OR o.segment_count IS NOT NULL OR o.published_at IS NOT NULL
          OR o.cleanup_owner IS NOT NULL OR o.cleanup_until IS NOT NULL))
    AND ((NOT EXISTS(SELECT 1 FROM media_outputs WHERE job_id=j.id)
          AND NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id=j.id))
      OR EXISTS(SELECT 1 FROM media_outputs o JOIN cache_write_reservations reservation ON reservation.job_id=o.job_id
          WHERE o.job_id=j.id AND o.attempt=1 AND o.owner_id=j.owner_id AND o.relative_dir=j.id::text||'/1'
          AND reservation.owner_id=j.owner_id AND reservation.attempt=1
          AND reservation.purpose='static_hls_child_output' AND reservation.bytes=33554432)))
   OR (j.status='succeeded' AND j.attempt=1 AND j.owner_id IS NOT NULL
    AND proof.capture_id=c.id AND proof.input_sha256=c.input_sha256 AND proof.root_digest=c.root_digest
    AND proof.root_expires_at=c.expires_at AND proof.validation_kind='static_hls_full_child_snapshot_v1'
    AND proof.validation_version=1 AND proof.evidence->>'validation_kind'='complete_owned_child_v1'
    AND proof.evidence->'encoder_input_scope_reaped'='true'::jsonb
    AND (proof.evidence->>'requested_position_ms')::double precision=$12
    AND static_hls_child_output_publication_matches(j.id)
    -- Published output may have genuine delivery executions, including reaped
    -- read history. Retain the single original job-execution fence separately.
    AND (SELECT count(*) FROM media_executions WHERE job_id=j.id
        OR (session_id=r.session_id AND kind='job'))=1)
 )
"#;

fn validate_reply_bounds(response: &str) -> Result<()> {
    ensure!(
        !response.is_empty() && response.len() <= 262_144,
        "static_hls_child_reply_bounds"
    );
    Ok(())
}

fn validate_metadata_ciphertexts(
    descriptor: &str,
    inventory: &str,
    token_hash: &str,
) -> Result<()> {
    ensure!(
        !descriptor.is_empty() && descriptor.len() <= 65_536,
        "static_hls_child_descriptor_bounds"
    );
    ensure!(
        !inventory.is_empty() && inventory.len() <= 262_144,
        "static_hls_child_inventory_bounds"
    );
    ensure!(
        token_hash.len() == 64
            && token_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "static_hls_child_delivery_hash_required"
    );
    Ok(())
}

/// Insert session, publish its child capture, complete the immutable request,
/// and enqueue the exact child job atomically. Nothing performs source/hash or
/// filesystem work under these locks. This API only accepts a pending child;
/// replay of a completed request must separately prove live child-output facts.
pub async fn publish_child(
    pool: &PgPool,
    publication: ChildPublication<'_>,
    queue_limit: i64,
) -> Result<Publication> {
    ensure!((1..=10000).contains(&queue_limit), "invalid_queue_limit");
    require_owner(publication.child, &publication.owner, publication.witness)?;
    publication.witness.check().await?;
    let mut tx = pool.begin().await?;
    let result = publish_locked(&mut tx, &publication, queue_limit).await;
    match result {
        Ok(Admission::Inserted | Admission::Existing) => {
            // publish_locked's last SQL is the exact final job/response fence;
            // its last synchronous step checks this very same opaque witness.
            tx.commit().await?;
            // Published reports this committed private storage receipt. Do not
            // add a fallible post-COMMIT step that could misreport a known
            // committed tuple as rolled back; fresh plan/output checks are
            // separate and cannot treat this receipt as continuing ownership.
            Ok(Publication::Published {
                response_encrypted: publication.payload.response,
            })
        }
        Ok(Admission::Full) => {
            tx.rollback().await?;
            Ok(Publication::Full)
        }
        Ok(Admission::Stale) => {
            tx.rollback().await?;
            Ok(Publication::Stale)
        }
        Err(error) => {
            // Explicitly roll back all preceding publication writes, including
            // failures after request completion or a successful job INSERT.
            if tx.rollback().await.is_err() {
                return Err(error.context("static_hls_child_publication_rollback_unconfirmed"));
            }
            Err(error)
        }
    }
}

async fn publish_locked(
    tx: &mut Transaction<'_, Postgres>,
    publication: &ChildPublication<'_>,
    queue_limit: i64,
) -> Result<Admission> {
    crate::static_hls_pending::fence(tx).await?;
    sqlx::query("SET LOCAL lock_timeout='750ms'")
        .execute(&mut **tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='750ms'")
        .execute(&mut **tx)
        .await?;
    let child = publication.child.identity_statement();
    let parent = publication.parent.identity_statement();
    if !crate::static_hls_child_claim::lock_authority(tx, &child, None).await?
        || !exact_requests(tx, publication, false).await?
    {
        return Ok(Admission::Stale);
    }
    let session = uuid(&child.session_id)?;
    let capture = uuid(&child.operation_id)?;
    let owner = uuid(&publication.owner.owner_id)?;
    // Match the queue's capture/session suffix and UUID ordering. Request locks
    // already serialize closure/pruning of both preparations and reservations.
    sqlx::query("SELECT id FROM static_hls_captures WHERE id IN ($1,$2) ORDER BY id FOR UPDATE")
        .bind(capture)
        .bind(uuid(&parent.operation_id)?)
        .fetch_all(&mut **tx)
        .await?;
    sqlx::query("SELECT id FROM playback_sessions WHERE id IN ($1,$2) ORDER BY id FOR UPDATE")
        .bind(session)
        .bind(uuid(&parent.session_id)?)
        .fetch_all(&mut **tx)
        .await?;
    sqlx::query("SELECT session_id FROM playback_preparations WHERE session_id=$1 FOR UPDATE")
        .bind(session)
        .fetch_optional(&mut **tx)
        .await?;
    let pending: bool = sqlx::query_scalar(PENDING_BINDING)
        .bind(session)
        .bind(capture)
        .bind(owner)
        .bind(publication.child.input_sha256())
        .bind(uuid(&parent.operation_id)?)
        .bind(publication.root.root_digest())
        .bind(uuid(&parent.session_id)?)
        .bind(uuid(&child.worker_instance)?)
        .bind(uuid(&child.database)?)
        .bind(publication.purpose.position_ms)
        .bind(serde_json::to_value(publication.purpose.selected_audio)?)
        .fetch_one(&mut **tx)
        .await?;
    if !pending {
        return Ok(Admission::Stale);
    }
    require_owner(publication.child, &publication.owner, publication.witness)?;

    let mut session_resource = publication.payload.resource.clone();
    session_resource
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_resource_required"))?
        .insert("static_hls_capture_id".into(), json!(capture));
    let inserted = sqlx::query(INSERT_SESSION)
        .bind(session)
        .bind(&publication.payload.token_hash)
        .bind(&session_resource)
        .bind(capture)
        .bind(owner)
        .bind(publication.root.root_digest())
        .execute(&mut **tx)
        .await?
        .rows_affected();
    ensure!(inserted == 1, "static_hls_child_publication_unconfirmed");
    let changed = sqlx::query(PUBLISH_CAPTURE)
        .bind(capture)
        .bind(owner)
        .bind(session)
        .bind(&publication.payload.resource)
        .bind(publication.root.root_digest())
        .execute(&mut **tx)
        .await?
        .rows_affected();
    ensure!(changed == 1, "static_hls_child_publication_unconfirmed");
    let changed = sqlx::query(COMPLETE_REQUEST)
        .bind(session)
        .bind(&publication.payload.response)
        .bind(capture)
        .bind(owner)
        .bind(publication.root.root_digest())
        .execute(&mut **tx)
        .await?
        .rows_affected();
    ensure!(changed == 1, "static_hls_child_publication_unconfirmed");

    let admitted = static_hls_child_queue::enqueue(tx, &publication.job, queue_limit).await?;
    if matches!(admitted, Admission::Full | Admission::Stale) {
        return Ok(admitted);
    }
    if !exact_requests(tx, publication, true).await? {
        return Ok(Admission::Stale);
    }
    publication.job.check_before_commit(tx).await?;
    let final_binding: bool = sqlx::query_scalar(FINAL_BINDING)
        .bind(session)
        .bind(capture)
        .bind(owner)
        .bind(&publication.payload.response)
        .bind(&publication.payload.token_hash)
        .bind(&publication.payload.resource)
        .bind(&publication.stored_spec)
        .bind(publication.purpose.position_ms)
        .bind(serde_json::to_value(publication.purpose.selected_audio)?)
        .fetch_one(&mut **tx)
        .await?;
    if !final_binding {
        return Ok(Admission::Stale);
    }
    require_owner(publication.child, &publication.owner, publication.witness)?;
    Ok(admitted)
}

// This is deliberately a CHILD predicate: disposed parent evidence and its
// unique retained claim are necessary, while live parent authority is not.
const PENDING_BINDING: &str = r#"
SELECT EXISTS(SELECT 1 FROM playback_requests r
 JOIN static_hls_captures c ON c.session_id=r.session_id
 JOIN static_hls_captures parent ON parent.id=r.static_hls_parent_capture_id
 JOIN playback_requests original ON original.session_id=parent.session_id
 JOIN playback_sessions retired ON retired.id=parent.session_id
 JOIN static_hls_database_binding db ON db.singleton
 WHERE r.session_id=$1 AND r.status='pending' AND r.response_encrypted IS NULL
 AND r.static_hls_input_version=1 AND r.static_hls_operation_id=$2
 AND r.static_hls_input_sha256=$4 AND r.static_hls_parent_capture_id=$5
 AND r.static_hls_worker_instance=$8 AND r.static_hls_database_id=$9 AND db.id=$9
 AND r.http_file_context_encrypted IS NULL AND r.http_file_parent IS NULL
 AND c.id=$2 AND c.owner_id=$3 AND c.input_sha256=$4 AND c.root_digest=$6
 AND c.request_owner_epoch=r.owner_epoch AND c.user_id=r.user_id
 AND c.worker_instance=$8 AND c.database_id=$9 AND c.reader_version=2 AND c.recipe_version=1
 AND c.publication_phase='pending_child' AND c.state='verified' AND c.disposed_at IS NULL
 AND c.inventory_encrypted IS NOT NULL AND c.expires_at=r.static_hls_root_expires_at
 AND c.published_resource IS NULL AND c.published_at IS NULL
 AND c.child_position_ms=$10 AND c.child_selected_audio=$11
 AND parent.id=$5 AND parent.session_id=$7 AND parent.publication_phase='published_parent'
 AND parent.state='disposed' AND parent.disposed_at IS NOT NULL
 AND parent.streams_closed_at IS NOT NULL AND parent.process_closed_at IS NOT NULL
 AND parent.files_removed_at IS NOT NULL AND parent.process_disposition IN ('never_started','reaped')
 AND parent.root_digest=$6 AND parent.input_sha256=original.static_hls_input_sha256
 AND parent.inventory_encrypted IS NOT NULL AND parent.expires_at=c.expires_at
 AND parent.user_id=r.user_id AND parent.request_owner_epoch=original.owner_epoch
 AND parent.worker_instance=$8 AND parent.database_id=$9
 AND original.static_hls_parent_capture_id IS NULL AND original.status IN ('completed','failed')
 AND original.static_hls_operation_id=parent.id AND original.static_hls_root_expires_at=c.expires_at
 AND retired.stopped AND retired.static_hls_capture_id=parent.id
 AND EXISTS(SELECT 1 FROM cache_write_reservations reservation WHERE reservation.job_id=c.id
     AND reservation.owner_id=c.owner_id AND reservation.attempt=0
     AND reservation.bytes=134217728 AND reservation.purpose='static_hls_capture')
 AND NOT EXISTS(SELECT 1 FROM cache_write_reservations reservation WHERE reservation.job_id=parent.id)
 AND NOT EXISTS(SELECT 1 FROM playback_sessions WHERE id=r.session_id)
 AND NOT EXISTS(SELECT 1 FROM media_jobs WHERE id=r.session_id OR session_id=r.session_id)
 AND static_hls_pending_child_capture_authority_allowed(c.id))
"#;

const INSERT_SESSION: &str = r#"
INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,
 resource,expires_at,lifecycle_epoch,viewer_id,plan_generation,static_hls_capture_id,
 auth_login_hash,auth_membership_epoch)
 SELECT r.session_id,r.user_id,r.room_id,r.static_hls_media_id,r.static_hls_media_generation,
 $2,$3,r.static_hls_root_expires_at,r.lifecycle_epoch,r.viewer_id,r.plan_generation,$4,
 r.auth_login_hash,r.auth_membership_epoch
 FROM playback_requests r JOIN static_hls_captures c ON c.session_id=r.session_id
 WHERE r.session_id=$1 AND r.status='pending' AND r.static_hls_parent_capture_id IS NOT NULL
 AND c.id=$4 AND c.owner_id=$5 AND c.root_digest=$6 AND c.state='verified'
 AND c.publication_phase='pending_child' AND c.disposed_at IS NULL
 AND static_hls_pending_child_capture_authority_allowed(c.id)
"#;

const PUBLISH_CAPTURE: &str = r#"
UPDATE static_hls_captures SET publication_phase='published_child',published_resource=$4,
 published_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND session_id=$3
 AND publication_phase='pending_child' AND state='verified' AND disposed_at IS NULL
 AND root_digest=$5 AND static_hls_pending_child_capture_authority_allowed(id)
"#;

const COMPLETE_REQUEST: &str = r#"
UPDATE playback_requests r SET status='completed',response_encrypted=$2
 WHERE r.session_id=$1 AND r.status='pending' AND r.response_encrypted IS NULL
 AND r.static_hls_input_version=1 AND r.static_hls_parent_capture_id IS NOT NULL
 AND r.http_file_context_encrypted IS NULL AND r.http_file_parent IS NULL
 AND static_hls_pending_child_publication_authority_allowed(r.session_id)
 AND EXISTS(SELECT 1 FROM static_hls_captures c JOIN playback_sessions p ON p.id=c.session_id
     WHERE c.id=$3 AND c.owner_id=$4 AND c.session_id=r.session_id AND c.root_digest=$5
     AND c.publication_phase='published_child' AND c.state='verified' AND c.disposed_at IS NULL
     AND p.static_hls_capture_id=c.id AND NOT p.stopped
     AND p.resource=c.published_resource||jsonb_build_object('static_hls_capture_id',c.id))
"#;

const FINAL_BINDING: &str = r#"
SELECT EXISTS(SELECT 1 FROM playback_requests r
 JOIN static_hls_captures c ON c.session_id=r.session_id
 JOIN playback_sessions p ON p.id=r.session_id
 JOIN media_jobs j ON j.id=r.session_id AND j.session_id=r.session_id
 WHERE r.session_id=$1 AND c.id=$2 AND c.owner_id=$3
 AND r.status='completed' AND r.response_encrypted=$4 AND p.delivery_token_hash=$5
 AND c.publication_phase='published_child' AND c.state='verified' AND c.disposed_at IS NULL
 AND c.published_resource=$6 AND p.resource=$6||jsonb_build_object('static_hls_capture_id',c.id)
 AND p.static_hls_capture_id=c.id AND NOT p.stopped
 AND r.static_hls_parent_capture_id IS NOT NULL AND r.http_file_parent IS NULL
 AND r.http_file_context_encrypted IS NULL AND p.expires_at=r.static_hls_root_expires_at
 AND c.child_position_ms=$8 AND c.child_selected_audio=$9
 AND j.logical_queue='static_hls_v1' AND j.spec=$7
 AND j.spec->'position_ms'=to_jsonb(c.child_position_ms)
 AND j.spec->'selected_audio'=c.child_selected_audio
 AND static_hls_child_queue_authority_allowed(p.id))
"#;

fn require_owner(
    child: &FrozenInput,
    owner: &CaptureOwnerIdentity,
    witness: &PublicationLease,
) -> Result<()> {
    ensure!(
        child.kind() == OperationKind::Child
            && owner.capture_id == child.identity_statement().operation_id
            && !uuid(&owner.owner_id)?.is_nil()
            && owner.relative_key == format!("static-hls/{}", owner.capture_id)
            && witness.identity() == *owner,
        "static_hls_original_child_owner_required"
    );
    witness.live_evidence()?;
    Ok(())
}

fn private_payload(
    child: &FrozenInput,
    timeline_origin_ms: f64,
    seal_descriptor: impl FnOnce(&[u8]) -> Result<String>,
    seal_reply: impl FnOnce(&[u8]) -> Result<String>,
) -> Result<PrivatePayload> {
    ensure!(
        child.kind() == OperationKind::Child
            && timeline_origin_ms.is_finite()
            && timeline_origin_ms >= 0.0,
        "static_hls_child_timeline_required"
    );
    let spec = ChildJobSpec::from_child_input(child)?;
    let purpose: PurposeProjection = serde_json::from_slice(&spec.private_storage_plaintext()?)?;
    ensure!(
        timeline_origin_ms == purpose.position_ms,
        "static_hls_child_timeline_required"
    );
    let i = child.identity_statement();
    let encrypted = seal_descriptor(&serde_json::to_vec(&json!({
        "kind":"http","transport":"hls","delivery_mode":"transcode",
        "session_id":i.session_id,"input_sha256":i.input_sha256,
        "timeline_origin_ms":timeline_origin_ms
    }))?)?;
    ensure!(
        !encrypted.is_empty() && encrypted.len() <= 65_536,
        "static_hls_child_descriptor_bounds"
    );
    let resource = json!({
        "encrypted":encrypted,"source_policy_revision":i.source_policy_revision,
        "account_policy_generation":null,
        "auth_context":{"version":1,"user_id":i.user_id,"room_id":i.room_id,
            "membership_epoch":i.auth_membership_epoch,"login_hash":i.auth_login_hash},
        "static_hls_input":{"input_version":1,"reader_version":2,"recipe_version":1,
            "source_id":i.source_id,"media_source_generation":i.media_source_generation,
            "input_sha256":i.input_sha256,"worker_instance":i.worker_instance,
            "root_hard_expires_at_ms":child.root_deadline_ms()}
    });
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token_hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    let response = seal_reply(&serde_json::to_vec(&json!({
        "version":1,"session_id":i.session_id,"delivery_token":token,
        "delivery_mode":"transcode","timeline_origin_ms":timeline_origin_ms,
        "pending_job_id":i.session_id
    }))?)?;
    validate_reply_bounds(&response)?;
    Ok(PrivatePayload {
        resource,
        response,
        token_hash,
    })
}

fn uuid(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| anyhow::anyhow!("static_hls_child_identity_invalid"))
}

#[derive(Deserialize)]
struct ClockProjection {
    root_admitted_at_ms: u64,
    prepare_started_at_ms: u64,
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
    publication: &ChildPublication<'_>,
    completed: bool,
) -> Result<bool> {
    for input in [publication.parent, publication.child] {
        let row = sqlx::query("SELECT r.*,floor(extract(epoch FROM created_at)*1000)::bigint AS created_ms,floor(extract(epoch FROM static_hls_root_expires_at)*1000)::bigint AS root_ms,floor(extract(epoch FROM static_hls_prepare_expires_at)*1000)::bigint AS prepare_ms FROM playback_requests r WHERE session_id=$1 AND static_hls_input_version=1")
            .bind(uuid(&input.identity_statement().session_id)?).fetch_optional(&mut **tx).await?;
        let Some(row) = row else { return Ok(false) };
        input.require_identity_statement(&stored_identity(&row)?)?;
        let clock: ClockProjection = serde_json::from_slice(input.private_storage_plaintext())?;
        let child = input.kind() == OperationKind::Child;
        let status: String = row.try_get("status")?;
        if (child && status != if completed { "completed" } else { "pending" })
            || (!child && !matches!(status.as_str(), "completed" | "failed"))
            || row.try_get::<Option<Uuid>, _>("static_hls_parent_capture_id")?
                != if child {
                    Some(uuid(&publication.parent.identity_statement().operation_id)?)
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
    const PARENT: &[u8] =
        include_bytes!("../../media-core/src/static_hls/contracts/golden_input_v1.json");
    const ROOT: &[u8] =
        include_bytes!("../../media-core/src/static_hls/contracts/golden_root_v1.json");

    fn statements() -> (FrozenInput, FrozenInput, RootGraphStatement) {
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
        value["root"] = json!({"parent_session_id":parent.identity_statement().session_id,
            "parent_capture_id":parent.identity_statement().operation_id,"parent_input_sha256":parent.input_sha256(),
            "root_digest":root.root_digest(),"root_admitted_at_ms":1000,"root_hard_expires_at_ms":1801000,
            "selected_audio":{"kind":"single","stream_index":1}});
        let child =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
        (parent, child, root)
    }

    fn echo(bytes: &[u8]) -> Result<String> {
        Ok(String::from_utf8(bytes.to_vec())?)
    }

    #[test]
    fn generated_child_payloads_are_closed_private_transcode_without_recursive_promises() {
        let (_, child, _) = statements();
        // Echo is a test-only inspection sealer; production supplies encryption.
        let payload = private_payload(&child, 0.0, echo, echo).unwrap();
        let descriptor: Value =
            serde_json::from_str(payload.resource["encrypted"].as_str().unwrap()).unwrap();
        let reply: Value = serde_json::from_str(&payload.response).unwrap();
        assert_eq!(descriptor.as_object().unwrap().len(), 6);
        assert_eq!(payload.resource.as_object().unwrap().len(), 5);
        assert_eq!(reply.as_object().unwrap().len(), 6);
        assert_eq!(descriptor["delivery_mode"], "transcode");
        assert_eq!(reply["delivery_mode"], "transcode");
        assert_eq!(
            reply["pending_job_id"],
            child.identity_statement().session_id
        );
        assert_eq!(descriptor["input_sha256"], child.input_sha256());
        assert_eq!(
            payload.resource["static_hls_input"]["root_hard_expires_at_ms"],
            child.root_deadline_ms()
        );
        assert_eq!(
            payload.token_hash,
            format!(
                "{:x}",
                Sha256::digest(reply["delivery_token"].as_str().unwrap().as_bytes())
            )
        );
        for field in [
            "url",
            "source",
            "root",
            "root_digest",
            "inventory",
            "closure",
            "static_hls_fallback",
            "static_hls_fallback_version",
            "http_file_fallback",
            "http_file_fallback_version",
            "http_file_context",
        ] {
            assert!(descriptor.get(field).is_none());
            assert!(reply.get(field).is_none());
        }
        for secret in ["source.example", "x-label", "café"] {
            assert!(!payload.resource.to_string().contains(secret));
            assert!(!payload.response.contains(secret));
        }
    }

    #[test]
    fn child_payloads_refuse_parent_wrong_requested_origin_and_sealer_bounds() {
        let (parent, child, _) = statements();
        assert!(private_payload(&parent, 0.0, echo, echo).is_err());
        assert!(private_payload(&child, 1.0, echo, echo).is_err());
        for length in [0, 65_537] {
            assert!(private_payload(&child, 0.0, |_| Ok("x".repeat(length)), echo).is_err());
        }
        for length in [0, 262_145] {
            assert!(private_payload(&child, 0.0, echo, |_| Ok("x".repeat(length))).is_err());
        }
        assert!(private_payload(&child, 0.0, |_| anyhow::bail!("seal_failed"), echo).is_err());
        assert!(private_payload(&child, 0.0, echo, |_| anyhow::bail!("seal_failed")).is_err());
    }

    #[test]
    fn publication_purpose_is_derived_from_the_same_closed_child_spec() {
        let (_, child, _) = statements();
        let spec = ChildJobSpec::from_child_input(&child).unwrap();
        let purpose: PurposeProjection =
            serde_json::from_slice(&spec.private_storage_plaintext().unwrap()).unwrap();
        assert_eq!(purpose.position_ms, 0.0);
        assert!(purpose.selected_audio == SelectedAudioStatement::Single { stream_index: 1 });
        let mut value: Value = serde_json::from_slice(child.private_storage_plaintext()).unwrap();
        value["position_ms"] = json!(13.0);
        let changed =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(spec.require_input_statement(&changed).is_err());
    }

    #[test]
    fn queued_nonzero_requested_origin_is_frozen_without_asserting_ready_output() {
        let (_, child, _) = statements();
        for position in [13.0, 1013.0, 3417.0] {
            let mut value: Value =
                serde_json::from_slice(child.private_storage_plaintext()).unwrap();
            value["position_ms"] = json!(position);
            let child =
                FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
            let payload = private_payload(&child, position, echo, echo).unwrap();
            let descriptor: Value =
                serde_json::from_str(payload.resource["encrypted"].as_str().unwrap()).unwrap();
            let reply: Value = serde_json::from_str(&payload.response).unwrap();
            assert_eq!(descriptor["timeline_origin_ms"], position);
            assert_eq!(reply["timeline_origin_ms"], position);
            assert_eq!(
                reply["pending_job_id"],
                child.identity_statement().session_id
            );
            assert!(reply.get("playback_url").is_none());
            assert!(reply.get("output_ready").is_none());
            assert!(private_payload(&child, 0.0, echo, echo).is_err());
        }
    }

    #[test]
    fn committed_lookup_uses_distinct_authority_states_and_never_row_built_owners() {
        assert!(COMMITTED_METADATA.contains("j.status='queued' AND j.attempt=0"));
        assert!(COMMITTED_METADATA.contains("j.status='running' AND j.attempt=1"));
        assert!(COMMITTED_METADATA.contains("j.status='succeeded' AND j.attempt=1"));
        assert!(COMMITTED_METADATA.contains("static_hls_child_output_publication_matches(j.id)"));
        assert!(COMMITTED_METADATA.contains("static_hls_child_output_input_disposed(j.id)"));
        assert!(COMMITTED_METADATA.contains("static_hls_child_output_authority_allowed(j.id)"));
        assert!(
            COMMITTED_METADATA
                .contains("proof.validation_kind='static_hls_full_child_snapshot_v1'")
        );
        assert!(COMMITTED_METADATA.contains("proof.validation_version=1"));
        assert!(COMMITTED_METADATA.contains("r.response_encrypted=$4"));
        assert!(COMMITTED_METADATA.contains("j.spec=$9"));
        assert!(!COMMITTED_METADATA.contains("validation_version>="));
        assert!(!COMMITTED_METADATA.contains("set_config"));
        assert!(
            !COMMITTED_METADATA.contains("static_hls_child_output_retention_authority_allowed")
        );
        let source = include_str!("static_hls_child_publication.rs");
        let metadata = &source[source
            .find("pub async fn published_child_committed_plan_metadata(")
            .unwrap()
            ..source
                .find("pub async fn published_child_queued_plan_metadata(")
                .unwrap()];
        assert!(metadata.contains("rainsync.static_hls_child_reader"));
        assert!(!metadata.contains("rainsync.static_hls_child_capture_owner"));
        assert!(!metadata.contains("rainsync.static_hls_child_job_owner"));
        assert!(!metadata.contains("rainsync.static_hls_child_execution_id"));
    }

    #[test]
    fn queued_metadata_validates_ciphertext_and_token_hash_bounds() {
        let hash = "a".repeat(64);
        validate_metadata_ciphertexts("d", "i", &hash).unwrap();
        validate_metadata_ciphertexts(&"d".repeat(65_536), &"i".repeat(262_144), &hash).unwrap();
        for descriptor in [String::new(), "d".repeat(65_537)] {
            assert!(validate_metadata_ciphertexts(&descriptor, "i", &hash).is_err());
        }
        for inventory in [String::new(), "i".repeat(262_145)] {
            assert!(validate_metadata_ciphertexts("d", &inventory, &hash).is_err());
        }
        for hash in [
            "".to_owned(),
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            "g".repeat(64),
        ] {
            assert!(validate_metadata_ciphertexts("d", "i", &hash).is_err());
        }
        validate_reply_bounds("r").unwrap();
        validate_reply_bounds(&"r".repeat(262_144)).unwrap();
        assert!(validate_reply_bounds("").is_err());
        assert!(validate_reply_bounds(&"r".repeat(262_145)).is_err());
    }

    #[test]
    fn prepared_publication_cannot_be_cloned_or_serialized_as_ownership() {
        trait AmbiguousSerialize<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousSerialize<()> for T {}
        impl<T: ?Sized + serde::Serialize> AmbiguousSerialize<u8> for T {}
        let _ = <ChildPublication<'_> as AmbiguousSerialize<_>>::check;
        trait AmbiguousClone<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousClone<()> for T {}
        impl<T: Clone> AmbiguousClone<u8> for T {}
        let _ = <ChildPublication<'_> as AmbiguousClone<_>>::check;
    }
}
