use super::*;
use std::{sync::Mutex, time::Duration};
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

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
        self.stop.send_replace(true);
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
            tokio::select! {
                _ = stop.changed() => {},
                _ = self.input_failure.stopped() => {},
            }
        }
    }
}

pub struct Offer {
    pub id: Uuid,
    pub agent: Uuid,
    pub session_id: Option<Uuid>,
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

// Start timing before pool acquisition and keep the original database deadline
// when the request result is unknown. A slow reply cannot add a fresh lease.
async fn renew(db: &PgPool, id: Uuid, bytes: i64) -> anyhow::Result<Option<Instant>> {
    process::confirmed_deadline(async {
        let mut tx = db.begin().await?;
        lock(&mut tx, id).await?;
        let remaining: Option<f64> = sqlx::query_scalar("UPDATE agent_transfer_runs SET lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp(),bytes_delivered=$2 WHERE id=$1 AND finished_at IS NULL AND lease_until>clock_timestamp() RETURNING extract(epoch FROM lease_until-clock_timestamp())::float8")
            .bind(id).bind(bytes).fetch_optional(&mut *tx).await?;
        tx.commit().await?;
        remaining.map(Duration::try_from_secs_f64).transpose().map_err(Into::into)
    }).await
}

async fn hold_lease<F, Fut>(
    state: &State,
    cancelled: &mut oneshot::Receiver<()>,
    mut confirmed_until: Instant,
    mut renew: F,
) where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Option<Instant>>>,
{
    let mut next_check = Instant::now() + Duration::from_secs(10);
    loop {
        tokio::select! {
            biased;
            _ = &mut *cancelled => return,
            _ = state.input_failure.stopped() => {
                state.cancel();
                return;
            },
            _ = tokio::time::sleep_until(confirmed_until) => break,
            _ = tokio::time::sleep_until(next_check) => {
                let result = tokio::select! {
                    biased;
                    _ = &mut *cancelled => return,
                    _ = state.input_failure.stopped() => {
                        state.cancel();
                        return;
                    },
                    _ = tokio::time::sleep_until(confirmed_until) => break,
                    result = tokio::time::timeout(Duration::from_secs(3), renew()) => result,
                };
                if Instant::now() >= confirmed_until {
                    break;
                }
                match result {
                    Ok(Ok(Some(until))) if until > Instant::now() => {
                        confirmed_until = until;
                        next_check = Instant::now() + Duration::from_secs(10);
                    },
                    Ok(Ok(_)) => break,
                    _ => {
                        tracing::warn!("transfer lease renewal unknown; retrying within confirmed lease");
                        next_check = Instant::now() + Duration::from_secs(1);
                    },
                }
            },
        }
    }
    state.fail("transfer_lease_lost");
    state.stop.send_replace(true);
}

pub async fn own(
    db: PgPool,
    offer: Offer,
    state: State,
    mut cancelled: oneshot::Receiver<()>,
    ready: oneshot::Sender<std::result::Result<(), sqlx::Error>>,
) {
    let offered_at = Instant::now();
    let result: std::result::Result<Duration, sqlx::Error> = async {
        let mut tx = db.begin().await?;
        if let Some(session) = offer.session_id {
            // Offer persistence has its own detached owner. Serialize its late
            // INSERT with close too: delivery cancellation may have already
            // dropped the registration and acknowledged the local response.
            let room: Uuid = sqlx::query_scalar("SELECT room_id FROM playback_sessions WHERE id=$1")
                .bind(session).fetch_one(&mut *tx).await?;
            let epoch: i64 = sqlx::query_scalar("SELECT lifecycle_epoch FROM rooms WHERE id=$1 AND lifecycle='active' FOR NO KEY UPDATE")
                .bind(room).fetch_one(&mut *tx).await?;
            let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions WHERE id=$1 AND lifecycle_epoch=$2 AND NOT stopped AND expires_at>clock_timestamp())")
                .bind(session).bind(epoch).fetch_one(&mut *tx).await?;
            if !active { return Err(sqlx::Error::RowNotFound); }
        }
        sqlx::query("INSERT INTO agent_transfers VALUES($1,$2,$3,$4,false,now()+interval '30 seconds')")
            .bind(offer.id).bind(offer.agent).bind(&offer.token_hash).bind(&offer.request)
            .execute(&mut *tx).await?;
        let remaining: f64 = sqlx::query_scalar("INSERT INTO agent_transfer_runs(id,agent_id,resource_hash,head,byte_range,session_id,legacy_unconfirmed,lease_until) VALUES($1,$2,$3,$4,$5,$6,false,clock_timestamp()+interval '30 seconds') RETURNING extract(epoch FROM lease_until-clock_timestamp())::float8")
            .bind(offer.id).bind(offer.agent).bind(&offer.resource_hash)
            .bind(offer.request["head"].as_bool().unwrap_or(false))
            .bind(offer.request["range"].as_str()).bind(offer.session_id).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Duration::try_from_secs_f64(remaining).map_err(|_| sqlx::Error::Protocol("invalid_transfer_lease".into()))
    }.await;
    let inserted = result.is_ok();
    let confirmed_until = result
        .as_ref()
        .ok()
        .and_then(|remaining| offered_at.checked_add(*remaining));
    let _ = ready.send(result.map(|_| ()));
    if !inserted {
        return;
    }
    hold_lease(
        &state,
        &mut cancelled,
        confirmed_until.unwrap_or(offered_at),
        || {
            let bytes = state.progress.lock().unwrap().bytes;
            renew(&db, offer.id, bytes)
        },
    )
    .await;
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
        sqlx::query("UPDATE agent_transfer_runs SET status=$2,reason=$3,bytes_delivered=$4,updated_at=clock_timestamp(),finished_at=clock_timestamp(),agent_drained_at=CASE WHEN dispatched_at IS NULL AND NOT legacy_unconfirmed THEN COALESCE(agent_drained_at,clock_timestamp()) ELSE agent_drained_at END WHERE id=$1 AND finished_at IS NULL AND lease_until>clock_timestamp()")
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

    async fn postgres_transfer(db: &PgPool, seconds: i32) -> (Uuid, Instant) {
        let agent = Uuid::new_v4();
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO agents(id,name,token_hash) VALUES($1,'isolated transfer health',$2)",
        )
        .bind(agent)
        .bind(agent.to_string())
        .execute(db)
        .await
        .unwrap();
        let until = process::confirmed_deadline(async {
            let remaining: f64 = sqlx::query_scalar("INSERT INTO agent_transfer_runs(id,agent_id,resource_hash,head,legacy_unconfirmed,lease_until) VALUES($1,$2,'isolated-resource',false,false,clock_timestamp()+$3*interval '1 second') RETURNING extract(epoch FROM lease_until-clock_timestamp())::float8")
                .bind(id).bind(agent).bind(seconds).fetch_one(db).await?;
            Ok(Some(Duration::try_from_secs_f64(remaining)?))
        }).await.unwrap().unwrap();
        (id, until)
    }

    // Run only through tests/worker-reliability.mjs. It creates and positively
    // cleans up its own cluster and records the executed source/binary identity.
    #[tokio::test]
    #[ignore = "requires an isolated real PostgreSQL database"]
    async fn postgres_transfer_health() {
        assert_eq!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref(), Ok("1"));
        let db = persistence::connect(&std::env::var("WORKER_RELIABILITY_DATABASE_URL").unwrap())
            .await
            .unwrap();
        let name: String = sqlx::query_scalar("SELECT current_database()")
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(name.starts_with("rainsync_d_reliability_"));
        persistence::migrate(&db).await.unwrap();
        let mut evidence = Vec::new();

        let (id, until) = postgres_transfer(&db, 30).await;
        let mut tx = db.begin().await.unwrap();
        lock(&mut tx, id).await.unwrap();
        let locker = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(14500)).await;
            tx.rollback().await.unwrap();
        });
        let state = State::default();
        let (cancel, mut cancelled) = oneshot::channel();
        let cancel = Mutex::new(Some(cancel));
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let began = Instant::now();
        tokio::time::timeout(
            Duration::from_secs(20),
            hold_lease(&state, &mut cancelled, until, || async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let result = renew(&db, id, 32768).await?;
                if result.is_some() {
                    // A 3s unknown did not cancel the retained relay/socket body.
                    assert!(!*state.stop.borrow());
                    assert!(state.progress.lock().unwrap().terminal.is_none());
                    let _ = cancel.lock().unwrap().take().unwrap().send(());
                }
                Ok(result)
            }),
        )
        .await
        .unwrap();
        locker.await.unwrap();
        assert!(calls.load(std::sync::atomic::Ordering::SeqCst) >= 2);
        assert!(!*state.stop.borrow());
        let bytes: i64 =
            sqlx::query_scalar("SELECT bytes_delivered FROM agent_transfer_runs WHERE id=$1")
                .bind(id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(bytes, 32768);
        evidence.push(json!({"case":"relay-row-lock-recovers-within-confirmed-lease","elapsed_seconds":began.elapsed().as_secs_f64(),"renewal_requests":calls.load(std::sync::atomic::Ordering::SeqCst),"bytes_delivered":bytes,"stream_stopped":false}));

        let (id, until) = postgres_transfer(&db, 14).await;
        let mut tx = db.begin().await.unwrap();
        lock(&mut tx, id).await.unwrap();
        let state = State::default();
        let (_cancel, mut cancelled) = oneshot::channel();
        let began = Instant::now();
        let confirmed_seconds = until.duration_since(began).as_secs_f64();
        tokio::time::timeout(
            Duration::from_secs(17),
            hold_lease(&state, &mut cancelled, until, || renew(&db, id, 0)),
        )
        .await
        .unwrap();
        let elapsed = began.elapsed().as_secs_f64();
        assert!(elapsed >= confirmed_seconds && elapsed < confirmed_seconds + 1.0);
        assert!(*state.stop.borrow());
        assert_eq!(
            state.progress.lock().unwrap().terminal,
            Some(("failed", Some("transfer_lease_lost")))
        );
        tx.rollback().await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(renew(&db, id, 0).await.unwrap().is_none());
        let drain_unknown: bool = sqlx::query_scalar(
            "SELECT agent_drained_at IS NULL FROM agent_transfer_runs WHERE id=$1",
        )
        .bind(id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(
            drain_unknown,
            "lease expiry never invents a physical disposal receipt"
        );
        evidence.push(json!({"case":"relay-continuous-unknown-stops-at-confirmed-expiry","confirmed_seconds":confirmed_seconds,"elapsed_seconds":elapsed,"late_renewal":false,"drain_unconfirmed":drain_unknown}));

        let (id, until) = postgres_transfer(&db, 30).await;
        sqlx::query("UPDATE agent_transfer_runs SET status='cancelled',finished_at=clock_timestamp() WHERE id=$1").bind(id).execute(&db).await.unwrap();
        let state = State::default();
        let (_cancel, mut cancelled) = oneshot::channel();
        let began = Instant::now();
        tokio::time::timeout(
            Duration::from_secs(12),
            hold_lease(&state, &mut cancelled, until, || renew(&db, id, 0)),
        )
        .await
        .unwrap();
        assert!(*state.stop.borrow());
        assert!(began.elapsed() < Duration::from_secs(12));
        evidence.push(json!({"case":"relay-confirmed-terminal-stops-without-retry","elapsed_seconds":began.elapsed().as_secs_f64(),"stream_stopped":true}));

        let (id, until) = postgres_transfer(&db, 30).await;
        let mut tx = db.begin().await.unwrap();
        lock(&mut tx, id).await.unwrap();
        let state = State::default();
        let cancel_state = state.clone();
        let (cancel, mut cancelled) = oneshot::channel();
        let (entered, ready) = oneshot::channel();
        let mut entered = Some(entered);
        let signal = tokio::spawn(async move {
            ready.await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            let at = Instant::now();
            cancel_state.cancel();
            let _ = cancel.send(());
            at
        });
        tokio::time::timeout(
            Duration::from_secs(12),
            hold_lease(&state, &mut cancelled, until, || {
                entered.take().unwrap().send(()).unwrap();
                renew(&db, id, 0)
            }),
        )
        .await
        .unwrap();
        let signalled = signal.await.unwrap();
        assert!(signalled.elapsed() < Duration::from_secs(1));
        assert_eq!(
            state.progress.lock().unwrap().terminal,
            Some(("cancelled", Some("consumer_cancelled")))
        );
        tx.rollback().await.unwrap();
        evidence.push(json!({"case":"relay-cancel-during-postgres-row-lock","stop_seconds":signalled.elapsed().as_secs_f64(),"terminal":"cancelled"}));

        let (id, until) = postgres_transfer(&db, 30).await;
        let mut tx = db.begin().await.unwrap();
        lock(&mut tx, id).await.unwrap();
        let registry = input_failure::Registry::default();
        let session = Uuid::new_v4();
        let execution = registry.register(session);
        let state = State::observed(registry.observe(session, Some(execution.token())));
        let (_cancel, mut cancelled) = oneshot::channel();
        let (entered, ready) = oneshot::channel();
        let mut entered = Some(entered);
        let signal = tokio::spawn(async move {
            ready.await.unwrap();
            let at = Instant::now();
            drop(execution);
            at
        });
        tokio::time::timeout(
            Duration::from_secs(12),
            hold_lease(&state, &mut cancelled, until, || {
                entered.take().unwrap().send(()).unwrap();
                renew(&db, id, 0)
            }),
        )
        .await
        .unwrap();
        let signalled = signal.await.unwrap();
        assert!(signalled.elapsed() < Duration::from_secs(1));
        assert!(*state.stop.borrow());
        assert_eq!(
            state.progress.lock().unwrap().terminal,
            Some(("cancelled", Some("consumer_cancelled")))
        );
        tx.rollback().await.unwrap();
        evidence.push(json!({"case":"relay-execution-authorization-ended-during-row-lock","stop_seconds":signalled.elapsed().as_secs_f64(),"terminal":"cancelled"}));

        let state = State::default();
        let (_cancel, mut cancelled) = oneshot::channel();
        let until = Instant::now() + Duration::from_millis(10050);
        let began = Instant::now();
        hold_lease(&state, &mut cancelled, until, || async {
            // A delayed single runtime poll cannot resurrect an expired stream.
            std::thread::sleep(Duration::from_millis(150));
            Ok(Some(Instant::now() + Duration::from_secs(30)))
        })
        .await;
        assert!(*state.stop.borrow());
        evidence.push(json!({"case":"relay-late-response-cannot-revive-stream","elapsed_seconds":began.elapsed().as_secs_f64(),"stream_stopped":true}));

        std::fs::write(
            std::env::var("WORKER_RELIABILITY_REPORT").unwrap(),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
        db.close().await;
    }

    #[tokio::test]
    async fn execution_end_stops_a_live_transfer_even_with_its_body_retained() {
        let registry = input_failure::Registry::default();
        let id = Uuid::new_v4();
        let execution = registry.register(id);
        let state = State::observed(registry.observe(id, Some(execution.token())));
        let retained_body = state.clone();
        state.fail("source_changed");
        drop(execution);
        tokio::time::timeout(Duration::from_millis(500), retained_body.stopped())
            .await
            .unwrap();
        state.cancel();
        let progress = state.progress.lock().unwrap();
        assert_eq!(progress.terminal, Some(("failed", Some("source_changed"))));
    }

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
