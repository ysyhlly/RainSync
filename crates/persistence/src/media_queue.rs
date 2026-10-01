use serde_json::Value;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// Capacity covers queued and running work with a live playback grant.
/// The transaction lock is retained through the caller's session/plan commit.
pub async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    spec: &Value,
    limit: i64,
) -> Result<bool, sqlx::Error> {
    if !(1..=10000).contains(&limit) {
        return Err(sqlx::Error::Protocol("invalid_queue_limit".into()));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(72614932)")
        .execute(&mut **tx)
        .await?;
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id WHERE j.status IN ('queued','running') AND NOT p.stopped AND p.expires_at>clock_timestamp()")
        .fetch_one(&mut **tx).await?;
    if active >= limit {
        return Ok(false);
    }
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec,timing_version,timing_attempt,queue_entered_at,run_started_at) VALUES($1,$1,'queued',$2,1,0,clock_timestamp(),NULL)")
        .bind(session)
        .bind(spec)
        .execute(&mut **tx)
        .await?;
    Ok(true)
}
