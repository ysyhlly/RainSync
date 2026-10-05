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
    enqueue_queue(tx, session, spec, limit, None).await
}

/// Purpose-separated advanced jobs cannot be claimed by pre-wave Workers.
pub async fn enqueue_advanced_local(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    spec: &Value,
    limit: i64,
) -> Result<bool, sqlx::Error> {
    if spec.get("advanced_assets").is_some() || spec["kind"] == "advanced_owned_remote_transcode_v1"
    {
        sqlx::query("INSERT INTO advanced_media_bindings(session_id,frozen_spec,frozen_resource,deadline_ms) SELECT id,$2,resource,floor(extract(epoch FROM expires_at)*1000)::bigint FROM playback_sessions WHERE id=$1 AND NOT stopped AND expires_at>clock_timestamp() AND playback_source_allowed(media_id,resource,id)")
            .bind(session).bind(spec).execute(&mut **tx).await?;
    }
    enqueue_queue(
        tx,
        session,
        spec,
        limit,
        Some(
            if spec["kind"] == media_core::advanced_media::REMOTE_ASSET_KIND {
                media_core::advanced_media::REMOTE_ASSET_QUEUE
            } else if spec["kind"]
                .as_str()
                .is_some_and(|k| k.starts_with("advanced_owned"))
            {
                "advanced_owned_v1"
            } else {
                "advanced_local_v1"
            },
        ),
    )
    .await
}

/// Dedicated own-software ladder; never admitted to the legacy or static queue.
pub async fn enqueue_local_hls_ladder(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    spec: &Value,
    limit: i64,
) -> Result<bool, sqlx::Error> {
    crate::local_hls_ladder::validate_spec(spec)
        .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    enqueue_queue(
        tx,
        session,
        spec,
        limit,
        Some(
            if spec["kind"] == crate::local_hls_ladder::OWNED_ADVANCED_KIND {
                crate::local_hls_ladder::OWNED_ADVANCED_QUEUE
            } else if spec["kind"] == crate::local_hls_ladder::ADVANCED_KIND {
                crate::local_hls_ladder::ADVANCED_QUEUE
            } else {
                crate::local_hls_ladder::QUEUE
            },
        ),
    )
    .await
}

/// Internal Stage A queue admission only; no production caller invokes this.
/// It shares the existing global capacity lock and known-prefix INSERT shape.
pub async fn enqueue_static_hls(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    spec: &Value,
    limit: i64,
) -> Result<bool, sqlx::Error> {
    enqueue_queue(tx, session, spec, limit, Some("static_hls_v1")).await
}
pub async fn enqueue_native_platform(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    spec: &Value,
    limit: i64,
) -> Result<bool, sqlx::Error> {
    crate::native_platform_transcode::validate_spec(spec)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
    enqueue_queue(
        tx,
        session,
        spec,
        limit,
        Some(crate::native_platform_transcode::QUEUE),
    )
    .await
}
pub async fn enqueue_native_platform_ladder(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    spec: &Value,
    limit: i64,
) -> Result<bool, sqlx::Error> {
    crate::native_platform_ladder::validate_spec(spec)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
    enqueue_queue(
        tx,
        session,
        spec,
        limit,
        Some(crate::native_platform_ladder::QUEUE),
    )
    .await
}
async fn enqueue_queue(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    spec: &Value,
    limit: i64,
    queue: Option<&str>,
) -> Result<bool, sqlx::Error> {
    if !(1..=10000).contains(&limit) {
        return Err(sqlx::Error::Protocol("invalid_queue_limit".into()));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(72614932)")
        .execute(&mut **tx)
        .await?;
    if queue == Some("static_hls_v1")
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
        .bind(queue)
        .execute(&mut **tx)
        .await?;
    Ok(true)
}

/// Retain the exact original owned descriptor recipe behind a new-Worker queue.
pub async fn enqueue_owned_http(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    spec: &Value,
    limit: i64,
) -> Result<bool, sqlx::Error> {
    crate::owned_http::validate_spec(spec).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
    let changed=sqlx::query("UPDATE owned_http_representations SET frozen_spec=$2 WHERE session_id=$1 AND state='ready' AND frozen_spec IS NULL AND owned_http_representation_authority_allowed(session_id)").bind(session).bind(spec).execute(&mut **tx).await?.rows_affected();
    if changed != 1 {
        return Ok(false);
    }
    enqueue_queue(tx, session, spec, limit, Some(crate::owned_http::QUEUE)).await
}
