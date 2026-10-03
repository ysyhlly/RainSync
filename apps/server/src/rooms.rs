use super::*;
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use protocol::{Command, PlaybackStatus, RoomState};
use tokio::sync::{mpsc, oneshot};

#[path = "room_delivery.rs"]
mod delivery;

#[path = "room_presence.rs"]
mod presence_runtime;

#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<Request>,
    events: delivery::Bus,
    presence: presence_runtime::Runtime,
}
impl Handle {
    pub fn command_queue_depth(&self) -> usize {
        self.tx.max_capacity() - self.tx.capacity()
    }
    pub fn connected_receivers(&self) -> usize {
        self.events.receiver_count()
    }
}
struct Request {
    user_id: Uuid,
    session_hash: String,
    command: Command,
    reply: oneshot::Sender<Value>,
}

pub async fn ownership_changed(app: &App, state: &RoomState, owner: Uuid, event_id: Uuid) {
    if let Some(handle) = app.rooms.lock().await.get(&state.room_id) {
        let _ = handle.events.send(json!({
            "type":"EVENT", "state":state, "owner_id":owner,
            "event_id":event_id, "action":{"type":"TRANSFER_OWNERSHIP"}
        }));
    }
}

pub async fn lifecycle_changed(
    app: &App,
    state: &RoomState,
    lifecycle: &str,
    lifecycle_epoch: i64,
    event_id: Uuid,
) {
    if let Some(handle) = app.rooms.lock().await.get(&state.room_id) {
        let _ = handle.events.send(json!({
            "type":"EVENT", "state":state, "lifecycle":lifecycle,
            "lifecycle_epoch":lifecycle_epoch, "event_id":event_id,
            "control_epoch":null, "action":{"type":"ROOM_LIFECYCLE"}
        }));
    }
}

async fn owned_snapshot(
    app: &App,
    room: Uuid,
    user: Uuid,
) -> Result<(RoomState, Uuid, String, i64, Option<protocol::ControlEpoch>)> {
    let mut tx = app.db.begin().await?;
    let row = sqlx::query(
        "SELECT owner_id,lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE",
    )
    .bind(room)
    .fetch_one(&mut *tx)
    .await?;
    let state: Value = sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    let membership = sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(room)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?;
    if membership.is_none() {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    let lifecycle: String = row.get("lifecycle");
    let control_epoch = if lifecycle == "active" {
        let id = Uuid::new_v4();
        let expires_at_ms: i64 = sqlx::query_scalar("INSERT INTO control_epochs(id,user_id,room_id) VALUES($1,$2,$3) RETURNING floor(extract(epoch FROM expires_at)*1000)::bigint")
            .bind(id).bind(user).bind(room).fetch_one(&mut *tx).await?;
        Some(protocol::ControlEpoch { id, expires_at_ms })
    } else {
        None
    };
    tx.commit().await?;
    Ok((
        serde_json::from_value(state).map_err(anyhow::Error::from)?,
        row.get("owner_id"),
        lifecycle,
        row.get("lifecycle_epoch"),
        control_epoch,
    ))
}

fn socket_error(reason: &str, command_id: Option<Uuid>) -> Value {
    let code = protocol::ErrorCode::from_reason(reason, 400);
    let error = protocol::ApiError::new(code, Uuid::new_v4());
    tracing::warn!(request_id = %error.request_id, ?code, "room request failed");
    json!({"type":"ERROR", "command_id":command_id, "error":error})
}

async fn socket_membership(
    app: &App,
    room: Uuid,
    user: Uuid,
) -> std::result::Result<(), &'static str> {
    // An admission read after a membership deletion commits cannot authorize a
    // new frame. Release the read before any network write; a slow connection
    // never holds a database/room lock while sending. Previously admitted bytes
    // may already be in transport buffers and cannot be recalled.
    match tokio::time::timeout(
        std::time::Duration::from_secs(2),
        database_checks::boolean(
            &app.db,
            sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)",
            )
            .bind(room)
            .bind(user),
            1500,
        ),
    )
    .await
    {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err("not_a_member"),
        _ => Err("service_unavailable"),
    }
}

async fn socket_access(
    app: &App,
    room: Uuid,
    user: Uuid,
    session_hash: &str,
) -> std::result::Result<(), &'static str> {
    socket_membership(app, room, user).await?;
    // Login authority is independent of optional presence negotiation. Legacy
    // sockets must not keep sending or receiving for the heartbeat interval.
    match tokio::time::timeout(std::time::Duration::from_secs(2), database_checks::boolean(
        &app.db,
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())")
            .bind(session_hash).bind(user),
        1500,
    )).await {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err("session_expired"),
        _ => Err("service_unavailable"),
    }
}

async fn reject_socket(
    out: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    reason: &str,
) {
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        out.send(Message::Text(socket_error(reason, None).to_string().into())),
    )
    .await;
}

async fn reject_with_presence(
    out: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    reason: &str,
    lease: Option<&presence_runtime::Lease>,
) {
    if matches!(
        reason,
        "not_a_member" | "session_expired" | "service_unavailable" | "rate_limited"
    ) && let Some(lease) = lease
    {
        lease.revoke();
    }
    reject_socket(out, reason).await;
}

async fn handle(app: &App, id: Uuid) -> Result<Handle> {
    let mut map = app.rooms.lock().await;
    if let Some(h) = map.get(&id) {
        return Ok(h.clone());
    }
    let mut state = persistence::snapshot(&app.db, id).await?;
    let (tx, mut rx) = mpsc::channel::<Request>(128);
    let events = delivery::Bus::new();
    let h = Handle {
        tx,
        events: events.clone(),
        presence: presence_runtime::Runtime::new(app, id, events.clone()),
    };
    map.insert(id, h.clone());
    let app = app.clone();
    tokio::spawn(async move {
        loop {
            let req =
                match tokio::time::timeout(std::time::Duration::from_secs(300), rx.recv()).await {
                    Ok(Some(req)) => req,
                    Ok(None) => break,
                    Err(_) => {
                        let mut rooms = app.rooms.lock().await;
                        if events.receiver_count() == 0 && rx.is_empty() {
                            rooms.remove(&id);
                            break;
                        }
                        continue;
                    }
                };
            let result: std::result::Result<(RoomState, bool), String> = async {
                if req.command.room_id != id {
                    return Err("room_mismatch".to_string());
                }
                // REST management can replace ownership while this actor stays
                // alive. The persisted snapshot is authoritative for every command.
                state = persistence::snapshot(&app.db, id)
                    .await.map_err(|_| "database_error".to_string())?;
                let active: bool = sqlx::query_scalar("SELECT lifecycle='active' FROM rooms WHERE id=$1")
                    .bind(id).fetch_one(&app.db).await.map_err(|_| "database_error".to_string())?;
                if !active { return Err("room_not_active".to_string()); }
                persistence::check_control_epoch(
                    &app.db,
                    id,
                    req.user_id,
                    req.command.control_epoch,
                )
                .await
                .map_err(|error| control_error(error, "database_error"))?;
                if let Some(previous) =
                    persistence::previous(&app.db, id, &req.command, req.user_id)
                        .await
                        .map_err(|error| match error.to_string().as_str() {
                            "room_not_active" => "room_not_active".to_string(),
                            "not_a_member" => "not_a_member".to_string(),
                            "control_epoch_expired" => "control_epoch_expired".to_string(),
                            "control_epoch_required" => "control_epoch_required".to_string(),
                            "command_owned_by_another_user" => {
                                "command_owned_by_another_user".to_string()
                            }
                            "command_payload_conflict" => "command_payload_conflict".to_string(),
                            "command_replay_unverifiable" => {
                                "command_replay_unverifiable".to_string()
                            }
                            _ => "database_error".to_string(),
                        })?
                {
                    return Ok((
                        if previous.clock_epoch == state.clock_epoch {
                            previous
                        } else {
                            state.clone()
                        },
                        false,
                    ));
                }
                let reducer_time_ms = app.now();
                // The final reduction belongs to the transaction, with the
                // current role and exact originating login held through commit.
                let mut media_id = match req.command.action {
                    protocol::Action::ChangeMedia { media_id } => Some(media_id),
                    _ => state.media_id,
                };
                if matches!(req.command.action, protocol::Action::EndMedia { .. }) {
                    let mut ids: Vec<Uuid> = sqlx::query_scalar(&format!("SELECT q.media_id FROM playlist_items q JOIN media_items m ON m.id=q.media_id JOIN sources s ON s.id=m.source_id WHERE q.room_id=$1 AND {} ORDER BY q.sort_order,q.id", media_titles::VISIBLE))
                        .bind(id).fetch_all(&app.db).await.map_err(|_| "database_error")?;
                    // Legacy playlists may contain duplicates. Without an item cursor,
                    // repeated media must not trap advancement at its first occurrence.
                    let mut seen = std::collections::HashSet::new();
                    ids.retain(|media| seen.insert(*media));
                    if !ids.is_empty() {
                        let index = ids.iter().position(|media| Some(*media) == state.media_id);
                        media_id = Some(ids[index.map_or(0, |i| (i + 1) % ids.len())]);
                    }
                }
                let mut resolved_media = None;
                if matches!(req.command.action, protocol::Action::ChangeMedia { .. } | protocol::Action::EndMedia { .. }) {
                    let media_id = media_id.ok_or("no_media")?;
                    let duration = sqlx::query(
                        &format!("SELECT m.duration_ms FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND {}", media_titles::VISIBLE),
                    )
                    .bind(media_id)
                    .fetch_optional(&app.db)
                    .await
                    .map_err(|_| "database_error".to_string())?
                    .ok_or("media_not_found")?;
                    let resolution = room_core::diagnostics::ResolvedMedia {
                        media_id,
                        duration_ms: duration.get("duration_ms"),
                    };
                    resolved_media = Some(resolution);
                }
                let next = persistence::commit(&app.db, &req.command, req.user_id, &req.session_hash, reducer_time_ms, resolved_media)
                    .await
                    .map_err(|error| control_error(error, "commit_failed"))?;
                state = next.clone();
                Ok((next, true))
            }
            .await;
            let value = match result {
                Ok((s, changed)) => {
                    if changed {
                        let _ = events
                            .send(json!({"type":"EVENT","state":s,"action":req.command.action}));
                    }
                    json!({"type":"ACK","command_id":req.command.command_id,"state":s,"action":req.command.action})
                }
                Err(error) => {
                    if let Ok(current) = persistence::snapshot(&app.db, id).await {
                        state = current;
                    }
                    let mut message = socket_error(&error, Some(req.command.command_id));
                    message["state"] = json!(state);
                    message
                }
            };
            let _ = req.reply.send(value);
        }
    });
    Ok(h)
}

fn control_error(error: anyhow::Error, fallback: &str) -> String {
    match error.to_string().as_str() {
        "control_epoch_required" => "control_epoch_required".into(),
        "control_epoch_expired" => "control_epoch_expired".into(),
        "revision_conflict" => "revision_conflict".into(),
        "controller_required" => "controller_required".into(),
        "room_not_active" => "room_not_active".into(),
        "not_a_member" => "not_a_member".into(),
        "session_expired" => "session_expired".into(),
        // Reducer validation now runs inside persistence's authority transaction.
        reason @ ("protocol_version"
        | "wrong_room"
        | "stale_media"
        | "no_media"
        | "invalid_position"
        | "invalid_rate"
        | "generation_overflow"
        | "revision_overflow") => reason.into(),
        _ => fallback.into(),
    }
}

pub async fn list(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let u = auth(&app, &h, false).await?;
    let rows=sqlx::query("SELECT r.id,r.name,r.owner_id,r.lifecycle,r.lifecycle_epoch FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.user_id=$1 ORDER BY r.created_at DESC").bind(u.id).fetch_all(&app.db).await?;
    Ok(Json(Value::Array(rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"owner_id":r.get::<Uuid,_>("owner_id"),"lifecycle":r.get::<String,_>("lifecycle"),"lifecycle_epoch":r.get::<i64,_>("lifecycle_epoch")})).collect())))
}
#[derive(Deserialize)]
pub struct Name {
    pub name: String,
}
pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Name>,
) -> Result<Json<Value>> {
    let u = auth(&app, &h, true).await?;
    if body.name.trim().is_empty() || body.name.chars().count() > 120 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_name"));
    }
    let id = Uuid::new_v4();
    let state = RoomState {
        room_id: id,
        revision: 0,
        media_id: None,
        media_generation: 0,
        playback_status: PlaybackStatus::Paused,
        anchor_position_ms: 0.0,
        anchor_server_time_ms: app.now(),
        playback_rate: 1.0,
        controller_user_id: u.id,
        duration_ms: None,
        clock_epoch: app.epoch,
    };
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,$2,$3)")
        .bind(id)
        .bind(body.name)
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2)")
        .bind(id)
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO room_snapshots VALUES($1,$2)")
        .bind(id)
        .bind(serde_json::to_value(state).unwrap())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id})))
}
async fn controller<'a>(
    app: &'a App,
    h: &HeaderMap,
    id: Uuid,
) -> Result<sqlx::Transaction<'a, sqlx::Postgres>> {
    let u = auth(app, h, true).await?;
    member(app, &u, id).await?;
    let mut tx = app.db.begin().await?;
    // Same order as joining: room first, then snapshot/invitation.
    persistence::room_lifecycle::lock_active(&mut tx, id)
        .await
        .map_err(room_lifecycle::gate_error)?;
    let value: Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let s: RoomState = serde_json::from_value(value).map_err(anyhow::Error::from)?;
    // Keep room -> snapshot -> member ordering. The earlier fast check cannot
    // authorize a mutation after membership is revoked while these locks wait.
    let membership: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(id)
    .bind(u.id)
    .fetch_optional(&mut *tx)
    .await?;
    if membership.is_none() {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    // Freeze current role and the exact authenticated login through commit.
    // FOR SHARE, unlike KEY SHARE, also conflicts with non-key admin/expiry
    // changes. Do not reacquire a pool connection via auth() while holding tx.
    let current_admin: Option<bool> =
        sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 FOR SHARE")
            .bind(u.id)
            .fetch_optional(&mut *tx)
            .await?;
    let login_hash =
        hash(&cookie(h).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))?);
    let csrf: Option<String> = sqlx::query_scalar(
        "SELECT csrf FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(&login_hash)
    .bind(u.id)
    .fetch_optional(&mut *tx)
    .await?;
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())",
    ).bind(&login_hash).bind(u.id).fetch_one(&mut *tx).await?;
    if !valid || csrf.is_none() || current_admin.is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    if h.get("x-csrf-token").and_then(|value| value.to_str().ok()) != csrf.as_deref() {
        return Err(err(StatusCode::FORBIDDEN, "csrf_rejected"));
    }
    if current_admin != Some(true) && s.controller_user_id != u.id {
        return Err(err(StatusCode::FORBIDDEN, "controller_required"));
    };
    Ok(tx)
}
async fn commit_controller(
    mut tx: sqlx::Transaction<'_, sqlx::Postgres>,
    h: &HeaderMap,
) -> Result<()> {
    // Row locks prevent revocation/role changes, not natural expiration while
    // a later INSERT/DELETE waits. Recheck the exact login at final admission.
    let login_hash =
        hash(&cookie(h).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))?);
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>clock_timestamp())",
    ).bind(login_hash).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    tx.commit().await?;
    Ok(())
}

pub async fn invite(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let mut tx = controller(&app, &h, id).await?;
    let t = token();
    sqlx::query("INSERT INTO invites VALUES($1,$2,now()+interval '24 hours',false)")
        .bind(hash(&t))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    commit_controller(tx, &h).await?;
    Ok(Json(json!({"token":t,"room_id":id})))
}
pub async fn revoke_invite(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, t)): Path<(Uuid, String)>,
) -> Result<Json<Value>> {
    let mut tx = controller(&app, &h, id).await?;
    sqlx::query("UPDATE invites SET revoked=true WHERE room_id=$1 AND token_hash=$2")
        .bind(id)
        .bind(hash(&t))
        .execute(&mut *tx)
        .await?;
    commit_controller(tx, &h).await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct Join {
    token: String,
}
pub async fn join(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Join>,
) -> Result<Json<Value>> {
    let u = auth(&app, &h, true).await?;
    let mut tx = app.db.begin().await?;
    persistence::room_lifecycle::lock_active(&mut tx, id)
        .await
        .map_err(room_lifecycle::gate_error)?;
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM invites WHERE room_id=$1 AND token_hash=$2 AND expires_at>now() AND NOT revoked)").bind(id).bind(hash(&body.token)).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(err(StatusCode::FORBIDDEN, "invalid_invite"));
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM room_members WHERE room_id=$1 AND user_id<>$2")
            .bind(id)
            .bind(u.id)
            .fetch_one(&mut *tx)
            .await?;
    if count >= 10 {
        return Err(err(StatusCode::CONFLICT, "room_full"));
    }
    sqlx::query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn playlist(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    member(&app, &u, id).await?;
    let rows=sqlx::query(&format!("{} JOIN playlist_items q ON q.media_id=m.id WHERE {} AND q.room_id=$2 ORDER BY q.sort_order,q.id", media_titles::SELECT.replace("SELECT m.id,", "SELECT q.id AS playlist_id,m.id,"), media_titles::VISIBLE)).bind(u.id).bind(id).fetch_all(&app.db).await?;
    Ok(media_titles::private_json(Value::Array(rows.iter().map(|r| {
        let media = media_titles::media(r);
        json!({"id":r.get::<Uuid,_>("playlist_id"),"media_id":media["id"],"title":media["title"],"cover":media["cover"]})
    }).collect())))
}
#[derive(Deserialize)]
pub struct Add {
    media_id: Uuid,
}
pub async fn add_playlist(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Add>,
) -> Result<Json<Value>> {
    let mut tx = controller(&app, &h, id).await?;
    if let Some(item) = sqlx::query_scalar::<_, Uuid>("SELECT id FROM playlist_items WHERE room_id=$1 AND media_id=$2 ORDER BY sort_order,id LIMIT 1")
        .bind(id).bind(body.media_id).fetch_optional(&mut *tx).await? {
        return Ok(Json(json!({"id":item})));
    }
    let available: bool = sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND {})", media_titles::VISIBLE))
        .bind(body.media_id).fetch_one(&mut *tx).await?;
    if !available {
        return Err(err(StatusCode::NOT_FOUND, "media_not_found"));
    }
    let item = Uuid::new_v4();
    sqlx::query("INSERT INTO playlist_items SELECT $1,$2,$3,COALESCE(max(sort_order),0)+1 FROM playlist_items WHERE room_id=$2").bind(item).bind(id).bind(body.media_id).execute(&mut *tx).await?;
    commit_controller(tx, &h).await?;
    Ok(Json(json!({"id":item})))
}
pub async fn remove_playlist(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, item)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let mut tx = controller(&app, &h, id).await?;
    sqlx::query("DELETE FROM playlist_items WHERE room_id=$1 AND id=$2")
        .bind(id)
        .bind(item)
        .execute(&mut *tx)
        .await?;
    commit_controller(tx, &h).await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct MessageCursor {
    after: Option<Uuid>,
}
pub async fn messages(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    axum::extract::Query(cursor): axum::extract::Query<MessageCursor>,
) -> Result<Json<Value>> {
    let u = auth(&app, &h, false).await?;
    member(&app, &u, id).await?;
    let rows = if let Some(after) = cursor.after {
        sqlx::query("SELECT c.id,c.body,c.user_id,u.username,COALESCE(p.display_name,u.username) AS display_name,a.version AS avatar_version,a.content_type AS avatar_content_type,floor(extract(epoch FROM c.created_at)*1000)::bigint AS created_at_ms FROM chat_messages c JOIN users u ON u.id=c.user_id LEFT JOIN user_profiles p ON p.user_id=u.id LEFT JOIN user_avatars a ON a.user_id=u.id WHERE c.room_id=$1 AND (NOT EXISTS(SELECT 1 FROM chat_messages WHERE id=$2 AND room_id=$1) OR (c.created_at,c.id) > (SELECT created_at,id FROM chat_messages WHERE id=$2 AND room_id=$1)) ORDER BY c.created_at,c.id LIMIT 100").bind(id).bind(after).fetch_all(&app.db).await?
    } else {
        sqlx::query("SELECT * FROM (SELECT c.id,c.body,c.user_id,u.username,COALESCE(p.display_name,u.username) AS display_name,a.version AS avatar_version,a.content_type AS avatar_content_type,c.created_at,floor(extract(epoch FROM c.created_at)*1000)::bigint AS created_at_ms FROM chat_messages c JOIN users u ON u.id=c.user_id LEFT JOIN user_profiles p ON p.user_id=u.id LEFT JOIN user_avatars a ON a.user_id=u.id WHERE room_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT 100) history ORDER BY created_at,id").bind(id).fetch_all(&app.db).await?
    };
    Ok(Json(Value::Array(rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"body":r.get::<String,_>("body"),"user_id":r.get::<Uuid,_>("user_id"),"username":r.get::<String,_>("username"),"display_name":r.get::<String,_>("display_name"),"created_at":r.get::<i64,_>("created_at_ms"),"avatar_url":avatars::url(r.get("user_id"),r.get("avatar_version"),r.get::<Option<String>,_>("avatar_content_type").is_some()),"avatar_version":r.get::<Option<Uuid>,_>("avatar_version")})).collect())))
}

async fn persist_chat(
    db: &sqlx::PgPool,
    room_id: Uuid,
    user_id: Uuid,
    body: &str,
    client_message_id: Option<Uuid>,
) -> std::result::Result<(Uuid, bool), &'static str> {
    let mut tx = db.begin().await.map_err(|_| "database_error")?;
    persistence::room_lifecycle::lock_active(&mut tx, room_id)
        .await
        .map_err(|error| {
            if error.to_string() == "room_not_active" {
                "room_not_active"
            } else {
                "database_error"
            }
        })?;
    // JOIN is not a permanent grant. Hold the same membership key-share used
    // by room management until the message commit, including idempotent replay.
    let membership = sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(room_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| "database_error")?;
    if membership.is_none() {
        return Err("not_a_member");
    }
    let inserted = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO chat_messages(id,room_id,user_id,body,client_message_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT (room_id,user_id,client_message_id) DO NOTHING RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind(room_id)
    .bind(user_id)
    .bind(body)
    .bind(client_message_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| "database_error")?;
    if let Some(id) = inserted {
        tx.commit().await.map_err(|_| "database_error")?;
        return Ok((id, false));
    }
    // The unique-index conflict waits for the concurrent insertion to commit.
    // Read in a new statement so its committed row is visible at READ COMMITTED.
    let existing = sqlx::query(
        "SELECT id,body FROM chat_messages WHERE room_id=$1 AND user_id=$2 AND client_message_id=$3",
    )
    .bind(room_id)
    .bind(user_id)
    .bind(client_message_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| "database_error")?;
    if existing.get::<String, _>("body") != body {
        return Err("invalid_request");
    }
    tx.commit().await.map_err(|_| "database_error")?;
    Ok((existing.get("id"), true))
}

pub async fn socket(app: App, user: User, socket: WebSocket, session_hash: String) {
    let (mut out, mut input) = socket.split();
    let first = tokio::time::timeout(std::time::Duration::from_secs(10), input.next()).await;
    let Ok(Some(Ok(Message::Text(text)))) = first else {
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        reject_socket(&mut out, "invalid_request").await;
        return;
    };
    if !matches!(v["type"].as_str(), Some("JOIN" | "RESUME")) {
        reject_socket(&mut out, "invalid_request").await;
        return;
    }
    let Some(id) = v["room_id"].as_str().and_then(|s| Uuid::parse_str(s).ok()) else {
        reject_socket(&mut out, "invalid_request").await;
        return;
    };
    if member(&app, &user, id).await.is_err() {
        reject_socket(&mut out, "not_a_member").await;
        return;
    };
    let Ok(handle) = handle(&app, id).await else {
        reject_socket(&mut out, "database_error").await;
        return;
    };
    let negotiated_presence =
        v["presence_version"].as_u64() == Some(u64::from(protocol::PRESENCE_VERSION));
    let negotiated_control_metrics = v["control_recovery_metrics_version"].as_u64()
        == Some(u64::from(protocol::TRANSPORT_METRICS_VERSION));
    let mut control_metrics_slot = control_recovery_metrics::Slot::default();
    let mut control_metrics_pending = tokio::task::JoinSet::new();
    let mut events = handle.events.subscribe_with_presence(negotiated_presence);
    let (s, owner_id, lifecycle, lifecycle_epoch, control_epoch) =
        match owned_snapshot(&app, id, user.id).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let reason = if error.1 == "not_a_member" {
                    "not_a_member"
                } else {
                    "database_error"
                };
                reject_socket(&mut out, reason).await;
                return;
            }
        };
    let mut recovery = "snapshot";
    let mut missing = Vec::<Value>::new();
    if v["type"] == "RESUME"
        && v["clock_epoch"] == s.clock_epoch.to_string()
        && let Some(revision) = v["revision"]
            .as_u64()
            .filter(|r| *r <= u64::from(s.revision))
    {
        let rows=sqlx::query("SELECT state FROM room_events WHERE room_id=$1 AND revision>$2 AND revision<=$3 ORDER BY revision LIMIT 1024").bind(id).bind(revision as i64).bind(i64::from(s.revision)).fetch_all(&app.db).await.unwrap_or_default();
        if rows.len() as u64 == u64::from(s.revision) - revision {
            recovery = "delta";
            missing = rows.iter().map(|r| r.get("state")).collect();
        }
    }
    if let Err(reason) = socket_access(&app, id, user.id, &session_hash).await {
        reject_socket(&mut out, reason).await;
        return;
    }
    let presence_lease = if negotiated_presence {
        match handle.presence.register(user.id, &session_hash) {
            Ok(lease) => Some(lease),
            Err(_) => {
                reject_socket(&mut out, "rate_limited").await;
                return;
            }
        }
    } else {
        None
    };
    let mut initial = json!({"type":"SNAPSHOT","state":s,"owner_id":owner_id,"recovery":recovery,"events":missing,"control_epoch":control_epoch,"lifecycle":lifecycle,"lifecycle_epoch":lifecycle_epoch});
    if negotiated_control_metrics {
        initial["control_recovery_metrics_version"] = json!(protocol::TRANSPORT_METRICS_VERSION);
    }
    if let Some(lease) = &presence_lease {
        match handle
            .presence
            .for_recipient(&app, user.id, &session_hash)
            .await
        {
            Ok(Some(presence)) => {
                initial["presence_connection_id"] = json!(lease.id);
                initial["presence"] = json!(presence);
            }
            Ok(None) => {
                reject_with_presence(&mut out, "service_unavailable", presence_lease.as_ref())
                    .await;
                return;
            }
            Err(reason) => {
                reject_with_presence(&mut out, reason, presence_lease.as_ref()).await;
                return;
            }
        }
        if lease.deadline().is_none() {
            reject_with_presence(&mut out, "service_unavailable", presence_lease.as_ref()).await;
            return;
        }
    }
    if !matches!(
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            out.send(Message::Text(initial.to_string().into()))
        )
        .await,
        Ok(Ok(()))
    ) {
        return;
    }
    let deadline = presence_lease
        .as_ref()
        .and_then(|lease| lease.deadline())
        .unwrap_or_else(|| Instant::now() + std::time::Duration::from_secs(3600));
    let lease_expiry = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline));
    tokio::pin!(lease_expiry);
    let mut probes = std::collections::VecDeque::<Vec<u8>>::with_capacity(3);
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(15));
    let mut last_seen = Instant::now();
    let mut window = Instant::now();
    let mut count = 0;
    loop {
        let mut value = tokio::select! {
            _ = control_metrics_pending.join_next(), if !control_metrics_pending.is_empty() => { continue; },
            _ = &mut lease_expiry, if negotiated_presence => { break; },
            _=heartbeat.tick()=>{
                if !negotiated_presence && last_seen.elapsed().as_secs()>45 {break};
                if let Err(reason)=socket_access(&app,id,user.id,&session_hash).await {reject_with_presence(&mut out, reason, presence_lease.as_ref()).await;break};
                let payload = if negotiated_presence {
                    let nonce = Uuid::new_v4().as_bytes().to_vec();
                    if probes.len() == 3 { probes.pop_front(); }
                    probes.push_back(nonce.clone());
                    nonce
                } else { Vec::new() };
                if !matches!(tokio::time::timeout(std::time::Duration::from_secs(5),out.send(Message::Ping(payload.into()))).await,Ok(Ok(()))) {break};continue;
            }
            event=events.recv()=>match event {Ok(v)=>v,Err(delivery::Lag::Control)=>{match owned_snapshot(&app,id,user.id).await{Ok((s,owner_id,lifecycle,lifecycle_epoch,control_epoch))=>json!({"type":"SNAPSHOT","state":s,"owner_id":owner_id,"lifecycle":lifecycle,"lifecycle_epoch":lifecycle_epoch,"control_epoch":control_epoch}),Err(_)=>break}},Err(delivery::Lag::Chat | delivery::Lag::Closed)=>break},
            message=input.next()=>{
                let Some(Ok(message))=message else{break};
                if let Message::Pong(payload) = &message {
                    last_seen=Instant::now();
                    if let Some(lease) = &presence_lease && let Some(index) = probes.iter().position(|probe| probe.as_slice() == payload.as_ref()) {
                            probes.remove(index);
                            if let Err(reason) = socket_access(&app,id,user.id,&session_hash).await { reject_with_presence(&mut out, reason, presence_lease.as_ref()).await;break; }
                            if !lease.renew() { break; }
                            if let Some(deadline) = lease.deadline() { lease_expiry.as_mut().reset(tokio::time::Instant::from_std(deadline)); }
                    }
                    continue;
                }
                let Message::Text(text)=message else{last_seen=Instant::now();continue};
                if window.elapsed().as_secs()>=1{window=Instant::now();count=0} count+=1;if count>30{reject_with_presence(&mut out, "rate_limited", presence_lease.as_ref()).await;break}
                let Ok(v)=serde_json::from_str::<Value>(&text)else{last_seen=Instant::now();reject_with_presence(&mut out, "invalid_request", presence_lease.as_ref()).await;continue};
                if v["type"] == "CONTROL_RECOVERY_METRICS" {
                    if let Some(task) = control_metrics_slot.begin(&app,id,user.id,&session_hash,negotiated_control_metrics,&text) {
                        control_metrics_pending.spawn(task);
                    }
                    continue;
                }
                last_seen=Instant::now();
                if let Err(reason)=socket_access(&app,id,user.id,&session_hash).await {reject_with_presence(&mut out, reason, presence_lease.as_ref()).await;break};
                match v["type"].as_str().unwrap_or("") {
                    "CLOCK_SYNC"=>{let t2=app.now();json!({"type":"CLOCK_SYNC_REPLY","t1":v["t1"],"t2":t2,"t3":app.now(),"clock_epoch":app.epoch})},
                    "CLIENT_STATUS"=>{app.metrics.report(&v["status"]);let _=handle.events.send(json!({"type":"CLIENT_STATUS","user_id":user.id,"status":v["status"]}));continue},
                    "CHAT"=>{
                        let Some(body)=v["body"].as_str().filter(|b|!b.trim().is_empty()&&b.chars().count()<=2000)else{reject_with_presence(&mut out, "invalid_request", presence_lease.as_ref()).await;continue};
                        let client_message_id = match v.get("client_message_id") {
                            None | Some(Value::Null) => None,
                            Some(value) => match value.as_str().and_then(|s| Uuid::parse_str(s).ok()) {
                                Some(key) => Some(key),
                                None => {reject_with_presence(&mut out, "invalid_request", presence_lease.as_ref()).await;continue},
                            },
                        };
                        let (cid,replayed)=match persist_chat(&app.db,id,user.id,body,client_message_id).await {
                            Ok(result)=>result,
                            Err(reason)=>{reject_with_presence(&mut out, reason, presence_lease.as_ref()).await;if reason=="not_a_member" {break};continue},
                        };
                        let identity=match profile::value(&app,user.id).await{Ok(value)=>value,Err(_)=>{reject_with_presence(&mut out, "database_error", presence_lease.as_ref()).await;break}};
                        let reply=json!({"type":"CHAT","id":cid,"user_id":user.id,"username":identity["username"],"display_name":identity["display_name"],"avatar_url":identity["avatar_url"],"avatar_version":identity["avatar_version"],"body":body,"client_message_id":client_message_id});
                        if replayed {
                            if let Err(reason)=socket_access(&app,id,user.id,&session_hash).await {reject_with_presence(&mut out, reason, presence_lease.as_ref()).await;break};
                            if !matches!(tokio::time::timeout(std::time::Duration::from_secs(5),out.send(Message::Text(reply.to_string().into()))).await,Ok(Ok(()))) {break}
                        } else {let _=handle.events.send(reply);}
                        continue
                    }
                    _=>{
                        let command_id = v["command_id"].as_str().and_then(|s|Uuid::parse_str(s).ok());
                        let Ok(command)=serde_json::from_value::<Command>(v)else{
                            let message = socket_error("invalid_request",command_id);
                            let _ = tokio::time::timeout(std::time::Duration::from_secs(5),out.send(Message::Text(message.to_string().into()))).await;
                            continue
                        };let(tx,rx)=oneshot::channel();
                        if handle.tx.try_send(Request{user_id:user.id,session_hash:session_hash.clone(),command,reply:tx}).is_err(){socket_error("room_busy",command_id)}else{match rx.await{Ok(v)=>v,Err(_)=>break}}
                    }
                }
            }
        };
        if value["type"] == "PRESENCE_SNAPSHOT" {
            // Never send a cached watch value: its subjects may have been revoked
            // or its epoch retired while this writer was awaiting other work.
            match handle
                .presence
                .for_recipient(&app, user.id, &session_hash)
                .await
            {
                Ok(Some(snapshot)) => {
                    value = json!(snapshot);
                    value["type"] = json!("PRESENCE_SNAPSHOT");
                }
                Ok(None) => continue,
                Err(reason) => {
                    reject_with_presence(&mut out, reason, presence_lease.as_ref()).await;
                    break;
                }
            }
        }
        let renew_control = value["action"]["type"] == "TRANSFER_OWNERSHIP"
            || (value["action"]["type"] == "ROOM_LIFECYCLE" && value["lifecycle"] == "active")
            || matches!(
                value["error"]["code"].as_str(),
                Some("CONTROL_EPOCH_REQUIRED" | "CONTROL_EPOCH_EXPIRED")
            );
        if renew_control {
            if let Err(reason) = socket_access(&app, id, user.id, &session_hash).await {
                reject_with_presence(&mut out, reason, presence_lease.as_ref()).await;
                break;
            }
            if let Ok(epoch) = persistence::issue_control_epoch(&app.db, id, user.id).await {
                value["control_epoch"] = json!(epoch);
            }
        }
        // Presence has just checked recipient and subjects in one final read.
        if value["type"] != "PRESENCE_SNAPSHOT"
            && let Err(reason) = socket_access(&app, id, user.id, &session_hash).await
        {
            reject_with_presence(&mut out, reason, presence_lease.as_ref()).await;
            break;
        }
        if presence_lease
            .as_ref()
            .is_some_and(|lease| lease.deadline().is_none())
        {
            break;
        }
        if !matches!(
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                out.send(Message::Text(value.to_string().into()))
            )
            .await,
            Ok(Ok(()))
        ) {
            break;
        }
    }
    // Abort optional owned authorization work before waiting on close transport.
    drop(control_metrics_pending);
    drop(presence_lease);
    // Do not drop a TCP socket with unread burst frames immediately after its
    // terminal ERROR. Complete the WebSocket close handshake so the peer can
    // receive that error instead of only observing an abnormal reset.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        if out.send(Message::Close(None)).await.is_err() {
            return;
        }
        while let Some(Ok(message)) = input.next().await {
            if matches!(message, Message::Close(_)) {
                let _ = out.flush().await;
                break;
            }
        }
    })
    .await;
}
