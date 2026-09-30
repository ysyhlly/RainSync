# E01 presence production patch plan

This extends the existing independent implementation. It is a reviewable patch
plan, not a claim that protocol or production wiring has landed. Only integration
owns protocol, generated schemas, main/lib, manifests and migrations. This lane
waits for the shared protocol commit before production integration.

## Stable startup API for integration owner

```rust
mod presence;
// App, which already implements Clone:
presence_sequence: presence::Sequence,
// One construction in the App startup initializer:
presence_sequence: presence::Sequence::default(),
```

`Sequence: Default + Clone`. Clones share the process clock and negotiated
presence connection quota. A room constructs
`presence::Presence::new(app.presence_sequence.clone())`. No initialization per
socket and no database storage. Its synchronous API remains compatible with the
first checkpoint; this audit adds
`checked_snapshot(&[Uuid], &HashSet<Uuid>, Instant) -> Option<Snapshot>` and
`AdmissionError::ProcessLimit`. `Snapshot` is internal (`epoch`, `seq`, `members`);
`rooms.rs` maps it to the approved protocol and supplies room_id.

## Bounded state and explicit coverage

Only `presence_version=1` connections acquire leases. Legacy and unsupported
versions follow the existing control admission path without invoking Presence.
Do not replace `connected_receivers` metrics with presence counts or alter existing
100-control-connection capacity tests. Presence limits are 8 per user per room,
80 per room and 4096 across the process. `ConnectionPermit` releases process
capacity on disconnect, expiry, permission reconciliation and room drop. A quota
failure has no lease or sequence side effects, apart from independently expiring
already expired leases. Map failures to an existing retryable admission error
(e.g. RATE_LIMITED), and terminate only that negotiated connection.

The core connection keys/user IDs are fixed-size UUIDs. At most 80 entries remain
in a room; map allocation stays bounded even after churn. Candidate vectors and
snapshots contain at most 80 records. Process-wide state is constant-size apart
from room-owned leases. The mutex wrapper's session-context map must be pruned
whenever a lease is removed, with the same 80-entry bound. There must be no
unbounded revocation tombstones, heartbeat histories or pending snapshot queues.
Use one watch slot per room and one current snapshot per UI. The UI bounds IDs
to 64 characters, stores only known fields and keeps at most 8 retired epochs.
Existing unnegotiated socket/room Actor resource limits retain their independent
behavior; presence quotas do not promise to cap those existing resources.

The list means **reported online connections**. Unknown/legacy members and a
member with no reported connection have unknown status. An empty valid snapshot
means zero reported members, not an empty room or universal offline status. The
panel explicitly explains coverage and uses connection counts, never physical
device identity. Old servers or missing negotiation display unavailable. These
semantics are fixed for v1, so the accepted four-field snapshot needs no coverage
field. A future expansion to different coverage modes would need its own contract.

## Patch 1: room connection and permission lifecycle (`rooms.rs`)

- Add a room-owned mutex wrapper with the core Presence plus bounded
  connection-to-session contexts. The context is internal admission data only;
  do not serialize session hashes. Serialize core mutations, snapshot capture
  and publication order under a short synchronous mutex. Do not await inside it.
- Subscribe to control/chat/status first. Parse negotiation exactly as JSON
  integer 1; malformed, missing or unsupported values do not opt in. Only an
  opted-in, authorized socket receives a server-issued connection UUID and lease.
  Initial snapshot includes both presence fields or neither. No caller may
  supply a lease identity, and a reconnect always obtains a fresh identity.
- Keep an RAII cleanup guard immediately after registration. It removes lease
  and context and replaces the latest presence slot on all early returns,
  disconnects and cancelled tasks; it runs before waiting for close handshake.
  An idle actor can be recycled only after existing connections are gone.
- For permission reconciliation capture candidate IDs/subjects under the mutex,
  release it, query valid user sessions joined with room membership, then match
  results to those exact IDs. Never use a permission result as connection
  admission. `checked_snapshot` prunes denied checked IDs and returns None if
  any live ID was not in the completed query. Retry a bounded number of times,
  then skip that presence publication and retry on the next scheduled check.
  Never publish an incomplete full snapshot using the newer global seq.
- Distinguish room-member removal (all that user's leases) from one login-session
  expiry (only its corresponding leases). Negative authorization is terminal;
  a later positive result for the old ID does not restore it. DB timeout/failure
  closes/fences affected negotiated leases and publishes no unvalidated subjects.
- Validate session and membership at outbound admission, including replayed
  presence from the latest slot. Reconcile **subjects** as well as recipient;
  do not merely reuse an old room-wide permission result. The existing
  revocation guarantee is based on the admission read relative to the committed
  removal. Release DB locks before network writes. Already admitted transport
  bytes cannot be recalled. Real tests must cover a query completing on either
  side of a revocation commit, not just in-memory removal.

## Patch 2: heartbeat and leases (`rooms.rs`)

- Continue the physical WebSocket's existing 15-second server Ping probes.
  For negotiated presence renew only from valid Ping/Pong liveness after fresh
  authorization; CLOCK_SYNC, CLIENT_STATUS and other text are not presence
  prerequisites and do not independently renew a lease. Prefer bounded probe
  nonces (at most three outstanding) to reject duplicate/unsolicited old Pong.
- Sample monotonic time **after** any awaited permission check before renewing.
  Calling renew with a receipt timestamp captured before that wait can miss a
  deadline reached during the wait. The core rejects renewal at the exact
  deadline; after removal no old heartbeat can recreate an ID.
- Use an exact per-connection lease-deadline branch or room expiry scheduler,
  rather than the existing `elapsed > 45` check on a 15-second interval (which
  can wait until 60 seconds). Expiry must publish and clean up even if a network
  writer is stalled. No lock or DB transaction may be held during the 5-second
  network write timeout. The watcher/sweep and cleanup guard must remain safe
  when expiry races with late Pong or disconnect.
- A false renewal result ends that connection's negotiated presence; it does
  not silently register a replacement. Closing/reopening rooms is already
  implemented. Presence continues to mean authorized room-UI liveness in a
  readable closed/archived room; it grants no playback/control permission and
  does not modify those lifecycle state machines.

## Patch 3: replaceable delivery (`room_delivery.rs`)

Add a dedicated watch/latest-snapshot slot, separate from CLIENT_STATUS and
control broadcast queues. Keep control-first contention and the existing bounded
background fairness. Subscribe to the presence slot only for opted-in sockets,
so old control connections cannot spin on unread presence updates. Floods retain
one complete snapshot, not an accumulating stream. Authorization and current
snapshot capture occur at send admission, so a queued old slot value cannot leak
revoked subjects. A slow writer retains its existing timeout and isolation.

## Patch 4: client and independent panel (`room-runtime.ts`, PresencePanel)

Opt in on RESUME. Adapt generated types into the existing internal PresenceState.
Capture its connection generation in every callback; bind the paired initial
snapshot once. Clear online claims synchronously before reconnect/leave async
work and before processing terminal permission/session errors. Never derive an
online count from permanent room_members or CLIENT_STATUS.

Same-epoch full snapshots accept sequence gaps and reject non-increasing seq.
Callbacks from old connections are ignored. A known retired epoch is ignored
without clearing the new snapshot; an unknown epoch requests a new authenticated
handshake. UUID epochs have no sortable order. A fresh handshake is authoritative,
even if it establishes a UUID in retired history. History is bounded to eight;
an older unknown epoch may cause a conservative reconnect, never become accepted
state. Large/malformed collections and IDs are ignored without state changes.
Do not route presence gaps into control revision recovery or playback effects.

Only the panel is owned here. Mounting in an existing room host view requires a
parent-applied small patch or explicit ownership assignment. The host may provide
existing member display names; those names never establish presence.

## Sequence exhaustion and process restart

The allocator increments for membership changes, not lease-only renewal or
control changes. Global gaps are valid. It cannot wrap within an epoch. At u32
exhaustion, rotate the shared process presence epoch and set seq to 1 atomically,
without clearing live leases or resetting process capacity. Every active room's
15-second maintenance pass must observe epoch mismatch and publish a full
snapshot even if its members did not change; clients reconnect. Cached old
values must pass current-epoch/subject checks at send admission. Empty rooms need
no notification. A restarted process creates a fresh allocator and empty lease
sets. This preserves bounded memory without a permanent per-room seq registry.
Integration owner still needs to confirm exhaustion behavior in the contract.

## Required integration regressions after protocol arrives

Keep the existing legacy 100-connection smoke unchanged. Add a mixed-room case
with many legacy connections and two v1 connections: only the two are counted,
and no legacy connection receives presence fields/frames or quota errors.
Then cover user/room/process v1 caps and release of slots, independent users,
rooms and login sessions, revocation across all devices, send-time authorization
failure, admission-vs-removal races, query-time joins, cancelled task cleanup,
black-holed and delayed Pong, 45-second exact expiry, seq rollover propagation,
control revision invariance, presence floods and slow consumers, permission
errors/reconnect/old epoch frames in the client, old-server unavailable UI and
empty reported-list coverage. Use isolated DB/ports/build outputs. Long runs and
real devices remain later acceptance gates.
