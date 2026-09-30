//! Epoch-fenced retry queue. This module never equates logical revocation with
//! actual resource disposal; completion requires independent owner receipts.
use anyhow::Result;
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

pub struct Task {
    pub room: Uuid,
    pub epoch: i64,
    pub owner: Uuid,
}

pub async fn enqueue(tx: &mut Transaction<'_, Postgres>, room: Uuid, epoch: i64) -> Result<()> {
    crate::upstream_reservations::close_lifecycle(tx, room, epoch).await?;
    sqlx::query("INSERT INTO room_cleanup_tasks(room_id,lifecycle_epoch) VALUES($1,$2) ON CONFLICT DO NOTHING")
        .bind(room).bind(epoch).execute(&mut **tx).await?;
    Ok(())
}

pub async fn claim(pool: &PgPool) -> Result<Option<Task>> {
    let owner = Uuid::new_v4();
    let row = sqlx::query("UPDATE room_cleanup_tasks t SET lease_owner=$1,lease_until=clock_timestamp()+interval '30 seconds',attempts=LEAST(attempts,2147483646)+1 FROM (SELECT c.room_id,c.lifecycle_epoch FROM room_cleanup_tasks c JOIN rooms r ON r.id=c.room_id AND r.lifecycle='closing' AND r.lifecycle_epoch=c.lifecycle_epoch WHERE c.completed_at IS NULL AND c.next_attempt_at<=clock_timestamp() AND (c.lease_until IS NULL OR c.lease_until<clock_timestamp()) ORDER BY c.next_attempt_at FOR UPDATE OF c SKIP LOCKED LIMIT 1) due WHERE t.room_id=due.room_id AND t.lifecycle_epoch=due.lifecycle_epoch RETURNING t.room_id,t.lifecycle_epoch")
        .bind(owner).fetch_optional(pool).await?;
    Ok(row.map(|row| Task {
        room: row.get("room_id"),
        epoch: row.get("lifecycle_epoch"),
        owner,
    }))
}

pub async fn retry(pool: &PgPool, task: &Task, reason: &str) -> Result<()> {
    sqlx::query("UPDATE room_cleanup_tasks SET lease_owner=NULL,lease_until=NULL,last_error=$4,next_attempt_at=clock_timestamp()+LEAST(30,attempts::bigint+1)*interval '1 second' WHERE room_id=$1 AND lifecycle_epoch=$2 AND lease_owner=$3 AND completed_at IS NULL")
        .bind(task.room).bind(task.epoch).bind(task.owner).bind(reason).execute(pool).await?;
    Ok(())
}

/// Call under the room lifecycle lock, after revocation. The old generation is
/// less than the closing epoch; inspecting all previous epochs also preserves
/// unresolved obligations across interrupted/reclaimed preparation attempts.
pub async fn blocker(
    tx: &mut Transaction<'_, Postgres>,
    task: &Task,
) -> Result<Option<&'static str>> {
    let row = sqlx::query("SELECT EXISTS(SELECT 1 FROM agent_transfer_runs t WHERE t.legacy_unconfirmed AND (t.possible_room_cutoff IS NULL OR t.possible_room_cutoff >= (SELECT cleanup_birth_ordinal FROM rooms WHERE id=$1))) AS legacy_agents,EXISTS(SELECT 1 FROM playback_preparations WHERE room_id=$1 AND lifecycle_epoch<$2 AND drained_at IS NULL) AS preparations,EXISTS(SELECT 1 FROM media_executions e JOIN playback_sessions p ON p.id=e.session_id WHERE p.room_id=$1 AND p.lifecycle_epoch<$2 AND e.reaped_at IS NULL) AS executions,EXISTS(SELECT 1 FROM agent_transfer_runs t JOIN playback_sessions p ON p.id=t.session_id WHERE p.room_id=$1 AND p.lifecycle_epoch<$2 AND t.agent_drained_at IS NULL) AS agent_transfers,EXISTS(SELECT 1 FROM upstream_reservations WHERE room_id=$1 AND lifecycle_epoch<$2 AND state<>'closed') AS upstream,EXISTS(SELECT 1 FROM upstream_reservations WHERE room_id=$1 AND lifecycle_epoch<$2 AND state<>'closed' AND (negotiation='unknown' OR io_uncertain)) AS upstream_unknown,EXISTS(SELECT 1 FROM upstream_reservations WHERE room_id=$1 AND lifecycle_epoch<$2 AND state='cleanup_failed') AS upstream_failed,EXISTS(SELECT 1 FROM playback_sessions p WHERE p.room_id=$1 AND p.lifecycle_epoch<$2 AND NOT(p.resource @> '{\"upstream_closed\":true}'::jsonb) AND NOT EXISTS(SELECT 1 FROM upstream_reservations u WHERE u.id=p.id) AND NOT EXISTS(SELECT 1 FROM playback_observations o WHERE o.session_id=p.id)) AS legacy_upstream,EXISTS(SELECT 1 FROM playback_sessions WHERE room_id=$1 AND lifecycle_epoch<$2 AND NOT stopped) AS sessions,EXISTS(SELECT 1 FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id WHERE p.room_id=$1 AND p.lifecycle_epoch<$2 AND j.status IN('queued','running')) AS jobs")
        .bind(task.room).bind(task.epoch).fetch_one(&mut **tx).await?;
    // An old transfer remains uncertain for every room that could have existed
    // before its offer. The transactional birth watermark excludes only rooms
    // created causally later; it never supplies a receipt or clears the flag.
    Ok(if row.get::<bool, _>("legacy_agents") {
        Some("legacy_agent_drain_unconfirmed")
    } else if row.get::<bool, _>("preparations") {
        Some("playback_preparation_drain_unconfirmed")
    } else if row.get::<bool, _>("executions") {
        Some("media_execution_drain_unconfirmed")
    } else if row.get::<bool, _>("agent_transfers") {
        Some("agent_transfer_drain_unconfirmed")
    } else if row.get::<bool, _>("upstream_unknown") {
        Some("upstream_operation_unconfirmed")
    } else if row.get::<bool, _>("upstream_failed") {
        Some("upstream_cleanup_failed")
    } else if row.get::<bool, _>("legacy_upstream") {
        Some("legacy_upstream_cleanup_unconfirmed")
    } else if row.get::<bool, _>("upstream") {
        Some("upstream_cleanup_pending")
    } else if row.get::<bool, _>("sessions") || row.get::<bool, _>("jobs") {
        Some("playback_revocation_pending")
    } else {
        None
    })
}

/// Retain uncertainty indefinitely. Only positive receipts age out, and never
/// while their room has a pending cleanup that may need the audit evidence.
pub async fn prune_receipts(pool: &PgPool) -> Result<()> {
    sqlx::query("DELETE FROM media_executions e USING playback_sessions p WHERE p.id=e.session_id AND e.reaped_at<clock_timestamp()-interval '48 hours' AND NOT EXISTS(SELECT 1 FROM room_cleanup_tasks c WHERE c.room_id=p.room_id AND c.completed_at IS NULL)")
        .execute(pool).await?;
    sqlx::query("DELETE FROM playback_preparations p WHERE p.drained_at<clock_timestamp()-interval '48 hours' AND NOT EXISTS(SELECT 1 FROM room_cleanup_tasks c WHERE c.room_id=p.room_id AND c.completed_at IS NULL)")
        .execute(pool).await?;
    Ok(())
}
