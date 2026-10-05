//! Optional, one-shot client timing. It never renews socket/presence liveness.
use super::*;
use media_core::runtime_metrics::TransportMetricDrop as DropReason;
use protocol::ControlRecoveryMetricsSample;
use sqlx::{Connection, Postgres, pool::PoolConnection};
use std::{future::Future, pin::Pin, time::Duration};

static PENDING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(128);
static DATABASE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
pub type Pending = Pin<Box<dyn Future<Output = ()> + Send>>;

#[derive(Default)]
pub struct Slot {
    seen: bool,
}
impl Slot {
    pub fn begin(
        &mut self,
        app: &App,
        room: Uuid,
        user: Uuid,
        session_hash: &str,
        negotiated: bool,
        text: &str,
    ) -> Option<Pending> {
        // Every socket has one opportunity. Duplicates, conflicts and malformed
        // retries cannot create repeated authorization work or aggregate credit.
        if std::mem::replace(&mut self.seen, true) {
            return None;
        }
        let sample = match decode(negotiated, text) {
            Ok(sample) => sample,
            Err(reason) => {
                app.metrics.runtime.client_control_dropped(reason);
                return None;
            }
        };
        let Ok(permit) = PENDING.try_acquire() else {
            app.metrics
                .runtime
                .client_control_dropped(DropReason::Capacity);
            return None;
        };
        let app = app.clone();
        let session_hash = session_hash.to_owned();
        Some(Box::pin(async move {
            let _permit = permit;
            let mut credited = false;
            let result = tokio::time::timeout(Duration::from_secs(2), async {
                let _database = DATABASE
                    .acquire()
                    .await
                    .map_err(|_| DropReason::Unavailable)?;
                receive(&app, room, user, &session_hash, &sample, &mut credited).await
            })
            .await;
            // Credit occurs under authorization locks. A subsequent cancelled
            // rollback cannot turn that already-consumed sample into a retry.
            if !credited {
                match result {
                    Ok(Ok(())) => {} // Collector already recorded overflow.
                    Ok(Err(reason)) => app.metrics.runtime.client_control_dropped(reason),
                    Err(_) => app
                        .metrics
                        .runtime
                        .client_control_dropped(DropReason::Unavailable),
                }
            }
        }))
    }
}

fn decode(
    negotiated: bool,
    text: &str,
) -> std::result::Result<ControlRecoveryMetricsSample, DropReason> {
    if !negotiated {
        return Err(DropReason::Unauthorized);
    }
    if text.len() > protocol::TRANSPORT_METRICS_MAX_BYTES {
        return Err(DropReason::Invalid);
    }
    serde_json::from_str::<ControlRecoveryMetricsSample>(text)
        .ok()
        .filter(ControlRecoveryMetricsSample::valid)
        .ok_or(DropReason::Invalid)
}

struct OwnedConnection(Option<PoolConnection<Postgres>>);
impl Drop for OwnedConnection {
    fn drop(&mut self) {
        if let Some(connection) = &mut self.0 {
            connection.close_on_drop();
        }
    }
}

async fn receive(
    app: &App,
    room: Uuid,
    user: Uuid,
    session_hash: &str,
    sample: &ControlRecoveryMetricsSample,
    credited: &mut bool,
) -> std::result::Result<(), DropReason> {
    let mut connection = OwnedConnection(Some(
        app.db
            .acquire()
            .await
            .map_err(|_| DropReason::Unavailable)?,
    ));
    let mut tx = connection
        .0
        .as_mut()
        .expect("owned metrics connection")
        .begin()
        .await
        .map_err(|_| DropReason::Unavailable)?;
    sqlx::query("SELECT set_config('statement_timeout','1500ms',true),set_config('lock_timeout','500ms',true)")
        .execute(&mut *tx).await.map_err(|_| DropReason::Unavailable)?;
    // Same room -> membership ordering as ordinary room admission. Session
    // SHARE blocks logout/expiry edits until the synchronous measurement credit.
    let exists = sqlx::query_scalar::<_, Uuid>("SELECT id FROM rooms WHERE id=$1 FOR KEY SHARE")
        .bind(room)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| DropReason::Unavailable)?
        .is_some();
    if !exists {
        return Err(DropReason::Unauthorized);
    }
    let member = sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(room)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| DropReason::Unavailable)?
    .is_some();
    if !member {
        return Err(DropReason::Unauthorized);
    }
    let login = sqlx::query_scalar::<_, String>(
        "SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(session_hash)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| DropReason::Unavailable)?
    .is_some();
    if !login {
        return Err(DropReason::Unauthorized);
    }
    let current: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())")
        .bind(session_hash).bind(user).fetch_one(&mut *tx).await.map_err(|_| DropReason::Unavailable)?;
    if !current {
        return Err(DropReason::Unauthorized);
    }
    *credited = app.metrics.runtime.client_control_recovery(sample);
    tx.rollback().await.map_err(|_| DropReason::Unavailable)?;
    drop(connection.0.take());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet() -> Value {
        json!({"type":"CONTROL_RECOVERY_METRICS","version":1,"socket_open_to_state_applied_ms":12,"background":false})
    }
    #[test]
    fn strict_negotiated_bounded_packet() {
        assert!(decode(true, &packet().to_string()).is_ok());
        assert!(matches!(
            decode(false, &packet().to_string()),
            Err(DropReason::Unauthorized)
        ));
        let mut p = packet();
        p["room_id"] = json!(Uuid::new_v4());
        assert!(decode(true, &p.to_string()).is_err());
        let mut p = packet();
        p["disconnect_observed_to_state_applied_ms"] = json!(11);
        assert!(decode(true, &p.to_string()).is_err());
        assert!(decode(true, &format!("{}{}", packet(), " ".repeat(4096))).is_err());
        assert!(decode(true, r#"{"type":"CONTROL_RECOVERY_METRICS","version":1,"version":1,"socket_open_to_state_applied_ms":12,"background":false}"#).is_err());
    }
}
