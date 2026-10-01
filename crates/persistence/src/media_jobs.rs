use crate::media_job_timing::{
    AGGREGATE_SQL, CancellationScope, OLD_PHASE_SQL, OWNED_TICK_SQL, SINGLE_PHASE_SQL, cancel_jobs,
    count, record_aggregate, record_single,
};
use anyhow::Result;
use media_core::job_health::{
    LeaseExpiryResult, PendingJobHealth, RetryReason, TimingKind, begin_mutation_observation,
};
use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
pub enum JobFailure {
    CacheCapacityExceeded,
    CacheReadOnly,
    CachePermissionDenied,
    ExecutionFailed,
    InputInvalid,
    InputDenied,
    DecoderUnavailable,
    EncoderUnavailable,
    UpstreamTransient,
    SourceChanged,
    SourceVersionRequired,
    SourceSeekUnsupported,
}
impl JobFailure {
    pub fn reason(self) -> &'static str {
        match self {
            Self::CacheCapacityExceeded => "cache_capacity_exceeded",
            Self::CacheReadOnly => "cache_read_only",
            Self::CachePermissionDenied => "cache_permission_denied",
            Self::ExecutionFailed => "media_job_failed",
            Self::InputInvalid => "media_input_invalid",
            Self::InputDenied => "media_input_denied",
            Self::DecoderUnavailable => "media_decoder_unavailable",
            Self::EncoderUnavailable => "media_encoder_unavailable",
            Self::UpstreamTransient => "upstream_transport_failed",
            Self::SourceChanged => "source_changed",
            Self::SourceVersionRequired => "source_version_required",
            Self::SourceSeekUnsupported => "source_seek_unsupported",
        }
    }
}
impl std::fmt::Display for JobFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason())
    }
}
impl std::error::Error for JobFailure {}

/// Stored task errors are untrusted diagnostic text, never an arbitrary public code.
pub fn terminal_error(reason: Option<&str>) -> (u16, &'static str) {
    match reason {
        Some("source_changed") => (409, "source_changed"),
        Some("cache_capacity_exceeded") => (503, "cache_capacity_exceeded"),
        Some("cache_read_only") => (503, "cache_read_only"),
        Some("cache_permission_denied") => (503, "cache_permission_denied"),
        Some("source_version_required") => (409, "source_version_required"),
        Some("source_seek_unsupported") => (422, "source_seek_unsupported"),
        Some("media_input_invalid") => (422, "media_input_invalid"),
        Some("media_input_denied") => (502, "media_input_denied"),
        Some("media_decoder_unavailable") => (422, "media_decoder_unavailable"),
        Some("media_encoder_unavailable") => (503, "media_encoder_unavailable"),
        Some("upstream_transport_retry_exhausted" | "media_job_retry_exhausted") => {
            (502, "media_job_retry_exhausted")
        }
        _ => (502, "media_job_failed"),
    }
}

pub struct Claim {
    pub id: Uuid,
    pub owner: Uuid,
    pub attempt: i64,
    pub spec: Value,
}

pub struct Publication {
    pub manifest_sha256: String,
    pub segment_count: i32,
}

pub async fn claim(pool: &PgPool, owner: Uuid) -> Result<Option<Claim>> {
    // Normalize abandoned work before claiming. Cancellation wins over retry
    // exhaustion; changing running to queued schedules backoff exactly once.
    let observation = begin_mutation_observation();
    let delta = cancel_jobs(pool, CancellationScope::StoppedOrExpiredSessions).await?;
    observation.confirmed(delta);

    // Drain locked before sampling a single authority clock. Each independent
    // normalization keeps its own standalone acknowledgement and bounded delta.
    let observation = begin_mutation_observation();
    let query = format!(
        r#"/* media_job_exhausted */
WITH locked AS MATERIALIZED (
    SELECT j.id,j.status AS old_status,j.attempt AS old_attempt,
        j.timing_version,j.timing_attempt,j.queue_entered_at,j.run_started_at
    FROM media_jobs j WHERE j.attempt>=j.max_attempts
        AND (j.status='queued' OR (j.status='running' AND j.lease_until<=clock_timestamp()))
    ORDER BY j.id FOR UPDATE OF j
), tick AS MATERIALIZED (
    SELECT CASE WHEN count(*)>=0 THEN clock_timestamp() END AS ended_at FROM locked
), changed AS (
    UPDATE media_jobs j SET status='failed',error='media_job_retry_exhausted',
        owner_id=NULL,lease_until=NULL,timing_version=NULL,timing_attempt=NULL,
        queue_entered_at=NULL,run_started_at=NULL
    FROM locked l CROSS JOIN tick t WHERE j.id=l.id AND j.attempt>=j.max_attempts
        AND (j.status='queued' OR (j.status='running' AND j.lease_until<=clock_timestamp()))
    RETURNING l.old_status,l.old_attempt,l.timing_version,l.timing_attempt,
        l.queue_entered_at,l.run_started_at,t.ended_at
){AGGREGATE_SQL}"#
    );
    let row = sqlx::query(&query).fetch_one(pool).await?;
    let mut delta = PendingJobHealth::default();
    match count(&row, "run_total") {
        Some(rows) => delta.lease_expiry_normalized(LeaseExpiryResult::Exhausted, rows),
        None => delta.mark_incomplete(),
    }
    record_aggregate(&mut delta, &row, "queue", TimingKind::QueueFailed);
    record_aggregate(&mut delta, &row, "run", TimingKind::RunFailed);
    observation.confirmed(delta);

    let observation = begin_mutation_observation();
    let query = format!(
        r#"/* media_job_lease_retry */
WITH locked AS MATERIALIZED (
    SELECT j.id,j.status AS old_status,j.attempt AS old_attempt,
        j.timing_version,j.timing_attempt,j.queue_entered_at,j.run_started_at
    FROM media_jobs j WHERE j.status='running' AND j.lease_until<=clock_timestamp()
        AND j.attempt<j.max_attempts ORDER BY j.id FOR UPDATE OF j
), tick AS MATERIALIZED (
    SELECT CASE WHEN count(*)>=0 THEN clock_timestamp() END AS ended_at FROM locked
), changed AS (
    UPDATE media_jobs j SET status='queued',error='worker_lease_expired',
        owner_id=NULL,lease_until=NULL,
        available_at=clock_timestamp()+((CASE WHEN j.attempt=1 THEN 2 ELSE 5 END)+random())*interval '1 second',
        timing_version=1,timing_attempt=j.attempt,queue_entered_at=t.ended_at,run_started_at=NULL
    FROM locked l CROSS JOIN tick t WHERE j.id=l.id AND j.status='running'
        AND j.lease_until<=clock_timestamp() AND j.attempt<j.max_attempts
    RETURNING l.old_status,l.old_attempt,l.timing_version,l.timing_attempt,
        l.queue_entered_at,l.run_started_at,t.ended_at
){AGGREGATE_SQL}"#
    );
    let row = sqlx::query(&query).fetch_one(pool).await?;
    let mut delta = PendingJobHealth::default();
    match count(&row, "updated_count") {
        Some(rows) => {
            delta.retry_scheduled(RetryReason::LeaseExpired, rows);
            delta.lease_expiry_normalized(LeaseExpiryResult::Requeued, rows);
        }
        None => delta.mark_incomplete(),
    }
    record_aggregate(&mut delta, &row, "run", TimingKind::RunRetry);
    observation.confirmed(delta);
    sqlx::query("UPDATE media_outputs o SET status='abandoned' FROM media_jobs j WHERE o.job_id=j.id AND o.status='writing' AND (o.attempt<>j.attempt OR j.status<>'running')").execute(pool).await?;
    let mut tx = pool.begin().await?;
    // Serialize only the short scheduling decision. A committed turn survives
    // worker restarts; failed claims roll back both the job and its user's turn.
    sqlx::query("SELECT pg_advisory_xact_lock(72614933)")
        .execute(&mut *tx)
        .await?;
    let query = format!(
        r#"WITH locked AS MATERIALIZED (
    SELECT {OLD_PHASE_SQL}
    FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id
    LEFT JOIN media_queue_turns turn ON turn.user_id IS NOT DISTINCT FROM p.user_id
    WHERE j.status='queued' AND j.attempt<j.max_attempts
        AND j.available_at<=clock_timestamp() AND NOT p.stopped AND p.expires_at>clock_timestamp()
    ORDER BY turn.last_turn NULLS FIRST,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
), tick AS MATERIALIZED (
    SELECT CASE WHEN count(*)>=0 THEN clock_timestamp() END AS ended_at FROM locked
)
UPDATE media_jobs claimed SET status='running',owner_id=$1,attempt=claimed.attempt+1,
    lease_until=clock_timestamp()+interval '30 seconds',timing_version=1,
    timing_attempt=claimed.attempt+1,queue_entered_at=NULL,run_started_at=t.ended_at
FROM locked l CROSS JOIN tick t,playback_sessions session
WHERE claimed.id=l.id AND session.id=claimed.session_id AND claimed.status='queued'
    AND claimed.attempt<claimed.max_attempts AND claimed.available_at<=clock_timestamp()
    AND NOT session.stopped AND session.expires_at>clock_timestamp()
RETURNING claimed.id,claimed.spec,claimed.attempt,session.user_id,
    {SINGLE_PHASE_SQL}"#
    );
    let row = sqlx::query(&query)
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await?;
    let mut delta = PendingJobHealth::default();
    if let Some(row) = &row {
        record_single(&mut delta, row, "queue_seconds", TimingKind::QueueStarted);
    }
    if let Some(row) = &row {
        sqlx::query("INSERT INTO media_queue_turns(user_id,last_turn) VALUES($1,nextval('media_queue_turn_seq')) ON CONFLICT(user_id) DO UPDATE SET last_turn=EXCLUDED.last_turn")
            .bind(row.get::<Option<Uuid>, _>("user_id")).execute(&mut *tx).await?;
    }
    let claim = row.map(|row| Claim {
        id: row.get("id"),
        owner,
        attempt: row.get("attempt"),
        spec: row.get("spec"),
    });
    if let Some(claim) = &claim {
        sqlx::query("INSERT INTO media_outputs(job_id,attempt,owner_id,status,relative_dir) VALUES($1,$2,$3,'writing',$4)")
            .bind(claim.id).bind(claim.attempt).bind(owner).bind(format!("{}/{}",claim.id,claim.attempt)).execute(&mut *tx).await?;
        // Scheduling state may be cancelled/reclaimed while the old owner is
        // still alive. Keep one independent drain receipt for every attempt.
        sqlx::query("INSERT INTO media_executions(id,session_id,kind,job_id,attempt,owner_id) SELECT gen_random_uuid(),session_id,'job',id,attempt,owner_id FROM media_jobs WHERE id=$1")
            .bind(claim.id).execute(&mut *tx).await?;
    }
    let observation = delta.into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
    Ok(claim)
}

pub async fn renew(pool: &PgPool, claim: &Claim) -> Result<bool> {
    Ok(renew_remaining(pool, claim).await?.is_some())
}

/// None is a confirmed failed fence; an error is an unknown database result.
/// The caller must subtract the complete request round trip from this database
/// measured remainder before using it as a local execution deadline.
pub async fn renew_remaining(pool: &PgPool, claim: &Claim) -> Result<Option<std::time::Duration>> {
    let mut tx = pool.begin().await?;
    let owned = sqlx::query("SELECT id FROM media_jobs WHERE id=$1 AND owner_id=$2 AND attempt=$3 AND status='running' FOR UPDATE")
        .bind(claim.id).bind(claim.owner).bind(claim.attempt).fetch_optional(&mut *tx).await?;
    if owned.is_none() {
        tx.rollback().await?;
        return Ok(None);
    }
    // Recheck the live lease/session after acquiring the row lock. A query
    // delayed by a lock must never revive an execution whose lease expired.
    let remaining: Option<f64> = sqlx::query_scalar("UPDATE media_jobs j SET lease_until=clock_timestamp()+interval '30 seconds' FROM playback_sessions p WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running' AND j.lease_until>clock_timestamp() AND p.id=j.session_id AND NOT p.stopped AND p.expires_at>clock_timestamp() RETURNING extract(epoch FROM j.lease_until-clock_timestamp())::float8")
        .bind(claim.id).bind(claim.owner).bind(claim.attempt).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    remaining
        .map(std::time::Duration::try_from_secs_f64)
        .transpose()
        .map_err(Into::into)
}

pub async fn finish(
    pool: &PgPool,
    claim: &Claim,
    failure: Option<JobFailure>,
    publication: Option<&Publication>,
) -> Result<bool> {
    if failure.is_none() {
        let proof = publication.ok_or_else(|| anyhow::anyhow!("publication_required"))?;
        anyhow::ensure!(
            proof.segment_count > 0
                && proof.manifest_sha256.len() == 64
                && proof
                    .manifest_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid_publication"
        );
    }
    let mut tx = pool.begin().await?;
    let retryable = matches!(failure, Some(JobFailure::UpstreamTransient));
    let query = format!(
        "SELECT {OLD_PHASE_SQL} FROM media_jobs j WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running' FOR UPDATE OF j"
    );
    let old = sqlx::query(&query)
        .bind(claim.id)
        .bind(claim.owner)
        .bind(claim.attempt)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(_old) = old else {
        tx.rollback().await?;
        return Ok(false);
    };
    // The output participates in the same legacy publication transaction.
    // Acquire its lock before the authority tick and final live fence.
    let output = sqlx::query("SELECT job_id FROM media_outputs WHERE job_id=$1 AND attempt=$2 AND owner_id=$3 AND status='writing' AND (validation_version<2 OR $4) FOR UPDATE")
        .bind(claim.id).bind(claim.attempt).bind(claim.owner).bind(failure.is_some())
        .fetch_optional(&mut *tx).await?;
    if output.is_none() {
        tx.rollback().await?;
        return Ok(false);
    }
    let query = format!(
        r#"{OWNED_TICK_SQL}
UPDATE media_jobs j SET
    status=CASE WHEN $6 AND j.attempt<j.max_attempts THEN 'queued' ELSE $4 END,
    error=CASE WHEN $6 AND j.attempt>=j.max_attempts THEN 'upstream_transport_retry_exhausted' ELSE $5 END,
    available_at=CASE WHEN $6 THEN clock_timestamp()+((CASE WHEN j.attempt=1 THEN 2 ELSE 5 END)+random())*interval '1 second' ELSE j.available_at END,
    owner_id=CASE WHEN $6 THEN NULL ELSE j.owner_id END,lease_until=NULL,
    timing_version=CASE WHEN $6 AND j.attempt<j.max_attempts THEN 1 ELSE NULL END,
    timing_attempt=CASE WHEN $6 AND j.attempt<j.max_attempts THEN j.attempt ELSE NULL END,
    queue_entered_at=CASE WHEN $6 AND j.attempt<j.max_attempts THEN t.ended_at ELSE NULL END,
    run_started_at=NULL
FROM locked l CROSS JOIN tick t,playback_sessions p
WHERE j.id=l.id AND j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running'
    AND j.lease_until>clock_timestamp() AND p.id=j.session_id
    AND NOT p.stopped AND p.expires_at>clock_timestamp()
RETURNING j.status,{SINGLE_PHASE_SQL}"#
    );
    let ended = sqlx::query(&query)
        .bind(claim.id)
        .bind(claim.owner)
        .bind(claim.attempt)
        .bind(if failure.is_none() {
            "succeeded"
        } else {
            "failed"
        })
        .bind(failure.map(JobFailure::reason))
        .bind(retryable)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(ended) = ended else {
        tx.rollback().await?;
        return Ok(false);
    };
    let status: String = ended.get("status");
    let updated = sqlx::query("UPDATE media_outputs SET status=$4,manifest_sha256=$5,segment_count=$6,published_at=CASE WHEN $4='published' THEN clock_timestamp() ELSE NULL END WHERE job_id=$1 AND attempt=$2 AND owner_id=$3 AND status='writing' AND (validation_version<2 OR $4<>'published')")
        .bind(claim.id).bind(claim.attempt).bind(claim.owner)
        .bind(if failure.is_none() { "published" } else if retryable { "abandoned" } else { "failed" })
        .bind(publication.map(|p| p.manifest_sha256.as_str())).bind(publication.map(|p| p.segment_count))
        .execute(&mut *tx).await?.rows_affected();
    if updated != 1 {
        tx.rollback().await?;
        return Ok(false);
    }
    let mut delta = PendingJobHealth::default();
    let kind = match status.as_str() {
        "queued" => {
            delta.retry_scheduled(RetryReason::UpstreamTransport, 1);
            TimingKind::RunRetry
        }
        "succeeded" => TimingKind::RunSucceeded,
        _ => TimingKind::RunFailed,
    };
    record_single(&mut delta, &ended, "run_seconds", kind);
    let observation = delta.into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
    Ok(true)
}

/// Called only after the execution's child has stopped and been reaped.
pub async fn release(pool: &PgPool, claim: &Claim) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let query = format!(
        "SELECT {OLD_PHASE_SQL} FROM media_jobs j WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running' FOR UPDATE OF j"
    );
    let old = sqlx::query(&query)
        .bind(claim.id)
        .bind(claim.owner)
        .bind(claim.attempt)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(_old) = old else {
        tx.rollback().await?;
        return Ok(false);
    };
    sqlx::query("SELECT job_id FROM media_outputs WHERE job_id=$1 AND attempt=$2 AND owner_id=$3 AND status='writing' FOR UPDATE")
        .bind(claim.id).bind(claim.attempt).bind(claim.owner).fetch_optional(&mut *tx).await?;
    let query = format!(
        r#"{OWNED_TICK_SQL}
UPDATE media_jobs j SET status=CASE WHEN j.attempt>=j.max_attempts THEN 'failed' ELSE 'queued' END,
    error=CASE WHEN j.attempt>=j.max_attempts THEN 'media_job_retry_exhausted' ELSE 'worker_shutdown' END,
    available_at=clock_timestamp(),owner_id=NULL,lease_until=NULL,
    timing_version=CASE WHEN j.attempt<j.max_attempts THEN 1 ELSE NULL END,
    timing_attempt=CASE WHEN j.attempt<j.max_attempts THEN j.attempt ELSE NULL END,
    queue_entered_at=CASE WHEN j.attempt<j.max_attempts THEN t.ended_at ELSE NULL END,run_started_at=NULL
FROM locked l CROSS JOIN tick t,playback_sessions p
WHERE j.id=l.id AND j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running'
    AND j.lease_until>clock_timestamp() AND p.id=j.session_id
    AND NOT p.stopped AND p.expires_at>clock_timestamp()
RETURNING j.status,{SINGLE_PHASE_SQL}"#
    );
    let ended = sqlx::query(&query)
        .bind(claim.id)
        .bind(claim.owner)
        .bind(claim.attempt)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(ended) = ended else {
        tx.rollback().await?;
        return Ok(false);
    };
    let status: String = ended.get("status");
    sqlx::query("UPDATE media_outputs SET status='abandoned' WHERE job_id=$1 AND attempt=$2 AND owner_id=$3 AND status='writing'")
        .bind(claim.id).bind(claim.attempt).bind(claim.owner).execute(&mut *tx).await?;
    let mut delta = PendingJobHealth::default();
    let kind = if status == "queued" {
        delta.retry_scheduled(RetryReason::WorkerShutdown, 1);
        TimingKind::RunRetry
    } else {
        TimingKind::RunFailed
    };
    record_single(&mut delta, &ended, "run_seconds", kind);
    let observation = delta.into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
    Ok(true)
}

/// Legacy completed jobs use the old directory; every new claim is isolated.
pub fn output_dir(root: &std::path::Path, id: Uuid, attempt: i64) -> std::path::PathBuf {
    let job = root.join(id.to_string());
    if attempt == 0 {
        job
    } else {
        job.join(attempt.to_string())
    }
}
