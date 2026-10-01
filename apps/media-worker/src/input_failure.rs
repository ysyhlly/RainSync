use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
};
use tokio::sync::watch;
use uuid::Uuid;

/// Only the encoder's unguessable execution token can associate proxy failures
/// with a running attempt. Browser/probe requests and old streams cannot poison
/// a newer execution. Stores classification and lifetime only, never URLs or response text.
#[derive(Clone, Default)]
pub struct Registry(Arc<Mutex<HashMap<Uuid, (Uuid, Observation)>>>);
#[derive(Clone)]
pub struct Observation(Arc<AtomicU8>, watch::Sender<bool>);
impl Default for Observation {
    fn default() -> Self {
        Self(Default::default(), watch::channel(false).0)
    }
}
pub struct Guard {
    registry: Registry,
    token: Uuid,
    observation: Observation,
}
impl Registry {
    pub fn register(&self, session: Uuid) -> Guard {
        let token = Uuid::new_v4();
        let observation = Observation::default();
        self.0
            .lock()
            .unwrap()
            .insert(token, (session, observation.clone()));
        Guard {
            registry: self.clone(),
            token,
            observation,
        }
    }
    pub fn observe(&self, session: Uuid, token: Option<Uuid>) -> Observation {
        token
            .and_then(|t| {
                self.0
                    .lock()
                    .unwrap()
                    .get(&t)
                    .filter(|(id, _)| *id == session)
                    .map(|(_, o)| o.clone())
            })
            .unwrap_or_default()
    }
}
impl Observation {
    /// End only the execution that owns this observation. Existing relay
    /// streams must stop even when their HTTP bodies are not being polled.
    pub fn stop(&self) {
        self.1.send_replace(true);
    }
    pub async fn stopped(&self) {
        let mut stop = self.1.subscribe();
        if !*stop.borrow_and_update() {
            let _ = stop.changed().await;
        }
    }
    pub fn transient(&self) {
        self.0.fetch_max(1, Ordering::Relaxed);
    }
    pub fn permanent(&self) {
        self.0.fetch_max(2, Ordering::Relaxed);
    }
    pub fn denied(&self) {
        self.0.fetch_max(3, Ordering::Relaxed);
    }
    // Preserve a confirmed source conflict across concurrent generic failures.
    // A transport retry cannot repair a grant pinned to the previous version.
    pub fn source_version_required(&self) {
        self.0.fetch_max(4, Ordering::Relaxed);
    }
    pub fn source_seek_unsupported(&self) {
        self.0.fetch_max(5, Ordering::Relaxed);
    }
    pub fn source_changed(&self) {
        self.0.fetch_max(6, Ordering::Relaxed);
    }
    pub fn status(&self, status: reqwest::StatusCode) {
        if status.is_server_error() || matches!(status.as_u16(), 408 | 429) {
            self.transient();
        } else if matches!(status.as_u16(), 401 | 403) {
            self.denied();
        } else if status.is_client_error() {
            // An authorization/not-found response is not made transient by an
            // unrelated simultaneous transport failure within this execution.
            self.permanent();
        }
    }
    pub fn network(&self, error: &reqwest::Error) {
        // reqwest wraps bytes_stream transport errors as Decode; this is HTTP
        // body decoding, not FFmpeg's media parser/codec result.
        if error.is_connect()
            || error.is_timeout()
            || error.is_request()
            || error.is_body()
            || error.is_decode()
        {
            self.transient();
        }
    }
}
impl Guard {
    pub fn token(&self) -> Uuid {
        self.token
    }
    pub fn failure(&self) -> Option<persistence::media_jobs::JobFailure> {
        use persistence::media_jobs::JobFailure;
        match self.observation.0.load(Ordering::Relaxed) {
            1 => Some(JobFailure::UpstreamTransient),
            2 => Some(JobFailure::ExecutionFailed),
            3 => Some(JobFailure::InputDenied),
            4 => Some(JobFailure::SourceVersionRequired),
            5 => Some(JobFailure::SourceSeekUnsupported),
            6 => Some(JobFailure::SourceChanged),
            _ => None,
        }
    }
    #[cfg(test)]
    fn retryable(&self) -> bool {
        matches!(
            self.failure(),
            Some(persistence::media_jobs::JobFailure::UpstreamTransient)
        )
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.registry.0.lock().unwrap().remove(&self.token);
        // The HTTP body may outlive its FFmpeg consumer under backpressure.
        // Cancel this execution's existing streams independently of body Drop.
        self.observation.stop();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn reset_and_truncated_http_bodies_are_transport_failures() {
        use futures_util::StreamExt;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for truncated in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 1024];
                assert!(stream.read(&mut buffer).await.unwrap() > 0);
                if truncated {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\na",
                        )
                        .await
                        .unwrap();
                }
            });
            let registry = Registry::default();
            let id = Uuid::new_v4();
            let guard = registry.register(id);
            let observer = registry.observe(id, Some(guard.token()));
            match reqwest::Client::new()
                .get(format!("http://{address}/"))
                .send()
                .await
            {
                Err(error) => observer.network(&error),
                Ok(response) => {
                    assert!(truncated);
                    let mut stream = response.bytes_stream();
                    while let Some(chunk) = stream.next().await {
                        if let Err(error) = chunk {
                            observer.network(&error);
                        }
                    }
                }
            }
            server.await.unwrap();
            assert!(guard.retryable());
        }
    }
    #[test]
    fn observations_are_execution_scoped_and_permanent_errors_win() {
        let registry = Registry::default();
        let id = Uuid::new_v4();
        let old = registry.register(id);
        registry
            .observe(id, None)
            .status(reqwest::StatusCode::SERVICE_UNAVAILABLE);
        registry
            .observe(Uuid::new_v4(), Some(old.token()))
            .status(reqwest::StatusCode::SERVICE_UNAVAILABLE);
        assert!(!old.retryable());
        let stream = registry.observe(id, Some(old.token()));
        stream.status(reqwest::StatusCode::TOO_MANY_REQUESTS);
        assert!(old.retryable());
        let token = old.token();
        drop(old);
        let next = registry.register(id);
        stream.status(reqwest::StatusCode::BAD_GATEWAY);
        registry
            .observe(id, Some(token))
            .status(reqwest::StatusCode::SERVICE_UNAVAILABLE);
        assert!(!next.retryable());
        let current = registry.observe(id, Some(next.token()));
        current.status(reqwest::StatusCode::FORBIDDEN);
        current.status(reqwest::StatusCode::GATEWAY_TIMEOUT);
        assert!(!next.retryable());
        drop(next);
        assert!(registry.0.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn execution_drop_stops_old_streams_but_not_the_next_attempt_or_direct_requests() {
        let registry = Registry::default();
        let id = Uuid::new_v4();
        let old = registry.register(id);
        let token = old.token();
        let old_stream = registry.observe(id, Some(token));
        let next = registry.register(id);
        let current = registry.observe(id, Some(next.token()));
        drop(old);
        tokio::time::timeout(std::time::Duration::from_millis(500), old_stream.stopped())
            .await
            .unwrap();
        for unrelated in [
            current.clone(),
            registry.observe(id, None),
            registry.observe(id, Some(token)),
            registry.observe(Uuid::new_v4(), Some(next.token())),
        ] {
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(20), unrelated.stopped())
                    .await
                    .is_err()
            );
        }
        drop(next);
        current.stopped().await;
    }
    #[test]
    fn source_conflicts_survive_other_failures_and_stay_execution_scoped() {
        use persistence::media_jobs::{JobFailure, terminal_error};
        let registry = Registry::default();
        let id = Uuid::new_v4();
        for (changed, reason) in [(false, "source_version_required"), (true, "source_changed")] {
            let guard = registry.register(id);
            let observer = registry.observe(id, Some(guard.token()));
            if changed {
                observer.source_changed();
            } else {
                observer.source_version_required();
            }
            observer.permanent();
            observer.transient();
            assert_eq!(guard.failure().map(JobFailure::reason), Some(reason));
            assert_eq!(terminal_error(Some(reason)), (409, reason));
            assert!(!guard.retryable());
            drop(guard);
            let next = registry.register(id);
            observer.source_changed();
            assert!(next.failure().is_none());
        }
        assert_eq!(
            terminal_error(Some("private upstream diagnostic")),
            (502, "media_job_failed")
        );
    }
    #[test]
    fn confirmed_upstream_denial_is_specific_and_never_a_login_or_retry_signal() {
        for status in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
        ] {
            let registry = Registry::default();
            let id = Uuid::new_v4();
            let guard = registry.register(id);
            let observer = registry.observe(id, Some(guard.token()));
            observer.status(status);
            observer.transient();
            observer.permanent();
            assert_eq!(guard.failure().unwrap().reason(), "media_input_denied");
            assert_eq!(
                persistence::media_jobs::terminal_error(Some("media_input_denied")),
                (502, "media_input_denied")
            );
            assert!(!guard.retryable());
            observer.source_changed();
            assert_eq!(guard.failure().unwrap().reason(), "source_changed");
        }
    }
}
