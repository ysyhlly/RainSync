//! Durable, room-owner fenced cleanup after a global account tombstone commits.
use crate::*;

pub struct Maintenance(tokio::task::JoinHandle<()>);
impl Drop for Maintenance {
    fn drop(&mut self) {
        self.0.abort();
    }
}
impl Maintenance {
    pub fn start(app: App) -> Self {
        Self(tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                if sweep(&app).await.is_err() {
                    tracing::warn!("account exit room cleanup will retry");
                }
            }
        }))
    }
}

async fn sweep(app: &App) -> Result<()> {
    let rows=sqlx::query("WITH candidates AS (SELECT room_id,user_id FROM account_exit_room_cleanup ORDER BY last_attempt_at NULLS FIRST,created_at,room_id,user_id LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE account_exit_room_cleanup q SET last_attempt_at=clock_timestamp() FROM candidates c WHERE q.room_id=c.room_id AND q.user_id=c.user_id RETURNING q.room_id,q.user_id")
        .fetch_all(&app.db).await?;
    for row in rows {
        let room: Uuid = row.get("room_id");
        let user: Uuid = row.get("user_id");
        // The atomic batch above skips locked receipts and rotates unavailable
        // rooms; neither can starve unrelated room owners.
        if cleanup_one(app, room, user).await.is_err() {
            tracing::warn!(%room,"account exit room cleanup will retry");
        }
    }
    Ok(())
}

async fn cleanup_one(app: &App, room: Uuid, user: Uuid) -> Result<()> {
    if let Some(cluster) = &app.control_cluster {
        // A media/gateway process or another room's owner cannot mutate it.
        if cluster.local_lease(room).await.is_err() {
            return Ok(());
        }
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='2s'")
        .execute(&mut *tx)
        .await?;
    if sqlx::query_scalar::<_, Uuid>("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(room)
        .fetch_optional(&mut *tx)
        .await?
        .is_none()
    {
        return Ok(());
    }
    sqlx::query("SELECT room_id FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
        .bind(room)
        .fetch_optional(&mut *tx)
        .await?;
    let pending: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM account_exit_room_cleanup WHERE room_id=$1 AND user_id=$2 FOR UPDATE",
    )
    .bind(room)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?;
    if pending.is_none() {
        return Ok(());
    }
    let exited: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_exits WHERE user_id=$1)")
            .bind(user)
            .fetch_one(&mut *tx)
            .await?;
    if !exited {
        return Ok(());
    }
    sqlx::query("UPDATE invites SET revoked=true WHERE room_id=$1 AND (created_by=$2 OR invited_user_id=$2) AND NOT revoked")
            .bind(room).bind(user).execute(&mut *tx).await?;
    sqlx::query(
        "DELETE FROM room_member_permissions WHERE room_id=$1 AND (user_id=$2 OR granted_by=$2)",
    )
    .bind(room)
    .bind(user)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM room_members WHERE room_id=$1 AND user_id=$2")
        .bind(room)
        .bind(user)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM account_exit_room_cleanup WHERE room_id=$1 AND user_id=$2")
        .bind(room)
        .bind(user)
        .execute(&mut *tx)
        .await?;
    // Existing SQL room guards recheck wall-clock lease at COMMIT.
    tx.commit().await?;
    Ok(())
}
