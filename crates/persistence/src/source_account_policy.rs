//! Transactional policy admission. Cleanup never calls these gates.
use anyhow::Result;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub async fn lock(
    tx: &mut Transaction<'_, Postgres>,
    source: Uuid,
    revision: i64,
    generation: Option<i64>,
) -> Result<bool> {
    let row = sqlx::query("SELECT kind,access_policy_revision FROM sources WHERE id=$1 FOR SHARE")
        .bind(source)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(row) = row else { return Ok(false) };
    if row.get::<i64, _>("access_policy_revision") != revision {
        return Ok(false);
    }
    if matches!(row.get::<String, _>("kind").as_str(), "jellyfin" | "emby") {
        sqlx::query("SELECT source_id FROM source_account_policies WHERE source_id=$1 FOR SHARE")
            .bind(source)
            .fetch_optional(&mut **tx)
            .await?;
    }
    // Re-evaluate expiry after waiting for all contended authority locks.
    Ok(
        sqlx::query_scalar("SELECT source_account_policy_allowed($1,$2,$3)")
            .bind(source)
            .bind(revision)
            .bind(generation)
            .fetch_one(&mut **tx)
            .await?,
    )
}

/// Caller holds its room/lifecycle admission lock through commit. This locks
/// source authority only; the final statement must also recheck stopped/expiry.
pub async fn lock_session(tx: &mut Transaction<'_, Postgres>, session: Uuid) -> Result<bool> {
    let row = sqlx::query("SELECT m.source_id,COALESCE((p.resource->>'source_policy_revision')::bigint,0) AS revision,(p.resource->>'account_policy_generation')::bigint AS generation FROM playback_sessions p JOIN media_items m ON m.id=p.media_id WHERE p.id=$1")
        .bind(session).fetch_optional(&mut **tx).await?;
    let Some(row) = row else { return Ok(false) };
    let Some(source) = row.get::<Option<Uuid>, _>("source_id") else {
        return Ok(false);
    };
    lock(tx, source, row.get("revision"), row.get("generation")).await
}

pub async fn lock_reservation(
    tx: &mut Transaction<'_, Postgres>,
    reservation: Uuid,
) -> Result<bool> {
    let row = sqlx::query("SELECT source_id,source_policy_revision,account_policy_generation FROM upstream_reservations WHERE id=$1")
        .bind(reservation).fetch_optional(&mut **tx).await?;
    let Some(row) = row else { return Ok(false) };
    lock(
        tx,
        row.get("source_id"),
        row.get("source_policy_revision"),
        row.get("account_policy_generation"),
    )
    .await
}
