//! Original-owner Stage B child queue admission; no public activation or dispatch.
//!
//! Requires the child publication/queue schema and guards in 0047, plus
//! 0046's child-claim authority lock prefix. It deliberately cannot use Stage A's UUID/JSON enqueue API. A
//! completed child request, published verified child capture, live grant, unique
//! retained parent claim and original local publication witness must all agree.
//! The caller publishes the child and completes its request BEFORE enqueueing in
//! the SAME transaction; deferred publication guards must require the final job.
//! Keep the witness alive and call `check_before_commit` after the last unrelated
//! await before COMMIT. A returned admission is not a committed queue receipt.
use anyhow::{Result, ensure};
use media_core::static_hls::contracts::{
    graph::RootGraphStatement,
    input::{FrozenInput, IdentityStatement, OperationKind},
    worker::{ChildJobSpec, Task, WorkerStatement, require_task_statement},
};
use media_core::static_hls::{CaptureOwnerIdentity, PublicationLease};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use uuid::Uuid;

const LOGICAL_QUEUE: &str = "static_hls_v1";
const QUEUE_LOCK: &str = "SELECT pg_advisory_xact_lock(72614932)";
const CAPACITY: &str = "SELECT count(*) FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id WHERE j.status IN ('queued','running') AND NOT p.stopped AND p.expires_at>clock_timestamp() AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)";
// Preserve media_queue's known queue-prefix and attempt-zero insertion shape.
// The immediate job trigger is retained. No ON CONFLICT can hide a wrong job.
const INSERT: &str = "INSERT INTO media_jobs(id,session_id,status,spec,timing_version,timing_attempt,queue_entered_at,run_started_at,metrics_queue_ms,metrics_queue_complete,metrics_queue_accounted_attempt,logical_queue) SELECT $1,$1,'queued',$2,1,0,clock_timestamp(),NULL,0,true,0,'static_hls_v1' WHERE static_hls_child_queue_authority_allowed($1)";

/// This is neither a serializable job ticket nor a process-ownership assertion.
/// Its only constructor requires the actual child's opaque, live local witness.
/// Frozen inputs/root statements still receive exact durable checks at admission.
pub struct PreparedChildJob<'a> {
    child: &'a FrozenInput,
    parent: &'a FrozenInput,
    root: &'a RootGraphStatement,
    witness: &'a PublicationLease,
    owner: CaptureOwnerIdentity,
    spec: ChildJobSpec,
    stored_spec: Value,
}
impl<'a> PreparedChildJob<'a> {
    /// Run outside transaction locks. The caller obtains `observed` through its
    /// fresh authenticated same-Worker operation boundary. It is compatibility
    /// evidence only; the original lease and SQL guards supply separate fences.
    /// Entire recaptured inventory/closure/timeline, including unread resources,
    /// is compared here; metadata-only or caller-supplied scan JSON is rejected.
    pub async fn prepare(
        child: &'a FrozenInput,
        parent: &'a FrozenInput,
        root: &'a RootGraphStatement,
        witness: &'a PublicationLease,
        observed: Option<&WorkerStatement>,
    ) -> Result<Self> {
        require_task_statement(observed, Task::ChildEncode, child)?;
        witness.check().await?;
        let owner = witness.identity();
        ensure!(
            owner.capture_id == child.identity_statement().operation_id
                && !uuid(&owner.owner_id)?.is_nil(),
            "static_hls_original_child_owner_required"
        );
        root.require_parent_input(parent)?;
        child.require_child_of(parent, root.root_digest(), root.selected_audio_statement())?;
        let evidence = witness.live_evidence()?;
        let recapture = RootGraphStatement::parse_private_plaintext(&serde_json::to_vec(
            &json!({
                "graph_version":1,"parent_input_sha256":parent.input_sha256(),
                "inventory":evidence.inventory,"closure":evidence.closure,"timeline":evidence.timeline
            }),
        )?)?;
        root.require_child_recapture(&recapture, child)?;
        let spec = ChildJobSpec::from_child_input(child)?;
        let stored_spec = serde_json::from_slice(&spec.private_storage_plaintext()?)?;
        witness.live_evidence()?;
        Ok(Self {
            child,
            parent,
            root,
            witness,
            owner,
            spec,
            stored_spec,
        })
    }

    /// Final relational and synchronous local fence, after the caller's last
    /// publication/preparation write and immediately before COMMIT. No source
    /// read, decoder, filesystem hash or physical side effect occurs here.
    pub async fn check_before_commit(&self, tx: &mut Transaction<'_, Postgres>) -> Result<()> {
        ensure!(
            exact_binding(tx, self).await?,
            "static_hls_child_queue_authority_required"
        );
        self.witness.live_evidence()?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Admission {
    Inserted,
    /// Matching immutable job already exists, in ANY state. Never retry/reset it.
    Existing,
    Full,
    Stale,
}

/// Hold the caller's ordered authority/publication transaction through COMMIT.
/// This does not complete requests, mint grants, release reservations, advance
/// viewer high-water, change attempts or create a recursive fallback marker.
/// On Full/Stale/Error the caller MUST roll back its entire child publication;
/// committing a completed grant without its final job is forbidden.
/// Invalid/missing schema and trigger refusals propagate as errors, not success.
pub async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    prepared: &PreparedChildJob<'_>,
    limit: i64,
) -> Result<Admission> {
    validate_limit(limit)?;
    prepared.witness.live_evidence()?;
    prepared.spec.require_input_statement(prepared.child)?;
    crate::static_hls_pending::fence(tx).await?;
    let identity = prepared.child.identity_statement();
    if !crate::static_hls_child_claim::lock_authority(tx, &identity, None).await? {
        return Ok(Admission::Stale);
    }
    if !exact_requests(tx, prepared).await? {
        return Ok(Admission::Stale);
    }
    // The prefix already locked requests in UUID order. Lock both captures and
    // sessions in UUID order too; source/media authority always precedes them.
    sqlx::query("SELECT id FROM static_hls_captures WHERE id IN ($1,$2) ORDER BY id FOR UPDATE")
        .bind(uuid(&identity.operation_id)?)
        .bind(uuid(&prepared.parent.identity_statement().operation_id)?)
        .fetch_all(&mut **tx)
        .await?;
    sqlx::query("SELECT id FROM playback_sessions WHERE id IN ($1,$2) ORDER BY id FOR UPDATE")
        .bind(uuid(&identity.session_id)?)
        .bind(uuid(&prepared.parent.identity_statement().session_id)?)
        .fetch_all(&mut **tx)
        .await?;
    if !exact_binding(tx, prepared).await? {
        return Ok(Admission::Stale);
    }
    // Same capacity serialization and semantics as existing ordinary/Stage A
    // queues. Check replay BEFORE capacity, so a full queue cannot duplicate it.
    sqlx::query(QUEUE_LOCK).execute(&mut **tx).await?;
    let jobs = sqlx::query("SELECT id,session_id,logical_queue,spec FROM media_jobs WHERE id=$1 OR session_id=$1 ORDER BY id FOR UPDATE")
        .bind(uuid(&identity.session_id)?).fetch_all(&mut **tx).await?;
    if let Some(job) = jobs.first() {
        ensure!(jobs.len() == 1, "static_hls_child_job_conflict");
        require_existing_job(
            job.try_get("id")?,
            job.try_get("session_id")?,
            job.try_get::<Option<String>, _>("logical_queue")?
                .as_deref(),
            &job.try_get::<Value, _>("spec")?,
            uuid(&identity.session_id)?,
            &prepared.spec,
            prepared.child,
        )?;
        prepared.check_before_commit(tx).await?;
        return Ok(Admission::Existing);
    }
    let active: i64 = sqlx::query_scalar(CAPACITY).fetch_one(&mut **tx).await?;
    if active >= limit {
        return Ok(Admission::Full);
    }
    // Recheck expiry/current authority after all contended locks. The INSERT
    // repeats the child-only SQL predicate and still runs the existing guards.
    prepared.check_before_commit(tx).await?;
    let changed = sqlx::query(INSERT)
        .bind(uuid(&identity.session_id)?)
        .bind(&prepared.stored_spec)
        .execute(&mut **tx)
        .await?
        .rows_affected();
    ensure!(changed == 1, "static_hls_child_queue_unconfirmed");
    prepared.check_before_commit(tx).await?;
    Ok(Admission::Inserted)
}

fn validate_limit(limit: i64) -> Result<()> {
    ensure!((1..=10000).contains(&limit), "invalid_queue_limit");
    Ok(())
}
fn uuid(value: &str) -> Result<Uuid> {
    // Do not include rejected identifiers/private input in diagnostic messages.
    Uuid::parse_str(value).map_err(|_| anyhow::anyhow!("static_hls_child_identity_invalid"))
}

fn require_existing_job(
    id: Uuid,
    session: Option<Uuid>,
    queue: Option<&str>,
    value: &Value,
    expected: Uuid,
    expected_spec: &ChildJobSpec,
    child: &FrozenInput,
) -> Result<()> {
    ensure!(
        id == expected && session == Some(expected) && queue == Some(LOGICAL_QUEUE),
        "static_hls_child_job_conflict"
    );
    let existing = ChildJobSpec::parse_private_plaintext(&serde_json::to_vec(value)?)?;
    expected_spec.require_same_spec_statement(&existing)?;
    existing.require_input_statement(child)?;
    Ok(())
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
    prepared: &PreparedChildJob<'_>,
) -> Result<bool> {
    for input in [prepared.parent, prepared.child] {
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
                    Some(uuid(&prepared.parent.identity_statement().operation_id)?)
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

// SQL relational proof is deliberately separate from opaque local ownership.
// Parent authority is HISTORICAL: it must be stopped and positively disposed,
// never a still-deliverable parent grant. The child retains the original root
// deadline and its OWN live 128 MiB reservation, original worker/database/input.
const EXACT_BINDING: &str = r#"
SELECT EXISTS(SELECT 1 FROM playback_requests r
 JOIN static_hls_captures c ON c.session_id=r.session_id
 JOIN playback_sessions p ON p.id=r.session_id
 JOIN static_hls_captures parent ON parent.id=r.static_hls_parent_capture_id
 JOIN playback_requests original ON original.session_id=parent.session_id
 JOIN playback_sessions retired ON retired.id=parent.session_id
 JOIN static_hls_database_binding db ON db.singleton
 WHERE r.session_id=$1 AND r.status='completed' AND r.static_hls_input_version=1
 AND r.static_hls_operation_id=$2 AND r.static_hls_input_sha256=$4
 AND r.static_hls_parent_capture_id=$5 AND r.static_hls_worker_instance=$8
 AND r.static_hls_database_id=$9 AND db.id=$9
 AND c.id=$2 AND c.owner_id=$3 AND c.input_sha256=$4 AND c.root_digest=$6
 AND c.request_owner_epoch=r.owner_epoch AND c.user_id=r.user_id
 AND c.worker_instance=$8 AND c.database_id=$9 AND c.reader_version=2 AND c.recipe_version=1
 AND c.publication_phase='published_child' AND c.state='verified' AND c.disposed_at IS NULL
 AND c.inventory_encrypted IS NOT NULL AND c.expires_at=r.static_hls_root_expires_at
 AND p.static_hls_capture_id=c.id AND NOT p.stopped
 AND p.resource=c.published_resource||jsonb_build_object('static_hls_capture_id',c.id)
 AND p.user_id=r.user_id AND p.room_id=r.room_id AND p.media_id=r.static_hls_media_id
 AND p.generation=r.static_hls_media_generation AND p.lifecycle_epoch=r.lifecycle_epoch
 AND p.viewer_id=r.viewer_id AND p.plan_generation=r.plan_generation
 AND p.auth_login_hash=r.auth_login_hash AND p.auth_membership_epoch=r.auth_membership_epoch
 AND p.expires_at<=c.expires_at AND p.expires_at>clock_timestamp()
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
 AND r.static_hls_prepare_expires_at>clock_timestamp()
 AND EXISTS(SELECT 1 FROM cache_write_reservations reservation WHERE reservation.job_id=c.id
     AND reservation.owner_id=c.owner_id AND reservation.attempt=0
     AND reservation.bytes=134217728 AND reservation.purpose='static_hls_capture')
 AND NOT EXISTS(SELECT 1 FROM cache_write_reservations reservation WHERE reservation.job_id=parent.id)
 AND static_hls_child_queue_authority_allowed(p.id))
"#;
async fn exact_binding(
    tx: &mut Transaction<'_, Postgres>,
    prepared: &PreparedChildJob<'_>,
) -> Result<bool> {
    let child = prepared.child.identity_statement();
    let parent = prepared.parent.identity_statement();
    Ok(sqlx::query_scalar(EXACT_BINDING)
        .bind(uuid(&child.session_id)?)
        .bind(uuid(&child.operation_id)?)
        .bind(uuid(&prepared.owner.owner_id)?)
        .bind(prepared.child.input_sha256())
        .bind(uuid(&parent.operation_id)?)
        .bind(prepared.root.root_digest())
        .bind(uuid(&parent.session_id)?)
        .bind(uuid(&child.worker_instance)?)
        .bind(uuid(&child.database)?)
        .fetch_one(&mut **tx)
        .await?)
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
            "parent_capture_id":parent.identity_statement().operation_id,
            "parent_input_sha256":parent.input_sha256(),"root_digest":root.root_digest(),
            "root_admitted_at_ms":1000,"root_hard_expires_at_ms":1801000,
            "selected_audio":{"kind":"single","stream_index":1}});
        let child =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
        (parent, child, root)
    }

    #[test]
    fn child_queue_limit_matches_existing_global_queue() {
        for limit in [1, 10000] {
            validate_limit(limit).unwrap();
        }
        for limit in [i64::MIN, -1, 0, 10001, i64::MAX] {
            assert!(validate_limit(limit).is_err());
        }
    }
    #[test]
    fn golden_child_uses_its_own_input_and_original_complete_root() {
        let (parent, child, root) = statements();
        root.require_parent_input(&parent).unwrap();
        child
            .require_child_of(&parent, root.root_digest(), root.selected_audio_statement())
            .unwrap();
        root.require_child_recapture(&root, &child).unwrap();
        let spec = ChildJobSpec::from_child_input(&child).unwrap();
        let json: Value =
            serde_json::from_slice(&spec.private_storage_plaintext().unwrap()).unwrap();
        assert_eq!(json["input_sha256"], child.input_sha256());
        assert_ne!(json["input_sha256"], parent.input_sha256());
        assert_eq!(json["root_digest"], root.root_digest());
        assert_eq!(json.as_object().unwrap().len(), 12);
        for field in [
            "url",
            "path",
            "root",
            "input_ticket",
            "argv",
            "delivery_token",
            "static_hls_fallback",
            "http_file_fallback",
        ] {
            assert!(json.get(field).is_none());
        }
    }
    #[test]
    fn forged_parent_or_root_does_not_become_an_authorized_child_statement() {
        let (parent, child, root) = statements();
        let mut value: Value = serde_json::from_slice(child.private_storage_plaintext()).unwrap();
        for field in ["auth_login_hash", "request_sha256"] {
            let original = value[field].clone();
            value[field] = json!("3".repeat(64));
            let changed =
                FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
            if field == "auth_login_hash" {
                assert!(
                    changed
                        .require_child_of(
                            &parent,
                            root.root_digest(),
                            root.selected_audio_statement()
                        )
                        .is_err()
                );
            } else {
                // A new child hash is structurally valid, but cannot replay the
                // same immutable job: the resulting input/spec changes.
                let spec = ChildJobSpec::from_child_input(&child).unwrap();
                assert!(spec.require_input_statement(&changed).is_err());
            }
            value[field] = original;
        }
        value["root"]["root_digest"] = json!("4".repeat(64));
        let changed =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(root.require_child_recapture(&root, &changed).is_err());
    }
    #[test]
    fn same_session_replay_requires_the_exact_immutable_child_job() {
        let (_, child, _) = statements();
        let spec = ChildJobSpec::from_child_input(&child).unwrap();
        let value: Value =
            serde_json::from_slice(&spec.private_storage_plaintext().unwrap()).unwrap();
        let session = uuid(&child.identity_statement().session_id).unwrap();
        let other = Uuid::new_v4();
        require_existing_job(
            session,
            Some(session),
            Some(LOGICAL_QUEUE),
            &value,
            session,
            &spec,
            &child,
        )
        .unwrap();
        for (id, bound, queue) in [
            (other, Some(session), Some(LOGICAL_QUEUE)),
            (session, Some(other), Some(LOGICAL_QUEUE)),
            (session, None, Some(LOGICAL_QUEUE)),
            (session, Some(session), None),
        ] {
            assert!(
                require_existing_job(id, bound, queue, &value, session, &spec, &child).is_err()
            );
        }
        for field in [
            "capture_id",
            "worker_instance",
            "input_sha256",
            "root_digest",
            "position_ms",
            "selected_audio",
        ] {
            let mut changed = value.clone();
            changed[field] = match field {
                "capture_id" | "worker_instance" => json!(other),
                "position_ms" => json!(1.0),
                "selected_audio" => json!({"kind":"single","stream_index":2}),
                _ => json!("7".repeat(64)),
            };
            assert!(
                require_existing_job(
                    session,
                    Some(session),
                    Some(LOGICAL_QUEUE),
                    &changed,
                    session,
                    &spec,
                    &child
                )
                .is_err()
            );
        }
        let mut generic = value.clone();
        generic["url"] = json!("https://untrusted.example/manifest.m3u8");
        assert!(
            require_existing_job(
                session,
                Some(session),
                Some(LOGICAL_QUEUE),
                &generic,
                session,
                &spec,
                &child
            )
            .is_err()
        );
    }
    #[test]
    fn complete_root_comparison_refuses_a_changed_unread_resource_target() {
        let (_, child, root) = statements();
        let mut value: Value = serde_json::from_slice(ROOT).unwrap();
        value["inventory"][2]["final_target_sha256"] = json!("7".repeat(64));
        let changed =
            RootGraphStatement::parse_private_plaintext(&serde_json::to_vec(&value).unwrap())
                .unwrap();
        assert!(root.require_child_recapture(&changed, &child).is_err());
    }
    #[test]
    fn queue_sql_preserves_old_guards_timing_and_exact_owner_fences() {
        assert!(INSERT.contains("static_hls_child_queue_authority_allowed($1)"));
        assert!(!INSERT.contains("ON CONFLICT"));
        assert!(INSERT.contains("1,0,clock_timestamp(),NULL,0,true,0,'static_hls_v1'"));
        for fence in [
            "r.status='completed'",
            "c.publication_phase='published_child'",
            "c.owner_id=$3",
            "c.input_sha256=$4",
            "c.root_digest=$6",
            "parent.state='disposed'",
            "parent.disposed_at IS NOT NULL",
            "retired.stopped",
            "reservation.bytes=134217728",
            "static_hls_child_queue_authority_allowed(p.id)",
        ] {
            assert!(EXACT_BINDING.contains(fence));
        }
        assert!(!EXACT_BINDING.contains("static_hls_published_parent_authority_allowed"));
        assert!(CAPACITY.contains("j.status IN ('queued','running')"));
    }
    #[test]
    fn prepared_child_job_has_no_ticket_serialization_or_clone() {
        trait AmbiguousSerialize<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousSerialize<()> for T {}
        impl<T: ?Sized + serde::Serialize> AmbiguousSerialize<u8> for T {}
        let _ = <PreparedChildJob<'_> as AmbiguousSerialize<_>>::check;
        trait AmbiguousClone<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousClone<()> for T {}
        impl<T: Clone> AmbiguousClone<u8> for T {}
        let _ = <PreparedChildJob<'_> as AmbiguousClone<_>>::check;
    }
}
