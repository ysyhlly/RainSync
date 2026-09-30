#[path = "../src/presence.rs"]
mod presence;

use presence::*;
use std::collections::HashSet;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[test]
fn aggregates_connections_and_disconnects_only_the_matching_lease() {
    let mut p = Presence::new(Sequence::default());
    let now = Instant::now();
    let user = Uuid::new_v4();
    let a = p.connect(user, now).unwrap();
    let b = p.connect(user, now).unwrap();
    assert_ne!(a, b);
    assert_eq!(
        p.snapshot(now).members,
        vec![Member {
            user_id: user,
            connection_count: 2
        }]
    );
    assert!(p.disconnect(a));
    let snapshot = p.snapshot(now);
    assert_eq!(snapshot.members[0].connection_count, 1);
    assert!(!p.disconnect(a));
    assert!(!p.renew(a, now));
    assert_eq!(p.snapshot(now), snapshot);
    assert!(p.disconnect(b));
    assert!(p.snapshot(now).members.is_empty());
}

#[test]
fn expires_at_exact_boundary_and_late_heartbeat_cannot_resurrect() {
    let mut p = Presence::new(Sequence::default());
    let now = Instant::now();
    let id = p.connect(Uuid::new_v4(), now).unwrap();
    assert!(
        !p.snapshot(now + LEASE - Duration::from_nanos(1))
            .members
            .is_empty()
    );
    assert!(!p.renew(id, now + LEASE));
    assert!(p.snapshot(now + LEASE).members.is_empty());
}

#[test]
fn renewal_is_independent_of_snapshot_sequence_and_other_devices() {
    let mut p = Presence::new(Sequence::default());
    let now = Instant::now();
    let user = Uuid::new_v4();
    let a = p.connect(user, now).unwrap();
    p.connect(user, now).unwrap();
    let before = p.snapshot(now);
    assert!(p.renew(a, now + Duration::from_secs(30)));
    assert_eq!(p.snapshot(now + Duration::from_secs(30)), before);
    assert_eq!(p.snapshot(now + LEASE).members[0].connection_count, 1);
    assert!(p.snapshot(now + Duration::from_secs(75)).members.is_empty());
}

#[test]
fn revoked_user_is_removed_from_all_devices_without_affecting_other_users() {
    let mut p = Presence::new(Sequence::default());
    let now = Instant::now();
    let user = Uuid::new_v4();
    let other = Uuid::new_v4();
    let a = p.connect(user, now).unwrap();
    let b = p.connect(user, now).unwrap();
    p.connect(other, now).unwrap();
    assert!(p.revoke_user(user));
    assert!(!p.renew(a, now));
    assert!(!p.renew(b, now));
    assert_eq!(
        p.snapshot(now).members,
        vec![Member {
            user_id: other,
            connection_count: 1
        }]
    );
}

#[test]
fn stale_reconciliation_does_not_delete_new_connection_or_restore_old_one() {
    let mut p = Presence::new(Sequence::default());
    let now = Instant::now();
    let user = Uuid::new_v4();
    let old = p.connect(user, now).unwrap();
    let checked: Vec<_> = p.candidates().into_iter().map(|(id, _)| id).collect();
    p.disconnect(old);
    let new = p.connect(user, now).unwrap();
    p.reconcile(&checked, &HashSet::new());
    p.reconcile(&checked, &HashSet::from([old]));
    assert!(!p.renew(old, now));
    assert!(p.renew(new, now));
    assert_eq!(p.snapshot(now).members[0].connection_count, 1);
}

#[test]
fn session_revocation_can_remove_one_connection_while_preserving_other_sessions() {
    let mut p = Presence::new(Sequence::default());
    let now = Instant::now();
    let user = Uuid::new_v4();
    let a = p.connect(user, now).unwrap();
    let b = p.connect(user, now).unwrap();
    assert!(p.reconcile(&[a, b], &HashSet::from([b])));
    assert!(!p.renew(a, now));
    assert!(p.renew(b, now));
}

#[test]
fn fresh_instance_changes_epoch_and_never_inherits_online_members() {
    let now = Instant::now();
    let mut old = Presence::new(Sequence::default());
    old.connect(Uuid::new_v4(), now).unwrap();
    let mut new = Presence::new(Sequence::default());
    assert_ne!(old.snapshot(now).epoch, new.snapshot(now).epoch);
    assert_eq!(new.snapshot(now).seq, 0);
    assert!(new.snapshot(now).members.is_empty());
}

#[test]
fn bounded_admission_and_expired_slots_are_reusable() {
    let mut p = Presence::new(Sequence::default());
    let now = Instant::now();
    let user = Uuid::new_v4();
    for _ in 0..PER_USER_LIMIT {
        p.connect(user, now).unwrap();
    }
    let before = p.snapshot(now);
    assert_eq!(p.connect(user, now), Err(AdmissionError::UserLimit));
    assert_eq!(p.snapshot(now), before);
    for _ in PER_USER_LIMIT..ROOM_LIMIT {
        p.connect(Uuid::new_v4(), now).unwrap();
    }
    assert_eq!(
        p.connect(Uuid::new_v4(), now),
        Err(AdmissionError::RoomLimit)
    );
    p.connect(user, now + LEASE).unwrap();
    assert_eq!(p.snapshot(now + LEASE).members.len(), 1);
}

#[test]
fn actor_recreation_and_other_rooms_share_the_process_epoch_and_monotonic_sequence() {
    let sequence = Sequence::default();
    let now = Instant::now();
    let mut a = Presence::new(sequence.clone());
    let id = a.connect(Uuid::new_v4(), now).unwrap();
    let before = a.snapshot(now);
    a.disconnect(id);
    drop(a);
    let mut b = Presence::new(sequence.clone());
    b.connect(Uuid::new_v4(), now).unwrap();
    let mut recreated = Presence::new(sequence);
    recreated.connect(Uuid::new_v4(), now).unwrap();
    let after = recreated.snapshot(now);
    assert_eq!(before.epoch, after.epoch);
    assert!(after.seq > before.seq);
    assert_eq!(after.epoch, b.snapshot(now).epoch);
}
