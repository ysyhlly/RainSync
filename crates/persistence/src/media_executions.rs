//! Durable evidence of resource ownership, separate from scheduling state.
//! Only the process owner may acknowledge after all local processes/sources are
//! released. Lost leases and dead owners deliberately leave evidence unknown.
use anyhow::Result;
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub async fn begin_delivery(
    pool: &PgPool,
    session: Uuid,
    token_hash: &str,
    owner: Uuid,
) -> Result<Option<Uuid>> {
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
    let inserted = sqlx::query("INSERT INTO media_executions(id,session_id,kind,owner_id) SELECT $1,p.id,'delivery',$2 FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id WHERE p.id=$3 AND p.delivery_token_hash=$4 AND p.lifecycle_epoch=$5 AND p.expires_at>clock_timestamp() AND NOT p.stopped AND playback_source_allowed(p.media_id,p.resource) AND (s.state->>'media_generation')::bigint=p.generation AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id)")
        .bind(id).bind(owner).bind(session).bind(token_hash).bind(row.get::<i64,_>("lifecycle_epoch"))
        .execute(&mut *tx).await?.rows_affected() == 1;
    tx.commit().await?;
    Ok(inserted.then_some(id))
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
