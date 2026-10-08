use super::*;
use persistence::media_job_timing::{CancellationScope, cancel_jobs};
use protocol::{PlaybackStatus, RoomState};

#[path = "room_management_authority.rs"]
pub(crate) mod management_authority;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    expected_revision: u32,
}

pub fn gate_error(error: anyhow::Error) -> Error {
    match error.to_string().as_str() {
        "room_not_active" => err(StatusCode::CONFLICT, "room_not_active"),
        _ => error.into(),
    }
}

pub async fn status(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let user = auth_viewer(&app, &h, false).await?;
    if !user.admin {
        member(&app, &user, id).await?;
    }
    let row = sqlx::query("SELECT r.lifecycle,r.lifecycle_epoch,r.owner_id,s.state FROM rooms r JOIN room_snapshots s ON s.room_id=r.id WHERE r.id=$1")
        .bind(id).fetch_optional(&app.db).await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    let cleanup = sqlx::query("SELECT attempts,last_error,completed_at IS NOT NULL AS completed FROM room_cleanup_tasks WHERE room_id=$1 AND lifecycle_epoch=$2")
        .bind(id).bind(row.get::<i64,_>("lifecycle_epoch")).fetch_optional(&app.db).await?;
    Ok(responses::ok_json(json!({
        "lifecycle":row.get::<String,_>("lifecycle"),
        "lifecycle_epoch":row.get::<i64,_>("lifecycle_epoch"),
        "owner_id":row.get::<Uuid,_>("owner_id"),
        "state":row.get::<Value,_>("state"),
        "cleanup":cleanup.map(|row| json!({"attempts":row.get::<i32,_>("attempts"),"last_error":row.get::<Option<String>,_>("last_error"),"completed":row.get::<bool,_>("completed")})),
    })))
}

pub async fn close(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Change>,
) -> Result<Response> {
    change(&app, &h, id, body, "active", "closing").await
}
pub async fn reopen(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Change>,
) -> Result<Response> {
    change(&app, &h, id, body, "closed", "active").await
}
pub async fn archive(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Change>,
) -> Result<Response> {
    change(&app, &h, id, body, "closed", "archived").await
}

async fn change(
    app: &App,
    h: &HeaderMap,
    id: Uuid,
    body: Change,
    expected: &str,
    target: &str,
) -> Result<Response> {
    let user = auth(app, h, true).await?;
    let mut tx = app.db.begin().await?;
    let room = sqlx::query(
        "SELECT owner_id,lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    let owner: Uuid = room.get("owner_id");
    let value: Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    // Read membership even for a previously admitted admin. Its current role
    // is authoritative only after the room/snapshot/member locks have waited.
    let membership: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let authority = management_authority::Authority::admit_action(
        &mut tx,
        h,
        user.id,
        owner,
        membership.is_some(),
        if target == "closing" {
            Some((id, protocol::RoomPermission::Close))
        } else {
            None
        },
    )
    .await?;
    let mut state: RoomState = serde_json::from_value(value).map_err(anyhow::Error::from)?;
    let before = state.clone();
    if state.revision != body.expected_revision {
        return Err(err(StatusCode::CONFLICT, "revision_conflict"));
    }
    if room.get::<String, _>("lifecycle") != expected {
        return Err(err(StatusCode::CONFLICT, "room_lifecycle_conflict"));
    }
    let previous_epoch: i64 = room.get("lifecycle_epoch");
    let epoch = previous_epoch;
    let epoch = if target == "archived" {
        epoch
    } else {
        epoch
            .checked_add(1)
            .ok_or_else(|| err(StatusCode::CONFLICT, "room_lifecycle_conflict"))?
    };
    state.revision = state
        .revision
        .checked_add(1)
        .ok_or_else(|| err(StatusCode::CONFLICT, "revision_conflict"))?;
    // One captured monotonic input makes the committed transition replayable.
    // Freeze the shared timeline at close; opening never resumes playback.
    let server_time_ms = app.now();
    if target == "closing" {
        state.anchor_position_ms = room_core::position(&state, server_time_ms);
    }
    state.playback_status = PlaybackStatus::Paused;
    state.anchor_server_time_ms = server_time_ms;
    state.clock_epoch = app.epoch;
    let value = serde_json::to_value(&state).map_err(anyhow::Error::from)?;
    sqlx::query("UPDATE rooms SET lifecycle=$2,lifecycle_epoch=$3 WHERE id=$1")
        .bind(id)
        .bind(target)
        .bind(epoch)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE room_snapshots SET state=$2 WHERE room_id=$1")
        .bind(id)
        .bind(&value)
        .execute(&mut *tx)
        .await?;
    let event_id = Uuid::new_v4();
    use room_core::diagnostics::{LifecycleTransition, Operation};
    let transition = match target {
        "closing" => LifecycleTransition::Closing,
        "active" => LifecycleTransition::Reopened,
        "archived" => LifecycleTransition::Archived,
        _ => return Err(err(StatusCode::CONFLICT, "room_lifecycle_conflict")),
    };
    let mut diagnostic = persistence::room_diagnostics::envelope(
        event_id,
        before,
        Some((user.id, authority.actor_is_admin())),
        persistence::room_diagnostics::lifecycle(expected, previous_epoch)?,
        persistence::room_diagnostics::lifecycle(target, epoch)?,
        Operation::Lifecycle {
            transition,
            expected_revision: body.expected_revision,
            server_time_ms: Some(server_time_ms),
        },
    );
    diagnostic.actor_permission = authority.actor_permission();
    persistence::room_diagnostics::append(&mut tx, &state, diagnostic).await?;
    sqlx::query("INSERT INTO room_lifecycle_events(id,room_id,actor_id,previous_lifecycle,lifecycle,lifecycle_epoch,revision) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(event_id).bind(id).bind(user.id).bind(expected).bind(target).bind(epoch).bind(i64::from(state.revision)).execute(&mut *tx).await?;
    // These revocations are part of the same commit as the state transition.
    // Reopening deliberately never updates old rows to the new epoch.
    sqlx::query("DELETE FROM control_epochs WHERE room_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE invites SET revoked=true WHERE room_id=$1 AND NOT revoked")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let pending_hls: Vec<Uuid> = sqlx::query_scalar("SELECT session_id FROM playback_requests WHERE room_id=$1 AND static_hls_input_version=1 ORDER BY session_id FOR UPDATE")
        .bind(id).fetch_all(&mut *tx).await?;
    for session in pending_hls {
        persistence::static_hls_pending::terminalize_locked(
            &mut tx,
            session,
            409,
            "room_not_active",
        )
        .await?;
    }
    sqlx::query("UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=409,error_code='room_not_active' WHERE room_id=$1 AND static_hls_input_version IS NULL AND status IN('pending','completed')")
        .bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE room_id=$1 AND NOT stopped")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let job_health = cancel_jobs(&mut *tx, CancellationScope::Room(id)).await?;
    if target == "closing" {
        persistence::room_cleanup::enqueue(&mut tx, id, epoch).await?;
    }
    let observation = job_health.into_commit_observation();
    authority.commit(tx).await?;
    observation.confirmed();
    rooms::lifecycle_changed(app, &state, target, epoch, event_id).await;
    Ok(responses::ok_json(
        json!({"lifecycle":target,"lifecycle_epoch":epoch,"owner_id":owner,"state":state,"event_id":event_id}),
    ))
}
