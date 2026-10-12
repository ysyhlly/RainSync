//! Closing revokes immediately; this reconciler proves disposal before closed.
use super::*;
use persistence::room_cleanup::Task;

async fn finish(app: &App, task: &Task) -> anyhow::Result<Option<(protocol::RoomState, Uuid)>> {
    let control_lease = match &app.control_cluster {
        Some(cluster) => Some(cluster.local_lease(task.room).await?),
        None => None,
    };
    let mut tx = app.db.begin().await?;
    // A blocked room/receipt transaction must not monopolize the one durable
    // reconciler and strand unrelated closing rooms. This budget is shorter
    // than the cleanup claim lease; timing out never supplies disposal proof.
    sqlx::query("SET LOCAL lock_timeout='2s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
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
    let owns: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM room_cleanup_tasks WHERE room_id=$1 AND lifecycle_epoch=$2 AND lease_owner=$3 AND lease_until>clock_timestamp() AND completed_at IS NULL)")
        .bind(task.room).bind(task.epoch).bind(task.owner).fetch_one(&mut *tx).await?;
    if !owns {
        return Ok(None);
    }
    if !distributed_compute::room_drained(&mut tx, task.room).await? {
        anyhow::bail!("distributed_compute_drain_unconfirmed");
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
    if let Some(lease) = &control_lease {
        persistence::room_node_leases::guard(&mut tx, lease).await?;
    }
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
    if let Some(lease) = &control_lease {
        persistence::room_node_leases::guard(&mut tx, lease).await?;
    }
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
                let result =
                    tokio::time::timeout(std::time::Duration::from_secs(5), reconcile(&app, &task))
                        .await
                        .unwrap_or_else(|_| Err(anyhow::anyhow!("room_cleanup_timeout")));
                if let Err(error) = result {
                    // Only bounded, known reason codes enter the observable API.
                    let database_code =
                        error
                            .downcast_ref::<sqlx::Error>()
                            .and_then(|error| match error {
                                sqlx::Error::Database(database) => database.code(),
                                _ => None,
                            });
                    let reason = match (database_code.as_deref(), error.to_string().as_str()) {
                        (Some("55P03"), _) => "room_cleanup_locked",
                        (Some("57014"), _) => "room_cleanup_timeout",
                        (_, "legacy_agent_drain_unconfirmed") => "legacy_agent_drain_unconfirmed",
                        (_, "playback_preparation_drain_unconfirmed") => {
                            "playback_preparation_drain_unconfirmed"
                        }
                        (_, "media_execution_drain_unconfirmed") => {
                            "media_execution_drain_unconfirmed"
                        }
                        (_, "distributed_compute_drain_unconfirmed") => {
                            "distributed_compute_drain_unconfirmed"
                        }
                        (_, "static_hls_capture_drain_unconfirmed") => {
                            "static_hls_capture_drain_unconfirmed"
                        }
                        (_, "agent_transfer_drain_unconfirmed") => {
                            "agent_transfer_drain_unconfirmed"
                        }
                        (_, "upstream_cleanup_failed") => "upstream_cleanup_failed",
                        (_, "legacy_upstream_cleanup_unconfirmed") => {
                            "legacy_upstream_cleanup_unconfirmed"
                        }
                        (_, "upstream_cleanup_pending") => "upstream_cleanup_pending",
                        (_, "upstream_operation_unconfirmed") => "upstream_operation_unconfirmed",
                        (_, "playback_revocation_pending") => "playback_revocation_pending",
                        (_, "room_cleanup_timeout") => "room_cleanup_timeout",
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
