use super::*;
use axum::extract::ws::{Message, WebSocketUpgrade};
use futures_util::StreamExt;
use std::{collections::HashMap, sync::Mutex};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Default)]
pub struct Registry(Arc<Mutex<HashMap<Uuid, Pending>>>);
struct Registration {
    id: Uuid,
    registry: Registry,
    state: transfer_state::State,
    // Drop closes this channel after removing the pending connection. The
    // database owner can then clean up even if INSERT finished after cancellation.
    _cancel: oneshot::Sender<()>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.registry.0.lock().unwrap().remove(&self.id);
        self.state.cancel();
    }
}
pub struct Pending {
    pub headers: oneshot::Sender<Value>,
    pub chunks: mpsc::Sender<std::result::Result<Vec<u8>, std::io::Error>>,
    pub input_failure: input_failure::Observation,
    pub state: transfer_state::State,
    pub source_version: String,
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
    let source_version = resource["source_version"]
        .as_str()
        .filter(|v| media_core::file_version::valid_file_version(v))
        .ok_or_else(|| {
            input_failure.source_version_required();
            (StatusCode::CONFLICT, "source_version_required".into())
        })?
        .to_owned();
    let id = Uuid::new_v4();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let (ht, hr) = oneshot::channel();
    let (ct, cr) = mpsc::channel(16);
    let state = transfer_state::State::observed(input_failure.clone());
    app.relay.0.lock().unwrap().insert(
        id,
        Pending {
            headers: ht,
            chunks: ct,
            input_failure: input_failure.clone(),
            state: state.clone(),
            source_version: source_version.clone(),
        },
    );
    let data_url = format!(
        "{}/agent-data/{id}?token={token}",
        app.public_url
            .replace("https://", "wss://")
            .replace("http://", "ws://")
    );
    let request = json!({"data_url":data_url,"resource":resource["resource"],"source_version":source_version,"range":h.get(header::RANGE).and_then(|v|v.to_str().ok()),"head":head});
    let (cancel, cancelled) = oneshot::channel();
    let registration = Registration {
        id,
        registry: app.relay.clone(),
        state: state.clone(),
        _cancel: cancel,
    };
    let (ready, offered) = oneshot::channel();
    tokio::spawn(transfer_state::own(
        app.db.clone(),
        transfer_state::Offer {
            id,
            agent,
            token_hash: hash(&token),
            request,
            resource_hash: hash(&resource.to_string()),
        },
        state.clone(),
        cancelled,
        ready,
    ));
    offered.await.map_err(failure)?.map_err(failure)?;
    let reply = tokio::select! {
        biased;
        _ = state.stopped() => return Err((StatusCode::SERVICE_UNAVAILABLE, "agent_timeout".into())),
        reply = tokio::time::timeout(std::time::Duration::from_secs(15), hr) => reply,
    };
    let meta = match reply {
        Ok(Ok(v)) => v,
        _ => {
            input_failure.transient();
            state.fail("agent_timeout");
            return Err((StatusCode::GATEWAY_TIMEOUT, "agent_timeout".into()));
        }
    };
    if meta["status"] == 409 {
        match meta["error"].as_str() {
            Some("source_changed") => return Err((StatusCode::CONFLICT, "source_changed".into())),
            Some("source_version_required") => {
                return Err((StatusCode::CONFLICT, "source_version_required".into()));
            }
            _ => {}
        }
    }
    let mut builder = Response::builder().status(meta["status"].as_u64().unwrap_or(502) as u16);
    for key in [
        "content-length",
        "content-range",
        "content-type",
        "accept-ranges",
    ] {
        if let Some(v) = meta[key].as_str() {
            let value = axum::http::HeaderValue::from_str(v).map_err(|error| {
                state.fail("invalid_agent_headers");
                failure(error)
            })?;
            builder = builder.header(key, value)
        }
    }
    // connect validates metadata before handing it to the HTTP response.
    let expected = metadata(&meta).expect("validated Agent metadata").1;
    if head || expected == 0 {
        state.complete();
    }
    let stream = futures_util::stream::unfold(
        (cr, registration, state),
        move |(mut rx, guard, state)| async move {
            let next = tokio::select! {
                biased;
                _ = state.stopped() => Some(Err(std::io::Error::other("transfer_lease_lost"))),
                v = rx.recv() => v,
            };
            next.map(|v| {
                if let Ok(ref bytes) = v {
                    state.delivered(bytes.len(), expected);
                }
                (v, (rx, guard, state))
            })
        },
    );
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
    let mut tx = app.db.begin().await.map_err(failure)?;
    sqlx::query("SELECT id FROM agent_transfers WHERE id=$1 AND token_hash=$2 FOR UPDATE")
        .bind(id)
        .bind(hash(&q.token))
        .execute(&mut *tx)
        .await
        .map_err(failure)?;
    let row=sqlx::query("DELETE FROM agent_transfers t USING agents a WHERE t.id=$1 AND t.token_hash=$2 AND t.expires_at>clock_timestamp() AND a.id=t.agent_id AND NOT a.revoked RETURNING t.id").bind(id).bind(hash(&q.token)).fetch_optional(&mut *tx).await.map_err(failure)?;
    if row.is_none() {
        return Err((StatusCode::UNAUTHORIZED, "invalid_transfer".into()));
    }
    transfer_state::lock(&mut tx, id).await.map_err(failure)?;
    let connected = sqlx::query("UPDATE agent_transfer_runs SET status='connected',updated_at=clock_timestamp() WHERE id=$1 AND status='offered' AND lease_until>clock_timestamp()")
        .bind(id).execute(&mut *tx).await.map_err(failure)?;
    if connected.rows_affected() != 1 {
        return Err((StatusCode::GONE, "transfer_expired".into()));
    }
    tx.commit().await.map_err(failure)?;
    let pending = app
        .relay
        .0
        .lock()
        .unwrap()
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
                    _ = pending.state.stopped() => return,
                    v = tokio::time::timeout_at(header_deadline, socket.next()) => v,
                };
                match first {
                    Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
                    Ok(Some(Ok(Message::Text(text)))) => {
                        let Ok(meta) = serde_json::from_str::<Value>(&text) else {
                            pending.input_failure.permanent();
                            pending.state.fail("invalid_agent_headers");
                            return;
                        };
                        break meta;
                    }
                    Ok(Some(Ok(Message::Binary(_)))) => {
                        pending.input_failure.permanent();
                        pending.state.fail("invalid_agent_headers");
                        return;
                    }
                    _ => {
                        pending.input_failure.transient();
                        pending.state.fail("agent_headers_interrupted");
                        return;
                    }
                }
            };
            let Some((status, expected)) = metadata(&meta) else {
                pending.input_failure.permanent();
                pending.state.fail("invalid_agent_headers");
                return;
            };
            pending.input_failure.status(status);
            if status.is_success() && meta["source_version"].as_str() != Some(pending.source_version.as_str()) {
                let reason = if meta["source_version"].as_str().is_none() { "source_version_required" } else { "source_changed" };
                if reason == "source_changed" {
                    pending.input_failure.source_changed();
                } else {
                    pending.input_failure.source_version_required();
                }
                pending.state.fail(reason);
                let _ = pending.headers.send(json!({"status":409,"content-length":"0","error":reason}));
                return;
            }
            if !status.is_success() {
                let reason = match (status, meta["error"].as_str()) {
                    (StatusCode::CONFLICT, Some("source_changed")) => {
                        pending.input_failure.source_changed();
                        "source_changed"
                    }
                    (StatusCode::CONFLICT, Some("source_version_required")) => {
                        pending.input_failure.source_version_required();
                        "source_version_required"
                    }
                    _ => "agent_http_error",
                };
                pending.state.fail(reason);
            }
            let streaming = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                let mut tx = app.db.begin().await?;
                transfer_state::lock(&mut tx, id).await?;
                let row = sqlx::query("UPDATE agent_transfer_runs SET status='streaming',updated_at=clock_timestamp() WHERE id=$1 AND status='connected' AND lease_until>clock_timestamp()")
                    .bind(id).execute(&mut *tx).await?;
                tx.commit().await?;
                Ok::<_, sqlx::Error>(row)
            }).await;
            if !matches!(streaming, Ok(Ok(ref row)) if row.rows_affected() == 1) {
                pending.state.fail("transfer_lease_lost");
                return;
            }
            if pending.headers.send(meta).is_err() {
                return;
            }
            let mut received = 0u64;
            let mut deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
            let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(5));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                let message = tokio::select! {
                    _ = pending.chunks.closed() => break,
                    _ = pending.state.stopped() => break,
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
                            let send = pending.chunks.send(Ok(b.to_vec()));
                            tokio::pin!(send);
                            let sent = loop {
                                tokio::select! {
                                    biased;
                                    _ = pending.state.stopped() => break None,
                                    _ = pending.chunks.closed() => break None,
                                    sent = &mut send => break Some(sent),
                                    _ = heartbeat.tick() => {
                                        // This exact Ping is evidence of local
                                        // queue backpressure under a live owner,
                                        // not evidence of Agent byte progress.
                                        // Lease failure or HTTP cancellation
                                        // stops it even while the queue is full.
                                        let ping = tokio::select! {
                                            biased;
                                            _ = pending.state.stopped() => break None,
                                            _ = pending.chunks.closed() => break None,
                                            ping = tokio::time::timeout(std::time::Duration::from_secs(3), socket.send(Message::Ping(b"rainsync-backpressure-v1".to_vec().into()))) => ping,
                                        };
                                        if !matches!(ping, Ok(Ok(()))) {
                                            pending.input_failure.transient();
                                            pending.state.fail("agent_backpressure_heartbeat_failed");
                                            break None;
                                        }
                                    }
                                }
                            };
                            if !matches!(sent, Some(Ok(()))) {
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
                pending.state.fail(reason);
                send_error(&pending.chunks, &pending.state, reason).await;
                break;
            }
        }))
}

async fn send_error(
    chunks: &mpsc::Sender<std::io::Result<Vec<u8>>>,
    state: &transfer_state::State,
    reason: &'static str,
) {
    tokio::select! {
        biased;
        _ = state.stopped() => {},
        _ = chunks.closed() => {},
        _ = tokio::time::timeout(std::time::Duration::from_secs(1), chunks.send(Err(std::io::Error::other(reason)))) => {},
    }
}

fn metadata(meta: &Value) -> Option<(StatusCode, u64)> {
    let status = u16::try_from(meta["status"].as_u64()?).ok()?;
    if !(200..600).contains(&status) {
        return None;
    }
    let expected: u64 = meta["content-length"].as_str()?.parse().ok()?;
    if expected > i64::MAX as u64 {
        return None;
    }
    Some((StatusCode::from_u16(status).ok()?, expected))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn full_error_queue_releases_on_execution_end_without_dropping_the_body() {
        let registry = input_failure::Registry::default();
        let id = Uuid::new_v4();
        let execution = registry.register(id);
        let state = transfer_state::State::observed(registry.observe(id, Some(execution.token())));
        let (chunks, mut retained_body) = mpsc::channel(1);
        chunks.send(Ok(vec![1])).await.unwrap();
        let sending = send_error(&chunks, &state, "truncated_agent_data");
        tokio::pin!(sending);
        tokio::select! {
            _ = &mut sending => panic!("full queue unexpectedly accepted terminal error"),
            _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {},
        }
        drop(execution);
        tokio::time::timeout(std::time::Duration::from_millis(500), &mut sending)
            .await
            .unwrap();
        assert_eq!(retained_body.recv().await.unwrap().unwrap(), vec![1]);
        assert!(retained_body.try_recv().is_err());
    }
    #[tokio::test]
    async fn full_error_queue_has_a_deadline_for_a_direct_request() {
        let state = transfer_state::State::default();
        let (chunks, mut retained_body) = mpsc::channel(1);
        chunks.send(Ok(vec![1])).await.unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            send_error(&chunks, &state, "truncated_agent_data"),
        )
        .await
        .unwrap();
        assert_eq!(retained_body.recv().await.unwrap().unwrap(), vec![1]);
        assert!(retained_body.try_recv().is_err());
    }
    #[tokio::test]
    async fn cancelled_registration_releases_pending_channels_before_database_cleanup() {
        let registry = Registry::default();
        let id = Uuid::new_v4();
        let (headers, response) = oneshot::channel();
        let (chunks, mut body) = mpsc::channel(16);
        registry.0.lock().unwrap().insert(
            id,
            Pending {
                headers,
                chunks,
                input_failure: Default::default(),
                state: Default::default(),
                source_version: format!("stat-v1:{}", "0".repeat(64)),
            },
        );
        let (cancel, cancelled) = oneshot::channel();
        let guard = Registration {
            id,
            registry: registry.clone(),
            state: Default::default(),
            _cancel: cancel,
        };
        drop(guard);
        assert!(registry.0.lock().unwrap().is_empty());
        assert!(response.await.is_err());
        assert!(body.recv().await.is_none());
        assert!(cancelled.await.is_err());
    }
}
