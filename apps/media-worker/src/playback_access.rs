//! Revalidate a delivery grant independently of HTTP backpressure. Dropping the
//! producer also drops the local file, upstream response, or NAS registration.
use axum::{
    body::{Body, Bytes},
    response::Response,
};
use futures_util::StreamExt;
use sqlx::{Acquire, PgPool, Postgres, pool::PoolConnection};
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
    state: Mutex<OwnerState>,
    count: watch::Sender<usize>,
    stop: watch::Sender<bool>,
}
impl Default for Owners {
    fn default() -> Self {
        Self {
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

async fn authorized(pool: &PgPool, id: Uuid, token_hash: &str) -> anyhow::Result<bool> {
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
    let allowed = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id JOIN rooms r ON r.id=p.room_id WHERE r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND p.id=$1 AND p.delivery_token_hash=$2 AND p.expires_at>clock_timestamp() AND NOT p.stopped AND EXISTS(SELECT 1 FROM media_items mi JOIN sources src ON src.id=mi.source_id WHERE mi.id=p.media_id AND COALESCE((p.resource->>'source_policy_revision')::bigint,0)=src.access_policy_revision) AND (s.state->>'media_generation')::bigint=p.generation AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id))")
        .bind(id).bind(token_hash).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    drop(connection.0.take());
    Ok(allowed)
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

pub async fn protect(
    prepare: impl Future<Output = super::Result<Response>> + Send + 'static,
    pool: PgPool,
    id: Uuid,
    token_hash: String,
    registry: Registry,
    input_cancel: crate::input_failure::Observation,
) -> super::Result<Response> {
    let admission = registry
        .admit()
        .ok_or_else(|| Denied::Unavailable.response())?;
    let (mut sender, response) = oneshot::channel();
    // Keep INSERT/COMMIT ownership outside cancellation: a late committed row
    // must be acknowledged, never left behind by a vanished HTTP waiter.
    tokio::spawn(async move {
        let owner = Uuid::new_v4();
        let registered =
            persistence::media_executions::begin_delivery(&pool, id, &token_hash, owner).await;
        let execution_id = match registered {
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
            id: execution_id,
            owner,
            scope: scope.clone(),
            admission,
        };
        let result = tokio::select! {
            biased;
            _ = shutdown(Some(registry.0.stop.subscribe())) => Some(Err(Denied::Unavailable.response())),
            _ = sender.closed() => None,
            _ = input_cancel.stopped() => Some(Err(Denied::Unavailable.response())),
            result = scope.run(prepare_response(prepare, pool.clone(), id, token_hash.clone())) => Some(result),
        };
        match result {
            Some(Ok((response, checked_at))) => {
                let (parts, body) = response.into_parts();
                let body = guarded_body(
                    body,
                    move || {
                        let pool = pool.clone();
                        let token_hash = token_hash.clone();
                        async move { authorized(&pool, id, &token_hash).await }
                    },
                    checked_at,
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
) -> super::Result<(Response, Instant)> {
    // Header waits and bounded playlist/subtitle buffering also own a source.
    // Revocation must cancel these futures before any response body exists.
    let checker = || {
        let pool = pool.clone();
        let token_hash = token_hash.clone();
        async move { authorized(&pool, id, &token_hash).await }
    };
    let prepared = async {
        let response = prepare.await?;
        // Preparation can take time (e.g. waiting for an HLS output). Check
        // again before committing headers, while the preparation monitor still
        // owns its deadline and can drop this already-created response.
        let checked_at = Instant::now();
        match tokio::time::timeout(CHECK_TIMEOUT, authorized(&pool, id, &token_hash)).await {
            Ok(Ok(true)) => Ok((response, checked_at)),
            Ok(Ok(false)) => Err(Denied::Revoked.response()),
            _ => Err(Denied::Unavailable.response()),
        }
    };
    let (response, checked_at) = tokio::select! {
        biased;
        denied = monitor(checker, Instant::now(), CHECK_INTERVAL, CHECK_TIMEOUT, MAX_AUTH_AGE) => {
            return Err(denied.response());
        },
        response = prepared => response?,
    };
    Ok((response, checked_at))
}

#[derive(Clone, Copy)]
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

async fn monitor<F, C>(
    mut check: F,
    mut confirmed_at: Instant,
    interval: Duration,
    timeout: Duration,
    max_age: Duration,
) -> Denied
where
    F: FnMut() -> C,
    C: Future<Output = anyhow::Result<bool>>,
{
    loop {
        tokio::time::sleep_until((Instant::now() + interval).min(confirmed_at + max_age)).await;
        let began = Instant::now();
        // A delayed result cannot extend the lifetime of an older DB snapshot.
        let result = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(confirmed_at + max_age) => return Denied::Unavailable,
            result = tokio::time::timeout(timeout, check()) => result,
        };
        match result {
            Ok(Ok(true)) => confirmed_at = began,
            Ok(Ok(false)) => return Denied::Revoked,
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

fn guarded_body<F, C>(
    body: Body,
    check: F,
    checked_at: Instant,
    interval: Duration,
    timeout: Duration,
    max_age: Duration,
    owners: SourceOwners,
) -> Body
where
    F: FnMut() -> C + Send + 'static,
    C: Future<Output = anyhow::Result<bool>> + Send,
{
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
            _ = monitor(check, checked_at, interval, timeout, max_age) => { let _ = revoke.send(true); },
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
