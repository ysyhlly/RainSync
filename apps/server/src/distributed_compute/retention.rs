//! Retention sweep for configured Server-uploaded compute outputs and retained history.
use sqlx::PgPool;
use std::path::Path;
use uuid::Uuid;

pub(super) struct Context<'a> {
    pub(super) db: &'a PgPool,
    pub(super) root: &'a Path,
}

// Each SQL statement commits independently. File deletion and metadata deletion are
// not atomic; a failure preserves earlier side effects and stops the later phases.
// Attempt receipts protect the ledger, but do not gate deletion of stale Server files.
pub(super) async fn sweep(context: Context<'_>) -> anyhow::Result<()> {
    let Context { db, root } = context;
    sqlx::query("UPDATE distributed_compute_jobs SET status='cancelled',error='compute_authority_lost' WHERE status IN('queued','running','ready') AND NOT distributed_compute_authorized(id)").execute(db).await?;
    // Short-lived signaling must not depend on filesystem/history cleanup.
    sqlx::query("DELETE FROM room_p2p_signals WHERE expires_at<=clock_timestamp()")
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM room_p2p_peers WHERE expires_at<=clock_timestamp() OR NOT room_p2p_peer_authorized(id)").execute(db).await?;
    let mut directories = match tokio::fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    while let Some(job) = directories.next_entry().await? {
        let Some(id) = job
            .file_name()
            .to_str()
            .and_then(|s| Uuid::parse_str(s).ok())
        else {
            continue;
        };
        if !job.file_type().await?.is_dir() {
            continue;
        }
        let keep:Option<Uuid>=sqlx::query_scalar("SELECT output_generation FROM distributed_compute_jobs WHERE id=$1 AND expires_at>clock_timestamp() AND status IN('running','ready')").bind(id).fetch_optional(db).await?.flatten();
        let mut generations = tokio::fs::read_dir(job.path()).await?;
        while let Some(generation) = generations.next_entry().await? {
            let Some(g) = generation
                .file_name()
                .to_str()
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                continue;
            };
            if Some(g) != keep && generation.file_type().await?.is_dir() {
                tokio::fs::remove_dir_all(generation.path()).await?;
                sqlx::query("DELETE FROM distributed_compute_files WHERE job_id=$1 AND output_generation=$2").bind(id).bind(g).execute(db).await?;
            }
        }
        if keep.is_none() {
            let _ = tokio::fs::remove_dir(job.path()).await;
        }
    }
    sqlx::query("DELETE FROM distributed_compute_attempts a USING distributed_compute_jobs j WHERE a.job_id=j.id AND j.expires_at<clock_timestamp()-interval '48 hours' AND a.process_reaped_at IS NOT NULL AND a.files_removed_at IS NOT NULL AND (a.server_verification_started_at IS NULL OR a.server_verification_reaped_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM room_cleanup_tasks c WHERE c.room_id=a.room_id AND c.completed_at IS NULL)").execute(db).await?;
    // Playback bindings are immutable retained session history. Keep their job
    // rather than cascading away evidence or repeatedly failing the whole batch.
    sqlx::query(
        "DELETE FROM distributed_compute_jobs j WHERE expires_at<clock_timestamp()-interval '1 hour' AND NOT EXISTS(SELECT 1 FROM distributed_compute_attempts a WHERE a.job_id=j.id) AND NOT EXISTS(SELECT 1 FROM distributed_playback_bindings b WHERE b.job_id=j.id)",
    )
    .execute(db)
    .await?;
    Ok(())
}
