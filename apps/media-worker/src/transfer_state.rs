use super::*;
use std::{sync::Mutex, time::Duration};
use tokio::sync::{oneshot, watch};

#[derive(Default)]
struct Progress {
    terminal: Option<(&'static str, Option<&'static str>)>,
    bytes: i64,
}

#[derive(Clone)]
pub struct State {
    progress: Arc<Mutex<Progress>>,
    stop: watch::Sender<bool>,
    input_failure: input_failure::Observation,
}
impl Default for State {
    fn default() -> Self {
        Self {
            progress: Default::default(),
            stop: watch::channel(false).0,
            input_failure: Default::default(),
        }
    }
}
impl State {
    pub fn observed(input_failure: input_failure::Observation) -> Self {
        Self {
            input_failure,
            ..Self::default()
        }
    }
    pub fn cancel(&self) {
        self.progress
            .lock()
            .unwrap()
            .terminal
            .get_or_insert(("cancelled", Some("consumer_cancelled")));
    }
    pub fn fail(&self, reason: &'static str) {
        if reason == "transfer_lease_lost" {
            self.input_failure.transient();
        }
        self.progress
            .lock()
            .unwrap()
            .terminal
            .get_or_insert(("failed", Some(reason)));
    }
    pub fn complete(&self) {
        self.progress
            .lock()
            .unwrap()
            .terminal
            .get_or_insert(("completed", None));
    }
    pub fn delivered(&self, bytes: usize, expected: u64) {
        let mut progress = self.progress.lock().unwrap();
        progress.bytes = progress.bytes.saturating_add(bytes as i64);
        if progress.bytes as u64 == expected {
            progress.terminal.get_or_insert(("completed", None));
        }
    }
    pub async fn stopped(&self) {
        let mut stop = self.stop.subscribe();
        if !*stop.borrow_and_update() {
            let _ = stop.changed().await;
        }
    }
}

pub struct Offer {
    pub id: Uuid,
    pub agent: Uuid,
    pub token_hash: String,
    pub request: Value,
    pub resource_hash: String,
}

// Check leases in a separate statement after taking the row lock. A predicate
// evaluated before a lock wait must not revive an already expired transfer.
pub async fn lock(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
) -> std::result::Result<(), sqlx::Error> {
    sqlx::query("SELECT id FROM agent_transfer_runs WHERE id=$1 FOR UPDATE")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn own(
    db: PgPool,
    offer: Offer,
    state: State,
    mut cancelled: oneshot::Receiver<()>,
    ready: oneshot::Sender<std::result::Result<(), sqlx::Error>>,
) {
    let result: std::result::Result<(), sqlx::Error> = async {
        let mut tx = db.begin().await?;
        sqlx::query("INSERT INTO agent_transfers VALUES($1,$2,$3,$4,false,now()+interval '30 seconds')")
            .bind(offer.id).bind(offer.agent).bind(&offer.token_hash).bind(&offer.request)
            .execute(&mut *tx).await?;
        sqlx::query("INSERT INTO agent_transfer_runs(id,agent_id,resource_hash,head,byte_range) VALUES($1,$2,$3,$4,$5)")
            .bind(offer.id).bind(offer.agent).bind(&offer.resource_hash)
            .bind(offer.request["head"].as_bool().unwrap_or(false))
            .bind(offer.request["range"].as_str()).execute(&mut *tx).await?;
        tx.commit().await
    }.await;
    let inserted = result.is_ok();
    let _ = ready.send(result);
    if !inserted {
        return;
    }
    let mut tick = tokio::time::interval(Duration::from_secs(10));
    tick.tick().await;
    loop {
        tokio::select! {
            biased;
            _ = &mut cancelled => break,
            _ = tick.tick() => {
                let bytes = state.progress.lock().unwrap().bytes;
                let renewed = tokio::time::timeout(Duration::from_secs(3), async {
                    let mut tx = db.begin().await?;
                    lock(&mut tx, offer.id).await?;
                    let row = sqlx::query("UPDATE agent_transfer_runs SET lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp(),bytes_delivered=$2 WHERE id=$1 AND finished_at IS NULL AND lease_until>clock_timestamp()")
                        .bind(offer.id).bind(bytes).execute(&mut *tx).await?;
                    tx.commit().await?;
                    Ok::<_, sqlx::Error>(row)
                }).await;
                if !matches!(renewed, Ok(Ok(ref row)) if row.rows_affected() == 1) {
                    state.fail("transfer_lease_lost");
                    state.stop.send_replace(true);
                    break;
                }
            }
        }
    }
    // Ordered after INSERT settles, including cancellation during INSERT.
    // Terminal state and ticket retirement commit together. On DB failure the
    // lease sweeper supplies a durable failed state, never a guessed success.
    let (status, reason, bytes) = {
        let progress = state.progress.lock().unwrap();
        let (status, reason) = progress
            .terminal
            .unwrap_or(("cancelled", Some("consumer_cancelled")));
        (status, reason, progress.bytes)
    };
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        let mut tx = db.begin().await?;
        sqlx::query("DELETE FROM agent_transfers WHERE id=$1").bind(offer.id).execute(&mut *tx).await?;
        lock(&mut tx, offer.id).await?;
        sqlx::query("UPDATE agent_transfer_runs SET status=$2,reason=$3,bytes_delivered=$4,updated_at=clock_timestamp(),finished_at=clock_timestamp() WHERE id=$1 AND finished_at IS NULL AND lease_until>clock_timestamp()")
            .bind(offer.id).bind(status).bind(reason).bind(bytes).execute(&mut *tx).await?;
        tx.commit().await
    }).await;
    if !matches!(result, Ok(Ok(()))) {
        tracing::warn!(transfer_id=%offer.id, "transfer finalization deferred to lease cleanup");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_outcome_survives_late_cleanup_and_partial_delivery_is_not_success() {
        let cancelled = State::default();
        cancelled.delivered(3, 10);
        assert!(cancelled.progress.lock().unwrap().terminal.is_none());
        cancelled.cancel();
        cancelled.fail("late_socket_close");
        assert_eq!(
            cancelled.progress.lock().unwrap().terminal.unwrap().0,
            "cancelled"
        );

        let failed = State::default();
        failed.fail("agent_http_error");
        failed.complete();
        failed.cancel();
        assert_eq!(
            failed.progress.lock().unwrap().terminal.unwrap().0,
            "failed"
        );

        let complete = State::default();
        complete.delivered(3, 3);
        complete.cancel();
        assert_eq!(
            complete.progress.lock().unwrap().terminal.unwrap().0,
            "completed"
        );
    }
}
