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
    let state = transfer_state::State::observed(input_failure.clone());
    app.relay.0.lock().unwrap().insert(
        id,
        Pending {
            headers: ht,
            chunks: ct,
            input_failure: input_failure.clone(),
            state: state.clone(),
        },
    );
    let data_url = format!(
        "{}/agent-data/{id}?token={token}",
        app.public_url
            .replace("https://", "wss://")
            .replace("http://", "ws://")
    );
    let request = json!({"data_url":data_url,"resource":resource["resource"],"range":h.get(header::RANGE).and_then(|v|v.to_str().ok()),"head":head});
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
            if !status.is_success() {
                pending.state.fail("agent_http_error");
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
                            let sent = tokio::select! {
                                _ = pending.state.stopped() => break,
                                sent = pending.chunks.send(Ok(b.to_vec())) => sent,
                            };
                            if sent.is_err() {
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
