//! Connection-local delivery keeps replaceable telemetry away from durable control.
//! The existing WebSocket envelopes are unchanged; chat catches up over REST after
//! reconnect, and control lag requires an authoritative snapshot.
use serde_json::Value;
use tokio::sync::{broadcast, watch};

#[derive(Clone)]
pub(super) struct Bus {
    control: broadcast::Sender<Value>,
    chat: broadcast::Sender<Value>,
    status: broadcast::Sender<Value>,
    presence: watch::Sender<Option<Value>>,
}

pub(super) struct Subscription {
    control: broadcast::Receiver<Value>,
    chat: broadcast::Receiver<Value>,
    status: broadcast::Receiver<Value>,
    presence: Option<watch::Receiver<Option<Value>>>,
    control_burst: u8,
    background_turn: u8,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Lag {
    Control,
    Chat,
    Closed,
}

impl Bus {
    pub(super) fn new() -> Self {
        Self {
            control: broadcast::channel(128).0,
            chat: broadcast::channel(128).0,
            status: broadcast::channel(32).0,
            presence: watch::channel(None).0,
        }
    }

    pub(super) fn send(&self, value: Value) -> usize {
        if value["type"] == "PRESENCE_SNAPSHOT" {
            return self.send_presence(value);
        }
        let channel = match value["type"].as_str() {
            Some("CHAT") => &self.chat,
            Some("CLIENT_STATUS") => &self.status,
            _ => &self.control,
        };
        // Broadcast never awaits a receiver. A slow connection cannot hold the
        // room actor or consume another connection's delivery capacity.
        channel.send(value).unwrap_or(0)
    }

    pub(super) fn send_presence(&self, value: Value) -> usize {
        self.presence.send_if_modified(|current| {
            if current.as_ref() == Some(&value) {
                return false;
            }
            *current = Some(value);
            true
        });
        self.presence.receiver_count()
    }

    pub(super) fn receiver_count(&self) -> usize {
        self.control.receiver_count()
    }

    #[cfg(test)]
    pub(super) fn subscribe(&self) -> Subscription {
        self.subscribe_with_presence(false)
    }

    pub(super) fn subscribe_with_presence(&self, presence: bool) -> Subscription {
        Subscription {
            control: self.control.subscribe(),
            chat: self.chat.subscribe(),
            status: self.status.subscribe(),
            presence: presence.then(|| self.presence.subscribe()),
            control_burst: 0,
            background_turn: 0,
        }
    }
}

impl Subscription {
    fn chat_ready(&mut self) -> Option<Result<Value, Lag>> {
        match self.chat.try_recv() {
            Ok(value) => Some(Ok(value)),
            Err(broadcast::error::TryRecvError::Lagged(_)) => Some(Err(Lag::Chat)),
            Err(broadcast::error::TryRecvError::Closed) => Some(Err(Lag::Closed)),
            Err(broadcast::error::TryRecvError::Empty) => None,
        }
    }

    fn status_ready(&mut self) -> Option<Result<Value, Lag>> {
        // One lag notification advances to the retained telemetry. Limit the
        // work even when producers keep publishing while this task is scheduled.
        for _ in 0..2 {
            match self.status.try_recv() {
                Ok(value) => return Some(Ok(value)),
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(broadcast::error::TryRecvError::Closed) => return Some(Err(Lag::Closed)),
                Err(broadcast::error::TryRecvError::Empty) => return None,
            }
        }
        None
    }

    fn presence_ready(&mut self) -> Option<Result<Value, Lag>> {
        let receiver = self.presence.as_mut()?;
        match receiver.has_changed() {
            Ok(true) => receiver.borrow_and_update().clone().map(Ok),
            Ok(false) => None,
            Err(_) => Some(Err(Lag::Closed)),
        }
    }

    fn background_ready(&mut self) -> Option<Result<Value, Lag>> {
        for offset in 0..3 {
            let ready = match (self.background_turn + offset) % 3 {
                0 => self.chat_ready(),
                1 => self.status_ready(),
                _ => self.presence_ready(),
            };
            if ready.is_some() {
                return ready;
            }
        }
        None
    }

    async fn presence_next(
        receiver: &mut Option<watch::Receiver<Option<Value>>>,
    ) -> Result<Value, Lag> {
        let Some(receiver) = receiver else {
            return std::future::pending().await;
        };
        loop {
            receiver.changed().await.map_err(|_| Lag::Closed)?;
            if let Some(value) = receiver.borrow_and_update().clone() {
                return Ok(value);
            }
        }
    }

    fn note_delivery(&mut self, value: &Result<Value, Lag>) {
        if let Ok(value) = value {
            let next = match value["type"].as_str() {
                Some("CHAT") => Some(1),
                Some("CLIENT_STATUS") => Some(2),
                Some("PRESENCE_SNAPSHOT") => Some(0),
                _ => None,
            };
            if let Some(next) = next {
                self.control_burst = 0;
                self.background_turn = next;
            } else {
                self.control_burst = self.control_burst.saturating_add(1).min(8);
            }
        }
    }

    pub(super) async fn recv(&mut self) -> Result<Value, Lag> {
        loop {
            // Control wins normal contention; every eight envelopes allow one
            // ready background slot. Round-robin also avoids background starvation
            // when the control queue is empty. Presence retains only one full value.
            if self.control_burst >= 8
                && let Some(value) = self.background_ready()
            {
                self.note_delivery(&value);
                return value;
            }
            let ready = match self.control.try_recv() {
                Ok(value) => Some(Ok(value)),
                Err(broadcast::error::TryRecvError::Lagged(_)) => Some(Err(Lag::Control)),
                Err(broadcast::error::TryRecvError::Closed) => Some(Err(Lag::Closed)),
                Err(broadcast::error::TryRecvError::Empty) => None,
            };
            if let Some(value) = ready.or_else(|| self.background_ready()) {
                self.note_delivery(&value);
                return value;
            }
            let value = tokio::select! {
                biased;
                value = self.control.recv() => value.map_err(|error| match error {
                    broadcast::error::RecvError::Lagged(_) => Lag::Control,
                    broadcast::error::RecvError::Closed => Lag::Closed,
                }),
                value = self.chat.recv() => value.map_err(|error| match error {
                    broadcast::error::RecvError::Lagged(_) => Lag::Chat,
                    broadcast::error::RecvError::Closed => Lag::Closed,
                }),
                value = self.status.recv() => match value {
                    Ok(value) => Ok(value),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => Err(Lag::Closed),
                },
                value = Self::presence_next(&mut self.presence) => value,
            };
            self.note_delivery(&value);
            return value;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn telemetry_flood_cannot_evict_or_overtake_control() {
        let bus = Bus::new();
        let mut receiver = bus.subscribe();
        bus.send(json!({"type":"EVENT","state":{"revision":1}}));
        for seq in 0..1000 {
            bus.send(json!({"type":"CLIENT_STATUS","status":{"sequence":seq}}));
        }
        assert_eq!(receiver.recv().await.unwrap()["state"]["revision"], 1);
        assert_eq!(receiver.recv().await.unwrap()["type"], "CLIENT_STATUS");
    }

    #[tokio::test]
    async fn chat_flood_preserves_control_and_requires_chat_catchup() {
        let bus = Bus::new();
        let mut receiver = bus.subscribe();
        for seq in 0..1000 {
            bus.send(json!({"type":"CHAT","id":seq}));
        }
        bus.send(json!({"type":"EVENT","state":{"revision":2}}));
        assert_eq!(receiver.recv().await.unwrap()["state"]["revision"], 2);
        assert_eq!(receiver.recv().await, Err(Lag::Chat));
    }

    #[tokio::test]
    async fn a_slow_receiver_cannot_block_another_members_control() {
        let bus = Bus::new();
        let mut slow = bus.subscribe();
        let mut fast = bus.subscribe();
        for revision in 1..=1000 {
            bus.send(json!({"type":"EVENT","state":{"revision":revision}}));
            assert_eq!(fast.recv().await.unwrap()["state"]["revision"], revision);
        }
        assert_eq!(slow.recv().await, Err(Lag::Control));
        assert_eq!(bus.receiver_count(), 2);
        drop(slow);
        assert_eq!(bus.receiver_count(), 1);
    }

    #[tokio::test]
    async fn sustained_control_yields_bounded_slots_without_reordering_revisions() {
        let bus = Bus::new();
        let mut receiver = bus.subscribe();
        for revision in 1..=24 {
            bus.send(json!({"type":"EVENT","state":{"revision":revision}}));
        }
        bus.send(json!({"type":"CHAT","id":1}));
        bus.send(json!({"type":"CLIENT_STATUS","user_id":"device"}));
        for revision in 1..=8 {
            assert_eq!(
                receiver.recv().await.unwrap()["state"]["revision"],
                revision
            );
        }
        assert_eq!(receiver.recv().await.unwrap()["type"], "CHAT");
        for revision in 9..=16 {
            assert_eq!(
                receiver.recv().await.unwrap()["state"]["revision"],
                revision
            );
        }
        assert_eq!(receiver.recv().await.unwrap()["type"], "CLIENT_STATUS");
        for revision in 17..=24 {
            assert_eq!(
                receiver.recv().await.unwrap()["state"]["revision"],
                revision
            );
        }
    }

    #[tokio::test]
    async fn chat_cannot_starve_status_when_the_control_queue_is_idle() {
        let bus = Bus::new();
        let mut receiver = bus.subscribe();
        for id in 0..100 {
            bus.send(json!({"type":"CHAT","id":id}));
        }
        bus.send(json!({"type":"CLIENT_STATUS","status":{"sequence":1}}));
        assert_eq!(receiver.recv().await.unwrap()["type"], "CHAT");
        assert_eq!(receiver.recv().await.unwrap()["type"], "CLIENT_STATUS");
        assert_eq!(receiver.recv().await.unwrap()["id"], 1);
    }
}

#[cfg(test)]
mod presence_tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn presence_flood_coalesces_and_never_overtakes_control() {
        let bus = Bus::new();
        let mut receiver = bus.subscribe_with_presence(true);
        for seq in 0..1000 {
            bus.send_presence(json!({"type":"PRESENCE_SNAPSHOT","presence_seq":seq}));
        }
        bus.send(json!({"type":"EVENT","state":{"revision":1}}));
        assert_eq!(receiver.recv().await.unwrap()["state"]["revision"], 1);
        assert_eq!(receiver.recv().await.unwrap()["presence_seq"], 999);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), receiver.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn telemetry_churn_cannot_evict_presence_and_legacy_has_no_presence_subscription() {
        let bus = Bus::new();
        let mut modern = bus.subscribe_with_presence(true);
        let mut legacy = bus.subscribe();
        bus.send_presence(json!({"type":"PRESENCE_SNAPSHOT","presence_seq":7}));
        for seq in 0..1000 {
            bus.send(json!({"type":"CLIENT_STATUS","seq":seq}));
        }
        assert_eq!(modern.recv().await.unwrap()["type"], "CLIENT_STATUS");
        assert_eq!(modern.recv().await.unwrap()["presence_seq"], 7);
        // Drain the legacy telemetry; a presence-only update cannot wake it.
        for _ in 0..32 {
            legacy.recv().await.unwrap();
        }
        bus.send_presence(json!({"type":"PRESENCE_SNAPSHOT","presence_seq":8}));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), legacy.recv())
                .await
                .is_err()
        );
        assert_eq!(bus.receiver_count(), 2);
    }

    #[tokio::test]
    async fn sustained_control_chat_and_status_give_presence_a_bounded_slot() {
        let bus = Bus::new();
        let mut receiver = bus.subscribe_with_presence(true);
        for revision in 1..=32 {
            bus.send(json!({"type":"EVENT","state":{"revision":revision}}));
        }
        for id in 0..32 {
            bus.send(json!({"type":"CHAT","id":id}));
        }
        for id in 0..32 {
            bus.send(json!({"type":"CLIENT_STATUS","id":id}));
        }
        bus.send_presence(json!({"type":"PRESENCE_SNAPSHOT","presence_seq":1}));
        let mut controls = 0;
        for _ in 0..27 {
            let value = receiver.recv().await.unwrap();
            if value["type"] == "EVENT" {
                controls += 1;
                assert_eq!(value["state"]["revision"], controls);
            }
            if value["type"] == "PRESENCE_SNAPSHOT" {
                assert_eq!(controls, 24);
                return;
            }
        }
        panic!("presence was starved");
    }
}
