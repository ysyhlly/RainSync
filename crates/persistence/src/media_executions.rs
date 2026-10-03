//! Durable evidence of resource ownership, separate from scheduling state.
//! Only the process owner may acknowledge after all local processes/sources are
//! released. Lost leases and dead owners deliberately leave evidence unknown.
use anyhow::Result;
use sqlx::{Acquire, PgPool, Row};
use uuid::Uuid;

pub struct DeliveryAdmission {
    pub execution_id: Uuid,
    /// First eligible index admission only; missing/failed observation is false.
    pub first_output_entry: bool,
}

pub async fn begin_delivery(
    pool: &PgPool,
    session: Uuid,
    token_hash: &str,
    owner: Uuid,
    entry_candidate: bool,
) -> Result<Option<DeliveryAdmission>> {
    let mut tx = pool.begin().await?;
    let room: Option<Uuid> =
        sqlx::query_scalar("SELECT room_id FROM playback_sessions WHERE id=$1")
            .bind(session)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    let Some(room) = room else { return Ok(None) };
    // Share the lifecycle admission lock with close, then recheck the grant.
    let row =
        sqlx::query("SELECT lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
            .bind(room)
            .fetch_one(&mut *tx)
            .await?;
    if row.get::<String, _>("lifecycle") != "active" {
        return Ok(None);
    }
    if !crate::source_account_policy::lock_session(&mut tx, session).await? {
        return Ok(None);
    }
    let id = Uuid::new_v4();
    let inserted = sqlx::query("INSERT INTO media_executions(id,session_id,kind,owner_id,metrics_entry_candidate) SELECT $1,p.id,'delivery',$2,($6 AND COALESCE(p.playback_metrics_version=2,false)) FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id WHERE p.id=$3 AND p.delivery_token_hash=$4 AND p.lifecycle_epoch=$5 AND p.expires_at>clock_timestamp() AND NOT p.stopped AND playback_source_allowed(p.media_id,p.resource) AND (s.state->>'media_generation')::bigint=p.generation AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id)")
        .bind(id).bind(owner).bind(session).bind(token_hash).bind(row.get::<i64,_>("lifecycle_epoch")).bind(entry_candidate)
        .execute(&mut *tx).await?.rows_affected() == 1;
    // The mandatory receipt already exists before this optional lookup. Even
    // if the lookup fails, it consumes eligibility for all later admissions.
    // Roll back the read-only savepoint on both paths to restore its timeout.
    let first_output_entry = if inserted && entry_candidate {
        let mut observation = tx.begin().await?;
        let first = async {
            sqlx::query("SET LOCAL statement_timeout='100ms'").execute(&mut *observation).await?;
            sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM media_executions own WHERE own.id=$1 AND own.metrics_entry_candidate=true) AND NOT EXISTS(SELECT 1 FROM media_executions prior WHERE prior.session_id=$2 AND prior.kind='delivery' AND prior.id<>$1 AND prior.metrics_entry_candidate IS DISTINCT FROM false)")
                .bind(id).bind(session).fetch_one(&mut *observation).await
        }.await.unwrap_or(false);
        observation.rollback().await?;
        first
    } else {
        false
    };
    tx.commit().await?;
    Ok(inserted.then_some(DeliveryAdmission {
        execution_id: id,
        first_output_entry,
    }))
}

/// Caller must have a positive drain result; database retries are idempotent.
pub async fn acknowledge(pool: &PgPool, id: Uuid, owner: Uuid) -> Result<()> {
    sqlx::query("UPDATE media_executions SET reaped_at=COALESCE(reaped_at,clock_timestamp()) WHERE id=$1 AND owner_id=$2")
        .bind(id).bind(owner).execute(pool).await?;
    Ok(())
}

/// Queue owner calls this only after both encoder and validation children reap.
pub async fn acknowledge_job(pool: &PgPool, job: Uuid, attempt: i64, owner: Uuid) -> Result<()> {
    sqlx::query("UPDATE media_executions SET reaped_at=COALESCE(reaped_at,clock_timestamp()) WHERE job_id=$1 AND attempt=$2 AND owner_id=$3")
        .bind(job).bind(attempt).bind(owner).execute(pool).await?;
    Ok(())
}
