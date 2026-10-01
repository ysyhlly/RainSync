//! Receipt recovery has no source, index, scan or transfer admission authority.
use super::*;
use axum::extract::ws::Message;
use futures_util::{SinkExt, StreamExt};
use sqlx::Connection;
use std::time::Duration;

static CONNECTIONS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);
const DATABASE_WAIT: Duration = Duration::from_secs(3);

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
enum ReceiptMessage {
    Heartbeat {},
    TransferDrained { id: Uuid },
}

// Own the checkout inside the timed future. If it is cancelled, close-on-drop
// prevents an unfinished transaction/query from returning to the shared pool.
// PostgreSQL also bounds lock and statement waits independently of that future.
async fn settle(
    db: &PgPool,
    token_hash: &str,
    expected_agent: Option<Uuid>,
    receipt: Option<Uuid>,
) -> anyhow::Result<Option<(Uuid, bool)>> {
    tokio::time::timeout(DATABASE_WAIT, async {
        let mut connection = db.acquire().await?;
        connection.close_on_drop();
        let mut tx = connection.begin().await?;
        sqlx::query("SET LOCAL statement_timeout='1500ms'")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SET LOCAL lock_timeout='750ms'")
            .execute(&mut *tx)
            .await?;
        // SHARE serializes accepting a receipt against revoke/token changes.
        // Never authorize from the identity remembered at WebSocket upgrade.
        let id: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM agents WHERE token_hash=$1 AND NOT revoked FOR SHARE",
        )
        .bind(token_hash)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(id) = id.filter(|id| expected_agent.is_none_or(|expected| expected == *id))
        else {
            tx.rollback().await?;
            return Ok(None);
        };
        let accepted = if let Some(receipt) = receipt {
            sqlx::query("UPDATE agent_transfer_runs SET agent_drained_at=COALESCE(agent_drained_at,clock_timestamp()) WHERE id=$1 AND agent_id=$2 AND dispatched_at IS NOT NULL AND NOT legacy_unconfirmed")
                .bind(receipt)
                .bind(id)
                .execute(&mut *tx)
                .await?
                .rows_affected() == 1
        } else {
            false
        };
        tx.commit().await?;
        Ok::<_, anyhow::Error>(Some((id, accepted)))
    })
    .await?
}

pub async fn connect(
    State(app): State<App>,
    h: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response> {
    let permit = CONNECTIONS
        .try_acquire()
        .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "agent_drain_busy"))?;
    let token_hash = hash(
        h.get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "agent_token_required"))?,
    );
    let (id, _) = settle(&app.db, &token_hash, None, None)
        .await
        .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "agent_drain_database_busy"))?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "invalid_agent"))?;
    Ok(upgrade
        .max_message_size(4096)
        .max_frame_size(4096)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            let _ = tokio::time::timeout(Duration::from_secs(60), async {
            let (mut out, mut input) = socket.split();
            let mut check = tokio::time::interval(Duration::from_secs(5));
            check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut remaining = 1024usize;
            loop {
                tokio::select! {
                    biased;
                    _ = check.tick() => {
                        if !matches!(settle(&app.db, &token_hash, Some(id), None).await, Ok(Some(_))) { break; }
                    }
                    message = input.next() => {
                        if remaining == 0 { break; }
                        remaining -= 1;
                        let text = match message {
                            Some(Ok(Message::Text(text))) => text,
                            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                            _ => break,
                        };
                        let receipt = match serde_json::from_str::<ReceiptMessage>(&text) {
                            Ok(ReceiptMessage::Heartbeat {}) => None,
                            Ok(ReceiptMessage::TransferDrained { id }) => Some(id),
                            // HELLO, INDEX, SCAN and TRANSFER have no meaning here.
                            Err(_) => break,
                        };
                        let Ok(Some((_, accepted))) = settle(&app.db, &token_hash, Some(id), receipt).await else { break };
                        if let Some(receipt) = receipt {
                            // No database transaction or lock survives this send.
                            let ack = json!({"type":"TRANSFER_DRAINED_ACK","id":receipt,"accepted":accepted,"rejected_permanently":!accepted});
                            if !matches!(tokio::time::timeout(Duration::from_secs(3), out.send(Message::Text(ack.to_string().into()))).await, Ok(Ok(()))) { break; }
                        }
                    }
                }
            }
            }).await;
            // Drop the socket; no ordinary agent registry or readiness is touched.
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_messages_have_a_closed_non_authorizing_shape() {
        assert!(serde_json::from_str::<ReceiptMessage>(r#"{"type":"HEARTBEAT"}"#).is_ok());
        assert!(
            serde_json::from_str::<ReceiptMessage>(
                r#"{"type":"TRANSFER_DRAINED","id":"11111111-1111-4111-8111-111111111111"}"#
            )
            .is_ok()
        );
        for text in [
            r#"{"type":"HEARTBEAT","agent_id":"11111111-1111-4111-8111-111111111111"}"#,
            r#"{"type":"INDEX","items":[]}"#,
            r#"{"type":"TRANSFER_DRAINED","id":"11111111-1111-4111-8111-111111111111","agent_id":"11111111-1111-4111-8111-111111111111"}"#,
            r#"{"type":"TRANSFER_DRAINED","id":"11111111-1111-4111-8111-111111111111","id":"22222222-2222-4222-8222-222222222222"}"#,
            r#"{"type":"HEARTBEAT","type":"TRANSFER_DRAINED"}"#,
            r#"{"type":"TRANSFER_DRAINED","id":"invalid"}"#,
        ] {
            assert!(
                serde_json::from_str::<ReceiptMessage>(text).is_err(),
                "{text}"
            );
        }
    }
}
