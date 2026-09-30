//! Ephemeral connection leases. This module has no control state or persistence.
//! Only presence-v1 negotiated sockets enter this set; legacy control sockets
//! retain their independent admission behavior. Callers must authorize
//! admission/renewal and cover every live lease with checked_snapshot before
//! publishing. A removed/expired connection can never be renewed back to life.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const LEASE: Duration = Duration::from_secs(45);
pub const PER_USER_LIMIT: usize = 8;
pub const ROOM_LIMIT: usize = 80;
pub const PROCESS_LIMIT: usize = 4096;

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
    ProcessCapacity,
}

struct Connection {
    user: Uuid,
    deadline: Instant,
    _permit: ConnectionPermit,
}

struct Clock {
    epoch: Uuid,
    seq: u32,
    connections: usize,
}

/// Releases process capacity even when a room or an aborted task drops leases.
struct ConnectionPermit(Sequence);

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        let mut clock = self.0.0.lock().expect("presence sequence poisoned");
        clock.connections -= 1;
    }
}

/// One allocator shared by all rooms for the lifetime of the server process.
/// Gaps are permitted: other rooms may consume sequence values. Actor eviction
/// cannot reset a sequence because it does not own this allocator.
#[derive(Clone)]
pub struct Sequence(Arc<Mutex<Clock>>);

impl Default for Sequence {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Clock {
            epoch: Uuid::new_v4(),
            seq: 0,
            connections: 0,
        })))
    }
}

impl Sequence {
    fn changed(&self) {
        let mut stamp = self.0.lock().expect("presence sequence poisoned");
        if let Some(next) = stamp.seq.checked_add(1) {
            stamp.seq = next;
        } else {
            // Exhaustion rotates the process-wide presence epoch atomically;
            // clients must reconnect before trusting the new epoch.
            stamp.epoch = Uuid::new_v4();
            stamp.seq = 1;
        }
    }

    fn stamp(&self) -> (Uuid, u32) {
        let stamp = self.0.lock().expect("presence sequence poisoned");
        (stamp.epoch, stamp.seq)
    }

    fn acquire(&self) -> Result<ConnectionPermit, AdmissionError> {
        let mut clock = self.0.lock().expect("presence sequence poisoned");
        if clock.connections >= PROCESS_LIMIT {
            return Err(AdmissionError::ProcessCapacity);
        }
        clock.connections += 1;
        Ok(ConnectionPermit(self.clone()))
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
        let permit = self.sequence.acquire()?;
        let id = Uuid::new_v4();
        self.connections.insert(
            id,
            Connection {
                user,
                deadline: now + LEASE,
                _permit: permit,
            },
        );
        self.changed();
        Ok(id)
    }

    /// Invoked only after session and room membership validation. Late Pong or
    /// delayed permission-check completion cannot resurrect an expired lease.
    /// Sample now after awaited authorization, not before the query started.
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
    /// silently deleted by a stale async query result. checked_snapshot refuses
    /// publication if any live connection was absent from that completed check.
    pub fn candidates(&self) -> Vec<(Uuid, Uuid)> {
        self.connections
            .iter()
            .map(|(id, c)| (*id, c.user))
            .collect()
    }

    pub fn deadline(&self, id: Uuid) -> Option<Instant> {
        self.connections
            .get(&id)
            .map(|connection| connection.deadline)
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

    /// Publishing requires a completed check covering every still-live lease.
    /// If a connection joined while the caller awaited the DB query, retry the
    /// check instead of stamping an incomplete or unexamined full snapshot with
    /// the latest sequence. Removed IDs in an old result never regain a lease.
    pub fn checked_snapshot(
        &mut self,
        checked: &[Uuid],
        authorized: &HashSet<Uuid>,
        now: Instant,
    ) -> Option<Snapshot> {
        if checked.len() > ROOM_LIMIT || authorized.len() > ROOM_LIMIT {
            return None;
        }
        self.reconcile(checked, authorized);
        self.expire(now);
        if self.connections.keys().any(|id| !checked.contains(id)) {
            return None;
        }
        Some(self.snapshot(now))
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
    /// Production send paths must use checked_snapshot; this raw projection is
    /// for local state inspection and does not constitute authorization.
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
        sequence.0.lock().unwrap().seq = u32::MAX;
        sequence.changed();
        assert_eq!(sequence.stamp(), shared.stamp());
        assert_ne!(old_epoch, sequence.stamp().0);
        assert_eq!(sequence.stamp().1, 1);
    }

    #[test]
    fn rollover_preserves_live_leases_and_process_capacity_in_other_rooms() {
        let sequence = Sequence::default();
        let now = Instant::now();
        let mut a = Presence::new(sequence.clone());
        let mut b = Presence::new(sequence.clone());
        let user = Uuid::new_v4();
        a.connect(user, now).unwrap();
        let other = b.connect(user, now).unwrap();
        let before = b.snapshot(now);
        sequence.0.lock().unwrap().seq = u32::MAX;
        a.connect(user, now).unwrap();
        let after = b.snapshot(now);
        assert_ne!(before.epoch, after.epoch);
        assert_eq!(after.epoch, a.snapshot(now).epoch);
        assert_eq!(after.seq, 1);
        assert_eq!(before.members, after.members);
        assert_eq!(sequence.0.lock().unwrap().connections, 3);
        assert!(b.renew(other, now));
        assert_eq!(sequence.stamp().1, 1);
        drop(a);
        assert_eq!(sequence.0.lock().unwrap().connections, 1);
    }
}
