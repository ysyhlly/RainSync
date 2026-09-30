# E01 reported presence production handoff

## Baseline and scope

Branch: `feature/e01-presence`. Final changes are relative to shared contract
`79cff19718f94d053d69f5b969147ae540921d9e` (tree `26d7862`). The original
`9b167ab` checkout and independent checkpoint were preserved; only the later
independent audit was rebased onto 79cff. The original core/UI checkpoint was
already included by the parent and was not reapplied. Later HTTP/readiness
milestones were not followed or modified.

This lane implements server room/socket integration, replaceable delivery,
frontend runtime adaptation and the mounted presence panel. Shared protocol,
TypeScript/schema generation, process startup initialization and `pub mod
presence` are already supplied by 79cff. No additional main/lib patch, database
migration, dependency, lockfile, CI or global ledger change is required. No branch
was pushed or merged and no deployment, production service, user computer,
credential configuration or access-permission change was performed.

## Implemented behavior

- JOIN/RESUME opts in only with integer `presence_version: 1`. Legacy and unknown
  versions retain existing control admission/capacity and receive no presence.
- Each participating connection has a fresh server-issued UUID. Only the initial
  SNAPSHOT exposes that connection's ID, paired with the four-field snapshot.
  Subsequent PRESENCE_SNAPSHOT envelopes are complete replacements.
- Counts aggregate participating connections per user. They cover reported
  connections, potentially devices or browser tabs. Missing members remain
  unknown. The UI says “已上报在线状态的连接” and explicitly explains coverage;
  old servers or missing negotiation show “在线状态不可用”. No device identity,
  IP, browser fingerprint, session token or connection list is published.
- Server Ping/Pong probes run every 15 seconds. Only a matching outstanding
  server nonce with fresh authorization renews the 45-second monotonic lease.
  Three outstanding probes are retained. CLIENT_STATUS, CLOCK_SYNC and other
  text never establish or renew presence. Expiry is terminal; reconnect requires
  a new ID. Per-socket deadline and a separate expiry task remove stale leases
  independently of database and network waits.
- A cleanup guard removes the lease/session context on early return,
  disconnect, terminal rejection and task cancellation, before close-handshake
  waits. Limits apply only to participating connections: 8/user/room, 80/room,
  4096/process. Process capacity is released on expiry/revocation/disconnect or
  room drop. Admission failures return bounded RATE_LIMITED responses.
- Before each presence send, recipient and every captured subject are checked
  together against sessions and room_members with bounded cancellation-safe
  database reads and membership/session key-share locks. Candidate IDs fence
  delayed results: new unexamined connections trigger at most two attempts;
  exhausted retries skip updates or fail the initial handshake explicitly.
  Removed IDs cannot be restored by stale positive results. Logout removes only
  the associated login sessions; membership removal removes all that user's
  participating connections. Failed permission checks fence leases.
- The dedicated watch slot keeps one full snapshot. CLIENT_STATUS churn cannot
  evict it; control remains first with bounded background fairness. Queue values
  are hints: current subjects and epoch are revalidated before writing. Room/DB
  locks do not span network writes, which retain the existing five-second bound.
  Revocation follows admission reads relative to committed removal; bytes
  admitted before removal may already be in transport buffers.
- One process-wide Sequence supplies epoch/seq across rooms and actor recreation.
  Renewal alone and all presence changes leave control revision unchanged. On
  u32 exhaustion the shared epoch rotates without clearing live leases or
  resetting capacity; a 15-second maintenance pass propagates it to active
  rooms, and clients establish the epoch through a fresh handshake. Process
  restart retains no online collection. Existing playback-clock startup still
  increments control revision once; presence admission adds nothing to that.
- The client binds once per socket generation, accepts same-epoch sequence gaps,
  ignores smaller/equal sequences and old socket callbacks, and clears claims
  synchronously on disconnect, leave and terminal permission/session errors.
  Eight retired epochs are retained; known old epochs are ignored, unknown
  epochs trigger authenticated reconnect. Names from existing membership API
  are optional labels and never the source of online claims.
- Closed/archived rooms retain the existing readable-room admission rules;
  presence grants no playback/control permission and does not change lifecycle,
  ownership transfer, event replay or media generation behavior.

## Changed files relative to 79cff

Server: `apps/server/src/presence.rs`, `room_presence.rs`, `room_delivery.rs`,
`rooms.rs`, `apps/server/tests/presence.rs`.

Web: `apps/web/src/features/rooms/presence-state.ts`, `PresencePanel.vue`,
`room-runtime.ts`, `RoomPage.vue` (panel import/mount only).

Tests: `tests/presence-state.test.ts`, `tests/browser/room-presence.spec.ts`,
`tests/room-presence.mjs`, `tests/room-presence-timeout.mjs`.

Task docs: this file, `docs/E01_PRESENCE_WIRING_PLAN.md` and the portable
`docs/E01_PRESENCE_EVIDENCE.json` record.

## Regression evidence

Cloud verification uses an isolated Rust build/output directory, disposable
PostgreSQL 17.11 clusters and random loopback ports. Shared installed node
packages were used read-only. Existing tests/fixtures and capacity assertions
were not changed.

- `cargo test --locked -p rainsync-server`: 36 unit + 17 independent presence
  tests passed. Includes cleanup guard cancellation, exact/terminal expiry,
  reconciliation races, independent sessions, room/process capacity and shared
  epoch rollover with live leases/capacity intact.
- `cargo clippy --locked -p rainsync-server --all-targets -- -D warnings`: passed.
- `vitest run tests/presence-state.test.ts`: 25 passed, including bounded wire
  projection, unknown/retired epochs and generation fences.
- `vue-tsc --noEmit -p apps/web/tsconfig.json`: passed.
- `npm run build -w apps/web -- --outDir <isolated-output>`: passed; Vite
  reports the existing large-bundle warning.
- Desktop and mobile Chromium `tests/browser/room-presence.spec.ts`: 6 passed.
  Tests reported coverage, multiple connections, member removal, unavailable old
  server, sequence gaps without player/command effects, epoch reconnect, revoked
  UI cleanup and leave. These are browser simulations, not physical devices.
- Real `tests/room-presence.mjs`: passed. Covers 100 simultaneous same-user
  legacy control sockets beside participating sockets, unsupported versions,
  fresh server IDs, v1 cap/reclaimed slots, multi-session aggregation, logout,
  actual membership-deletion lock race for subjects and revoked recipients,
  CLIENT_STATUS/forged-frame rejection, no presence-driven revision increments,
  restart/new epoch, and real lease expiry at **45.001 seconds** despite text and
  unsolicited Pong. Valid Pong keeps another socket online without video.
- Existing `tests/room-events-isolation.mjs`: passed, including a paused slow
  socket, six-device telemetry burst, healthy control in **21 ms**, control/chat
  ordering/recovery and transactional membership races.
- Existing `tests/room-membership-timeout.mjs`: passed; 24 old control sockets
  fail closed and recover the shared pool before permission-table unlock.

- Real `tests/room-presence-timeout.mjs`: passed. Negotiated connections fail
  closed under actual permission-table contention, admit no control replies,
  release the shared pool before unlock and leave no abandoned online leases.

Real fixture reports assert owned Server/PostgreSQL processes stopped, PIDs
absent and loopback ports closed. Reports contain no session tokens or passwords.

## Reproduction and remaining work

Build server into your isolated CARGO_TARGET_DIR, set RAINSYNC_ARTIFACT_DIR and
(optional) RAINSYNC_NATIVE_POSTGRES_BIN, then run the listed Node integration
scripts. Browser tests can use an isolated Playwright config overriding the dev
port/output directory; no repository config change is necessary.

The parent can apply the downloadable commits/bundle onto 79cff and carry out
combined-lane review. No remaining shared interface/startup wiring blocker exists.
Long-duration, physical-device, broad multi-service acceptance and deployment
remain later work. This handoff does not claim all of E01 or the multi-lane release
is complete; persistent event replay is outside this lane.
