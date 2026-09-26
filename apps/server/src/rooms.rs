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
                if let Some(previous) =
                    persistence::previous(&app.db, id, req.command.command_id, req.user.id)
                        .await
                        .map_err(|_| "database_error".to_string())?
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
                    let duration = sqlx::query("SELECT duration_ms FROM media_items WHERE id=$1")
                        .bind(media_id)
                        .fetch_optional(&app.db)
                        .await
                        .map_err(|_| "database_error".to_string())?
                        .ok_or("media_not_found")?;
                    next.duration_ms = duration.get("duration_ms");
                }
                persistence::commit(
                    &app.db,
                    &next,
                    req.command.command_id,
                    req.user.id,
                    state.revision,
                )
                .await
                .map_err(|_| "commit_failed".to_string())?;
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
                    json!({"type":"ERROR","command_id":req.command.command_id,"error":error,"state":state})
                }
            };
            let _ = req.reply.send(value);
        }
    });
    Ok(h)
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
    if body.name.trim().is_empty() || body.name.len() > 120 {
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
async fn controller(app: &App, h: &HeaderMap, id: Uuid) -> Result<User> {
    let u = auth(app, h, true).await?;
    member(app, &u, id).await?;
    let s = persistence::snapshot(&app.db, id).await?;
    if !u.admin && s.controller_user_id != u.id {
        return Err(err(StatusCode::FORBIDDEN, "controller_required"));
    };
    Ok(u)
}
pub async fn invite(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    controller(&app, &h, id).await?;
    let t = token();
    sqlx::query("INSERT INTO invites VALUES($1,$2,now()+interval '24 hours',false)")
        .bind(hash(&t))
        .bind(id)
        .execute(&app.db)
        .await?;
    Ok(Json(json!({"token":t,"room_id":id})))
}
pub async fn revoke_invite(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, t)): Path<(Uuid, String)>,
) -> Result<Json<Value>> {
    controller(&app, &h, id).await?;
    sqlx::query("UPDATE invites SET revoked=true WHERE room_id=$1 AND token_hash=$2")
        .bind(id)
        .bind(hash(&t))
        .execute(&app.db)
        .await?;
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
    controller(&app, &h, id).await?;
    let item = Uuid::new_v4();
    sqlx::query("INSERT INTO playlist_items SELECT $1,$2,$3,COALESCE(max(sort_order),0)+1 FROM playlist_items WHERE room_id=$2").bind(item).bind(id).bind(body.media_id).execute(&app.db).await?;
    Ok(Json(json!({"id":item})))
}
pub async fn remove_playlist(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, item)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    controller(&app, &h, id).await?;
    sqlx::query("DELETE FROM playlist_items WHERE room_id=$1 AND id=$2")
        .bind(id)
        .bind(item)
        .execute(&app.db)
        .await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn messages(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let u = auth(&app, &h, false).await?;
    member(&app, &u, id).await?;
    let rows=sqlx::query("SELECT c.id,c.body,u.username FROM chat_messages c JOIN users u ON u.id=c.user_id WHERE room_id=$1 ORDER BY c.created_at DESC LIMIT 100").bind(id).fetch_all(&app.db).await?;
    Ok(Json(Value::Array(rows.iter().rev().map(|r|json!({"id":r.get::<Uuid,_>("id"),"body":r.get::<String,_>("body"),"username":r.get::<String,_>("username")})).collect())))
}

pub async fn socket(app: App, user: User, socket: WebSocket, session_hash: String) {
    let (mut out, mut input) = socket.split();
    let first = tokio::time::timeout(std::time::Duration::from_secs(10), input.next()).await;
    let Ok(Some(Ok(Message::Text(text)))) = first else {
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let Some(id) = v["room_id"].as_str().and_then(|s| Uuid::parse_str(s).ok()) else {
        return;
    };
    if member(&app, &user, id).await.is_err() {
        return;
    };
    let Ok(handle) = handle(&app, id).await else {
        return;
    };
    let mut events = handle.events.subscribe();
    let Ok(s) = persistence::snapshot(&app.db, id).await else {
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
    if out
        .send(Message::Text(
            json!({"type":"SNAPSHOT","state":s,"recovery":recovery,"events":missing})
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
        let value = tokio::select! {
            _=heartbeat.tick()=>{
                if last_seen.elapsed().as_secs()>45 {break};
                let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>now())").bind(&session_hash).fetch_one(&app.db).await.unwrap_or(false);
                if !valid{break}
                let _=out.send(Message::Ping(Vec::new().into())).await;continue;
            }
            event=events.recv()=>match event {Ok(v)=>v,Err(broadcast::error::RecvError::Lagged(_))=>{match persistence::snapshot(&app.db,id).await{Ok(s)=>json!({"type":"SNAPSHOT","state":s}),Err(_)=>break}},Err(_)=>break},
            message=input.next()=>{
                let Some(Ok(message))=message else{break};last_seen=Instant::now();
                let Message::Text(text)=message else{continue};
                if window.elapsed().as_secs()>=1{window=Instant::now();count=0} count+=1;if count>30{break}
                let Ok(v)=serde_json::from_str::<Value>(&text)else{continue};
                match v["type"].as_str().unwrap_or("") {
                    "CLOCK_SYNC"=>{let t2=app.now();json!({"type":"CLOCK_SYNC_REPLY","t1":v["t1"],"t2":t2,"t3":app.now(),"clock_epoch":app.epoch})},
                    "CLIENT_STATUS"=>{app.metrics.report(&v["status"]);let _=handle.events.send(json!({"type":"CLIENT_STATUS","user_id":user.id,"status":v["status"]}));continue},
                    "CHAT"=>{
                        let Some(body)=v["body"].as_str().filter(|b|!b.trim().is_empty()&&b.len()<=2000)else{continue};let cid=Uuid::new_v4();
                        if sqlx::query("INSERT INTO chat_messages(id,room_id,user_id,body) VALUES($1,$2,$3,$4)").bind(cid).bind(id).bind(user.id).bind(body).execute(&app.db).await.is_err(){break}
                        let name:String=sqlx::query_scalar("SELECT username FROM users WHERE id=$1").bind(user.id).fetch_one(&app.db).await.unwrap_or_default();
                        let _=handle.events.send(json!({"type":"CHAT","id":cid,"username":name,"body":body}));continue
                    }
                    _=>{
                        let Ok(command)=serde_json::from_value::<Command>(v)else{continue};let(tx,rx)=oneshot::channel();
                        if handle.tx.try_send(Request{user:user.clone(),command,reply:tx}).is_err(){json!({"type":"ERROR","error":"room_busy"})}else{match rx.await{Ok(v)=>v,Err(_)=>break}}
                    }
                }
            }
        };
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
}
