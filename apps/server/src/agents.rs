use super::*;
use axum::extract::ws::Message;
use futures_util::{SinkExt, StreamExt};
use sqlx::Connection;

// The Agent sends a heartbeat every five seconds. Six missed intervals close
// only that connection; indexed-content readiness remains a separate fact.
const CONTROL_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub struct Control {
    pub(super) connection: Uuid,
    last_received: tokio::time::Instant,
    scans: tokio::sync::mpsc::Sender<Scan>,
    manual_scan: bool,
    source_versions: Option<bool>,
    drain_receipts: Option<bool>,
}
impl Control {
    fn live_at(&self, now: tokio::time::Instant) -> bool {
        now.saturating_duration_since(self.last_received) < CONTROL_IDLE_TIMEOUT
            && !self.scans.is_closed()
    }
}

// Cancelled control writes must never return an unfinished query to the pool.
struct ControlDatabaseConnection {
    connection: sqlx::pool::PoolConnection<sqlx::Postgres>,
    reusable: bool,
}
impl Drop for ControlDatabaseConnection {
    fn drop(&mut self) {
        if !self.reusable {
            self.connection.close_on_drop();
        }
    }
}

// Persist one received timestamp at a time, coalescing any newer input into one
// watch slot. Row contention must not prevent ordinary control/metrics dispatch.
async fn persist_control_activity(
    app: App,
    id: Uuid,
    connection: Uuid,
    token_hash: String,
    mut incoming: tokio::sync::watch::Receiver<f64>,
) -> anyhow::Result<bool> {
    while incoming.changed().await.is_ok() {
        let received_at = *incoming.borrow_and_update();
        let current = tokio::time::timeout(CONTROL_IDLE_TIMEOUT, async {
            let mut owned = ControlDatabaseConnection {
                connection: app.db.acquire().await?,
                reusable: false,
            };
            let updated = sqlx::query("UPDATE agents SET last_seen=GREATEST(last_seen,to_timestamp($3)) WHERE id=$1 AND advanced_assets_connection=$2 AND token_hash=$4 AND NOT revoked")
                .bind(id).bind(connection).bind(received_at).bind(&token_hash)
                .execute(&mut *owned.connection).await?;
            owned.reusable = true;
            Ok::<_, sqlx::Error>(updated.rows_affected() == 1)
        }).await??;
        if !current {
            return Ok(true);
        }
    }
    Ok(false)
}

// Admission is a nonlocking current-identity read; durable side effects retain
// their own authority locks. Capture actual receipt before any database await.
async fn record_control_activity(
    app: &App,
    id: Uuid,
    connection: Uuid,
    token_hash: &str,
    activity: &tokio::sync::watch::Sender<f64>,
) -> anyhow::Result<Option<tokio::time::Instant>> {
    let received = tokio::time::Instant::now();
    let received_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs_f64();
    let current = sqlx::query("SELECT id FROM agents WHERE id=$1 AND advanced_assets_connection=$2 AND token_hash=$3 AND NOT revoked")
        .bind(id).bind(connection).bind(token_hash).fetch_optional(&app.db).await?;
    if current.is_none() {
        return Ok(None);
    }
    let mut controls = app.agent_controls.lock().await;
    let Some(control) = controls
        .get_mut(&id)
        .filter(|control| control.connection == connection)
    else {
        return Ok(None);
    };
    activity.send(received_at)?;
    control.last_received = received;
    Ok(Some(received))
}

async fn settle_control_receipt(
    app: &App,
    id: Uuid,
    connection: Uuid,
    token_hash: &str,
    transfer: Uuid,
) -> anyhow::Result<Option<bool>> {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let mut owned = ControlDatabaseConnection {
            connection: app.db.acquire().await?,
            reusable: false,
        };
        let mut tx = owned.connection.begin().await?;
        sqlx::query("SELECT set_config('statement_timeout','1500ms',true),set_config('lock_timeout','750ms',true)")
            .execute(&mut *tx).await?;
        let current = sqlx::query("SELECT id FROM agents WHERE id=$1 AND token_hash=$2 AND advanced_assets_connection=$3 AND NOT revoked FOR SHARE")
            .bind(id).bind(token_hash).bind(connection).fetch_optional(&mut *tx).await?;
        let accepted = if current.is_some() {
            Some(sqlx::query("UPDATE agent_transfer_runs SET agent_drained_at=COALESCE(agent_drained_at,clock_timestamp()) WHERE id=$1 AND agent_id=$2 AND dispatched_at IS NOT NULL")
                .bind(transfer).bind(id).execute(&mut *tx).await?.rows_affected() == 1)
        } else {
            None
        };
        tx.commit().await?;
        owned.reusable = true;
        Ok(accepted)
    }).await?
}

struct Scan {
    id: Uuid,
    reply: tokio::sync::oneshot::Sender<&'static str>,
}
// Wait for a committed matching snapshot, never report a dispatched request as success.
pub async fn scan(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    admin(&auth(&app, &h, true).await?)?;
    let valid: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agents WHERE id=$1 AND NOT revoked)")
            .bind(id)
            .fetch_one(&app.db)
            .await?;
    if !valid {
        return Err(err(StatusCode::NOT_FOUND, "invalid_agent"));
    }
    let (reply, result) = tokio::sync::oneshot::channel();
    let controls = app.agent_controls.lock().await;
    let Some(control) = controls
        .get(&id)
        .filter(|c| c.live_at(tokio::time::Instant::now()))
    else {
        return Ok(Json(json!({"status":"offline"})));
    };
    if control
        .scans
        .try_send(Scan {
            id: Uuid::new_v4(),
            reply,
        })
        .is_err()
    {
        return Ok(Json(json!({"status":"busy"})));
    }
    drop(controls);
    let mut status = match tokio::time::timeout(std::time::Duration::from_secs(120), result).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => "disconnected",
        Err(_) => "timeout",
    };
    let (count, unversioned_count) = if status == "complete" {
        let row = sqlx::query("SELECT count(*) AS count,count(*) FILTER (WHERE source_version IS NULL OR source_version !~ '^stat-v1:[0-9a-f]{64}$') AS unversioned_count FROM media_items WHERE source_id=$1 AND available")
            .bind(id)
            .fetch_one(&app.db)
            .await?;
        (
            row.get::<i64, _>("count"),
            row.get::<i64, _>("unversioned_count"),
        )
    } else {
        (0, 0)
    };
    // A legacy snapshot is still useful for browsing, but must never be
    // reported as a successful recovery of version-bound playback.
    if unversioned_count > 0 {
        status = "upgrade_required";
    }
    Ok(Json(
        json!({"status":status,"count":count,"unversioned_count":unversioned_count}),
    ))
}

fn source_version_status(
    count: i64,
    unversioned_count: i64,
    capable: Option<bool>,
) -> &'static str {
    if count == 0 {
        "empty"
    } else if unversioned_count == 0 {
        "ready"
    } else if capable == Some(false) {
        "upgrade_required"
    } else {
        "rescan_required"
    }
}

pub async fn list(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin(&auth(&app, &h, false).await?)?;
    let rows = sqlx::query("SELECT a.id,a.name,a.revoked,a.last_seen::text,count(m.id) AS indexed_count,count(m.id) FILTER (WHERE m.source_version IS NULL OR m.source_version !~ '^stat-v1:[0-9a-f]{64}$') AS unversioned_count FROM agents a LEFT JOIN media_items m ON m.source_id=a.id AND m.available GROUP BY a.id ORDER BY a.name,a.id")
        .fetch_all(&app.db)
        .await?;
    let controls = app.agent_controls.lock().await;
    Ok(Json(Value::Array(rows.iter().map(|r| {
        let id: Uuid = r.get("id");
        let revoked: bool = r.get("revoked");
        let control = controls.get(&id).filter(|c| !revoked && c.live_at(tokio::time::Instant::now()));
        let count: i64 = r.get("indexed_count");
        let unversioned_count: i64 = r.get("unversioned_count");
        let capable = control.and_then(|c| c.source_versions);
        json!({
            "id":id,"name":r.get::<String,_>("name"),"revoked":revoked,
            "last_seen":r.get::<Option<String>,_>("last_seen"),
            "connected":control.is_some(),"manual_scan":control.is_some_and(|c| c.manual_scan),
            "source_versions":capable,"drain_receipts":control.and_then(|c|c.drain_receipts),"indexed_count":count,"unversioned_count":unversioned_count,
            "source_version_status":source_version_status(count, unversioned_count, capable)
        })
    }).collect())))
}

fn validated_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_agent_name"));
    }
    Ok(name)
}

// Hold role/login authority before any device or policy locks; repeat before commit
// because wall-clock expiry can pass while a settings request is waiting.
pub(super) async fn lock_settings_admin(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: &User,
    h: &HeaderMap,
) -> Result<()> {
    let login = media_authorization::login_hash(h)?;
    let role: Option<bool> = sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM account_exits WHERE user_id=$1) FOR SHARE")
        .bind(user.id).fetch_optional(&mut **tx).await?;
    if role != Some(true) {
        return Err(err(StatusCode::FORBIDDEN, "admin_required"));
    }
    let live: Option<Uuid> = sqlx::query_scalar("SELECT user_id FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE")
        .bind(login).bind(user.id).fetch_optional(&mut **tx).await?;
    if live.is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    name: String,
    expected_name: String,
}

pub async fn update(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Settings>,
) -> Result<Json<Value>> {
    let user = auth(&app, &h, true).await?;
    admin(&user)?;
    let name = validated_name(&body.name)?;
    let mut tx = app.db.begin().await?;
    lock_settings_admin(&mut tx, &user, &h).await?;
    // Serialize with revocation, policy edits and initial source creation.
    let current: Option<String> =
        sqlx::query_scalar("SELECT name FROM agents WHERE id=$1 AND NOT revoked FOR NO KEY UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let current = current.ok_or_else(|| err(StatusCode::NOT_FOUND, "invalid_agent"))?;
    if current != body.expected_name {
        return Err(err(StatusCode::CONFLICT, "agent_settings_conflict"));
    }
    sqlx::query("UPDATE agents SET name=$2 WHERE id=$1")
        .bind(id)
        .bind(name)
        .execute(&mut *tx)
        .await?;
    // Keep the existing source identity, encrypted configuration and media index.
    sqlx::query("UPDATE sources SET name=$2 WHERE id=$1 AND kind='agent'")
        .bind(id)
        .bind(name)
        .execute(&mut *tx)
        .await?;
    lock_settings_admin(&mut tx, &user, &h).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"name":name})))
}

pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<rooms::Name>,
) -> Result<Json<Value>> {
    admin(&auth(&app, &h, true).await?)?;
    let name = validated_name(&body.name)?;
    let id = Uuid::new_v4();
    let code = token();
    sqlx::query("INSERT INTO agents(id,name,pair_hash,pair_expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')").bind(id).bind(name).bind(hash(&code)).execute(&app.db).await?;
    Ok(Json(json!({"id":id,"pair_code":code})))
}
#[derive(Deserialize)]
pub struct Pair {
    code: String,
}
pub async fn pair(State(app): State<App>, Json(body): Json<Pair>) -> Result<Json<Value>> {
    let t = token();
    let id:Option<Uuid>=sqlx::query_scalar("UPDATE agents SET token_hash=$2,pair_hash=NULL WHERE pair_hash=$1 AND pair_expires_at>now() AND NOT revoked RETURNING id").bind(hash(&body.code)).bind(hash(&t)).fetch_optional(&app.db).await?;
    let id = id.ok_or_else(|| err(StatusCode::FORBIDDEN, "pair_code_invalid"))?;
    Ok(Json(json!({"agent_id":id,"token":t})))
}
pub async fn revoke(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    admin(&auth(&app, &h, true).await?)?;
    sqlx::query("UPDATE agents SET revoked=true,token_hash=NULL WHERE id=$1")
        .bind(id)
        .execute(&app.db)
        .await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn connect(
    State(app): State<App>,
    h: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response> {
    let t = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "agent_token_required"))?;
    let token_hash = hash(t);
    let id: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM agents WHERE token_hash=$1 AND NOT revoked")
            .bind(&token_hash)
            .fetch_optional(&app.db)
            .await?;
    let id = id.ok_or_else(|| err(StatusCode::UNAUTHORIZED, "invalid_agent"))?;
    Ok(upgrade.max_message_size(1024 * 1024).max_frame_size(1024 * 1024).on_upgrade(move |socket| async move {
        let (mut out, mut input) = socket.split();
        let connection = Uuid::new_v4();
        let (scan_tx, mut scans) = tokio::sync::mpsc::channel::<Scan>(1);
        let mut last_received = tokio::time::Instant::now();
        {
            // Lock the agent before the control map, matching optional metrics.
            // Commit the replacement identity while holding the map lock.
            let Ok(mut tx) = app.db.begin().await else { return; };
            let installed = sqlx::query("UPDATE agents SET advanced_assets_version=0,advanced_assets_connection=$2,last_seen=clock_timestamp() WHERE id=$1 AND token_hash=$3 AND NOT revoked")
                .bind(id).bind(connection).bind(&token_hash).execute(&mut *tx).await;
            if !matches!(installed, Ok(result) if result.rows_affected() == 1) { return; }
            let mut controls = app.agent_controls.lock().await;
            if tx.commit().await.is_err() { return; }
            controls.insert(id, Control { connection, last_received, scans: scan_tx, manual_scan: false, source_versions: None, drain_receipts: None });
        }
        let mut uplink_metrics = crate::agent_metrics::Receiver::new(app.metrics.runtime.clone(), id, connection, token_hash.clone());
        let (activity, incoming_activity) = tokio::sync::watch::channel(0.0);
        let mut activity_tasks = tokio::task::JoinSet::new();
        activity_tasks.spawn(persist_control_activity(app.clone(), id, connection, token_hash.clone(), incoming_activity));
        let mut identity_retired = false;
        let mut supports_scan = false;
        let mut pending: Option<Scan> = None;
        let (pages, incoming) = tokio::sync::mpsc::channel(1);
        let (acks, mut completed) = tokio::sync::mpsc::channel(1);
        let ingest_app = app.clone();
        let ingest_token_hash = token_hash.clone();
        let ingest = tokio::spawn(async move {
            if ingest_index(ingest_app, id, connection, ingest_token_hash, incoming, acks.clone()).await.is_err() {
                let _ = acks.send(json!({"type":"INDEX_ERROR"})).await;
            }
        });
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
        loop { tokio::select! {
            _ = tokio::time::sleep_until(last_received + CONTROL_IDLE_TIMEOUT) => break,
            _ = uplink_metrics.poll_pending() => {},
            result = activity_tasks.join_next() => {
                identity_retired = matches!(result, Some(Ok(Ok(true))));
                break;
            },
            request = scans.recv() => {
                let Some(request) = request else {
                    // Installing a replacement drops the old registry sender.
                    // Distinguish that positive identity loss from disconnection.
                    identity_retired = app.agent_controls.lock().await.get(&id)
                        .is_some_and(|control| control.connection != connection);
                    break;
                };
                if !supports_scan { let _ = request.reply.send("unsupported"); continue; }
                if pending.is_some() { let _ = request.reply.send("busy"); continue; }
                let message = json!({"type":"SCAN","snapshot":request.id});
                if !matches!(tokio::time::timeout(std::time::Duration::from_secs(3), out.send(Message::Text(message.to_string().into()))).await, Ok(Ok(()))) { break; }
                pending = Some(request);
            }
            ack = completed.recv() => {
                let Some(ack) = ack else { break };
                let failed = ack["type"] == "INDEX_ERROR";
                if ack["final"] == true && ack["count"].as_i64().is_some_and(|n| n > 0) {
                    let mut controls = app.agent_controls.lock().await;
                    if let Some(control) = controls.get_mut(&id).filter(|c| c.connection == connection) {
                        control.source_versions = Some(ack["unversioned_count"] == 0);
                    }
                }
                if failed {
                    if let Some(request) = pending.take() { let _ = request.reply.send("failed"); }
                } else if pending.as_ref().is_some_and(|p| ack["snapshot"] == p.id.to_string()) {
                    if ack["type"] == "INDEX_ABORT_ACK" {
                        let _ = pending.take().unwrap().reply.send("failed");
                    } else if ack["type"] == "INDEX_ACK" && ack["final"] == true {
                        let _ = pending.take().unwrap().reply.send("complete");
                    }
                }
                if !matches!(tokio::time::timeout(std::time::Duration::from_secs(3), out.send(Message::Text(ack.to_string().into()))).await, Ok(Ok(()))) || failed { break }
            }
            _ = tick.tick() => {
                let valid = sqlx::query("SELECT id FROM agents WHERE id=$1 AND advanced_assets_connection=$2 AND token_hash=$3 AND NOT revoked").bind(id).bind(connection).bind(&token_hash).fetch_optional(&app.db).await;
                match valid {
                    Ok(Some(_)) => {},
                    Ok(None) => { identity_retired = true; break; },
                    Err(_) => break,
                }
                // Lock only the next transfer; claimed means dispatch attempted, not peer receipt.
                let result: anyhow::Result<()> = async {
                    // One bounded send per select iteration keeps heartbeats,
                    // index acknowledgements and incoming frames responsive.
                        let mut tx = app.db.begin().await?;
                        let row = sqlx::query("SELECT id,request FROM agent_transfers WHERE agent_id=$1 AND NOT claimed AND expires_at>now() ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 1").bind(id).fetch_optional(&mut *tx).await?;
                        let Some(row) = row else { return Ok(()) };
                        let transfer: Uuid = row.get("id");
                        let request: Value = row.get("request");
                        // Persist exposure intent before network send. A failed
                        // send is uncertain, never evidence the Agent saw nothing.
                        sqlx::query("UPDATE agent_transfers SET claimed=true WHERE id=$1").bind(transfer).execute(&mut *tx).await?;
                        sqlx::query("UPDATE agent_transfer_runs SET dispatched_at=COALESCE(dispatched_at,clock_timestamp()) WHERE id=$1")
                            .bind(transfer).execute(&mut *tx).await?;
                        tx.commit().await?;
                        tokio::time::timeout(std::time::Duration::from_secs(3), out.send(Message::Text(json!({"type":"TRANSFER","id":transfer,"request":request}).to_string().into()))).await??;
                    Ok(())
                }.await;
                if result.is_err() { break }
                // A slow claim must not leave catch-up ticks continuously ready:
                // give queued control frames a turn before the next dispatch.
                tick.reset();
            }
            message = input.next() => {
                match message {
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {
                        match record_control_activity(&app, id, connection, &token_hash, &activity).await {
                            Ok(Some(received)) => last_received = received,
                            Ok(None) => { identity_retired = true; break; },
                            Err(_) => break,
                        }
                    },
                    Some(Ok(Message::Text(text))) => {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                        if matches!(value["type"].as_str(), Some("HELLO" | "HEARTBEAT" | "TRANSFER_DRAINED" | "SCAN_BUSY" | "INDEX" | "INDEX_ABORT")) {
                            match record_control_activity(&app, id, connection, &token_hash, &activity).await {
                                Ok(Some(received)) => last_received = received,
                                Ok(None) => { identity_retired = true; break; },
                                Err(_) => break,
                            }
                        }
                        if value["type"] == "TRANSFER_DRAINED" {
                            let Some(transfer) = value["id"].as_str().and_then(|value|Uuid::parse_str(value).ok()) else { continue };
                            // The authenticated control identity may only settle
                            // its own previously exposed transfer. Terminal status
                            // alone (completed/cancelled) is not a drain receipt.
                            let accepted = match settle_control_receipt(&app, id, connection, &token_hash, transfer).await {
                                Ok(Some(accepted)) => accepted,
                                Ok(None) => { identity_retired = true; break; },
                                Err(_) => continue,
                            };
                            let ack=json!({"type":"TRANSFER_DRAINED_ACK","id":transfer,"accepted":accepted,"rejected_permanently":!accepted});
                            if !matches!(tokio::time::timeout(std::time::Duration::from_secs(3),out.send(Message::Text(ack.to_string().into()))).await,Ok(Ok(()))) { break; }
                            continue;
                        }
                        if value["type"] == "HELLO" {
                            let accepted = sqlx::query("UPDATE agents SET advanced_assets_version=$3 WHERE id=$1 AND advanced_assets_connection=$2 AND token_hash=$4 AND NOT revoked").bind(id).bind(connection).bind(if value["advanced_assets_version"]==1 {1i16}else{0i16}).bind(&token_hash).execute(&app.db).await;
                            match accepted {
                                Ok(result) if result.rows_affected() == 1 => {},
                                Ok(_) => { identity_retired = true; break; },
                                Err(_) => break,
                            }
                            supports_scan = value["manual_scan"] == true;
                            let ready = {
                                let mut controls = app.agent_controls.lock().await;
                                if let Some(control) = controls.get_mut(&id).filter(|c| c.connection == connection) {
                                    control.manual_scan = supports_scan;
                                    control.drain_receipts = Some(value["drain_receipts"] == true);
                                    // Absence is unknown: pre-capability Agents can still
                                    // prove support by committing a versioned snapshot.
                                    if value["source_versions"] == true { control.source_versions = Some(true); }
                                    uplink_metrics.hello(&text, &value)
                                } else { None }
                            };
                            // Optional negotiation never holds a database/control
                            // lock during a WebSocket send or changes ordinary auth.
                            if let Some(ready) = ready {
                                let _ = tokio::time::timeout(std::time::Duration::from_secs(3), out.send(Message::Text(ready.to_string().into()))).await;
                            }
                        }
                        if value["type"] == "HEARTBEAT" {
                            uplink_metrics.heartbeat(&app, &text, &value);
                        }
                        if value["type"] == "SCAN_BUSY" && pending.as_ref().is_some_and(|p| value["snapshot"] == p.id.to_string()) {
                            let _ = pending.take().unwrap().reply.send("busy");
                        }
                        if matches!(value["type"].as_str(), Some("INDEX" | "INDEX_ABORT")) && pages.try_send(value).is_err() { break }
                    }
                    Some(Ok(Message::Binary(_))) => {},
                    _ => break,
                }
            }
        }}
        // Only identity retirement may retain an already-running bounded report.
        // Disconnects, idle expiry and errors abort optional telemetry immediately.
        let mut retiring_metrics = if identity_retired {
            Some(uplink_metrics)
        } else {
            drop(uplink_metrics);
            None
        };
        activity_tasks.abort_all();
        // Dropping an uncommitted snapshot rolls back partial/disconnected indexing.
        ingest.abort();
        let _ = ingest.await;
        while activity_tasks.join_next().await.is_some() {}
        drop(scans);
        if let Some(request) = pending.take() { let _ = request.reply.send("disconnected"); }
        {
            let mut controls = app.agent_controls.lock().await;
            if controls.get(&id).is_some_and(|c| c.connection == connection) { controls.remove(&id); }
        }
        if let Some(metrics) = retiring_metrics.as_mut() {
            loop { tokio::select! {
                _ = metrics.finish_pending() => break,
                message = input.next() => match message {
                    Some(Ok(Message::Text(_) | Message::Binary(_) | Message::Ping(_) | Message::Pong(_))) => {},
                    _ => break,
                },
            }}
        }
    }))
}

async fn ingest_index(
    app: App,
    id: Uuid,
    connection: Uuid,
    token_hash: String,
    mut pages: tokio::sync::mpsc::Receiver<Value>,
    acks: tokio::sync::mpsc::Sender<Value>,
) -> anyhow::Result<()> {
    let config = providers::SourceConfig {
        s3: None,
        advanced_assets: None,
        access_policy: None,
        root: String::new(),
        url: String::new(),
        token: String::new(),
        user_id: String::new(),
        agent_id: id.to_string(),
        headers: Default::default(),
    };
    let encrypted = app.encrypt(&serde_json::to_value(config)?)?;
    let mut source_tx = app.db.begin().await?;
    let name: String =
        sqlx::query_scalar("SELECT name FROM agents WHERE id=$1 AND token_hash=$2 AND advanced_assets_connection=$3 AND NOT revoked FOR NO KEY UPDATE")
            .bind(id).bind(&token_hash).bind(connection)
            .fetch_one(&mut *source_tx)
            .await?;
    sqlx::query("INSERT INTO sources(id,name,kind,config_encrypted) VALUES($1,$2,'agent',$3) ON CONFLICT(id) DO NOTHING")
        .bind(id)
        .bind(name)
        .bind(encrypted)
        .execute(&mut *source_tx)
        .await?;
    source_tx.commit().await?;
    loop {
        let Some(first) = pages.recv().await else {
            return Ok(());
        };
        let snapshot = first["snapshot"].clone();
        if first["type"] == "INDEX_ABORT" {
            anyhow::ensure!(
                first["sequence"].as_u64() == Some(0),
                "invalid_index_sequence"
            );
            acks.send(json!({"type":"INDEX_ABORT_ACK","snapshot":snapshot,"sequence":0}))
                .await?;
            continue;
        }
        let mut page = first;
        let mut sequence = 0u64;
        let mut tx = app.db.begin().await?;
        // Stage without a source lock; take short authority/source locks in that
        // order only at publication. Capture the authority that this scan began in.
        let source = sqlx::query("SELECT access_policy_revision,config_encrypted FROM sources WHERE id=$1 AND kind='agent' AND deleted_at IS NULL")
            .bind(id).fetch_one(&mut *tx).await?;
        let source_revision: i64 = source.get("access_policy_revision");
        let source_binding: String = source.get("config_encrypted");
        anyhow::ensure!(
            app.decrypt(&source_binding)?["agent_id"] == id.to_string(),
            "agent_source_changed"
        );
        sqlx::query("CREATE TEMP TABLE agent_index_page (resource text PRIMARY KEY, title text NOT NULL, source_version text, available boolean NOT NULL) ON COMMIT DROP").execute(&mut *tx).await?;
        loop {
            anyhow::ensure!(
                page["snapshot"] == snapshot && page["sequence"].as_u64().unwrap_or(0) == sequence,
                "invalid_index_sequence"
            );
            if page["type"] == "INDEX_ABORT" {
                tx.rollback().await?;
                acks.send(
                    json!({"type":"INDEX_ABORT_ACK","snapshot":snapshot,"sequence":sequence}),
                )
                .await?;
                break;
            }
            let items = page["items"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("invalid_index"))?;
            anyhow::ensure!(items.len() <= 256, "index_page_too_large");
            for item in items {
                let path = item["resource"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid_resource"))?;
                let title = item["title"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid_title"))?;
                anyhow::ensure!(
                    !path.is_empty()
                        && path.chars().count() <= 16384
                        && title.chars().count() <= 1024,
                    "index_string_too_large"
                );
                if !item["source_version"].is_null() {
                    anyhow::ensure!(
                        item["source_version"]
                            .as_str()
                            .is_some_and(media_core::file_version::valid_file_version),
                        "invalid_source_version"
                    );
                }
                anyhow::ensure!(
                    item["available"].is_null() || item["available"].is_boolean(),
                    "invalid_index_availability"
                );
            }
            sqlx::query("INSERT INTO agent_index_page SELECT resource,title,source_version,COALESCE(available,true) FROM jsonb_to_recordset($1) AS x(resource text,title text,source_version text,available boolean) ON CONFLICT(resource) DO UPDATE SET title=EXCLUDED.title,source_version=EXCLUDED.source_version,available=EXCLUDED.available").bind(&page["items"]).execute(&mut *tx).await?;
            let final_page = page["final"].as_bool().unwrap_or(snapshot.is_null());
            if final_page {
                sqlx::query("SELECT id FROM agents WHERE id=$1 AND token_hash=$2 AND advanced_assets_connection=$3 AND NOT revoked FOR SHARE")
                    .bind(id).bind(&token_hash).bind(connection).fetch_one(&mut *tx).await?;
                sqlx::query("SELECT id FROM sources WHERE id=$1 AND kind='agent' AND deleted_at IS NULL AND access_policy_revision=$2 AND config_encrypted=$3 FOR UPDATE")
                    .bind(id).bind(source_revision).bind(&source_binding).fetch_one(&mut *tx).await?;
                sqlx::query("UPDATE media_items SET available=false WHERE source_id=$1 AND NOT EXISTS(SELECT 1 FROM agent_index_page i WHERE i.resource=media_items.resource)").bind(id).execute(&mut *tx).await?;
                sqlx::query("INSERT INTO media_items(id,source_id,title,resource,source_version,available) SELECT gen_random_uuid(),$1,title,resource,source_version,available FROM agent_index_page ON CONFLICT(source_id,resource) DO UPDATE SET title=EXCLUDED.title,available=EXCLUDED.available,source_version=EXCLUDED.source_version,metadata=CASE WHEN media_items.source_version IS DISTINCT FROM EXCLUDED.source_version THEN '{}'::jsonb ELSE media_items.metadata END,duration_ms=CASE WHEN media_items.source_version IS DISTINCT FROM EXCLUDED.source_version THEN NULL ELSE media_items.duration_ms END").bind(id).execute(&mut *tx).await?;
                let counts = sqlx::query("SELECT count(*) FILTER (WHERE available) AS count,count(*) FILTER (WHERE available AND source_version IS NULL) AS unversioned_count FROM agent_index_page")
                    .fetch_one(&mut *tx).await?;
                let count: i64 = counts.get("count");
                let unversioned_count: i64 = counts.get("unversioned_count");
                tx.commit().await?;
                acks.send(json!({"type":"INDEX_ACK","sequence":sequence,"snapshot":snapshot,"final":true,"count":count,"unversioned_count":unversioned_count}))
                    .await?;
                break;
            }
            acks.send(
                json!({"type":"INDEX_ACK","snapshot":snapshot,"sequence":sequence,"final":false}),
            )
            .await?;
            sequence += 1;
            page = tokio::time::timeout(std::time::Duration::from_secs(60), pages.recv())
                .await?
                .ok_or_else(|| anyhow::anyhow!("index_disconnected"))?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CONTROL_IDLE_TIMEOUT, Control, source_version_status, validated_name};

    #[test]
    fn online_state_uses_received_activity_and_a_live_current_channel() {
        let (scans, receiver) = tokio::sync::mpsc::channel(1);
        let received = tokio::time::Instant::now();
        let mut control = Control {
            connection: uuid::Uuid::new_v4(),
            last_received: received,
            scans,
            manual_scan: false,
            source_versions: Some(true),
            drain_receipts: None,
        };
        assert!(control.live_at(received));
        assert!(
            control.live_at(received + CONTROL_IDLE_TIMEOUT - std::time::Duration::from_millis(1))
        );
        assert!(!control.live_at(received + CONTROL_IDLE_TIMEOUT));
        control.last_received = received + std::time::Duration::from_secs(5);
        assert!(control.live_at(received + CONTROL_IDLE_TIMEOUT));
        assert_eq!(control.source_versions, Some(true));
        drop(receiver);
        assert!(!control.live_at(control.last_received));
    }

    #[test]
    fn device_names_are_trimmed_and_bounded_without_control_characters() {
        assert_eq!(validated_name("  合成 NAS  ").unwrap(), "合成 NAS");
        assert!(validated_name(&"设".repeat(120)).is_ok());
        for invalid in [
            "".to_owned(),
            "  ".to_owned(),
            "a\nb".to_owned(),
            "x".repeat(121),
        ] {
            assert!(validated_name(&invalid).is_err());
        }
    }

    #[test]
    fn version_readiness_requires_a_committed_version_for_every_available_item() {
        assert_eq!(source_version_status(0, 0, None), "empty");
        assert_eq!(source_version_status(2, 0, None), "ready");
        assert_eq!(source_version_status(2, 1, None), "rescan_required");
        assert_eq!(source_version_status(2, 1, Some(true)), "rescan_required");
        assert_eq!(source_version_status(2, 1, Some(false)), "upgrade_required");
    }
}
