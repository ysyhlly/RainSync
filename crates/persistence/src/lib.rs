use anyhow::{Result, bail};
use protocol::RoomState;
use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;
pub mod admin_settings;
pub mod cache;
pub mod cache_budget;
pub mod cache_outputs;
mod cache_writers;
pub mod http_file_authorization;
pub mod local_hls_ladder;
pub mod media_authorization;
pub mod media_executions;
pub mod media_job_timing;
pub mod media_jobs;
pub mod media_outputs;
pub mod media_queue;
pub mod native_live;
pub mod native_platform_ladder;
pub mod native_platform_transcode;
pub mod owned_http;
pub mod playback_observations;
pub mod room_cleanup;
pub mod room_commands;
pub mod room_diagnostics;
pub mod room_invites;
pub mod room_lifecycle;
mod room_media;
pub mod room_node_leases;
pub mod room_permissions;
pub mod source_account_policy;
pub mod static_hls;
pub mod static_hls_activation;
pub mod static_hls_child_capture;
pub mod static_hls_child_claim;
pub mod static_hls_child_jobs;
pub mod static_hls_child_output;
pub mod static_hls_child_output_cleanup;
pub mod static_hls_child_output_publication;
pub mod static_hls_child_publication;
pub mod static_hls_child_queue;
pub mod static_hls_child_read;
pub mod static_hls_history;
pub mod static_hls_pending;
pub mod upstream_reservations;

pub async fn connect(url: &str) -> Result<PgPool> {
    connect_with_control_node(url, None).await
}
pub async fn connect_with_control_node(url: &str, node: Option<Uuid>) -> Result<PgPool> {
    connect_with_control_instance(url, node, None).await
}
pub async fn connect_with_control_instance(
    url: &str,
    node: Option<Uuid>,
    instance: Option<Uuid>,
) -> Result<PgPool> {
    let control_instance = instance.map(|id| id.to_string()).unwrap_or_default();
    let control_node = node.map(|id| id.to_string()).unwrap_or_default();
    Ok(PgPoolOptions::new()
        .max_connections(12)
        // Custom GUC is established on every physical connection, including
        // replacements. It is purpose-specific and leaves NULL legacy grants
        // unchanged; frozen old binaries do not inherit it from this pool.
        .after_connect(move |connection, _| {
            let control_node=control_node.clone();
            let control_instance=control_instance.clone();
            Box::pin(async move {
                sqlx::query("SELECT set_config('rainsync.static_hls_reader','1',false),set_config('rainsync.local_hls_ladder_reader','1',false),set_config('rainsync.native_platform_ladder_reader','1',false),set_config('rainsync.advanced_hls_ladder_reader','1',false),set_config('rainsync.native_extended_reader','1',false),set_config('rainsync.owned_http_reader','1',false),set_config('rainsync.remote_assets_reader','1',false),set_config('rainsync.native_webm_reader','1',false),set_config('rainsync.owned_http_large_reader','1',false),set_config('rainsync.finite_hls_reader','1',false)")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SELECT set_config('rainsync.control_node',$1,false),set_config('rainsync.control_instance',$2,false)").bind(control_node).bind(control_instance).execute(connection).await?;
                Ok(())
            })
        })
        .connect(url)
        .await?)
}
pub async fn migrate(pool: &PgPool) -> Result<()> {
    sqlx::migrate!("../../migrations").run(pool).await?;
    Ok(())
}
pub async fn snapshot(pool: &PgPool, id: Uuid) -> Result<RoomState> {
    let state: serde_json::Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1")
            .bind(id)
            .fetch_one(pool)
            .await?;
    Ok(serde_json::from_value(state)?)
}
/// Membership is a transaction gate, not just socket admission. Hold the row
/// through the caller's commit so DELETE either precedes admission or waits.
/// Call only after the room and snapshot locks, matching management ordering.
async fn lock_membership(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    room: Uuid,
    user: Uuid,
) -> Result<()> {
    let present: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(room)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?;
    if present.is_none() {
        bail!("not_a_member");
    }
    Ok(())
}

pub async fn issue_control_epoch(
    pool: &PgPool,
    room: Uuid,
    user: Uuid,
) -> Result<protocol::ControlEpoch> {
    let mut tx = pool.begin().await?;
    // Serialize credential issuance with ownership changes. An issuance queued
    // behind a transfer must belong to the new authorization window.
    room_lifecycle::lock_active(&mut tx, room).await?;
    sqlx::query("SELECT room_id FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    lock_membership(&mut tx, room, user).await?;
    let id = Uuid::new_v4();
    let expires_at_ms: i64 = sqlx::query_scalar("INSERT INTO control_epochs(id,user_id,room_id) VALUES($1,$2,$3) RETURNING floor(extract(epoch FROM expires_at)*1000)::bigint")
        .bind(id).bind(user).bind(room).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(protocol::ControlEpoch { id, expires_at_ms })
}
pub async fn check_control_epoch<'e, E: sqlx::Executor<'e, Database = sqlx::Postgres>>(
    executor: E,
    room: Uuid,
    user: Uuid,
    epoch: Option<Uuid>,
) -> Result<()> {
    let epoch = epoch.ok_or_else(|| anyhow::anyhow!("control_epoch_required"))?;
    let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM control_epochs WHERE id=$1 AND room_id=$2 AND user_id=$3 AND expires_at>clock_timestamp())")
        .bind(epoch).bind(room).bind(user).fetch_one(executor).await?;
    if !valid {
        bail!("control_epoch_expired");
    }
    Ok(())
}
pub async fn cleanup_control_history(pool: &PgPool) -> Result<()> {
    // The replay window is independent of the shorter event/delta window.
    sqlx::query("DELETE FROM command_results WHERE created_at<now()-interval '48 hours'")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM control_epochs WHERE expires_at<=now()")
        .execute(pool)
        .await?;
    Ok(())
}
pub mod media_previews;
