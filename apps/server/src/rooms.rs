use super::*;
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use protocol::{Command, PlaybackStatus, RoomState};
use tokio::sync::{broadcast, mpsc, oneshot};

#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<Request>,
    events: broadcast::Sender<Value>,
}
struct Request {
    user: User,
    command: Command,
    reply: oneshot::Sender<Value>,
}

fn socket_error(reason: &str, command_id: Option<Uuid>) -> Value {
    let code = protocol::ErrorCode::from_reason(reason, 400);
    let error = protocol::ApiError::new(code, Uuid::new_v4());
    tracing::warn!(request_id = %error.request_id, ?code, "room request failed");
    json!({"type":"ERROR", "command_id":command_id, "error":error})
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

async fn handle(app: &App, id: Uuid) -> Result<Handle> {
    let mut map = app.rooms.lock().await;
    if let Some(h) = map.get(&id) {
        return Ok(h.clone());
    }
    let mut state = persistence::snapshot(&app.db, id).await?;
    let (tx, mut rx) = mpsc::channel::<Request>(128);
    let (events, _) = broadcast::channel(128);
    let h = Handle {
        tx,
        events: events.clone(),
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
                persistence::check_control_epoch(
                    &app.db,
                    id,
                    req.user.id,
                    req.command.control_epoch,
                )
                .await
                .map_err(|error| control_error(error, "database_error"))?;
                if let Some(previous) =
                    persistence::previous(&app.db, id, &req.command, req.user.id)
                        .await
                        .map_err(|error| match error.to_string().as_str() {
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
                let mut next =
                    room_core::reduce(&state, &req.command, req.user.id, req.user.admin, app.now())
                        .map_err(String::from)?;
                if let protocol::Action::ChangeMedia { media_id } = req.command.action {
                    let duration = sqlx::query(
                        "SELECT duration_ms FROM media_items WHERE id=$1 AND available",
                    )
                    .bind(media_id)
                    .fetch_optional(&app.db)
                    .await
                    .map_err(|_| "database_error".to_string())?
                    .ok_or("media_not_found")?;
                    next.duration_ms = duration.get("duration_ms");
                }
                persistence::commit(&app.db, &next, &req.command, req.user.id, state.revision)
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
        _ => fallback.into(),
    }
}

pub async fn list(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let u = auth(&app, &h, false).await?;
    let rows=sqlx::query("SELECT r.id,r.name,r.owner_id FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.user_id=$1 ORDER BY r.created_at DESC").bind(u.id).fetch_all(&app.db).await?;
    Ok(Json(Value::Array(rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"owner_id":r.get::<Uuid,_>("owner_id")})).collect())))
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
    sqlx::query("INSERT INTO room_members VALUES($1,$2)")
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
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let value: Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let s: RoomState = serde_json::from_value(value).map_err(anyhow::Error::from)?;
    if !u.admin && s.controller_user_id != u.id {
        return Err(err(StatusCode::FORBIDDEN, "controller_required"));
    };
    Ok(tx)
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
    tx.commit().await?;
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
    tx.commit().await?;
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
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
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
    sqlx::query("INSERT INTO room_members VALUES($1,$2) ON CONFLICT DO NOTHING")
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
) -> Result<Json<Value>> {
    let u = auth(&app, &h, false).await?;
    member(&app, &u, id).await?;
    let rows=sqlx::query("SELECT p.id,p.media_id,m.title FROM playlist_items p JOIN media_items m ON m.id=p.media_id WHERE room_id=$1 ORDER BY sort_order,id").bind(id).fetch_all(&app.db).await?;
    Ok(Json(Value::Array(rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"media_id":r.get::<Uuid,_>("media_id"),"title":r.get::<String,_>("title")})).collect())))
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
    let item = Uuid::new_v4();
    sqlx::query("INSERT INTO playlist_items SELECT $1,$2,$3,COALESCE(max(sort_order),0)+1 FROM playlist_items WHERE room_id=$2").bind(item).bind(id).bind(body.media_id).execute(&mut *tx).await?;
    tx.commit().await?;
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
    tx.commit().await?;
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
    let inserted = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO chat_messages(id,room_id,user_id,body,client_message_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT (room_id,user_id,client_message_id) DO NOTHING RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind(room_id)
    .bind(user_id)
    .bind(body)
    .bind(client_message_id)
    .fetch_optional(db)
    .await
    .map_err(|_| "database_error")?;
    if let Some(id) = inserted {
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
    .fetch_one(db)
    .await
    .map_err(|_| "database_error")?;
    if existing.get::<String, _>("body") != body {
        return Err("invalid_request");
    }
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
    let mut events = handle.events.subscribe();
    let Ok(s) = persistence::snapshot(&app.db, id).await else {
        reject_socket(&mut out, "database_error").await;
        return;
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
    let Ok(control_epoch) = persistence::issue_control_epoch(&app.db, id, user.id).await else {
        reject_socket(&mut out, "database_error").await;
        return;
    };
    if out
        .send(Message::Text(
            json!({"type":"SNAPSHOT","state":s,"recovery":recovery,"events":missing,"control_epoch":control_epoch})
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(15));
    let mut last_seen = Instant::now();
    let mut window = Instant::now();
    let mut count = 0;
    loop {
        let mut value = tokio::select! {
            _=heartbeat.tick()=>{
                if last_seen.elapsed().as_secs()>45 {break};
                let valid=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>now())").bind(&session_hash).fetch_one(&app.db).await;
                match valid {
                    Ok(true) => {},
                    Ok(false) => {reject_socket(&mut out,"session_expired").await;break},
                    Err(_) => {reject_socket(&mut out,"service_unavailable").await;break},
                }
                let _=out.send(Message::Ping(Vec::new().into())).await;continue;
            }
            event=events.recv()=>match event {Ok(v)=>v,Err(broadcast::error::RecvError::Lagged(_))=>{match persistence::snapshot(&app.db,id).await{Ok(s)=>json!({"type":"SNAPSHOT","state":s}),Err(_)=>break}},Err(_)=>break},
            message=input.next()=>{
                let Some(Ok(message))=message else{break};last_seen=Instant::now();
                let Message::Text(text)=message else{continue};
                if window.elapsed().as_secs()>=1{window=Instant::now();count=0} count+=1;if count>30{reject_socket(&mut out,"rate_limited").await;break}
                let Ok(v)=serde_json::from_str::<Value>(&text)else{reject_socket(&mut out,"invalid_request").await;continue};
                match v["type"].as_str().unwrap_or("") {
                    "CLOCK_SYNC"=>{let t2=app.now();json!({"type":"CLOCK_SYNC_REPLY","t1":v["t1"],"t2":t2,"t3":app.now(),"clock_epoch":app.epoch})},
                    "CLIENT_STATUS"=>{app.metrics.report(&v["status"]);let _=handle.events.send(json!({"type":"CLIENT_STATUS","user_id":user.id,"status":v["status"]}));continue},
                    "CHAT"=>{
                        let Some(body)=v["body"].as_str().filter(|b|!b.trim().is_empty()&&b.chars().count()<=2000)else{reject_socket(&mut out,"invalid_request").await;continue};
                        let client_message_id = match v.get("client_message_id") {
                            None | Some(Value::Null) => None,
                            Some(value) => match value.as_str().and_then(|s| Uuid::parse_str(s).ok()) {
                                Some(key) => Some(key),
                                None => {reject_socket(&mut out,"invalid_request").await;continue},
                            },
                        };
                        let (cid,replayed)=match persist_chat(&app.db,id,user.id,body,client_message_id).await {
                            Ok(result)=>result,
                            Err(reason)=>{reject_socket(&mut out,reason).await;continue},
                        };
                        let identity=match profile::value(&app,user.id).await{Ok(value)=>value,Err(_)=>{reject_socket(&mut out,"database_error").await;break}};
                        let reply=json!({"type":"CHAT","id":cid,"user_id":user.id,"username":identity["username"],"display_name":identity["display_name"],"avatar_url":identity["avatar_url"],"avatar_version":identity["avatar_version"],"body":body,"client_message_id":client_message_id});
                        if replayed {
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
                        if handle.tx.try_send(Request{user:user.clone(),command,reply:tx}).is_err(){socket_error("room_busy",command_id)}else{match rx.await{Ok(v)=>v,Err(_)=>break}}
                    }
                }
            }
        };
        if matches!(
            value["error"]["code"].as_str(),
            Some("CONTROL_EPOCH_REQUIRED" | "CONTROL_EPOCH_EXPIRED")
        ) && let Ok(epoch) = persistence::issue_control_epoch(&app.db, id, user.id).await
        {
            value["control_epoch"] = json!(epoch);
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
