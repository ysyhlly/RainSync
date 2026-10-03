//! Revalidate a delivery grant independently of HTTP backpressure. Dropping the
//! producer also drops the local file, upstream response, or NAS registration.
use axum::{
    body::{Body, Bytes},
    response::Response,
};
use futures_util::StreamExt;
use sqlx::{Acquire, PgPool, Postgres, Row, pool::PoolConnection};
use std::{
    future::Future,
    io,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    time::Instant,
};
use uuid::Uuid;

const CHECK_INTERVAL: Duration = Duration::from_secs(2);
const CHECK_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_AUTH_AGE: Duration = Duration::from_secs(5);
const CHUNK_BYTES: usize = 64 * 1024;

#[derive(Clone, PartialEq, Eq)]
struct AccountIdentity {
    source: Uuid,
    revision: i64,
    generation: i64,
    observer: Uuid,
}

struct AccountEvidence {
    identity: AccountIdentity,
    sequence: i64,
    remaining: Duration,
}

struct Authorization {
    allowed: bool,
    account: Option<AccountEvidence>,
}

impl From<bool> for Authorization {
    fn from(allowed: bool) -> Self {
        Self {
            allowed,
            account: None,
        }
    }
}

struct ConfirmedAccount {
    identity: AccountIdentity,
    sequence: i64,
    deadline: Instant,
}

struct Confirmation {
    checked_at: Instant,
    account: Option<ConfirmedAccount>,
}

/// Preparation, its final header check, and body delivery retain the same
/// observation deadline. Re-reading unchanged positive evidence cannot grant
/// another five seconds, even if the database wall clock stops advancing.
#[derive(Clone)]
struct AuthState(Arc<Mutex<Confirmation>>);

impl From<Instant> for AuthState {
    fn from(checked_at: Instant) -> Self {
        Self(Arc::new(Mutex::new(Confirmation {
            checked_at,
            account: None,
        })))
    }
}

impl AuthState {
    fn deadline(&self, max_age: Duration) -> Instant {
        let state = self.0.lock().expect("authorization confirmation");
        let deadline = state.checked_at + max_age;
        state
            .account
            .as_ref()
            .map_or(deadline, |account| deadline.min(account.deadline))
    }

    fn confirm(&self, authorization: Authorization, began: Instant) -> Result<(), Denied> {
        if !authorization.allowed {
            return Err(Denied::Revoked);
        }
        let mut state = self.0.lock().expect("authorization confirmation");
        let now = Instant::now();
        if state
            .account
            .as_ref()
            .is_some_and(|account| account.deadline <= now)
        {
            return Err(Denied::Unavailable);
        }
        if let Some(evidence) = authorization.account {
            // Account evidence is never useful for more than the observer's
            // positive TTL; charge the whole query/commit round trip to it.
            let deadline = began + evidence.remaining.min(MAX_AUTH_AGE);
            if deadline <= now {
                return Err(Denied::Unavailable);
            }
            match state.account.as_mut() {
                Some(account) if account.identity != evidence.identity => {
                    return Err(Denied::Revoked);
                }
                Some(account) if account.sequence == evidence.sequence => {
                    account.deadline = account.deadline.min(deadline);
                }
                Some(account) if account.sequence > evidence.sequence => {
                    // A concurrent final-header check may return an older
                    // observation after the preparation monitor saw a new one.
                }
                _ => {
                    state.account = Some(ConfirmedAccount {
                        identity: evidence.identity,
                        sequence: evidence.sequence,
                        deadline,
                    });
                }
            }
        } else if state.account.is_some() {
            return Err(Denied::Revoked);
        }
        state.checked_at = state.checked_at.max(began);
        Ok(())
    }
}

/// HTTP connections may outlive the server's drain deadline. Own admission,
/// source cancellation and receipt persistence separately from those waiters.
#[derive(Clone, Default)]
pub struct Registry(Arc<Owners>);

#[derive(Default)]
struct OwnerState {
    closing: bool,
    active: usize,
}
struct Owners {
    readiness: Option<crate::readiness::Runtime>,
    state: Mutex<OwnerState>,
    count: watch::Sender<usize>,
    stop: watch::Sender<bool>,
}
impl Default for Owners {
    fn default() -> Self {
        Self {
            readiness: None,
            state: Default::default(),
            count: watch::channel(0).0,
            stop: watch::channel(false).0,
        }
    }
}
struct Admission {
    registry: Registry,
}
impl Drop for Admission {
    fn drop(&mut self) {
        let mut state = self
            .registry
            .0
            .state
            .lock()
            .expect("delivery owner registry");
        state.active -= 1;
        self.registry.0.count.send_replace(state.active);
    }
}
impl Registry {
    pub fn with_readiness(readiness: crate::readiness::Runtime) -> Self {
        Self(Arc::new(Owners {
            readiness: Some(readiness),
            ..Owners::default()
        }))
    }
    fn admit(&self) -> Option<Admission> {
        let mut state = self.0.state.lock().expect("delivery owner registry");
        if state.closing {
            return None;
        }
        state.active += 1;
        self.0.count.send_replace(state.active);
        Some(Admission {
            registry: self.clone(),
        })
    }

    pub fn close(&self) {
        let mut state = self.0.state.lock().expect("delivery owner registry");
        state.closing = true;
        self.0.stop.send_replace(true);
    }

    pub async fn drain(&self) {
        self.close();
        let mut count = self.0.count.subscribe();
        while *count.borrow_and_update() != 0 {
            // Registry retains the sender throughout drain.
            count.changed().await.expect("delivery owner count");
        }
    }
}

async fn shutdown(mut stop: Option<watch::Receiver<bool>>) {
    let Some(ref mut stop) = stop else {
        std::future::pending::<()>().await;
        return;
    };
    while !*stop.borrow_and_update() {
        if stop.changed().await.is_err() {
            return;
        }
    }
}

// SQLx normally returns a cancelled query to the pool only after receiving
// ReadyForQuery. A revoked/aborted response must not strand a shared pool slot
// behind a table lock. Healthy checks still reuse their connection.
struct AuthorizationConnection(Option<PoolConnection<Postgres>>);
impl Drop for AuthorizationConnection {
    fn drop(&mut self) {
        if let Some(connection) = &mut self.0 {
            connection.close_on_drop();
        }
    }
}

async fn authorized(pool: &PgPool, id: Uuid, token_hash: &str) -> anyhow::Result<Authorization> {
    let mut connection = AuthorizationConnection(Some(pool.acquire().await?));
    let mut tx = connection
        .0
        .as_mut()
        .expect("owned check connection")
        .begin()
        .await?;
    // This transaction-local limit also bounds PostgreSQL-side work when it
    // cannot immediately observe a disconnected client; no setting leaks to
    // unrelated Worker queries when a healthy connection returns to the pool.
    sqlx::query("SET LOCAL statement_timeout = '2500ms'")
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT src.id AS source_id,src.kind,src.access_policy_revision,a.generation,a.observer_epoch,a.observation_seq,EXTRACT(EPOCH FROM(a.valid_until-clock_timestamp()))::double precision AS account_remaining FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id JOIN rooms r ON r.id=p.room_id JOIN media_items mi ON mi.id=p.media_id JOIN sources src ON src.id=mi.source_id LEFT JOIN source_account_policies a ON a.source_id=src.id AND src.kind IN('jellyfin','emby') WHERE r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND p.id=$1 AND p.delivery_token_hash=$2 AND p.expires_at>clock_timestamp() AND NOT p.stopped AND playback_source_allowed(p.media_id,p.resource) AND (s.state->>'media_generation')::bigint=p.generation AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id)")
        .bind(id).bind(token_hash).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    drop(connection.0.take());
    let Some(row) = row else {
        return Ok(false.into());
    };
    let account = if matches!(row.get::<String, _>("kind").as_str(), "jellyfin" | "emby") {
        let remaining = Duration::try_from_secs_f64(row.try_get("account_remaining")?)?;
        anyhow::ensure!(!remaining.is_zero(), "account_policy_expired");
        Some(AccountEvidence {
            identity: AccountIdentity {
                source: row.try_get("source_id")?,
                revision: row.try_get("access_policy_revision")?,
                generation: row.try_get("generation")?,
                observer: row.try_get("observer_epoch")?,
            },
            sequence: row.try_get("observation_seq")?,
            remaining,
        })
    } else {
        None
    };
    Ok(Authorization {
        allowed: true,
        account,
    })
}

// This owner survives its HTTP waiter and only acknowledges after dropping the
// source and positively draining every process spawned in the request scope.
struct Execution {
    pool: PgPool,
    id: Uuid,
    owner: Uuid,
    scope: media_core::child_process::Scope,
    // Held through local disposal and its durable receipt, including admission
    // that commits after the HTTP waiter or Worker shutdown signal disappears.
    admission: Admission,
}
impl Execution {
    async fn finish(self) {
        if self.scope.shutdown().await.is_err() {
            if let Some(readiness) = &self.admission.registry.0.readiness {
                readiness.drain_failed();
            }
            tracing::error!(execution = %self.id, "delivery process drain unconfirmed");
            return;
        }
        loop {
            if matches!(
                tokio::time::timeout(
                    CHECK_TIMEOUT,
                    persistence::media_executions::acknowledge(&self.pool, self.id, self.owner)
                )
                .await,
                Ok(Ok(()))
            ) {
                break;
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    }
}

pub async fn protect<Fut>(
    prepare: impl FnOnce(bool) -> Fut + Send + 'static,
    pool: PgPool,
    id: Uuid,
    token_hash: String,
    registry: Registry,
    input_cancel: crate::input_failure::Observation,
    entry_candidate: bool,
) -> super::Result<Response>
where
    Fut: Future<Output = super::Result<Response>> + Send + 'static,
{
    let admission = registry
        .admit()
        .ok_or_else(|| Denied::Unavailable.response())?;
    let (mut sender, response) = oneshot::channel();
    // Keep INSERT/COMMIT ownership outside cancellation: a late committed row
    // must be acknowledged, never left behind by a vanished HTTP waiter.
    tokio::spawn(async move {
        let owner = Uuid::new_v4();
        let registered = persistence::media_executions::begin_delivery(
            &pool,
            id,
            &token_hash,
            owner,
            entry_candidate,
        )
        .await;
        let registered = match registered {
            Ok(Some(id)) => id,
            Ok(None) => {
                let _ = sender.send(Err(Denied::Revoked.response()));
                return;
            }
            Err(_) => {
                let _ = sender.send(Err(Denied::Unavailable.response()));
                return;
            }
        };
        let scope = media_core::child_process::Scope::new();
        let execution = Execution {
            pool: pool.clone(),
            id: registered.execution_id,
            owner,
            scope: scope.clone(),
            admission,
        };
        let result = tokio::select! {
            biased;
            _ = shutdown(Some(registry.0.stop.subscribe())) => Some(Err(Denied::Unavailable.response())),
            _ = sender.closed() => None,
            _ = input_cancel.stopped() => Some(Err(Denied::Unavailable.response())),
            result = scope.run(prepare_response(prepare(registered.first_output_entry), pool.clone(), id, token_hash.clone())) => Some(result),
        };
        match result {
            Some(Ok((response, confirmed))) => {
                let (parts, body) = response.into_parts();
                let body = guarded_body(
                    body,
                    move || {
                        let pool = pool.clone();
                        let token_hash = token_hash.clone();
                        async move { authorized(&pool, id, &token_hash).await }
                    },
                    confirmed,
                    CHECK_INTERVAL,
                    CHECK_TIMEOUT,
                    MAX_AUTH_AGE,
                    SourceOwners {
                        execution: Some(execution),
                        input_cancel,
                    },
                );
                // If the waiter vanished, dropping this body signals its owner;
                // the body producer still drains/acknowledges independently.
                let _ = sender.send(Ok(Response::from_parts(parts, body)));
            }
            other => {
                if let Some(Err(error)) = other {
                    let _ = sender.send(Err(error));
                }
                execution.finish().await;
            }
        }
    });
    response
        .await
        .unwrap_or_else(|_| Err(Denied::Unavailable.response()))
}

async fn prepare_response(
    prepare: impl Future<Output = super::Result<Response>>,
    pool: PgPool,
    id: Uuid,
    token_hash: String,
) -> super::Result<(Response, AuthState)> {
    // Header waits and bounded playlist/subtitle buffering also own a source.
    // Revocation must cancel these futures before any response body exists.
    let checker = || {
        let pool = pool.clone();
        let token_hash = token_hash.clone();
        async move { authorized(&pool, id, &token_hash).await }
    };
    // Seed the account deadline before opening any source. The ledger grants
    // admission, but does not transfer an observer's remaining TTL to us.
    let began = Instant::now();
    let confirmed = AuthState::from(began);
    match tokio::time::timeout(CHECK_TIMEOUT, checker()).await {
        Ok(Ok(authorization)) => confirmed
            .confirm(authorization, began)
            .map_err(Denied::response)?,
        _ => return Err(Denied::Unavailable.response()),
    }
    let prepared = async {
        let response = prepare.await?;
        // Preparation can take time (e.g. waiting for an HLS output). Check
        // again before committing headers, while the preparation monitor still
        // owns its deadline and can drop this already-created response.
        let checked_at = Instant::now();
        match tokio::time::timeout(CHECK_TIMEOUT, authorized(&pool, id, &token_hash)).await {
            Ok(Ok(authorization)) => {
                confirmed
                    .confirm(authorization, checked_at)
                    .map_err(Denied::response)?;
                Ok((response, confirmed.clone()))
            }
            _ => Err(Denied::Unavailable.response()),
        }
    };
    let (response, confirmed) = tokio::select! {
        biased;
        denied = monitor(checker, confirmed.clone(), CHECK_INTERVAL, CHECK_TIMEOUT, MAX_AUTH_AGE) => {
            return Err(denied.response());
        },
        response = prepared => response?,
    };
    Ok((response, confirmed))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Denied {
    Revoked,
    Unavailable,
}
impl Denied {
    fn response(self) -> (axum::http::StatusCode, String) {
        match self {
            Self::Revoked => (
                axum::http::StatusCode::UNAUTHORIZED,
                "invalid_playback_session".into(),
            ),
            Self::Unavailable => (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "media_unavailable".into(),
            ),
        }
    }
}

async fn monitor<F, C, A>(
    mut check: F,
    confirmed: impl Into<AuthState>,
    interval: Duration,
    timeout: Duration,
    max_age: Duration,
) -> Denied
where
    F: FnMut() -> C,
    C: Future<Output = anyhow::Result<A>>,
    A: Into<Authorization>,
{
    let confirmed = confirmed.into();
    loop {
        let deadline = confirmed.deadline(max_age);
        tokio::time::sleep_until((Instant::now() + interval).min(deadline)).await;
        let began = Instant::now();
        // A delayed result cannot extend the lifetime of an older DB snapshot.
        let result = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(confirmed.deadline(max_age)) => return Denied::Unavailable,
            result = tokio::time::timeout(timeout, check()) => result,
        };
        match result {
            Ok(Ok(authorization)) => {
                if let Err(denied) = confirmed.confirm(authorization.into(), began) {
                    return denied;
                }
            }
            _ => return Denied::Unavailable,
        }
    }
}

struct Delivery {
    chunks: mpsc::Receiver<io::Result<Bytes>>,
    revoked: watch::Receiver<bool>,
    // Keep the watch open when a successfully finished producer exits, so EOF
    // drains normally instead of repeatedly waking on a closed watch channel.
    _notification: watch::Sender<bool>,
    ended: bool,
}

#[derive(Default)]
struct SourceOwners {
    execution: Option<Execution>,
    input_cancel: crate::input_failure::Observation,
}

fn guarded_body<F, C, A>(
    body: Body,
    check: F,
    confirmed: impl Into<AuthState>,
    interval: Duration,
    timeout: Duration,
    max_age: Duration,
    owners: SourceOwners,
) -> Body
where
    F: FnMut() -> C + Send + 'static,
    C: Future<Output = anyhow::Result<A>> + Send,
    A: Into<Authorization> + Send,
{
    let confirmed = confirmed.into();
    let SourceOwners {
        execution,
        input_cancel,
    } = owners;
    // One queued 64-KiB chunk. The source's own buffers and kernel/browser
    // buffers are separate; already delivered bytes cannot be recalled.
    let (send, chunks) = mpsc::channel(1);
    let (notification, revoked) = watch::channel(false);
    let revoke = notification.clone();
    tokio::spawn(async move {
        let output = send.clone();
        let forward = async move {
            let mut stream = body.into_data_stream();
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(mut bytes) => {
                        while !bytes.is_empty() {
                            let length = bytes.len().min(CHUNK_BYTES);
                            if output.send(Ok(bytes.split_to(length))).await.is_err() {
                                return;
                            }
                        }
                    }
                    Err(error) => {
                        let _ = output.send(Err(io::Error::other(error))).await;
                        return;
                    }
                }
            }
        };
        let scope = execution
            .as_ref()
            .map(|execution| execution.scope.clone())
            .unwrap_or_default();
        let stop = execution
            .as_ref()
            .map(|execution| execution.admission.registry.0.stop.subscribe());
        tokio::select! {
            biased;
            _ = shutdown(stop) => { let _ = revoke.send(true); },
            _ = send.closed() => {},
            _ = input_cancel.stopped() => { let _ = revoke.send(true); },
            _ = monitor(check, confirmed, interval, timeout, max_age) => { let _ = revoke.send(true); },
            _ = scope.run(forward) => {},
        }
        // The select drops `forward` and its source before any drain ACK.
        // Body drop closes the receiver; it never aborts this cleanup owner.
        drop(send);
        if let Some(execution) = execution {
            execution.finish().await;
        }
    });
    let state = Delivery {
        chunks,
        revoked,
        _notification: notification,
        ended: false,
    };
    Body::from_stream(futures_util::stream::unfold(
        state,
        |mut state| async move {
            if state.ended {
                return None;
            }
            let result = loop {
                if *state.revoked.borrow() {
                    break Some(Err(io::Error::other("invalid_playback_session")));
                }
                tokio::select! {
                    biased;
                    _ = state.revoked.changed() => {},
                    chunk = state.chunks.recv() => {
                        // Discard any application-buffered chunk after revocation.
                        if *state.revoked.borrow() { continue; }
                        break chunk;
                    },
                }
            };
            result.map(|chunk| {
                state.ended = chunk.is_err();
                (chunk, state)
            })
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn identity() -> AccountIdentity {
        AccountIdentity {
            source: Uuid::nil(),
            revision: 1,
            generation: 2,
            observer: Uuid::nil(),
        }
    }

    fn positive(sequence: i64, remaining: Duration) -> Authorization {
        Authorization {
            allowed: true,
            account: Some(AccountEvidence {
                identity: identity(),
                sequence,
                remaining,
            }),
        }
    }

    #[tokio::test]
    async fn unchanged_observation_keeps_its_first_monotonic_deadline() {
        let now = Instant::now();
        let confirmed = AuthState::from(now);
        confirmed
            .confirm(
                positive(1, Duration::from_secs(2)),
                now - Duration::from_secs(1),
            )
            .unwrap();
        let deadline = confirmed.deadline(MAX_AUTH_AGE);
        // A frozen or regressed DB clock can report the same remaining TTL.
        confirmed
            .confirm(positive(1, Duration::from_secs(2)), now)
            .unwrap();
        assert_eq!(confirmed.deadline(MAX_AUTH_AGE), deadline);
        // A fresh response for the same observation can conservatively shorten it.
        confirmed
            .confirm(positive(1, Duration::from_millis(500)), now)
            .unwrap();
        assert_eq!(
            confirmed.deadline(MAX_AUTH_AGE),
            now + Duration::from_millis(500)
        );
    }

    #[tokio::test]
    async fn only_a_newer_observation_refreshes_the_account_deadline() {
        let now = Instant::now();
        let confirmed = AuthState::from(now);
        confirmed
            .confirm(
                positive(1, Duration::from_secs(2)),
                now - Duration::from_secs(1),
            )
            .unwrap();
        confirmed
            .confirm(positive(2, Duration::from_secs(2)), now)
            .unwrap();
        let refreshed = now + Duration::from_secs(2);
        assert_eq!(confirmed.deadline(MAX_AUTH_AGE), refreshed);
        confirmed
            .confirm(positive(1, Duration::from_secs(4)), now)
            .unwrap();
        assert_eq!(confirmed.deadline(MAX_AUTH_AGE), refreshed);
        let mut changed = positive(3, Duration::from_secs(4));
        changed.account.as_mut().unwrap().identity.generation += 1;
        assert_eq!(confirmed.confirm(changed, now), Err(Denied::Revoked));
    }

    #[tokio::test]
    async fn elapsed_account_evidence_cannot_be_revived_by_final_headers() {
        let now = Instant::now();
        let confirmed = AuthState(Arc::new(Mutex::new(Confirmation {
            checked_at: now,
            account: Some(ConfirmedAccount {
                identity: identity(),
                sequence: 1,
                deadline: now - Duration::from_millis(1),
            }),
        })));
        assert_eq!(
            confirmed.confirm(positive(2, MAX_AUTH_AGE), now),
            Err(Denied::Unavailable)
        );
        let delayed = AuthState::from(now);
        assert_eq!(
            delayed.confirm(
                positive(1, Duration::from_millis(10)),
                now - Duration::from_millis(20)
            ),
            Err(Denied::Unavailable)
        );
    }

    #[tokio::test]
    async fn preparation_and_body_share_a_frozen_observation_deadline() {
        let now = Instant::now();
        let prepared = AuthState::from(now);
        prepared
            .confirm(positive(1, Duration::from_millis(80)), now)
            .unwrap();
        let deadline = prepared.deadline(MAX_AUTH_AGE);
        // Simulate the final header check reporting the unchanged positive row.
        let body_confirmation = prepared.clone();
        body_confirmation
            .confirm(positive(1, MAX_AUTH_AGE), Instant::now())
            .unwrap();
        assert_eq!(body_confirmation.deadline(MAX_AUTH_AGE), deadline);
        let dropped = Arc::new(AtomicBool::new(false));
        let body = guarded_body(
            source(dropped.clone()),
            || async { Ok(positive(1, MAX_AUTH_AGE)) },
            body_confirmation,
            Duration::from_millis(10),
            Duration::from_secs(1),
            MAX_AUTH_AGE,
            SourceOwners::default(),
        );
        tokio::time::timeout(Duration::from_millis(250), released(&dropped))
            .await
            .expect("unchanged DB evidence cannot keep a backpressured source alive");
        assert!(body.into_data_stream().next().await.unwrap().is_err());
    }

    #[tokio::test]
    async fn account_deadline_cancels_a_hung_authorization_query() {
        let now = Instant::now();
        let confirmed = AuthState::from(now);
        confirmed
            .confirm(positive(1, Duration::from_millis(40)), now)
            .unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        let body = guarded_body(
            source(dropped.clone()),
            std::future::pending::<anyhow::Result<Authorization>>,
            confirmed,
            Duration::from_millis(10),
            Duration::from_secs(1),
            MAX_AUTH_AGE,
            SourceOwners::default(),
        );
        tokio::time::timeout(Duration::from_millis(250), released(&dropped))
            .await
            .expect("the account deadline wins over a stalled DB check");
        assert!(body.into_data_stream().next().await.unwrap().is_err());
    }

    #[tokio::test]
    async fn shutdown_fences_new_admission_and_waits_for_late_owner() {
        let registry = Registry::default();
        let admission = registry.admit().unwrap();
        registry.close();
        assert!(registry.admit().is_none());
        tokio::time::timeout(
            Duration::from_secs(1),
            shutdown(Some(registry.0.stop.subscribe())),
        )
        .await
        .expect("late owner observes shutdown already requested");
        assert!(
            tokio::time::timeout(Duration::from_millis(10), registry.drain())
                .await
                .is_err(),
            "admission/receipt ownership outlives a cancelled drain waiter"
        );
        drop(admission);
        tokio::time::timeout(Duration::from_secs(1), registry.drain())
            .await
            .expect("last receipt owner releases drain");
    }

    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    fn source(dropped: Arc<AtomicBool>) -> Body {
        Body::from_stream(futures_util::stream::unfold(
            Dropped(dropped),
            |guard| async { Some((Ok::<_, io::Error>(Bytes::from(vec![0; CHUNK_BYTES])), guard)) },
        ))
    }
    #[tokio::test]
    async fn cancelled_execution_drops_retained_source_independently_of_body_polling() {
        let dropped = Arc::new(AtomicBool::new(false));
        let cancel = crate::input_failure::Observation::default();
        let _retained = guarded_body(
            source(dropped.clone()),
            || async { Ok(true) },
            Instant::now(),
            Duration::from_secs(10),
            Duration::from_secs(1),
            Duration::from_secs(20),
            SourceOwners {
                execution: None,
                input_cancel: cancel.clone(),
            },
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!dropped.load(Ordering::SeqCst));
        cancel.stop();
        released(&dropped).await;
    }
    fn test_body(
        body: Body,
        check: impl FnMut() -> std::pin::Pin<Box<dyn Future<Output = anyhow::Result<bool>> + Send>>
        + Send
        + 'static,
    ) -> Body {
        guarded_body(
            body,
            check,
            Instant::now(),
            Duration::from_millis(10),
            Duration::from_millis(20),
            Duration::from_millis(30),
            SourceOwners::default(),
        )
    }
    async fn released(dropped: &AtomicBool) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !dropped.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("upstream released independently of consumer polling");
    }
    #[tokio::test]
    async fn revoked_backpressured_body_drops_source_and_discards_queued_bytes() {
        let dropped = Arc::new(AtomicBool::new(false));
        let body = test_body(source(dropped.clone()), || Box::pin(async { Ok(false) }));
        released(&dropped).await;
        let mut stream = body.into_data_stream();
        assert!(stream.next().await.unwrap().is_err());
        assert!(stream.next().await.is_none());
    }
    #[tokio::test]
    async fn unavailable_authorization_fails_closed_while_consumer_is_paused() {
        for hangs in [false, true] {
            let dropped = Arc::new(AtomicBool::new(false));
            let body = test_body(source(dropped.clone()), move || {
                Box::pin(async move {
                    if hangs {
                        std::future::pending().await
                    } else {
                        Err(anyhow::anyhow!("database unavailable"))
                    }
                })
            });
            released(&dropped).await;
            assert!(body.into_data_stream().next().await.unwrap().is_err());
        }
    }
    #[tokio::test]
    async fn consumer_drop_releases_source_without_waiting_for_next_check() {
        let dropped = Arc::new(AtomicBool::new(false));
        let body = test_body(source(dropped.clone()), || Box::pin(async { Ok(true) }));
        tokio::task::yield_now().await;
        drop(body);
        released(&dropped).await;
    }
    #[tokio::test]
    async fn successful_body_reaches_eof_unchanged() {
        let body = test_body(Body::from("small media body"), || {
            Box::pin(async { Ok(true) })
        });
        let bytes = axum::body::to_bytes(body, 1024).await.unwrap();
        assert_eq!(bytes.as_ref(), b"small media body");
    }
}
