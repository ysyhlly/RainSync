# Playlist operation boundary

Base: `f5a6ce90daae97a548f60389ac6cb3a2a342a634`.

## Ownership and compatibility

The complete list/add/remove family now lives in
`apps/server/src/room_playlist_operations.rs`. Each entry receives only the
existing `identity::RequestContext` (database and origin), headers, and its
operation inputs. It does not receive `App`, access the runtime room registry,
start an owner, send an event, or construct an HTTP response.

- `list` returns a typed `Playlist` containing typed item identities/titles,
  the existing catalog cover projection, and the native platform discriminator.
  The original catalog and room-platform queries retain their independent
  viewer-specific library checks. Their merged order is `(sort_order, item_id)`.
  Authentication and membership checks run before both reads and again after
  projection, before returning the result.
- `add` returns `Addition::Existing(item)` or `Addition::Inserted(item)` only
  after the original `commit_controller` succeeds. Its separate preliminary
  actor and controller authentication calls, media locks, room/library checks,
  first-item duplicate lookup, and insertion SQL remain in their original order.
- `remove` returns `Removal::Absent` or `Removal::Removed` after the same final
  admission and commit. Its DELETE still scopes by both room and item identity;
  a no-op removal is not allowed to bypass final authorization.

`rooms.rs` remains the HTTP and delivery adapter. The list remains an array with
`Cache-Control: no-store`; add remains `{ "id": ... }`; remove remains
`{ "ok": true }`. Axum extractors, paths and route registration are unchanged.
The Add DTO still tolerates unknown fields and requires a UUID `media_id`.
Catalog rows still omit `kind`; native rows still carry `native_platform`.
Catalog cover uses its existing `status` field, while the native missing cover
retains the legacy `state` field. Nullable cover fields are not omitted.

The runtime emits only `{ "type": "PLAYLIST_CHANGED" }`, after successful
operation completion, for actual insertion/removal. Duplicate addition and
zero-row removal do not emit it. Per-viewer media facts never enter the event.
No snapshot, playback revision, timeline state, owner or second queue cache is
introduced.

## Existing transaction authority

The extraction reuses `controller_admission` and `commit_controller` without
changing them. The existing room-first ordering stays:

1. Active room
2. Room snapshot
3. Membership
4. Current user role
5. Exact login and locked CSRF
6. Owner/controller/delegated Queue decision
7. Existing media/playlist resource work
8. Exact-login natural-expiry and delegated-permission recheck, then commit

The existing preliminary identity is not a lasting permission. Existing room
locks serialize queue writes; a later resource wait does not replace the final
session/grant deadline checks. No generic repository, additional transaction,
second authority type, migration or protocol/schema version is added.

## Verification entry points

Pure checks, without database or sockets:

- `node --test tests/room-playlist-contract.test.mjs`: eight seam/evidence
  contracts, including negative reports with omitted, duplicated, failed,
  unknown and reordered checks.
- `cargo test -p rainsync-server playlist_operations --locked --offline`: five
  pure Rust tests for merged/tied/extreme ordering, catalog cover URL scope and
  nullable fields, native wire shape, mutation no-op results, and Add decoding.
- `cargo fmt --all --check`
- Existing `npm run test:backend-contracts`: 98 baseline contracts.

The direct native entry is `node tests/room-playlist-authority-native.mjs`.
It requires the existing owned native PostgreSQL fixture and a successful,
current source/binary binding (`W03_BACKEND_BINDING`), an isolated absolute
`CARGO_TARGET_DIR`, native Postgres binaries and owned artifact directory. The
fixture refuses a caller-supplied `DATABASE_URL`. Bind the exact candidate first
through `scripts/bind-native-backend.mjs`; do not reuse a baseline binary as
candidate evidence. Run the same fixture against the original and candidate
when checking parity.

Its fixed eight-check inventory covers:

- Mixed catalog/platform ordering, personal title, per-member private filtering,
  no-store GET without Origin/CSRF, real insertion/removal, duplicate addition,
  absent and foreign-room removal, metadata-free invalidations, and unchanged
  playback snapshot
- List exact-login natural expiry during an actual playlist SELECT wait
- List membership revocation during the same SELECT boundary
- New and duplicate addition exact-login expiry during a media-row lock wait
- Removal exact-login expiry during a DELETE wait
- Addition and removal delegated Queue expiry during those resource waits

Every wait case witnesses its unique actual PostgreSQL blocking edge, checks
that the original request has not settled, and observes the same edge after
invalidation. Natural expiry is proved by `clock_timestamp()` against the exact
unchanged expiry column, not by merely sleeping. Rejected operations compare
complete playlist, snapshot and room rows byte-for-byte; this is not a claim
about every table in the database. A separate live exact login subsequently
succeeds. HTTP bodies, WebSockets, holder processes/backends, the server and
PostgreSQL have bounded cleanup. The report cannot pass on an incomplete check
inventory. The extra synthetic-source fixture participates in coordinator
source rechecking.

The native absence check is a finite 250 ms post-response observation on a live
recipient, with a clock reply; it is not an unbounded proof of no future frames.
Ready catalog cover URL/field handling is covered by the Rust tests, not by a
ready-preview native seed. Existing `playlist-chat-regressions.mjs` and
`queue-propagation.mjs` remain additional regression entries for END_MEDIA's
committed queue read and ordinary two-recipient invalidations.

## Acceptance limits

This lane does not run any database/socket fixture. The new native gate and
existing playlist/chat/propagation gates are authored or retained for later
source-bound execution, not reported as passed. It is not yet registered in the
shared npm/CI/frozen authority inventory; the integration owner must wire those
entries without overwriting concurrent changes.

P08/P09, playback publication/owner behavior, media decoding, distributed node
fences, provider credentials, physical drain, browser behavior and soak are
outside this change. A pure/source test pass is not native or release acceptance.

GitNexus MCP was not exposed in this environment, and no usable CLI was found
in PATH or the existing task tool installations. Navigation used direct current
source inspection under the repository's documented fallback, with no claim of
current-index graph/impact qualification.
