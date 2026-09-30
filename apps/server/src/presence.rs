//! Ephemeral connection leases. This module has no control state or persistence.
//! Callers must authorize admission/renewal and reconcile permissions before
//! publishing. A removed/expired connection can never be renewed back to life.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const LEASE: Duration = Duration::from_secs(45);
pub const PER_USER_LIMIT: usize = 8;
pub const ROOM_LIMIT: usize = 80;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub user_id: Uuid,
    pub connection_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub epoch: Uuid,
    pub seq: u32,
    pub members: Vec<Member>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmissionError {
    UserLimit,
    RoomLimit,
}

struct Connection {
    user: Uuid,
    deadline: Instant,
}

/// One allocator shared by all rooms for the lifetime of the server process.
/// Gaps are permitted: other rooms may consume sequence values. Actor eviction
/// cannot reset a sequence because it does not own this allocator.
#[derive(Clone)]
pub struct Sequence(Arc<Mutex<(Uuid, u32)>>);

impl Default for Sequence {
    fn default() -> Self {
        Self(Arc::new(Mutex::new((Uuid::new_v4(), 0))))
    }
}

impl Sequence {
    fn changed(&self) {
        let mut stamp = self.0.lock().expect("presence sequence poisoned");
        if let Some(next) = stamp.1.checked_add(1) {
            stamp.1 = next;
        } else {
            // Exhaustion rotates the process-wide presence epoch atomically;
            // clients must reconnect before trusting the new epoch.
            *stamp = (Uuid::new_v4(), 1);
        }
    }

    fn stamp(&self) -> (Uuid, u32) {
        *self.0.lock().expect("presence sequence poisoned")
    }
}

pub struct Presence {
    sequence: Sequence,
    connections: HashMap<Uuid, Connection>,
}

impl Presence {
    pub fn new(sequence: Sequence) -> Self {
        Self {
            sequence,
            connections: HashMap::new(),
        }
    }

    fn changed(&mut self) {
        self.sequence.changed();
    }

    /// A UUID is issued here, never accepted from the peer or reused on resume.
    pub fn connect(&mut self, user: Uuid, now: Instant) -> Result<Uuid, AdmissionError> {
        self.expire(now);
        if self.connections.values().filter(|c| c.user == user).count() >= PER_USER_LIMIT {
            return Err(AdmissionError::UserLimit);
        }
        if self.connections.len() >= ROOM_LIMIT {
            return Err(AdmissionError::RoomLimit);
        }
        let id = Uuid::new_v4();
        self.connections.insert(
            id,
            Connection {
                user,
                deadline: now + LEASE,
            },
        );
        self.changed();
        Ok(id)
    }

    /// Invoked only after session and room membership validation. Late Pong or
    /// delayed permission-check completion cannot resurrect an expired lease.
    pub fn renew(&mut self, id: Uuid, now: Instant) -> bool {
        self.expire(now);
        let Some(connection) = self.connections.get_mut(&id) else {
            return false;
        };
        connection.deadline = connection.deadline.max(now + LEASE);
        // Counts did not change: there is no reason to publish another snapshot.
        true
    }

    pub fn disconnect(&mut self, id: Uuid) -> bool {
        let removed = self.connections.remove(&id).is_some();
        if removed {
            self.changed();
        }
        removed
    }

    pub fn revoke_user(&mut self, user: Uuid) -> bool {
        let before = self.connections.len();
        self.connections.retain(|_, c| c.user != user);
        let changed = before != self.connections.len();
        if changed {
            self.changed();
        }
        changed
    }

    /// Capture candidates under the same mutex as mutations, release it for the
    /// DB query, then reconcile only those candidates. New connections are not
    /// silently authorized or deleted by a stale async query result.
    pub fn candidates(&self) -> Vec<(Uuid, Uuid)> {
        self.connections
            .iter()
            .map(|(id, c)| (*id, c.user))
            .collect()
    }

    pub fn reconcile(&mut self, checked: &[Uuid], authorized: &HashSet<Uuid>) -> bool {
        let mut changed = false;
        for id in checked {
            if !authorized.contains(id) {
                changed |= self.connections.remove(id).is_some();
            }
        }
        if changed {
            self.changed();
        }
        changed
    }

    pub fn expire(&mut self, now: Instant) -> bool {
        let before = self.connections.len();
        self.connections.retain(|_, c| c.deadline > now);
        let changed = before != self.connections.len();
        if changed {
            self.changed();
        }
        changed
    }

    /// Expire even if the background sweep is delayed. Caller must also perform
    /// permission reconciliation before admitting a snapshot to any receiver.
    pub fn snapshot(&mut self, now: Instant) -> Snapshot {
        self.expire(now);
        let mut members = BTreeMap::<Uuid, u32>::new();
        for connection in self.connections.values() {
            *members.entry(connection.user).or_default() += 1;
        }
        let (epoch, seq) = self.sequence.stamp();
        Snapshot {
            epoch,
            seq,
            members: members
                .into_iter()
                .map(|(user_id, connection_count)| Member {
                    user_id,
                    connection_count,
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod sequence_tests {
    use super::*;

    #[test]
    fn sequence_exhaustion_rotates_the_shared_epoch_without_wrapping() {
        let sequence = Sequence::default();
        let shared = sequence.clone();
        let old_epoch = sequence.stamp().0;
        sequence.0.lock().unwrap().1 = u32::MAX;
        sequence.changed();
        assert_eq!(sequence.stamp(), shared.stamp());
        assert_ne!(old_epoch, sequence.stamp().0);
        assert_eq!(sequence.stamp().1, 1);
    }
}
