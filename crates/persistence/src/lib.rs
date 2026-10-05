use anyhow::{Result, bail};
use protocol::{Command, RoomState};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use uuid::Uuid;
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
pub mod room_diagnostics;
pub mod room_lifecycle;
pub mod room_node_leases;
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
pub async fn previous(
    pool: &PgPool,
    room: Uuid,
    command: &Command,
    user: Uuid,
) -> Result<Option<RoomState>> {
    previous_inner(pool, room, command, user, None, None).await
}
pub async fn previous_fenced(
    pool: &PgPool,
    room: Uuid,
    command: &Command,
    user: Uuid,
    session_hash: &str,
    lease: &room_node_leases::Lease,
) -> Result<Option<RoomState>> {
    previous_inner(pool, room, command, user, Some(session_hash), Some(lease)).await
}
async fn previous_inner(
    pool: &PgPool,
    room: Uuid,
    command: &Command,
    user: Uuid,
    session_hash: Option<&str>,
    lease: Option<&room_node_leases::Lease>,
) -> Result<Option<RoomState>> {
    let mut tx = pool.begin().await?;
    if lease.is_some() {
        sqlx::query("SELECT set_config('statement_timeout','3000',true),set_config('lock_timeout','1500',true),set_config('idle_in_transaction_session_timeout','5000',true)").execute(&mut *tx).await?;
    }
    if lease.is_none()
        && sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM control_cluster_activation)")
            .fetch_one(&mut *tx)
            .await?
    {
        bail!("room_owner_lost");
    }
    room_lifecycle::lock_active(&mut tx, room).await?;
    sqlx::query("SELECT room_id FROM room_snapshots WHERE room_id=$1 FOR SHARE")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    if let Some(lease) = lease {
        room_node_leases::guard(&mut tx, lease).await?;
    }
    lock_membership(&mut tx, room, user).await?;
    check_control_epoch(&mut *tx, room, user, command.control_epoch).await?;
    let row =
        sqlx::query("SELECT state,user_id,request_payload FROM command_results WHERE room_id=$1 AND command_id=$2")
            .bind(room)
            .bind(command.command_id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(login) = session_hash {
        check_control_login(&mut tx, user, login).await?;
    }
    if let Some(lease) = lease {
        room_node_leases::guard(&mut tx, lease).await?;
    }
    tx.commit().await?;
    match row {
        None => Ok(None),
        Some(row) => {
            if row.get::<Uuid, _>("user_id") != user {
                bail!("command_owned_by_another_user")
            };
            let saved: Option<serde_json::Value> = row.get("request_payload");
            match saved {
                None => bail!("command_replay_unverifiable"),
                Some(saved) if saved != serde_json::to_value(command)? => {
                    bail!("command_payload_conflict")
                }
                Some(_) => {}
            }
            Ok(Some(serde_json::from_value(row.get("state"))?))
        }
    }
}
pub async fn commit(
    pool: &PgPool,
    command: &Command,
    user: Uuid,
    session_hash: &str,
    server_time_ms: f64,
    resolved_media: Option<room_core::diagnostics::ResolvedMedia>,
) -> Result<RoomState> {
    commit_inner(
        pool,
        command,
        user,
        session_hash,
        server_time_ms,
        resolved_media,
        None,
    )
    .await
}
pub async fn commit_fenced(
    pool: &PgPool,
    command: &Command,
    user: Uuid,
    session_hash: &str,
    server_time_ms: f64,
    resolved_media: Option<room_core::diagnostics::ResolvedMedia>,
    lease: &room_node_leases::Lease,
) -> Result<RoomState> {
    commit_inner(
        pool,
        command,
        user,
        session_hash,
        server_time_ms,
        resolved_media,
        Some(lease),
    )
    .await
}
async fn commit_inner(
    pool: &PgPool,
    command: &Command,
    user: Uuid,
    session_hash: &str,
    server_time_ms: f64,
    resolved_media: Option<room_core::diagnostics::ResolvedMedia>,
    lease: Option<&room_node_leases::Lease>,
) -> Result<RoomState> {
    let previous_revision = command.expected_revision;
    let mut tx = pool.begin().await?;
    if lease.is_some() {
        sqlx::query("SELECT set_config('statement_timeout','3000',true),set_config('lock_timeout','1500',true),set_config('idle_in_transaction_session_timeout','5000',true)").execute(&mut *tx).await?;
    }
    if lease.is_none()
        && sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM control_cluster_activation)")
            .fetch_one(&mut *tx)
            .await?
    {
        bail!("room_owner_lost");
    }
    // Match room management's room -> snapshot lock order before inserting
    // rows whose foreign keys also need a key-share lock on rooms.
    let lifecycle_epoch = room_lifecycle::lock_active(&mut tx, command.room_id).await?;
    // Validate wall-clock expiry after acquiring the state lock, so a command
    // that expired while waiting cannot execute when that lock is released.
    let current: serde_json::Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(command.room_id)
            .fetch_one(&mut *tx)
            .await?;
    if let Some(lease) = lease {
        room_node_leases::guard(&mut tx, lease).await?;
    }
    lock_membership(&mut tx, command.room_id, user).await?;
    check_control_epoch(&mut *tx, command.room_id, user, command.control_epoch).await?;
    // Match the REST gate's room -> snapshot -> member -> user -> session
    // ordering. SHARE also blocks non-key admin/expiry updates; KEY SHARE
    // would only protect against deletion. Never use the socket's cached role.
    let actor_is_admin: Option<bool> =
        sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 FOR SHARE")
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?;
    let login: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(session_hash)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?;
    let actor_is_admin = actor_is_admin
        .filter(|_| login.is_some())
        .ok_or_else(|| anyhow::anyhow!("session_expired"))?;
    check_control_login(&mut tx, user, session_hash).await?;
    // Ownership and role can change while the actor or these locks wait.
    // Compute both the committed state and its diagnostic with the same
    // admitted authorization, rather than accepting an optimistic reduction.
    let current: RoomState = serde_json::from_value(current)?;
    // The selected immutable database identity decides room semantics. Client
    // flags only acknowledge support; they can never turn ordinary media live.
    let selected_live = match current.media_id {
        Some(media) => native_live::selected_binding(&mut *tx, command.room_id, media).await?,
        None => None,
    };
    if current.live != selected_live {
        bail!("native_live_state_changed");
    }
    // Room-private platform entries may share the ordinary media identifier
    // contract, but can never be selected from another room. Resolve and lock
    // this fact inside the same authority transaction as the final reduction.
    if matches!(
        command.action,
        protocol::Action::ChangeMedia { .. } | protocol::Action::EndMedia { .. }
    ) {
        let resolved = resolved_media
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("missing_resolved_media_fact"))?;
        if let protocol::Action::ChangeMedia { media_id } = command.action
            && resolved.media_id != media_id
        {
            bail!("media_resolution_mismatch");
        }
        let item: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM media_items WHERE id=$1 FOR SHARE")
                .bind(resolved.media_id)
                .fetch_optional(&mut *tx)
                .await?;
        sqlx::query("SELECT media_id FROM room_platform_media WHERE media_id=$1 FOR SHARE")
            .bind(resolved.media_id)
            .fetch_optional(&mut *tx)
            .await?;
        let allowed: bool = sqlx::query_scalar(
            "SELECT room_media_allowed($1,$2) AND library_media_allowed($3,$2,'play',$1)",
        )
        .bind(command.room_id)
        .bind(resolved.media_id)
        .bind(user)
        .fetch_one(&mut *tx)
        .await?;
        if item.is_none() || !allowed {
            bail!("media_not_found");
        }
        let selected_live =
            native_live::selected_binding(&mut *tx, command.room_id, resolved.media_id).await?;
        if selected_live != resolved.live {
            bail!("media_resolution_mismatch");
        }
        if selected_live.is_some() {
            if command.live_version != Some(1) {
                bail!("native_live_client_unsupported");
            }
            if resolved.duration_ms.is_some() {
                bail!("media_resolution_mismatch");
            }
        }
        check_control_login(&mut tx, user, session_hash).await?;
    }
    let mut state = room_core::reduce(&current, command, user, actor_is_admin, server_time_ms)
        .map_err(anyhow::Error::msg)?;
    if let Some(resolved) = &resolved_media {
        state.media_id = Some(resolved.media_id);
        state.duration_ms = resolved.duration_ms;
        state.live = resolved.live.clone();
        if state.live.is_some() {
            state.anchor_position_ms = 0.0;
            state.playback_rate = 1.0;
        }
    }
    let value = serde_json::to_value(&state)?;
    let result = sqlx::query(
        "UPDATE room_snapshots SET state=$2 WHERE room_id=$1 AND (state->>'revision')::bigint=$3",
    )
    .bind(command.room_id)
    .bind(&value)
    .bind(i64::from(previous_revision))
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() != 1 {
        bail!("revision_conflict")
    }
    // The snapshot lock is shared with playlist mutation; play-and-enqueue is atomic.
    if let protocol::Action::ChangeMedia { media_id } = command.action {
        sqlx::query("INSERT INTO playlist_items SELECT $1,$2,$3,COALESCE(max(sort_order),0)+1 FROM playlist_items WHERE room_id=$2 HAVING NOT EXISTS(SELECT 1 FROM playlist_items WHERE room_id=$2 AND media_id=$3)")
            .bind(Uuid::new_v4()).bind(command.room_id).bind(media_id).execute(&mut *tx).await?;
    }
    use room_core::diagnostics::{Operation, SafeCommand};
    let safe_command = SafeCommand::from_command(command);
    let operation = match command.action {
        protocol::Action::ChangeMedia { .. } | protocol::Action::EndMedia { .. } => {
            Operation::MediaControl {
                command: safe_command,
                server_time_ms,
                resolved_media: resolved_media
                    .ok_or_else(|| anyhow::anyhow!("missing_resolved_media_fact"))?,
            }
        }
        _ => {
            if resolved_media.is_some() {
                bail!("unexpected_resolved_media_fact");
            }
            Operation::Control {
                command: safe_command,
                server_time_ms,
            }
        }
    };
    let lifecycle = room_diagnostics::lifecycle("active", lifecycle_epoch)?;
    let diagnostic = room_diagnostics::envelope(
        Uuid::new_v4(),
        current,
        Some((user, actor_is_admin)),
        lifecycle,
        lifecycle,
        operation,
    );
    room_diagnostics::append(&mut tx, &state, diagnostic).await?;
    sqlx::query(
        "INSERT INTO command_results(room_id,command_id,user_id,state,request_payload) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(command.room_id)
    .bind(command.command_id)
    .bind(user)
    .bind(value)
    .bind(serde_json::to_value(command)?)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE room_id=$1 AND generation<>$2 AND NOT stopped").bind(command.room_id).bind(i64::from(state.media_generation)).execute(&mut *tx).await?;
    upstream_reservations::close_room(&mut tx, command.room_id, i64::from(state.media_generation))
        .await?;
    let job_health = media_job_timing::cancel_jobs(
        &mut *tx,
        media_job_timing::CancellationScope::StoppedRoom(command.room_id),
    )
    .await?;
    // Only the acknowledged logical transition is observed. Child-process
    // drainage remains owned by the existing execution supervisors/receipts.
    let job_health = job_health.into_commit_observation();
    // Locks prevent logout and role mutation, not natural expiry during a
    // later write/cleanup wait. Reject the whole transition at final admission.
    check_control_login(&mut tx, user, session_hash).await?;
    if let Some(lease) = lease {
        room_node_leases::checkpoint_locked(&mut tx, lease, &state, server_time_ms).await?;
        room_node_leases::guard(&mut tx, lease).await?;
    }
    tx.commit().await?;
    job_health.confirmed();
    Ok(state)
}

async fn check_control_login(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    session_hash: &str,
) -> Result<()> {
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())",
    )
    .bind(session_hash)
    .bind(user)
    .fetch_one(&mut **tx)
    .await?;
    if !valid {
        bail!("session_expired");
    }
    Ok(())
}
pub mod media_previews;
