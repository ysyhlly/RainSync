//! Exact authenticated child-output read observations and delivery ownership.
//!
//! These values are comparison metadata only. They cannot construct a capture,
//! output directory, publication receipt or physical reader. The Worker must
//! obtain its SAME retained `PublishedChildOutput` and independently check it.
use anyhow::{Result, ensure};
use media_core::static_hls::{
    child_output_owner::OutputIdentity,
    contracts::{
        graph::RootGraphStatement,
        input::{FrozenInput, IdentityStatement, OperationKind},
    },
};
use serde::Deserialize;
use sqlx::{Connection, PgPool, Postgres, Row, Transaction, postgres::PgRow};
use std::{future::Future, time::Duration};
use tokio::time::Instant;
use uuid::Uuid;

const OBSERVATION_TIME: Duration = Duration::from_millis(750);

#[derive(Deserialize)]
struct ClockProjection {
    root_admitted_at_ms: u64,
    prepare_started_at_ms: u64,
}

/// No public fields, identity-only constructor, Debug or serializer. Reading
/// this authenticated immutable tuple still grants no original output owner.
pub struct PublishedChildRead {
    input: FrozenInput,
    parent: FrozenInput,
    root: RootGraphStatement,
    output: OutputIdentity,
    user: Uuid,
    worker: Uuid,
    input_ciphertext: String,
    parent_ciphertext: String,
    root_ciphertext: String,
    evidence_sha256: String,
}

impl PublishedChildRead {
    pub fn input(&self) -> &FrozenInput {
        &self.input
    }
    pub fn output_identity(&self) -> &OutputIdentity {
        &self.output
    }
    pub fn authenticated_user(&self) -> Uuid {
        self.user
    }
    pub fn actual_worker(&self) -> Uuid {
        self.worker
    }
}

/// Acquisition, all SQL statements, authenticated decryption, parsing and
/// COMMIT share one absolute budget. Cancellation closes the physical SQL
/// connection; a ready-but-late result cannot become an authorization grant.
pub fn load_published_child<'a>(
    pool: &'a PgPool,
    session: Uuid,
    token_hash: &'a str,
    actual_worker: Uuid,
    unseal: impl Fn(&str) -> Result<Vec<u8>> + Send + Sync + 'a,
) -> impl Future<Output = Result<Option<PublishedChildRead>>> + Send + 'a {
    let until = Instant::now() + OBSERVATION_TIME;
    async move {
        observe(until, async {
            require_hash(token_hash)?;
            ensure!(
                !actual_worker.is_nil(),
                "static_hls_original_worker_required"
            );
            let mut connection = pool.acquire().await?;
            connection.close_on_drop();
            let mut tx = connection.begin().await?;
            configure(&mut tx, actual_worker).await?;
            let row = read_row(&mut tx, session, token_hash, actual_worker).await?;
            let Some(row) = row else { return Ok(None) };
            let input_ciphertext: String = row.try_get("static_hls_input_encrypted")?;
            require_ciphertext(&input_ciphertext, 65_536)?;
            let input = FrozenInput::parse_private_plaintext(&unseal(&input_ciphertext)?)?;
            ensure!(
                input.kind() == OperationKind::Child,
                "static_hls_child_input_required"
            );
            input.require_identity_statement(&stored_identity(&row)?)?;
            require_clock(&input, &row)?;
            let parent_capture: Uuid = row.try_get("static_hls_parent_capture_id")?;
            let parent_session: Uuid = row.try_get("parent_session_id")?;
            let parent_row = sqlx::query(PARENT)
                .bind(parent_session)
                .bind(parent_capture)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| anyhow::anyhow!("static_hls_child_parent_required"))?;
            let parent_ciphertext: String = parent_row.try_get("static_hls_input_encrypted")?;
            require_ciphertext(&parent_ciphertext, 65_536)?;
            let parent = FrozenInput::parse_private_plaintext(&unseal(&parent_ciphertext)?)?;
            parent.require_identity_statement(&stored_identity(&parent_row)?)?;
            require_clock(&parent, &parent_row)?;
            let root_ciphertext: String = row.try_get("inventory_encrypted")?;
            require_ciphertext(&root_ciphertext, 262_144)?;
            let root = RootGraphStatement::parse_private_plaintext(&unseal(&root_ciphertext)?)?;
            root.require_parent_input(&parent)?;
            input.require_child_of(&parent, root.root_digest(), root.selected_audio_statement())?;
            ensure!(
                row.try_get::<String, _>("root_digest")? == root.root_digest()
                    && parent_row.try_get::<String, _>("root_digest")? == root.root_digest()
                    && parent_capture.to_string() == parent.identity_statement().operation_id
                    && parent_session.to_string() == parent.identity_statement().session_id,
                "static_hls_child_root_mismatch"
            );
            let output = OutputIdentity::new(
                row.try_get::<Uuid, _>("output_job_id")?.to_string(),
                row.try_get("output_attempt")?,
                row.try_get::<Uuid, _>("output_owner_id")?.to_string(),
            )?;
            let evidence_sha256: String = row.try_get("evidence_sha256")?;
            require_hash(&evidence_sha256)?;
            let loaded = PublishedChildRead {
                user: row.try_get("user_id")?,
                input,
                parent,
                root,
                output,
                worker: actual_worker,
                input_ciphertext,
                parent_ciphertext,
                root_ciphertext,
                evidence_sha256,
            };
            // Parsing cannot turn an earlier row into the final current grant.
            if !current_in(&mut tx, session, token_hash, &loaded).await? {
                return Ok(None);
            }
            tx.commit().await?;
            Ok(Some(loaded))
        })
        .await
    }
}

/// Repeat the full current exact child gate, without installing owner GUCs
/// from SQL rows or using retained publication facts as a public grant.
pub fn authorized<'a>(
    pool: &'a PgPool,
    session: Uuid,
    token_hash: &'a str,
    loaded: &'a PublishedChildRead,
) -> impl Future<Output = Result<bool>> + Send + 'a {
    let until = Instant::now() + OBSERVATION_TIME;
    async move {
        observe(until, async {
            let mut connection = pool.acquire().await?;
            connection.close_on_drop();
            let mut tx = connection.begin().await?;
            configure(&mut tx, loaded.worker).await?;
            let allowed = current_in(&mut tx, session, token_hash, loaded).await?;
            tx.commit().await?;
            Ok(allowed)
        })
        .await
    }
}

/// Same lifetime/receipt semantics as ordinary deliveries, with a child-only
/// exact admission predicate. No source/file/process I/O occurs under locks.
pub async fn begin_delivery(
    pool: &PgPool,
    session: Uuid,
    token_hash: &str,
    execution_id: Uuid,
    owner: Uuid,
    loaded: &PublishedChildRead,
) -> Result<Option<crate::media_executions::DeliveryAdmission>> {
    // Registration lives in the Worker's independent delivery owner. Do not
    // abandon a possibly committed INSERT merely because an HTTP waiter's
    // observation budget elapsed: a late positive COMMIT must still be ACKed.
    // Each statement is bounded; an unknown COMMIT retains the original owner.
    async {
        ensure!(!execution_id.is_nil() && !owner.is_nil(), "static_hls_child_delivery_owner_required");
        let mut connection = pool.acquire().await?;
        connection.close_on_drop();
        let mut tx = connection.begin().await?;
        configure(&mut tx, loaded.worker).await?;
        lock_delivery_attempt(&mut tx, execution_id).await?;
        let identity = loaded.input.identity_statement();
        if identity.session_id != session.to_string()
            || !crate::static_hls_child_claim::lock_authority(&mut tx, &identity, None).await?
        {
            return Ok(None);
        }
        // Match the original publication owner: captures, sessions, job,
        // output. An output cleanup can only precede admission or wait for it.
        sqlx::query("SELECT id FROM static_hls_captures WHERE id IN ($1,$2) ORDER BY id FOR SHARE")
            .bind(uuid(&identity.operation_id)?)
            .bind(uuid(&loaded.parent.identity_statement().operation_id)?)
            .fetch_all(&mut *tx).await?;
        sqlx::query("SELECT id FROM playback_sessions WHERE id IN ($1,$2) ORDER BY id FOR SHARE")
            .bind(session).bind(uuid(&loaded.parent.identity_statement().session_id)?)
            .fetch_all(&mut *tx).await?;
        sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR SHARE")
            .bind(session).fetch_optional(&mut *tx).await?;
        sqlx::query("SELECT job_id FROM media_outputs WHERE job_id=$1 AND attempt=$2 FOR SHARE")
            .bind(session).bind(loaded.output.attempt()).fetch_optional(&mut *tx).await?;
        if !current_in(&mut tx, session, token_hash, loaded).await? {
            return Ok(None);
        }
        configure_delivery(&mut tx, execution_id, owner).await?;
        let inserted = sqlx::query("INSERT INTO media_executions(id,session_id,kind,owner_id,metrics_entry_candidate) SELECT $1,p.id,'delivery',$2,false FROM playback_sessions p WHERE p.id=$3 AND p.delivery_token_hash=$4 AND static_hls_pending_reader_supported() AND static_hls_child_output_authority_allowed(p.id)")
            .bind(execution_id).bind(owner).bind(session).bind(token_hash)
            .execute(&mut *tx).await?.rows_affected();
        if inserted != 1 || !current_in(&mut tx, session, token_hash, loaded).await? {
            return Ok(None);
        }
        tx.commit().await?;
        Ok(Some(crate::media_executions::DeliveryAdmission {
            execution_id, first_output_entry: false,
        }))
    }.await
}

/// Positive source/scope drainage is supplied by the retained Worker delivery
/// owner. Revocation does not forbid acknowledging the SAME original receipt.
pub async fn acknowledge_delivery(
    pool: &PgPool,
    execution: Uuid,
    owner: Uuid,
    actual_worker: Uuid,
) -> Result<()> {
    complete_delivery(pool, execution, owner, actual_worker, false).await
}

/// Only the original Worker's unstarted registration operation calls this.
/// No source/read was opened. Its advisory lock waits for the SAME uncertain
/// INSERT transaction to end before ACKing it or positively proving absence.
/// A missing row observed without this serialization would be inconclusive.
pub async fn resolve_unstarted_delivery(
    pool: &PgPool,
    execution: Uuid,
    owner: Uuid,
    actual_worker: Uuid,
) -> Result<()> {
    complete_delivery(pool, execution, owner, actual_worker, true).await
}

async fn complete_delivery(
    pool: &PgPool,
    execution: Uuid,
    owner: Uuid,
    actual_worker: Uuid,
    unstarted_registration: bool,
) -> Result<()> {
    let until = Instant::now() + OBSERVATION_TIME;
    observe(until, async {
        let mut connection = pool.acquire().await?;
        connection.close_on_drop();
        let mut tx = connection.begin().await?;
        configure(&mut tx, actual_worker).await?;
        lock_delivery_attempt(&mut tx, execution).await?;
        configure_delivery(&mut tx, execution, owner).await?;
        let changed = sqlx::query("UPDATE media_executions e SET reaped_at=COALESCE(e.reaped_at,clock_timestamp()) WHERE e.id=$1 AND e.owner_id=$2 AND e.kind='delivery' AND e.job_id IS NULL AND e.attempt IS NULL AND static_hls_is_child_session(e.session_id)")
            .bind(execution).bind(owner).execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            ensure!(unstarted_registration, "delivery_disposal_ack_unconfirmed");
            let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_executions WHERE id=$1)")
                .bind(execution).fetch_one(&mut *tx).await?;
            ensure!(!exists, "delivery_disposal_ack_unconfirmed");
        }
        tx.commit().await?;
        Ok(())
    }).await
}

async fn current_in(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    token_hash: &str,
    loaded: &PublishedChildRead,
) -> Result<bool> {
    require_hash(token_hash)?;
    if loaded.input.identity_statement().session_id != session.to_string() {
        return Ok(false);
    }
    let Some(row) = read_row(tx, session, token_hash, loaded.worker).await? else {
        return Ok(false);
    };
    loaded
        .input
        .require_identity_statement(&stored_identity(&row)?)?;
    require_clock(&loaded.input, &row)?;
    let parent = loaded.parent.identity_statement();
    Ok(row.try_get::<Uuid, _>("user_id")? == loaded.user
        && row.try_get::<String, _>("static_hls_input_encrypted")? == loaded.input_ciphertext
        && row.try_get::<String, _>("parent_input_encrypted")? == loaded.parent_ciphertext
        && row.try_get::<String, _>("inventory_encrypted")? == loaded.root_ciphertext
        && row.try_get::<String, _>("root_digest")? == loaded.root.root_digest()
        && row
            .try_get::<Uuid, _>("static_hls_parent_capture_id")?
            .to_string()
            == parent.operation_id
        && row.try_get::<Uuid, _>("parent_session_id")?.to_string() == parent.session_id
        && row.try_get::<String, _>("parent_input_sha256")? == loaded.parent.input_sha256()
        && row.try_get::<Uuid, _>("output_job_id")?.to_string() == loaded.output.job_id()
        && row.try_get::<i64, _>("output_attempt")? == loaded.output.attempt()
        && row.try_get::<Uuid, _>("output_owner_id")?.to_string() == loaded.output.owner_id()
        && row.try_get::<String, _>("evidence_sha256")? == loaded.evidence_sha256)
}

async fn read_row(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    token_hash: &str,
    worker: Uuid,
) -> Result<Option<PgRow>> {
    Ok(sqlx::query(READ)
        .bind(session)
        .bind(token_hash)
        .bind(worker)
        .fetch_optional(&mut **tx)
        .await?)
}

async fn configure(tx: &mut Transaction<'_, Postgres>, actual_worker: Uuid) -> Result<()> {
    ensure!(
        !actual_worker.is_nil(),
        "static_hls_original_worker_required"
    );
    crate::static_hls_pending::fence(tx).await?;
    sqlx::query("SELECT set_config('rainsync.static_hls_child_reader','original_published_child_v1',true),set_config('rainsync.static_hls_worker_instance',$1,true)")
        .bind(actual_worker.to_string()).execute(&mut **tx).await?;
    sqlx::query("SET LOCAL statement_timeout='750ms'")
        .execute(&mut **tx)
        .await?;
    sqlx::query("SET LOCAL lock_timeout='750ms'")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn lock_delivery_attempt(tx: &mut Transaction<'_, Postgres>, execution: Uuid) -> Result<()> {
    ensure!(
        !execution.is_nil(),
        "static_hls_child_delivery_owner_required"
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("rainsync-static-hls-child-delivery:{execution}"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn configure_delivery(
    tx: &mut Transaction<'_, Postgres>,
    execution: Uuid,
    owner: Uuid,
) -> Result<()> {
    ensure!(
        !execution.is_nil() && !owner.is_nil(),
        "static_hls_child_delivery_owner_required"
    );
    sqlx::query("SELECT set_config('rainsync.static_hls_child_delivery_execution',$1,true),set_config('rainsync.static_hls_child_delivery_owner',$2,true)")
        .bind(execution.to_string()).bind(owner.to_string()).execute(&mut **tx).await?;
    Ok(())
}

async fn observe<T>(until: Instant, future: impl Future<Output = Result<T>>) -> Result<T> {
    ensure!(
        Instant::now() < until,
        "static_hls_child_read_authority_unknown"
    );
    let result = tokio::time::timeout_at(until, future)
        .await
        .map_err(|_| anyhow::anyhow!("static_hls_child_read_authority_unknown"))?;
    ensure!(
        Instant::now() < until,
        "static_hls_child_read_authority_unknown"
    );
    result
}

fn require_ciphertext(ciphertext: &str, maximum: usize) -> Result<()> {
    ensure!(
        !ciphertext.is_empty() && ciphertext.len() <= maximum,
        "static_hls_child_read_ciphertext_bounds"
    );
    Ok(())
}
fn require_hash(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "static_hls_child_read_hash_required"
    );
    Ok(())
}
fn uuid(value: &str) -> Result<Uuid> {
    Ok(Uuid::parse_str(value)?)
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

fn require_clock(input: &FrozenInput, row: &PgRow) -> Result<()> {
    let clock: ClockProjection = serde_json::from_slice(input.private_storage_plaintext())?;
    ensure!(
        input.root_deadline_ms() == u64::try_from(row.try_get::<i64, _>("root_until_ms")?)?
            && input.preparation_deadline_ms()
                == u64::try_from(row.try_get::<i64, _>("prepare_until_ms")?)?
            && clock.prepare_started_at_ms == u64::try_from(row.try_get::<i64, _>("created_ms")?)?
            && (input.kind() != OperationKind::Parent
                || clock.root_admitted_at_ms == clock.prepare_started_at_ms),
        "static_hls_child_read_clock_mismatch"
    );
    Ok(())
}

const READ: &str = r#"
SELECT r.*,c.inventory_encrypted,c.root_digest,parent.session_id AS parent_session_id,
 original.static_hls_input_encrypted AS parent_input_encrypted,
 original.static_hls_input_sha256 AS parent_input_sha256,
 proof.job_id AS output_job_id,proof.attempt AS output_attempt,
 proof.owner_id AS output_owner_id,proof.evidence_sha256,
 floor(extract(epoch FROM r.created_at)*1000)::bigint AS created_ms,
 floor(extract(epoch FROM r.static_hls_root_expires_at)*1000)::bigint AS root_until_ms,
 floor(extract(epoch FROM r.static_hls_prepare_expires_at)*1000)::bigint AS prepare_until_ms
FROM playback_requests r JOIN playback_sessions p ON p.id=r.session_id
 JOIN static_hls_captures c ON c.id=r.static_hls_operation_id AND c.id=p.static_hls_capture_id AND c.session_id=p.id
 JOIN static_hls_captures parent ON parent.id=r.static_hls_parent_capture_id
 JOIN playback_requests original ON original.session_id=parent.session_id
 JOIN media_jobs j ON j.id=p.id AND j.session_id=p.id
 JOIN static_hls_child_output_publications proof ON proof.job_id=j.id AND proof.attempt=j.attempt AND proof.owner_id=j.owner_id
 JOIN static_hls_database_binding db ON db.singleton
WHERE p.id=$1 AND p.delivery_token_hash=$2
 AND r.static_hls_input_version=1 AND r.static_hls_worker_instance=$3 AND c.worker_instance=$3
 AND original.static_hls_worker_instance=$3 AND parent.worker_instance=$3
 AND r.static_hls_database_id=db.id AND c.database_id=db.id AND parent.database_id=db.id
 AND c.publication_phase='published_child' AND proof.capture_id=c.id
 AND proof.input_sha256=r.static_hls_input_sha256 AND proof.root_digest=c.root_digest
 AND static_hls_pending_reader_supported()
 AND static_hls_child_output_publication_matches(j.id)
 AND static_hls_child_output_input_disposed(j.id)
 AND static_hls_child_grant_authority_allowed(p.id)
 AND static_hls_child_output_authority_allowed(p.id)
 AND NOT EXISTS(SELECT 1 FROM static_hls_child_output_disposals WHERE job_id=j.id)
"#;

const PARENT: &str = r#"
SELECT r.*,c.root_digest,
 floor(extract(epoch FROM r.created_at)*1000)::bigint AS created_ms,
 floor(extract(epoch FROM r.static_hls_root_expires_at)*1000)::bigint AS root_until_ms,
 floor(extract(epoch FROM r.static_hls_prepare_expires_at)*1000)::bigint AS prepare_until_ms
FROM playback_requests r JOIN static_hls_captures c ON c.session_id=r.session_id
WHERE r.session_id=$1 AND r.static_hls_operation_id=$2 AND c.id=$2
 AND r.static_hls_input_version=1 AND r.static_hls_parent_capture_id IS NULL
 AND c.publication_phase='published_parent'
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_hash_and_ciphertext_bounds_are_closed() {
        assert!(require_hash(&"a".repeat(64)).is_ok());
        for value in [
            "A".repeat(64),
            "a".repeat(63),
            "g".repeat(64),
            "0".repeat(65),
        ] {
            assert!(require_hash(&value).is_err());
        }
        assert!(require_ciphertext("", 64).is_err());
        assert!(require_ciphertext(&"x".repeat(65), 64).is_err());
        assert!(require_ciphertext(&"x".repeat(64), 64).is_ok());
    }

    #[tokio::test]
    async fn ready_but_late_observation_cannot_grant_authority() {
        assert!(observe(Instant::now(), async { Ok(true) }).await.is_err());
    }

    #[test]
    fn read_sql_is_child_specific_and_has_no_original_owner_reconstruction() {
        assert!(READ.contains("static_hls_child_output_publication_matches"));
        assert!(READ.contains("static_hls_child_output_input_disposed"));
        assert!(READ.contains("static_hls_child_grant_authority_allowed"));
        assert!(READ.contains("static_hls_child_output_authority_allowed"));
        assert!(!READ.contains("static_hls_published_parent_authority_allowed"));
        assert!(!READ.contains("set_config"));
        assert!(!READ.contains("relative_dir"));
    }
}
