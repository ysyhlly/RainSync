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
    assert_eq!(p.deadline(id), Some(now + LEASE));
    assert!(!p.renew(id, now + LEASE));
    assert_eq!(p.deadline(id), None);
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

#[test]
fn a_join_during_authorization_cannot_be_published_as_a_checked_full_snapshot() {
    let now = Instant::now();
    let mut p = Presence::new(Sequence::default());
    let user = Uuid::new_v4();
    let first = p.connect(user, now).unwrap();
    let checked = vec![first];
    let next = p.connect(user, now).unwrap();
    assert!(
        p.checked_snapshot(&checked, &HashSet::from([first]), now)
            .is_none()
    );
    let complete = p
        .checked_snapshot(&[first, next], &HashSet::from([first, next]), now)
        .unwrap();
    assert_eq!(complete.members[0].connection_count, 2);
}

#[test]
fn completed_permission_checks_remove_denied_members_before_snapshot_publication() {
    let now = Instant::now();
    let mut p = Presence::new(Sequence::default());
    let revoked = Uuid::new_v4();
    let authorized = Uuid::new_v4();
    let a = p.connect(revoked, now).unwrap();
    let b = p.connect(revoked, now).unwrap();
    let c = p.connect(authorized, now).unwrap();
    let full = p
        .checked_snapshot(&[a, b, c], &HashSet::from([c]), now)
        .unwrap();
    assert_eq!(
        full.members,
        vec![Member {
            user_id: authorized,
            connection_count: 1
        }]
    );
    // A delayed positive permission result is not a fresh connection admission.
    p.checked_snapshot(&[a, b, c], &HashSet::from([a, b, c]), now)
        .unwrap();
    assert!(!p.renew(a, now));
    assert!(!p.renew(b, now));
}

#[test]
fn checked_snapshot_does_not_need_to_recheck_connections_that_have_expired() {
    let now = Instant::now();
    let mut p = Presence::new(Sequence::default());
    p.connect(Uuid::new_v4(), now).unwrap();
    let full = p
        .checked_snapshot(&[], &HashSet::new(), now + LEASE)
        .unwrap();
    assert!(full.members.is_empty());
}

#[test]
fn stale_renewals_do_not_shorten_a_newer_lease_and_expiry_is_terminal() {
    let now = Instant::now();
    let mut p = Presence::new(Sequence::default());
    let id = p.connect(Uuid::new_v4(), now).unwrap();
    assert!(p.renew(id, now + Duration::from_secs(30)));
    assert!(p.renew(id, now + Duration::from_secs(1)));
    assert!(!p.snapshot(now + Duration::from_secs(74)).members.is_empty());
    assert!(p.snapshot(now + Duration::from_secs(75)).members.is_empty());
    assert!(!p.renew(id, now + Duration::from_secs(20)));
}

#[test]
fn process_capacity_is_shared_and_released_on_disconnect_expiry_revocation_and_room_drop() {
    let sequence = Sequence::default();
    let now = Instant::now();
    let mut rooms: Vec<_> = (0..PROCESS_LIMIT.div_ceil(ROOM_LIMIT))
        .map(|_| Presence::new(sequence.clone()))
        .collect();
    for index in 0..PROCESS_LIMIT {
        rooms[index / ROOM_LIMIT]
            .connect(Uuid::new_v4(), now)
            .unwrap();
    }
    let mut extra = Presence::new(sequence);
    let before = extra.snapshot(now);
    assert_eq!(
        extra.connect(Uuid::new_v4(), now),
        Err(AdmissionError::ProcessCapacity)
    );
    assert_eq!(extra.snapshot(now), before);

    let (id, _) = rooms[0].candidates()[0];
    rooms[0].disconnect(id);
    let test_user = Uuid::new_v4();
    let test_id = extra.connect(test_user, now).unwrap();
    extra.revoke_user(test_user);
    let test_id2 = extra.connect(test_user, now).unwrap();
    assert_ne!(test_id, test_id2);
    extra.reconcile(&[test_id2], &HashSet::new());
    extra.connect(test_user, now).unwrap();
    extra.expire(now + LEASE);
    extra.connect(test_user, now + LEASE).unwrap();
    drop(rooms);
    for _ in 1..PER_USER_LIMIT {
        extra.connect(test_user, now + LEASE).unwrap();
    }
    assert_eq!(
        extra.snapshot(now + LEASE).members[0].connection_count,
        PER_USER_LIMIT as u32
    );
}

#[test]
fn concurrent_rooms_cannot_overbook_process_capacity() {
    let sequence = Sequence::default();
    let now = Instant::now();
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let sequence = sequence.clone();
            std::thread::spawn(move || {
                let mut rooms = Vec::new();
                for index in 0..PROCESS_LIMIT / 8 {
                    if index % ROOM_LIMIT == 0 {
                        rooms.push(Presence::new(sequence.clone()));
                    }
                    rooms
                        .last_mut()
                        .unwrap()
                        .connect(Uuid::new_v4(), now)
                        .unwrap();
                }
                rooms
            })
        })
        .collect();
    // Thread results retain their leases, even before the main thread joins.
    let rooms: Vec<_> = workers
        .into_iter()
        .flat_map(|worker| worker.join().unwrap())
        .collect();
    let ids: HashSet<_> = rooms
        .iter()
        .flat_map(|room| room.candidates().into_iter().map(|(id, _)| id))
        .collect();
    assert_eq!(ids.len(), PROCESS_LIMIT);
    let mut extra = Presence::new(sequence);
    assert_eq!(
        extra.connect(Uuid::new_v4(), now),
        Err(AdmissionError::ProcessCapacity)
    );
    drop(rooms);
    extra.connect(Uuid::new_v4(), now).unwrap();
}
