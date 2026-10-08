//! Live authority adapter for the shared tracked finite-delivery owner.
//! The shared owner admits before source/header work, drives the source without
//! HTTP polling, copies bounded frames, monitors queued tails, and records
//! positive source+queue disposal before shutdown can finish.
use super::*;
use axum::body::{Body, Bytes};
use futures_util::stream;
use media_core::finite_delivery::{self, Checker, Evidence};
use tokio::sync::OwnedSemaphorePermit;

pub(super) use finite_delivery::Registry;
pub(super) struct Graph {
    pub runtime: std::sync::Weak<Runtime>,
    pub identity: Identity,
    pub key: String,
}
struct Scope {
    app: App,
    authority: delivery::Authority,
    expires: i64,
    graph: Option<Graph>,
}
impl Scope {
    async fn evidence(&self) -> anyhow::Result<Evidence> {
        delivery::check(&self.app, &self.authority)
            .await
            .map_err(|_| anyhow::anyhow!("native_live_delivery_ended"))?;
        if let Some(graph) = &self.graph {
            let runtime = graph
                .runtime
                .upgrade()
                .ok_or_else(|| anyhow::anyhow!("native_live_delivery_ended"))?;
            let window = runtime.window.lock().await;
            if !window.latest().is_some_and(|playlist| {
                playlist.segments.iter().any(|segment| {
                    delivery::key(&graph.identity, segment).is_ok_and(|key| key == graph.key)
                })
            }) {
                anyhow::bail!("native_live_delivery_ended");
            }
        }
        let remaining = self
            .expires
            .checked_sub(now_ms().map_err(|_| anyhow::anyhow!("native_live_delivery_ended"))?)
            .filter(|value| *value > 0)
            .ok_or_else(|| anyhow::anyhow!("native_live_delivery_ended"))?;
        let remaining = Duration::from_millis(remaining as u64);
        // Absolute grant time never grows. A short confirmation lease bounds
        // read-side evidence while the independent owner checks revocation.
        Ok(Evidence {
            grant_remaining: remaining,
            lease_remaining: remaining.min(Duration::from_secs(2)),
        })
    }
}
pub(super) struct Ready {
    pub payload: Vec<u8>,
    pub permits: Vec<OwnedSemaphorePermit>,
    pub head: bool,
    pub content_type: &'static str,
}
struct Source {
    bytes: Bytes,
    sent: bool,
    _permits: Vec<OwnedSemaphorePermit>,
    #[cfg(test)]
    dropped: Option<Arc<std::sync::atomic::AtomicBool>>,
}
#[cfg(test)]
impl Drop for Source {
    fn drop(&mut self) {
        if let Some(dropped) = &self.dropped {
            dropped.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
}
fn source_body(source: Source) -> Body {
    Body::from_stream(stream::unfold(source, |mut source| async move {
        if source.sent {
            None
        } else {
            source.sent = true;
            Some((Ok::<_, std::io::Error>(source.bytes.clone()), source))
        }
    }))
}
fn response(ready: Ready) -> Result<Response> {
    if ready.payload.len() > live::MAX_SEGMENT_BYTES {
        return Err(invalid());
    }
    let length = ready.payload.len();
    let content_type = ready.content_type;
    let body = if ready.head {
        drop(ready);
        Body::empty()
    } else {
        source_body(Source {
            bytes: Bytes::from(ready.payload),
            sent: false,
            _permits: ready.permits,
            #[cfg(test)]
            dropped: None,
        })
    };
    let mut response = Response::new(body);
    delivery::private(&mut response, content_type, length);
    Ok(response)
}
pub(super) async fn owned_response<F>(
    app: App,
    authority: delivery::Authority,
    expires: i64,
    graph: Option<Graph>,
    work: F,
) -> Result<Response>
where
    F: std::future::Future<Output = Result<Ready>> + Send + 'static,
{
    let registry = app.live_playback.deliveries.clone();
    let scope = Arc::new(Scope {
        app,
        authority,
        expires,
        graph,
    });
    let checker: Checker = Arc::new(move || {
        let scope = scope.clone();
        Box::pin(async move { scope.evidence().await })
    });
    finite_delivery::serve(
        registry,
        checker,
        move || async move { response(work.await?) },
        Arc::new(invalid),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    fn checker(until: Instant) -> Checker {
        Arc::new(move || {
            Box::pin(async move {
                let remaining = until.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    anyhow::bail!("expired");
                }
                Ok(Evidence {
                    grant_remaining: remaining,
                    lease_remaining: remaining,
                })
            })
        })
    }
    #[tokio::test]
    async fn live_source_buffer_and_permits_dispose_without_http_polling() {
        let registry = Arc::new(Registry::default());
        let semaphore = Arc::new(Semaphore::new(1));
        let dropped = Arc::new(AtomicBool::new(false));
        let source = Source {
            bytes: Bytes::from(vec![7; 1024 * 1024]),
            sent: false,
            _permits: vec![semaphore.clone().acquire_owned().await.unwrap()],
            dropped: Some(dropped.clone()),
        };
        let response = finite_delivery::serve(
            registry.clone(),
            checker(Instant::now() + Duration::from_millis(100)),
            move || async move { Ok::<_, Error>(Response::new(source_body(source))) },
            Arc::new(invalid),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        registry.drain().await.unwrap();
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(semaphore.available_permits(), 1);
        drop(response);
    }
    #[tokio::test]
    async fn live_head_drops_payload_and_permits_before_header_ack() {
        let semaphore = Arc::new(Semaphore::new(1));
        let response = response(Ready {
            payload: vec![9; 1024 * 1024],
            permits: vec![semaphore.clone().acquire_owned().await.unwrap()],
            head: true,
            content_type: "video/mp2t",
        })
        .unwrap();
        assert_eq!(semaphore.available_permits(), 1);
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            (1024 * 1024).to_string()
        );
        assert!(
            axum::body::to_bytes(response.into_body(), 1)
                .await
                .unwrap()
                .is_empty()
        );
    }
    #[tokio::test]
    async fn live_queued_tail_and_blocked_read_cannot_outlive_shutdown_receipt() {
        let registry = Arc::new(Registry::default());
        let allowed = Arc::new(AtomicBool::new(true));
        let gate = allowed.clone();
        let checker: Checker = Arc::new(move || {
            let gate = gate.clone();
            Box::pin(async move {
                if !gate.load(Ordering::SeqCst) {
                    futures_util::future::pending::<()>().await;
                }
                Ok(Evidence {
                    grant_remaining: Duration::from_secs(10),
                    lease_remaining: Duration::from_secs(10),
                })
            })
        });
        let response = finite_delivery::serve(
            registry.clone(),
            checker,
            move || async move { Ok::<_, Error>(Response::new(Body::from(vec![3; 16 * 1024]))) },
            Arc::new(invalid),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(25)).await;
        allowed.store(false, Ordering::SeqCst);
        let mut read = Box::pin(axum::body::to_bytes(response.into_body(), 16 * 1024));
        assert!(futures_util::poll!(&mut read).is_pending());
        registry.drain().await.unwrap();
        assert!(read.await.is_err());
    }
}
