# Room directory list/create candidate review

Status: implemented candidate and executable finite qualification fixture. No new PostgreSQL, HTTP, WebSocket, browser, Cargo build/test, or distributed-runtime pass is claimed here. The fixture has not qualified either original or candidate behavior. This is not completion of the full refactor plan.

## Basis and application scope

- Exact baseline: `5d976089e3f44a767264a7cb76fe0e23bd321f55`.
- Original proposal: `external-proposals/room-directory-operations-20261010T1320Z/` inside the committed handoff ZIP. All 276 repository input snapshots were independently byte-compared with that baseline; none differ.
- The original draft has no completed manifest, independent review, or new native fixture. Its README's complete/frozen readiness statements are not adopted as evidence.
- Production commit: `aafb471378f14525b858b693617611d597d4ada6`.
- Parent integration's first strict Clippy run subsequently found the now-unused `PlaybackStatus` import in `rooms.rs`. The parent owns removing that import and rerunning validation, preserving its first-failure log. This lane does not duplicate that edit. Span-exterior byte equality below describes the original production extraction commit, not the parent’s necessary import cleanup.
- Only the contiguous list/Name/creation-session-check/create operation span in `rooms.rs` changes. Everything before and after that span is byte-identical. The unique module declaration stays inside this span, so other lanes' room registrations and bodies can be composed independently. Do not overwrite `rooms.rs` with the stale ZIP reference.
- `room_directory_operations.rs` owns the full list operation and full creation transaction. It receives existing `RequestContext`, headers, the canonical `Name`, immutable boot `Instant`, and boot epoch. It does not receive `App`, an owner registry, or a cached authorization result.

## Preserved contracts

1. The canonical `Name` retains `deny_unknown_fields`. Its `rooms::Name` reexport is still the exact DTO consumed by unchanged `agents::create`. The new Rust unit test type-checks this identity and checks raw whitespace and unknown/missing/wrong-type fields.
2. List still authenticates at entry, allows a valid guest, projects only member rooms, orders by `created_at DESC`, and returns ordinary `Json` HTTP 200. It has no new final authentication or administrator-wide override.
3. Create still checks entry identity/guest/Origin/CSRF before name/key validation. It holds principal then exact originating login, reserves a request key, and performs all room/member/snapshot writes and final login validation in one transaction.
4. Unique-key conflict remains PostgreSQL `ON CONFLICT DO NOTHING` followed by a fresh statement under READ COMMITTED. Replay compares the untrimmed submitted name before the final login check. Conflicting payload after a key wait therefore retains its original 409 precedence over natural login expiry.
5. A replay returns the original UUID even if the room was physically deleted. No room FK was added to the request ledger. No migration or trigger changes.
6. Birth ordinal/counter remains the original transactional database trigger. A failed final login admission must roll back the newly claimed key, room, membership, snapshot and counter together.
7. Real monotonic time is sampled at the original state-construction boundary, after principal/login/key waits and before room insertion. Passing the boot `Instant` never precomputes `app.now()` in the HTTP adapter.
8. Snapshot serialization and return-value construction stay in their original order. No new await or serialization step is introduced while locks are held.

Independent mechanical inverse review mapped only the narrow context/HTTP-wrapper/boot-clock changes back to the original operation. The operation tokens matched; every string literal matched in byte content and order, including all nine SQL literals. The two existing source-binding consumers differ only by adding the new production file to their input lists. Existing assertions and timeouts were not weakened.

## Finite native qualification fixture

`tests/room-directory-authority-native.mjs` is a direct, opt-in `nativeOwnerGate` script, not an automatically executed unit test or new framework. It uses the existing 180-second owned fixture, required source/binary binding, explicit exact-login hash, interactive psql child, and positive PID/backend/close receipts. It rejects external database URLs through the existing gate.

Its six named groups are:

- `directory_ingress_and_shared_name_contract`: registered creation, Unicode name limits, raw-name replay/conflict, key bounds and ASCII rejection, actual duplicate HTTP fields, missing-cookie/Origin/CSRF/extractor precedence, member-only cookie GET including administrator and guest scope, and shared `/agents` name behavior. Rejected registered and guest callers have separate whole-row snapshots; agent rows are also compared. Duplicate fields use `node:http` because Fetch merges them into a comma-separated single value. The serialized header block stays private.
- `create_new_after_key_rollback_samples_monotonic_time`: a real uncommitted key holder rolls back; a live sibling's genuine joined WebSocket returns a later clock reply while the create remains blocked on that exact key INSERT. The new snapshot anchor must be at least that reply's `t3`, with the same boot epoch and exactly one transactional birth increment.
- `create_new_exact_login_expiry_snapshot_insert_wait`: a SHARE table lock blocks the exact snapshot INSERT after earlier transaction writes. The original exact login naturally expires without any further expiry UPDATE. The 401 must leave all selected rows and the singleton counter unchanged; a live sibling can claim the same key and gets the next ordinal.
- `create_replay_exact_login_expiry_key_commit_wait`: the holder commits an actual full request row pointing at a genuinely deleted room. Replay after natural expiry is 401; the only selected-row change is that exact holder row, including its real `created_at`. A live sibling replays the tombstone without recreation or counter advancement.
- `create_payload_conflict_after_login_expiry_key_commit_wait`: the same held-key pattern with a different raw payload yields the original 409 `INVALID_REQUEST`, not final-login 401. The next new request with the expired cookie is 401; the live original payload replays unchanged.
- `list_registered_exact_login_expiry_member_select_wait`: a room-members table lock must witness the actual list SELECT, not an earlier authentication query. The already-admitted GET returns 200 after natural expiry, unchanged and ordered; the next expired-cookie GET returns 401 and a live sibling succeeds.

Every wait requires one exact blocked query, holder/blocked PID and `backend_start`, and a `pg_blocking_pids` edge, rechecked before release. Expiry cases establish the login is live at the initial actual wait, save six-digit UTC expiry, and verify the column is unchanged when database time reaches it. All created observer/setup rooms precede the birth-counter baseline. Selected rows are uncapped and include all actor users/logins/profiles/account exits, scoped rooms/members/snapshots/leases/events/control epochs, all actor request keys, and the entire counter.

Private HTTP bodies, raw SQL observations, full rows and holder logs use mode 0600; the owner report contains hashes and finite receipts. Cleanup retains original request/body promises, releases only its own holder with COMMIT/ROLLBACK, and awaits child exit zero, PID absence and backend absence. Observer and raw duplicate-header sockets have positive close observations. Cleanup/progress failures are appended after the original failure, never turned into a pass by a timeout.

## Draft corrections from actual source

- The original internal `guest_restricted` reason maps to public 403 `FORBIDDEN`, because the current `ErrorCode` has no `GuestRestricted` variant. The draft's planned `GUEST_RESTRICTED` assertion was incorrect. Production mapping is unchanged; the new fixture explicitly freezes the actual static contract, pending original runtime qualification.
- `PlaybackStatus::Paused` serializes as `"paused"`, and `RoomState.live=None` is omitted by `skip_serializing_if`. Full initial-state assertions use that actual representation.
- Name-validation and key-validation failures both publicly map to `INVALID_REQUEST`; the fixture does not pretend their relative internal reason order can be inferred from that identical public code alone. Their source order is preserved by the inverse review.

Independent review of the frozen native fixture (`cf4b1e84d5d6efdff36dacbc0640846f3e18d7660c17160fdfd7a9b09eaed8d8`) found no remaining static blocker after fixes to real duplicate-header serialization/Host, original body-promise draining, first-failure retention during progress writes, separate guest snapshots and asynchronous WebSocket parse failure handling. This review is not runtime qualification.

## Checks actually run in this lane

- Direct `rustfmt --edition 2024 --check --config skip_children=true` on both changed Rust files: passed. This parses/formats, not type-checks.
- `node --check` on the new native fixture and both changed existing JS consumers: passed.
- Existing installed Prettier on the new fixture: passed.
- Focused ESLint `no-undef`, `no-unused-vars`, and `no-unreachable` on the new fixture: zero findings. This is not a claim of the repository's full lint suite.
- Source-only backend/bootstrap contracts: 13 passed, 0 failed.
- Separate pure in-process negative controls extracted the exact HTTP observation helper source and injected only fake responses/deadlines: 6 passed, 0 failed. They cover one successful drain, pending rejection, body rejection, late drain preserving the earlier timeout, undrained body preserving primary plus cleanup timeout, and invalid JSON after a successful drain. No native fixture was imported and no service/socket was opened. This local review aid does not replace native qualification.
- Operation inverse, all literal bytes/order, span isolation, 276-input baseline equality, and existing consumer binding-only checks: passed.
- `git diff --check`: passed.

Cargo build/test is owned by the parent integration lane and was not run here. Native PostgreSQL/Server/HTTP/WebSocket execution was prohibited for this preparation lane and was not attempted. Original qualification must precede candidate execution with the same assertions and fixture order. Keep the existing broad `room-creation-idempotency`, `legacy-nas-scope`, `account-exit`, `scoped-guests`, and `nas-configuration-settings` coverage. Two-node `control-cluster-runtime`, Docker load/soak, Windows/device/provider credentials, required CI and other plan-level gates retain their separate scope and are not covered by these six groups. P08/P09, user computers, push, merge and deployment remain excluded.
