//! Room-local integration of negotiated leases. No lock spans a database or
//! network await. Queue values are hints; subjects are revalidated before send.
use super::{App, delivery};
use crate::{database_checks, presence};
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

struct State {
    leases: presence::Presence,
    sessions: HashMap<Uuid, String>,
}

#[derive(Clone)]
pub(super) struct Runtime {
    room: Uuid,
    state: Arc<Mutex<State>>,
    bus: delivery::Bus,
}

pub(super) struct Lease {
    pub(super) id: Uuid,
    runtime: Runtime,
}

impl Lease {
    pub(super) fn deadline(&self) -> Option<Instant> {
        self.runtime
            .state
            .lock()
            .expect("room presence poisoned")
            .leases
            .deadline(self.id)
            .filter(|deadline| *deadline > Instant::now())
    }

    pub(super) fn revoke(&self) {
        let mut state = self.runtime.state.lock().expect("room presence poisoned");
        state.leases.disconnect(self.id);
        state.sessions.remove(&self.id);
        self.runtime.publish(&mut state);
    }

    pub(super) fn renew(&self) -> bool {
        let mut state = self.runtime.state.lock().expect("room presence poisoned");
        let renewed = state.leases.renew(self.id, Instant::now());
        self.runtime.publish(&mut state);
        renewed
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.runtime.state.lock().expect("room presence poisoned");
        state.leases.disconnect(self.id);
        state.sessions.remove(&self.id);
        self.runtime.publish(&mut state);
    }
}

impl Runtime {
    pub(super) fn new(app: &App, room: Uuid, bus: delivery::Bus) -> Self {
        let runtime = Self {
            room,
            state: Arc::new(Mutex::new(State {
                leases: presence::Presence::new(app.presence_sequence.clone()),
                sessions: HashMap::new(),
            })),
            bus,
        };
        let expiry_weak = Arc::downgrade(&runtime.state);
        let expiry_bus = runtime.bus.clone();
        // Expiry has its own task: neither a permission query nor network write
        // can postpone removal at the monotonic deadline.
        tokio::spawn(async move {
            loop {
                let Some(state) = expiry_weak.upgrade() else {
                    break;
                };
                let deadline = {
                    let state = state.lock().expect("room presence poisoned");
                    state
                        .leases
                        .candidates()
                        .iter()
                        .filter_map(|(id, _)| state.leases.deadline(*id))
                        .min()
                };
                drop(state);
                tokio::time::sleep_until(tokio::time::Instant::from_std(
                    deadline.unwrap_or_else(|| Instant::now() + presence::LEASE),
                ))
                .await;
                let Some(state) = expiry_weak.upgrade() else {
                    break;
                };
                let runtime = Self {
                    room,
                    state,
                    bus: expiry_bus.clone(),
                };
                let mut state = runtime.state.lock().expect("room presence poisoned");
                runtime.publish(&mut state);
            }
        });
        let weak = Arc::downgrade(&runtime.state);
        let app = app.clone();
        let bus = runtime.bus.clone();
        tokio::spawn(async move {
            let mut refresh = tokio::time::interval(Duration::from_secs(15));
            loop {
                refresh.tick().await;
                let Some(state) = weak.upgrade() else { break };
                let runtime = Self {
                    room,
                    state,
                    bus: bus.clone(),
                };
                if runtime.snapshot(&app).await.is_err() {
                    runtime.fence();
                }
            }
        });
        runtime
    }

    /// Invoked only after current room/session admission, and only for v1.
    pub(super) fn register(
        &self,
        user: Uuid,
        session_hash: &str,
    ) -> Result<Lease, presence::AdmissionError> {
        let mut state = self.state.lock().expect("room presence poisoned");
        let result = state.leases.connect(user, Instant::now());
        if let Ok(id) = result {
            state.sessions.insert(id, session_hash.to_owned());
        }
        self.publish(&mut state);
        result.map(|id| Lease {
            id,
            runtime: self.clone(),
        })
    }

    fn publish(&self, state: &mut State) {
        let snapshot = state.leases.snapshot(Instant::now());
        let alive: HashSet<_> = state
            .leases
            .candidates()
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        state.sessions.retain(|id, _| alive.contains(id));
        let snapshot = protocol::PresenceSnapshot {
            room_id: self.room,
            presence_epoch: snapshot.epoch,
            presence_seq: snapshot.seq,
            members: snapshot
                .members
                .into_iter()
                .map(|member| protocol::PresenceMember {
                    user_id: member.user_id,
                    connection_count: member.connection_count,
                })
                .collect(),
        };
        let mut value = json!(snapshot);
        value["type"] = json!("PRESENCE_SNAPSHOT");
        self.bus.send_presence(value);
    }

    fn fence(&self) {
        let mut state = self.state.lock().expect("room presence poisoned");
        let checked: Vec<_> = state
            .leases
            .candidates()
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        state.leases.reconcile(&checked, &HashSet::new());
        self.publish(&mut state);
    }

    /// Capture exact lease candidates, await bounded cancellation-safe DB reads,
    /// then require coverage of every live ID. A query-time join requests a new
    /// check, never a partial full snapshot with the current sequence.
    pub(super) async fn snapshot(
        &self,
        app: &App,
    ) -> Result<Option<protocol::PresenceSnapshot>, &'static str> {
        self.snapshot_for(app, None).await
    }

    pub(super) async fn for_recipient(
        &self,
        app: &App,
        user: Uuid,
        session_hash: &str,
    ) -> Result<Option<protocol::PresenceSnapshot>, &'static str> {
        self.snapshot_for(app, Some((user, session_hash))).await
    }

    async fn snapshot_for(
        &self,
        app: &App,
        recipient: Option<(Uuid, &str)>,
    ) -> Result<Option<protocol::PresenceSnapshot>, &'static str> {
        #[derive(Deserialize)]
        struct ValidSession {
            user_id: Uuid,
            session_hash: String,
        }
        for _ in 0..2 {
            let candidates = {
                let mut state = self.state.lock().expect("room presence poisoned");
                self.publish(&mut state);
                state
                    .leases
                    .candidates()
                    .into_iter()
                    .map(|(id, user)| (id, user, state.sessions[&id].clone()))
                    .collect::<Vec<_>>()
            };
            let valid: Vec<ValidSession> = if candidates.is_empty() && recipient.is_none() {
                Vec::new()
            } else {
                let mut hashes: Vec<_> = candidates
                    .iter()
                    .map(|(_, _, session)| session.clone())
                    .collect();
                if let Some((_, session_hash)) = recipient {
                    hashes.push(session_hash.to_owned());
                }
                let result = tokio::time::timeout(Duration::from_secs(2), database_checks::text(
                    &app.db,
                    sqlx::query_scalar("SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',user_id,'session_hash',token_hash)), '[]'::jsonb)::text FROM (SELECT s.user_id,s.token_hash FROM sessions s JOIN room_members m ON m.user_id=s.user_id WHERE m.room_id=$1 AND s.token_hash=ANY($2) AND s.expires_at>now() FOR KEY SHARE OF s,m) admitted_presence")
                        .bind(self.room).bind(hashes),
                    1500,
                )).await;
                let Ok(Ok(value)) = result else {
                    self.fence();
                    return Err("service_unavailable");
                };
                serde_json::from_str(&value).map_err(|_| "service_unavailable")?
            };
            if let Some((user, session_hash)) = recipient
                && !valid
                    .iter()
                    .any(|session| session.user_id == user && session.session_hash == session_hash)
            {
                // Resolve the terminal reason only on denial. Successful send
                // admission validates recipient and all subjects in one final
                // bounded read, without another awaited query before send.
                super::socket_access(app, self.room, user, session_hash, true).await?;
                return Err("service_unavailable");
            }
            let authorized = candidates
                .iter()
                .filter(|(_, user, hash)| {
                    valid
                        .iter()
                        .any(|session| session.user_id == *user && session.session_hash == *hash)
                })
                .map(|(id, _, _)| *id)
                .collect();
            let checked: Vec<_> = candidates.iter().map(|(id, _, _)| *id).collect();
            let mut state = self.state.lock().expect("room presence poisoned");
            let snapshot = state
                .leases
                .checked_snapshot(&checked, &authorized, Instant::now());
            self.publish(&mut state);
            if let Some(snapshot) = snapshot {
                return Ok(Some(protocol::PresenceSnapshot {
                    room_id: self.room,
                    presence_epoch: snapshot.epoch,
                    presence_seq: snapshot.seq,
                    members: snapshot
                        .members
                        .into_iter()
                        .map(|member| protocol::PresenceMember {
                            user_id: member.user_id,
                            connection_count: member.connection_count,
                        })
                        .collect(),
                }));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runtime() -> Runtime {
        Runtime {
            room: Uuid::new_v4(),
            state: Arc::new(Mutex::new(State {
                leases: presence::Presence::new(presence::Sequence::default()),
                sessions: HashMap::new(),
            })),
            bus: delivery::Bus::new(),
        }
    }

    #[tokio::test]
    async fn aborting_a_socket_task_drops_its_lease_and_session_context() {
        let runtime = runtime();
        let lease = runtime
            .register(Uuid::new_v4(), "test-owned-session")
            .unwrap();
        let task = tokio::spawn(async move {
            let _lease = lease;
            std::future::pending::<()>().await;
        });
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        let mut state = runtime.state.lock().unwrap();
        assert!(state.leases.snapshot(Instant::now()).members.is_empty());
        assert!(state.sessions.is_empty());
    }

    #[test]
    fn terminal_rejection_cleans_up_before_network_write_and_drop_is_idempotent() {
        let runtime = runtime();
        let lease = runtime
            .register(Uuid::new_v4(), "test-owned-session")
            .unwrap();
        lease.revoke();
        let snapshot = runtime
            .state
            .lock()
            .unwrap()
            .leases
            .snapshot(Instant::now());
        assert!(snapshot.members.is_empty());
        assert!(runtime.state.lock().unwrap().sessions.is_empty());
        drop(lease);
        assert_eq!(
            runtime
                .state
                .lock()
                .unwrap()
                .leases
                .snapshot(Instant::now()),
            snapshot
        );
    }

    #[test]
    fn expiry_prunes_the_sidecar_context_and_prevents_a_guard_from_renewing() {
        let runtime = runtime();
        let lease = runtime
            .register(Uuid::new_v4(), "test-owned-session")
            .unwrap();
        {
            let mut state = runtime.state.lock().unwrap();
            state.leases.expire(Instant::now() + presence::LEASE);
            runtime.publish(&mut state);
            assert!(state.sessions.is_empty());
        }
        assert!(!lease.renew());
        assert!(lease.deadline().is_none());
    }
}
