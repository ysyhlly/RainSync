//! HTTP code exchanges belong to the application, never to a request waiter.
//! Closing stops admission; drain waits for every admitted operation and rejects
//! unconfirmed durability. Dropping an HTTP waiter cannot cancel token custody.
use super::*;
use futures_util::FutureExt;
use std::{future::Future, panic::AssertUnwindSafe, sync::Mutex as StdMutex};
use tokio::sync::{Notify, oneshot};
#[derive(Default)]
struct State {
    closing: bool,
    active: usize,
    unconfirmed: bool,
}
pub struct Registry {
    state: StdMutex<State>,
    notify: Notify,
}
impl Registry {
    pub fn new() -> Self {
        Self {
            state: StdMutex::new(State::default()),
            notify: Notify::new(),
        }
    }
    pub fn close(&self) {
        self.state.lock().unwrap().closing = true;
        self.notify.notify_waiters();
    }
    pub(super) fn launch<F>(self: &Arc<Self>, work: F) -> Result<oneshot::Receiver<Result<Value>>>
    where
        F: Future<Output = (Result<Value>, bool)> + Send + 'static,
    {
        {
            let mut state = self.state.lock().unwrap();
            if state.closing {
                return Err(err(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "platform_oauth_exchange_closing",
                ));
            }
            state.active += 1;
        }
        let registry = self.clone();
        let (send, receive) = oneshot::channel();
        tokio::spawn(async move {
            let result = AssertUnwindSafe(work).catch_unwind().await;
            let (response, durable) = match result {
                Ok(result) => result,
                Err(_) => (
                    Err(err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "platform_oauth_exchange_unknown",
                    )),
                    false,
                ),
            };
            {
                let mut state = registry.state.lock().unwrap();
                state.active -= 1;
                state.unconfirmed |= !durable;
            }
            registry.notify.notify_waiters();
            let _ = send.send(response);
        });
        Ok(receive)
    }
    pub async fn drain(&self) -> Result<()> {
        self.close();
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let state = self.state.lock().unwrap();
                if state.active == 0 {
                    return if state.unconfirmed {
                        Err(err(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "platform_oauth_exchange_durability_unconfirmed",
                        ))
                    } else {
                        Ok(())
                    };
                }
            }
            notified.await;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn dropped_waiter_does_not_abandon_work_and_close_drains_admitted_operation() {
        let registry = Arc::new(Registry::new());
        let (send, receive) = oneshot::channel::<()>();
        let result = registry
            .launch(async move {
                receive.await.unwrap();
                (Ok(json!({"confirmed":true})), true)
            })
            .unwrap();
        drop(result);
        registry.close();
        assert!(registry.launch(async { (Ok(Value::Null), true) }).is_err());
        let owned = registry.clone();
        let drain = tokio::spawn(async move { owned.drain().await });
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        send.send(()).unwrap();
        assert!(drain.await.unwrap().is_ok());
    }
    #[tokio::test]
    async fn unconfirmed_custody_never_acknowledges_positive_drain() {
        let registry = Arc::new(Registry::new());
        let result = registry
            .launch(async {
                (
                    Err(err(StatusCode::INTERNAL_SERVER_ERROR, "fixture")),
                    false,
                )
            })
            .unwrap();
        assert!(result.await.unwrap().is_err());
        assert!(registry.drain().await.is_err());
        assert!(registry.drain().await.is_err());
    }
}
