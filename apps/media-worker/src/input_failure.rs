use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
};
use uuid::Uuid;

/// Only the encoder's unguessable execution token can associate proxy failures
/// with a running attempt. Browser/probe requests and old streams cannot poison
/// a newer execution. Stores classification only, never URLs or response text.
#[derive(Clone, Default)]
pub struct Registry(Arc<Mutex<HashMap<Uuid, (Uuid, Observation)>>>);
#[derive(Clone, Default)]
pub struct Observation(Arc<AtomicU8>);
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
    pub fn transient(&self) {
        self.0.fetch_max(1, Ordering::Relaxed);
    }
    pub fn permanent(&self) {
        self.0.store(2, Ordering::Relaxed);
    }
    pub fn status(&self, status: reqwest::StatusCode) {
        if status.is_server_error() || matches!(status.as_u16(), 408 | 429) {
            self.transient();
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
}
