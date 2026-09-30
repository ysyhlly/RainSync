//! Connection-local delivery keeps replaceable telemetry away from durable control.
//! The existing WebSocket envelopes are unchanged; chat catches up over REST after
//! reconnect, and control lag requires an authoritative snapshot.
use serde_json::Value;
use tokio::sync::broadcast;

#[derive(Clone)]
pub(super) struct Bus {
    control: broadcast::Sender<Value>,
    chat: broadcast::Sender<Value>,
    status: broadcast::Sender<Value>,
}

pub(super) struct Subscription {
    control: broadcast::Receiver<Value>,
    chat: broadcast::Receiver<Value>,
    status: broadcast::Receiver<Value>,
    control_burst: u8,
    status_turn: bool,
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
        }
    }

    pub(super) fn send(&self, value: Value) -> usize {
        let channel = match value["type"].as_str() {
            Some("CHAT") => &self.chat,
            Some("CLIENT_STATUS") => &self.status,
            _ => &self.control,
        };
        // Broadcast never awaits a receiver. A slow connection cannot hold the
        // room actor or consume another connection's delivery capacity.
        channel.send(value).unwrap_or(0)
    }

    pub(super) fn receiver_count(&self) -> usize {
        self.control.receiver_count()
    }

    pub(super) fn subscribe(&self) -> Subscription {
        Subscription {
            control: self.control.subscribe(),
            chat: self.chat.subscribe(),
            status: self.status.subscribe(),
            control_burst: 0,
            status_turn: false,
        }
    }
}

impl Subscription {
    fn background_result(
        result: Result<Value, broadcast::error::RecvError>,
        replaceable: bool,
    ) -> Option<Result<Value, Lag>> {
        match result {
            Ok(value) => Some(Ok(value)),
            Err(broadcast::error::RecvError::Lagged(_)) if replaceable => None,
            Err(broadcast::error::RecvError::Lagged(_)) => Some(Err(Lag::Chat)),
            Err(broadcast::error::RecvError::Closed) => Some(Err(Lag::Closed)),
        }
    }

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

    fn note_delivery(&mut self, value: &Result<Value, Lag>) {
        if let Ok(value) = value {
            match value["type"].as_str() {
                Some("CHAT") => {
                    self.control_burst = 0;
                    self.status_turn = true;
                }
                Some("CLIENT_STATUS") => {
                    self.control_burst = 0;
                    self.status_turn = false;
                }
                _ => self.control_burst = self.control_burst.saturating_add(1).min(8),
            }
        }
    }

    pub(super) async fn recv(&mut self) -> Result<Value, Lag> {
        loop {
            // Control wins ordinary contention. After eight control envelopes,
            // yield one slot to ready chat/status, alternating the preference so
            // neither background stream can be starved by sustained control.
            if self.control_burst >= 8 {
                let ready = if self.status_turn {
                    self.status_ready().or_else(|| self.chat_ready())
                } else {
                    self.chat_ready().or_else(|| self.status_ready())
                };
                if let Some(value) = ready {
                    self.note_delivery(&value);
                    return value;
                }
            }
            let preferred_is_status = self.status_turn;
            let (preferred, secondary) = if preferred_is_status {
                (&mut self.status, &mut self.chat)
            } else {
                (&mut self.chat, &mut self.status)
            };
            let value = tokio::select! {
                biased;
                value = self.control.recv() => value.map_err(|error| match error {
                    broadcast::error::RecvError::Lagged(_) => Lag::Control,
                    broadcast::error::RecvError::Closed => Lag::Closed,
                }),
                value = preferred.recv() => match Self::background_result(value, preferred_is_status) {
                    Some(value) => value,
                    None => continue,
                },
                value = secondary.recv() => match Self::background_result(value, !preferred_is_status) {
                    Some(value) => value,
                    None => continue,
                },
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
