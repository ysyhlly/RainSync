# E01 presence: contract request and independent implementation checkpoint

Base: `9b167ab92e36b373bdb6c46718ced16dfb8070aa` on
`integration/v0.1-next`, fetched 2026-09-30. Remote matched that exact baseline.
Branch: `feature/e01-presence`. Existing workspace/branch were not overwritten.

This checkpoint is **not a completed E01 implementation**. Protocol and production
wiring are pending integration-owner confirmation and the shared protocol commit.
No migration, shared manifest/lockfile, main/lib entrypoint, global status document,
HTTP file delivery or Worker readiness implementation was edited.

## Requested shared protocol

```typescript
// UUID denotes the existing protocol's UUID representation, not a device ID.
type PresenceMember = { user_id: UUID; connection_count: number /* u32 */ };
type PresenceSnapshot = {
  room_id: UUID;
  presence_epoch: UUID;
  presence_seq: number; // u32; gaps allowed
  members: PresenceMember[];
};
// JOIN / RESUME: optional presence_version: 1
// Initial SNAPSHOT: optional presence_connection_id: UUID and
//                   presence: PresenceSnapshot, present together.
// Server envelope: { type: "PRESENCE_SNAPSHOT", ...PresenceSnapshot }
```

Accepted by integration owner: no RoomState field, control revision, persistent
event, or migration. Unknown
presence versions do not enable presence delivery. Only connections declaring `presence_version: 1` enter the presence set and
consume its quotas. Legacy control connections do not enter this set, receive no
new envelopes, and keep their existing capacity behavior (including the existing
100-control-connection smoke). New clients on old servers display unavailable.
Snapshots cover reported connections, not all room members: absent users have
unknown status, never definite offline status. The UI explicitly states this
coverage; no extra coverage field is needed for this fixed v1 contract.
The server assigns a fresh connection UUID after admission, returns it only to
that socket, and never accepts a client-selected replacement. Counts describe
connections (potentially devices or tabs), not unique physical devices. Public
snapshots reveal only user IDs and counts, with no session tokens, connection
lists, IP addresses, user agents or device fingerprints.

Heartbeat uses existing WebSocket Ping/Pong: probe every 15 seconds, expire at
45 seconds using server monotonic time. CLIENT_STATUS is playback telemetry and
must neither create nor be required to maintain presence. Expired leases cannot
be resurrected by late frames. An explicit reconnect creates a new connection.
Renewals with unchanged membership need not send another snapshot.

Epoch is process-wide and independent of control state. The internal Sequence is
shared across rooms; every membership change consumes a u32 sequence, so gaps
are normal and room Actor eviction cannot reset its sequence. On counter
exhaustion the allocator rotates its process-wide presence epoch atomically;
clients reconnect rather than adopting an unsolicited epoch. Please confirm this
exhaustion behavior with the shared contract. Restart initializes an empty
presence collection and a new process epoch.

## Production integration locations and pending requirements

1. Integration-owned `apps/server/src/main.rs`: expose the module with
   `mod presence;`, add `presence_sequence: presence::Sequence` to App and
   initialize `presence::Sequence::default()` exactly once at process startup.
   `Sequence` is Clone (shared Arc), not one allocator per room or socket.
   No database or new service is needed. The new module remains unmounted in
   this checkpoint and is compiled through the independent test target.
2. `rooms.rs`: each Handle owns a mutex-protected `Presence::new` using the App
   allocator and a connection-to-session admission context. Subscribe before
   capturing the first full snapshot. Register only after auth and membership
   admission, and only when presence v1 was negotiated; retain a cleanup guard so
   aborted tasks drop the connection before
   close-handshake waits. Reconcile revoked memberships and sessions, expire
   leases and publish under serialized room mutation order. Distinguish removing
   one expired login session from removing all connections of a revoked member.
3. Before send admission validate both recipient session and membership; current
   code only validates membership on each outbound frame and checks sessions
   periodically. A presence snapshot must also filter/reconcile its **subjects**,
   not just authorize its recipient. DB failures fail closed. Never hold a DB
   transaction or room lock over network writes. Already admitted transport bytes
   cannot be recalled. Asynchronous authorization results must not authorize
   unexamined new connections or restore removed connection IDs. Use
   `checked_snapshot(checked, authorized, now)`, which returns `None` for a joining
   connection absent from the completed check; retry without publishing a partial
   full snapshot under a newer seq.
4. `room_delivery.rs`: add a separate watch/latest-value slot for full presence
   snapshots. Do not share CLIENT_STATUS's broadcast buffer and do not enqueue
   presence in control. Keep existing control-first scheduling with bounded
   background fairness and slow-consumer isolation. Per-recipient negotiated
   presence gates must not cause old clients to spin on a pending watch update.
5. `room-runtime.ts`: opt in on RESUME; adapt generated protocol types to the
   internal PresenceState; bind initial snapshot once per socket generation.
   Clear online claims synchronously on disconnect, leave, permission errors and
   new socket construction. Ignore old callbacks and non-increasing seq; unknown
   epochs request a new connection/snapshot; known retired epochs are ignored
   without clearing the newer snapshot. Do not touch control revision.
6. Mount `PresencePanel.vue` in the room UI. It is standalone and typechecked but
   not mounted yet; the parent should assign ownership of the existing host view
   or apply a mounting patch. Existing member display names may be supplied, but
   that permanent list is not an online source. Multiple connections are labeled
   accurately without claiming unique physical device identity.

## Independent implementation and evidence

- `apps/server/src/presence.rs`: monotonic lease set, server-issued IDs, aggregation,
  idempotent disconnect, terminal expiry, user and per-connection revocation,
  async checked-candidate reconciliation, bounded admission (8/user, 80/room,
  4096/process for negotiated presence connections),
  process-shared epoch/sequence allocator.
- `apps/server/tests/presence.rs`: core expiry, aggregation, revocation, late
  results, reconnection, process restart, actor recreation and quota regressions.
- `apps/web/src/features/rooms/presence-state.ts`: handshake/socket/epoch/sequence
  fences, full replacement, disconnect clearing, 8 retired epochs, bounded
  identifiers and projection of only known fields.
- `PresencePanel.vue`: accessible status and connection count presentation.
- `tests/presence-state.test.ts`: 19 reducer regressions.

Validation commands (no database or ports used):

```sh
source /workspace/.rainsync-cloud/env.sh
CARGO_TARGET_DIR=/workspace/rainsync-e01-target cargo test --locked -p rainsync-server --test presence
./node_modules/.bin/vitest run tests/presence-state.test.ts --cache=false
./node_modules/.bin/vue-tsc --noEmit -p apps/web/tsconfig.json
```

The Rust tests include the core directly rather than claiming production wiring
exists. Frontend tests validate an internal view model, not a duplicated public
wire schema. Shared dependency installation is read-only; Rust build outputs are
isolated. No long-running, real-device or production checks were performed.

Required after shared protocol lands: real WebSocket/PostgreSQL permission and
revocation races, task cancellation cleanup, room close/reopen/archived permission
semantics, independent users/devices, black-holed heartbeats, control revision
invariance, slow consumers/presence floods/control priority, browser reconnect and
legacy compatibility. Pure state tests do not prove these integration properties.

The expanded production patch plan is in `E01_PRESENCE_WIRING_PLAN.md`.
Independent audit validation: 17 Rust tests, 19 frontend tests and Vue typecheck.
Protocol production wiring and real DB/WS regressions remain pending.
