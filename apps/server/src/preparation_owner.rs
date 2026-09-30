//! Preparation ownership outlives HTTP waiters and includes durable drain ACKs.
//! Closing admission and incrementing the count share one synchronous lock, so
//! graceful shutdown cannot miss a reservation still waiting to commit.
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Default)]
struct State {
    closing: bool,
    owners: usize,
}

pub struct Registry {
    state: Mutex<State>,
    count: watch::Sender<usize>,
    stop: watch::Sender<bool>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            state: Default::default(),
            count: watch::channel(0).0,
            stop: watch::channel(false).0,
        }
    }
}

pub struct Owner {
    registry: Arc<Registry>,
    stop: watch::Receiver<bool>,
}

impl Registry {
    pub fn admit(self: &Arc<Self>) -> Option<Owner> {
        let mut state = self.state.lock().expect("preparation owner registry");
        if state.closing {
            return None;
        }
        state.owners += 1;
        self.count.send_replace(state.owners);
        Some(Owner {
            registry: self.clone(),
            stop: self.stop.subscribe(),
        })
    }

    pub fn close(&self) {
        let mut state = self.state.lock().expect("preparation owner registry");
        state.closing = true;
        self.stop.send_replace(true);
    }

    pub async fn drain(&self) {
        self.close();
        let mut count = self.count.subscribe();
        while *count.borrow_and_update() != 0 {
            count.changed().await.expect("preparation owner count");
        }
    }
}

impl Owner {
    /// Only cancel source work, never the durable reservation admission/commit.
    /// An owner admitted before close observes cancellation even if its task or
    /// transaction did not begin polling until after the shutdown signal.
    pub async fn cancelled(&self) {
        let mut stop = self.stop.clone();
        while !*stop.borrow_and_update() {
            if stop.changed().await.is_err() {
                return;
            }
        }
    }

    /// The caller has already drained all scoped local resources. Retain this
    /// owner through transient DB errors, including during graceful shutdown.
    /// This acknowledges only the preparation; remote resource cleanup still
    /// needs its separate positive upstream/Worker/Agent receipt.
    pub async fn acknowledge(
        self,
        app: &super::App,
        reservation: &super::playback_requests::Reservation,
    ) {
        loop {
            if super::playback_requests::drained(app, reservation)
                .await
                .is_ok()
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        let mut state = self
            .registry
            .state
            .lock()
            .expect("preparation owner registry");
        state.owners -= 1;
        self.registry.count.send_replace(state.owners);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn close_fences_late_admission_and_cancels_unpolled_owner() {
        let registry = Arc::new(Registry::default());
        let owner = registry.admit().unwrap();
        registry.close();
        assert!(registry.admit().is_none());
        tokio::time::timeout(Duration::from_secs(1), owner.cancelled())
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), registry.drain())
                .await
                .is_err()
        );
        drop(owner);
        tokio::time::timeout(Duration::from_secs(1), registry.drain())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn detached_ack_owner_is_included_in_shutdown_barrier() {
        let registry = Arc::new(Registry::default());
        let owner = registry.admit().unwrap();
        let (release, wait) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _owner = owner;
            let _ = wait.await;
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(10), registry.drain())
                .await
                .is_err()
        );
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), registry.drain())
            .await
            .unwrap();
    }
}
