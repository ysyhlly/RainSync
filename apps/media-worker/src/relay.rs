use super::*;
use axum::extract::ws::{Message, WebSocketUpgrade};
use futures_util::StreamExt;
use tokio::sync::{mpsc, oneshot};
pub struct Pending {
    pub headers: oneshot::Sender<Value>,
    pub chunks: mpsc::Sender<std::result::Result<Vec<u8>, std::io::Error>>,
    pub input_failure: input_failure::Observation,
}
pub async fn fetch(
    app: &App,
    resource: &Value,
    h: &HeaderMap,
    head: bool,
    input_failure: input_failure::Observation,
) -> Result<Response> {
    let agent = Uuid::parse_str(resource["agent_id"].as_str().unwrap_or("")).map_err(failure)?;
    let state: Option<(bool, bool)> = sqlx::query_as("SELECT revoked,COALESCE(last_seen>now()-interval '15 seconds',false) FROM agents WHERE id=$1").bind(agent).fetch_optional(&app.db).await.map_err(failure)?;
    if !matches!(state, Some((false, true))) {
        if matches!(state, Some((false, false))) {
            input_failure.transient();
        } else {
            input_failure.permanent();
        }
        return Err((StatusCode::SERVICE_UNAVAILABLE, "agent_offline".into()));
    }
    let id = Uuid::new_v4();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let (ht, hr) = oneshot::channel();
    let (ct, cr) = mpsc::channel(16);
    app.relay.lock().await.insert(
        id,
        Pending {
            headers: ht,
            chunks: ct,
            input_failure: input_failure.clone(),
        },
    );
    let data_url = format!(
        "{}/agent-data/{id}?token={token}",
        app.public_url
            .replace("https://", "wss://")
            .replace("http://", "ws://")
    );
    let request = json!({"data_url":data_url,"resource":resource["resource"],"range":h.get(header::RANGE).and_then(|v|v.to_str().ok()),"head":head});
    if sqlx::query(
        "INSERT INTO agent_transfers VALUES($1,$2,$3,$4,false,now()+interval '30 seconds')",
    )
    .bind(id)
    .bind(agent)
    .bind(hash(&token))
    .bind(request)
    .execute(&app.db)
    .await
    .is_err()
    {
        app.relay.lock().await.remove(&id);
        return Err(failure("db"));
    }
    let meta = match tokio::time::timeout(std::time::Duration::from_secs(15), hr).await {
        Ok(Ok(v)) => v,
        _ => {
            input_failure.transient();
            app.relay.lock().await.remove(&id);
            return Err((StatusCode::GATEWAY_TIMEOUT, "agent_timeout".into()));
        }
    };
    let mut builder = Response::builder().status(meta["status"].as_u64().unwrap_or(502) as u16);
    for key in [
        "content-length",
        "content-range",
        "content-type",
        "accept-ranges",
    ] {
        if let Some(v) = meta[key].as_str() {
            builder = builder.header(key, v)
        }
    }
    let stream =
        futures_util::stream::unfold(cr, |mut rx| async { rx.recv().await.map(|v| (v, rx)) });
    builder
        .body(if head {
            Body::empty()
        } else {
            Body::from_stream(stream)
        })
        .map_err(failure)
}
pub async fn connect(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    Query(q): Query<Params>,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    let row=sqlx::query("DELETE FROM agent_transfers t USING agents a WHERE t.id=$1 AND t.token_hash=$2 AND t.expires_at>now() AND a.id=t.agent_id AND NOT a.revoked RETURNING t.id").bind(id).bind(hash(&q.token)).fetch_optional(&app.db).await.map_err(failure)?;
    if row.is_none() {
        return Err((StatusCode::UNAUTHORIZED, "invalid_transfer".into()));
    }
    let pending = app
        .relay
        .lock()
        .await
        .remove(&id)
        .ok_or((StatusCode::GONE, "transfer_expired".into()))?;
    Ok(ws
        .max_message_size(65536)
        .max_frame_size(65536)
        .on_upgrade(move |mut socket| async move {
            let header_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            let meta = loop {
                let first = tokio::select! {
                    _ = pending.chunks.closed() => return,
                    v = tokio::time::timeout_at(header_deadline, socket.next()) => v,
                };
                match first {
                    Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
                    Ok(Some(Ok(Message::Text(text)))) => {
                        let Ok(meta) = serde_json::from_str::<Value>(&text) else {
                            pending.input_failure.permanent();
                            return;
                        };
                        break meta;
                    }
                    Ok(Some(Ok(Message::Binary(_)))) => {
                        pending.input_failure.permanent();
                        return;
                    }
                    _ => {
                        pending.input_failure.transient();
                        return;
                    }
                }
            };
            let Some((status, expected)) = metadata(&meta) else {
                pending.input_failure.permanent();
                return;
            };
            pending.input_failure.status(status);
            if pending.headers.send(meta).is_err() {
                return;
            }
            let mut received = 0u64;
            let mut deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
            loop {
                let message = tokio::select! {
                    _ = pending.chunks.closed() => break,
                    v = tokio::time::timeout_at(deadline, socket.next()) => v,
                };
                let reason = match message {
                    Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
                    Ok(Some(Ok(Message::Binary(b)))) => {
                        if b.len() as u64 > expected - received {
                            pending.input_failure.permanent();
                            "excess_agent_data"
                        } else {
                            received += b.len() as u64;
                            let progressed = !b.is_empty();
                            if pending.chunks.send(Ok(b.to_vec())).await.is_err() {
                                break;
                            }
                            // Waiting for the bounded consumer queue is local
                            // backpressure, not a stalled Agent read.
                            if progressed {
                                deadline = tokio::time::Instant::now()
                                    + std::time::Duration::from_secs(30);
                            }
                            continue;
                        }
                    }
                    Ok(Some(Ok(Message::Text(_)))) => {
                        pending.input_failure.permanent();
                        "invalid_agent_data"
                    }
                    _ if received < expected => {
                        pending.input_failure.transient();
                        "truncated_agent_data"
                    }
                    _ => break,
                };
                let _ = pending
                    .chunks
                    .send(Err(std::io::Error::other(reason)))
                    .await;
                break;
            }
        }))
}

fn metadata(meta: &Value) -> Option<(StatusCode, u64)> {
    let status = u16::try_from(meta["status"].as_u64()?).ok()?;
    if !(200..600).contains(&status) {
        return None;
    }
    let expected = meta["content-length"].as_str()?.parse().ok()?;
    Some((StatusCode::from_u16(status).ok()?, expected))
}
