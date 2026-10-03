//! Closing revokes immediately; this reconciler proves disposal before closed.
use super::*;
use persistence::room_cleanup::Task;

async fn finish(app: &App, task: &Task) -> anyhow::Result<Option<(protocol::RoomState, Uuid)>> {
    let mut tx = app.db.begin().await?;
    let room =
        sqlx::query("SELECT lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
            .bind(task.room)
            .fetch_one(&mut *tx)
            .await?;
    if room.get::<String, _>("lifecycle") != "closing"
        || room.get::<i64, _>("lifecycle_epoch") != task.epoch
    {
        return Ok(None);
    }
    let owns: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM room_cleanup_tasks WHERE room_id=$1 AND lifecycle_epoch=$2 AND lease_owner=$3 AND completed_at IS NULL)")
        .bind(task.room).bind(task.epoch).bind(task.owner).fetch_one(&mut *tx).await?;
    if !owns {
        return Ok(None);
    }
    if let Some(reason) = persistence::room_cleanup::blocker(&mut tx, task).await? {
        anyhow::bail!(reason);
    }
    let mut state: protocol::RoomState = serde_json::from_value(
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(task.room)
            .fetch_one(&mut *tx)
            .await?,
    )?;
    let before = state.clone();
    state.revision = state
        .revision
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("room_revision_exhausted"))?;
    let value = serde_json::to_value(&state)?;
    let event = Uuid::new_v4();
    sqlx::query("UPDATE rooms SET lifecycle='closed' WHERE id=$1")
        .bind(task.room)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE room_snapshots SET state=$2 WHERE room_id=$1")
        .bind(task.room)
        .bind(&value)
        .execute(&mut *tx)
        .await?;
    let diagnostic = persistence::room_diagnostics::envelope(
        event,
        before,
        None,
        persistence::room_diagnostics::lifecycle("closing", task.epoch)?,
        persistence::room_diagnostics::lifecycle("closed", task.epoch)?,
        room_core::diagnostics::Operation::Lifecycle {
            transition: room_core::diagnostics::LifecycleTransition::Closed,
            expected_revision: state.revision - 1,
            server_time_ms: None,
        },
    );
    persistence::room_diagnostics::append(&mut tx, &state, diagnostic).await?;
    sqlx::query("INSERT INTO room_lifecycle_events(id,room_id,previous_lifecycle,lifecycle,lifecycle_epoch,revision) VALUES($1,$2,'closing','closed',$3,$4)")
        .bind(event).bind(task.room).bind(task.epoch).bind(i64::from(state.revision)).execute(&mut *tx).await?;
    sqlx::query("UPDATE room_cleanup_tasks SET completed_at=clock_timestamp(),last_error=NULL,lease_owner=NULL,lease_until=NULL WHERE room_id=$1 AND lifecycle_epoch=$2 AND lease_owner=$3")
        .bind(task.room).bind(task.epoch).bind(task.owner).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some((state, event)))
}

async fn reconcile(app: &App, task: &Task) -> anyhow::Result<()> {
    // The existing upstream runtime owns bounded per-origin I/O and captured
    // observations. This queue only checks its positive disposal evidence.
    if let Some((state, event)) = finish(app, task).await? {
        rooms::lifecycle_changed(app, &state, "closed", task.epoch, event).await;
    }
    Ok(())
}

pub async fn run(app: App) {
    loop {
        match persistence::room_cleanup::claim(&app.db).await {
            Ok(Some(task)) => {
                if let Err(error) = reconcile(&app, &task).await {
                    // Only bounded, known reason codes enter the observable API.
                    let reason = match error.to_string().as_str() {
                        "legacy_agent_drain_unconfirmed" => "legacy_agent_drain_unconfirmed",
                        "playback_preparation_drain_unconfirmed" => {
                            "playback_preparation_drain_unconfirmed"
                        }
                        "media_execution_drain_unconfirmed" => "media_execution_drain_unconfirmed",
                        "static_hls_capture_drain_unconfirmed" => {
                            "static_hls_capture_drain_unconfirmed"
                        }
                        "agent_transfer_drain_unconfirmed" => "agent_transfer_drain_unconfirmed",
                        "upstream_cleanup_failed" => "upstream_cleanup_failed",
                        "legacy_upstream_cleanup_unconfirmed" => {
                            "legacy_upstream_cleanup_unconfirmed"
                        }
                        "upstream_cleanup_pending" => "upstream_cleanup_pending",
                        "upstream_operation_unconfirmed" => "upstream_operation_unconfirmed",
                        "playback_revocation_pending" => "playback_revocation_pending",
                        _ => "room_cleanup_retry",
                    };
                    let _ = persistence::room_cleanup::retry(&app.db, &task, reason).await;
                }
            }
            Ok(None) => {}
            Err(_) => tracing::warn!("room cleanup queue unavailable"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}
