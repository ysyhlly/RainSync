//! Retain a probe's HTTP representation pins through final plan publication.
use super::*;

pub async fn guard(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, id: Uuid) -> Result<()> {
    sqlx::query("SELECT lock_playback_http_representation($1)")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("SELECT id FROM playback_sessions WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
    // Separate statement after both contended locks: a committed mismatch
    // cannot be hidden by the snapshot from before a blocked row acquisition.
    let changed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_http_representations WHERE session_id=$1 AND identity->>'changed'='true')")
        .bind(id).fetch_one(&mut **tx).await?;
    if changed {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    Ok(())
}
