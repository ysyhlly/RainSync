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
    enqueue_queue(tx, session, spec, limit, false).await
}

/// Internal Stage A queue admission only; no production caller invokes this.
/// It shares the existing global capacity lock and known-prefix INSERT shape.
pub async fn enqueue_static_hls(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    spec: &Value,
    limit: i64,
) -> Result<bool, sqlx::Error> {
    enqueue_queue(tx, session, spec, limit, true).await
}
async fn enqueue_queue(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    spec: &Value,
    limit: i64,
    static_hls: bool,
) -> Result<bool, sqlx::Error> {
    if !(1..=10000).contains(&limit) {
        return Err(sqlx::Error::Protocol("invalid_queue_limit".into()));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(72614932)")
        .execute(&mut **tx)
        .await?;
    if static_hls
        && !sqlx::query_scalar::<_, bool>("SELECT static_hls_session_allowed($1)")
            .bind(session)
            .fetch_one(&mut **tx)
            .await?
    {
        return Ok(false);
    }
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id WHERE j.status IN ('queued','running') AND NOT p.stopped AND p.expires_at>clock_timestamp() AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)")
        .fetch_one(&mut **tx).await?;
    if active >= limit {
        return Ok(false);
    }
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec,timing_version,timing_attempt,queue_entered_at,run_started_at,metrics_queue_ms,metrics_queue_complete,metrics_queue_accounted_attempt,logical_queue) VALUES($1,$1,'queued',$2,1,0,clock_timestamp(),NULL,0,true,0,$3)")
        .bind(session)
        .bind(spec)
        .bind(static_hls.then_some("static_hls_v1"))
        .execute(&mut **tx)
        .await?;
    Ok(true)
}
