# Bounded room diagnostics

## Current version 2: deterministic replay of every newly captured room-state operation

New exports use format/reducer `2` / `room-diagnostics/2`. Every newly committed ordinary control, ownership, resolved media change/playlist advancement, lifecycle transition and Server clock reset now has enough typed input to reconstruct the complete RoomState and lifecycle metadata. The bounded offline CLI compares every reconstructed state and the final digest to the recorded states. It still has no database, network, upstream, chat, account or process handles.

- `media_control` captures the exact command, reducer monotonic time and the selected media ID/duration returned by live resolution, before commit. Playback and generation changes are replayed through the room reducer. Replay accepts the captured resolution as a domain fact; it does not re-run today's playlist query, prove historical library permission, or certify upstream metadata truth.
- `lifecycle` captures a typed transition, expected revision and the one monotonic instant used by the live management transaction. Close freezes position at that instant; reopen and archive remain paused. The background `closed` event has no actor/time input and changes only the revision and lifecycle state. Existing live owner-receipt blockers are unchanged. A replayed `closed` event is never resource-release proof and cannot clear an unknown Agent obligation.
- `server_restart` captures the newly assigned clock epoch. Its deterministic projection preserves position, pauses, resets only the monotonic anchor and increments revision. UTC event time is never used as playback elapsed time.
- Version 1 envelopes and exports remain readable under `room-diagnostics/1`. Their original media/lifecycle/restart checkpoints remain checkpoints and cannot become verified transitions merely by exporting them in a version 2 window. Version 1 cannot contain a version 2 operation; unsupported future versions, gaps, missing facts and malformed shapes fail closed.
- No new public protocol field or database migration is required. The existing bounded diagnostic JSON column stores the explicitly versioned new envelopes. Existing export authorization, redaction, size/deadline limits, event retention and external cleanup queues are unchanged.

### Executed version-2 checks (2026-10-02)

28 room-core checks pass, including seven new projection/version/legacy/field-completeness checks and after-state tampering across every unrelated field. Full workspace/all-target checking and strict Clippy pass. A source-bound real PostgreSQL 17.11 / Server / offline CLI run passes 12 groups, including actual playlist advancement with a separately seeded selected duration, all lifecycle changes and restart, no side effects from replay, retained legacy/future/gap rejection, authentication races, pool/lock deadlines and exact owned-process/listener cleanup. Source digest `60633b77b52142b76d65824382ac62dade59d3246a2ec6fd491f30e24c4a83ee`; run `bfa05aee-726e-4e9d-8333-2d952f66fe4b`.

The first run failed an obsolete checkpoint-count assertion after the now-verified media transition; its failed report is retained. Assertions were updated to the new versioned contract, not by relaxing runtime validation. These checks cover deterministic bounded state replay, not historical authorization authenticity, external-effect delivery, physical devices or long-running release acceptance.

## Historical version-1 contract and evidence

The first E01 diagnostic slice records typed facts with the existing room event log and lets an instance administrator download a private window for offline checking. Existing WebSocket RESUME, snapshot recovery, control credentials and 24-hour event retention keep their current behavior. This is not complete event sourcing or proof of every historical side effect.

## Use

While signed in as an instance administrator, open `GET /api/v1/admin/rooms/{room_id}/diagnostics?after_revision=0&limit=128` on the existing Server origin. The response downloads `rainsync-room-diagnostics.json` with `Cache-Control: no-store`. Room owners and members without the administrator role cannot use this endpoint. Active, closing, closed and archived rooms can be diagnosed.

Run the offline checker on the downloaded file:

```sh
cargo run -p room-core --example verify_diagnostics -- /path/to/rainsync-room-diagnostics.json
```

The checker reads at most 512KiB plus one overflow byte and prints a JSON report. It has no database, network, chat, provider or media-process actions. Exit status 1 means incomplete/unverifiable coverage or a missing current endpoint; malformed input also fails. A continuous window containing explicit checkpoints can exit successfully while `all_transitions_verified` remains false. Inspect the counts and issues, not just the exit status.

`after_revision` is an explicit exclusive start. The default is zero, not an inferred replacement for pruned history. The default page has 128 entries; 256 is the maximum. A limited result marks `truncated`; it never claims to reach the current snapshot. If a total byte limit is exceeded, reduce the requested window. Selecting a later start verifies only that selected window, not the earlier room history.

## Meaning of the report

- `verified_steps` are ordinary play/pause/seek/rate or ownership transitions whose captured inputs produce exactly the recorded after-state through the pure reducer
- `checkpoint_steps` are explicit media-change/media-advance, lifecycle or Server restart boundaries. These record state and reason; they do not replay external media facts or prove that external work occurred
- `unverifiable_steps` and bounded fixed-code `issues` identify legacy, unsupported, malformed or inconsistent rows. Missing revisions or a next before-state different from the preceding after-state make the whole window discontinuous. A later valid row cannot repair that coverage
- `reaches_snapshot` requires a continuous chain ending at the exact captured snapshot and lifecycle metadata. `all_transitions_verified` additionally requires actual verified transitions, no checkpoint and no unavailable row
- `final_state_digest` is SHA256 of compact serialization of a validated typed RoomState in its declared field order. It is a diagnostic comparison, not an access grant or a signature proving authorship

Reducer version `room-diagnostics/1` and envelope schema version 1 are explicit. An incompatible reducer change must use a new version; old semantics must not be silently interpreted using new defaults. Database UTC event time is metadata. Monotonic reducer time is compared only inside its matching clock epoch.

The captured `actor_is_admin` is the boolean actually supplied to the historical reducer, not an independent proof that the actor still had that role at commit or has it now. Diagnostic verification does not change existing command authorization.

## Persistence and redaction

Migration 0038 adds one optional, size-bounded JSON envelope to `room_events`; historical values remain unchanged and old envelopes stay absent. Each new envelope carries its before-state, actor facts, lifecycle/epoch and a typed operation. Existing state, revision and database UTC time remain the after-state record. Snapshot mutation and event insertion share the original transaction and room-to-snapshot lock order. A duplicate command returns its existing result without another diagnostic event.

Media change and playlist advancement are checkpoints because the live Server resolves media/duration outside the pure reducer. Lifecycle and restart are checkpoints even when other fields appear unchanged. Restart preserves the existing conservative pause, new clock epoch and zero monotonic anchor, while recording the transition atomically. Revision exhaustion fails closed rather than wrapping.

The exporter reconstructs a closed allowlist of UUIDs, numeric playback fields, known lifecycle values and known operations. It excludes control epochs, cookie/CSRF/token/hash values, user names, media titles, source configuration, paths, URLs, playback grants, chat and arbitrary error text. The file still contains private identifiers and activity timing.

Legacy NULL, future versions, malformed shapes and oversized data are explicitly unavailable. PostgreSQL first bounds each stored state/envelope, then transfers it as text; fallible per-row parsing prevents deep but small JSON from panicking during aggregate decoding. No old actor, command, clock or permission fact is invented by joining today's user or command-result tables.

## Resource and authorization bounds

The endpoint allows four concurrent exports. The two-second budget includes pool acquisition, database work and buffering. Local PostgreSQL statement and lock deadlines are shorter. Cancellation closes a connection that has not completed rollback instead of returning uncertain protocol state to the shared pool. States are capped at 4096 bytes, envelopes at 8192 bytes, and the complete download at 512KiB including its header and checkpoints.

One SQL statement reads the original snapshot, lifecycle and bounded event window under one MVCC view. The transaction explicitly uses READ COMMITTED. After buffering, another statement checks the same login hash, current administrator status, database-clock expiry and continued room existence. A logout, expiry, demotion or deletion committed before that final admission rejects the response. No lock or database connection is held while a slow client receives the response. Bytes already admitted to the response cannot be recalled.

## Executed checks and limits

The source-bound local Server/PostgreSQL/CLI matrix passed 11 grouped checks. It covers actual commands, ownership/lifecycle/restart, redaction, legacy and malformed/deep JSON, duplicate commands, bounded windows, current admin gating and positive process/port cleanup. Twenty requests under a real table lock failed closed while the shared pool remained available before unlock. With eleven request connections deliberately blocked and the twelfth owning the Server instance lock, exports hit their outer deadline in about 2.005 seconds and the pool recovered after release.

A separately labeled fixture-only row-evaluation view barrier held an already captured SQL view. Public logout, injected expiry, administrator demotion and deletion of a disposable room with no resource obligations each returned 403 at final admission. The earlier ordinary table-lock case returned 401 before admission; it is not misreported as proof of the final gate. The barrier is test SQL only and is never installed by the application or migration.

Final evidence identities:

- Source digest: `8cc1f2d56bc53a83dec389ab6a55e3b0e21d0b9ec8069930af4af4fa63fa239f`
- Coordinator SHA256: `fbbcf6913f9320234d262054484e82ba68662dfd521ff34e8d4595ed638ddff3`
- Run: `f4338662-6934-4ada-b0e9-0cccc6262348`
- Report SHA256: `d2177bbc2bce00289951073283978df4cd223980c8aff91e18ff482733d79163`

The real isolated 1–37 to 38 migration preserved old rows and rejected invalid envelope container/byte shapes. The room-core/persistence test targets passed 25 checks; Server targets passed 57 unit and 17 presence checks, with one separately owned-PostgreSQL HTTP claim test explicitly ignored by the default runner. Strict workspace Clippy and the five-check schema-38 recovery suite passed. Existing actual RESUME delta/retention-gap recovery and membership transaction-race suites also passed with this backend. These are bounded correctness checks; they do not establish production upgrade, physical-device or long-duration acceptance.

### Restart/legacy compatibility follow-up

The v2 reducer and live lifecycle code now additionally pass a real restart while closed followed by reopen and close. This verifies startup resets the persisted clock epoch before live management projects its captured monotonic time. A literal version-1 golden fixture preserves seven expected control/ownership states without calculating them through the current reducer; changes to old semantics require an explicit version policy. The 29 room-core checks and updated 12-group real fixture passed with source digest `f042e0a23ee49eb6c78cb80f65b910ac6609debf2f26ef6f5022f0408d153777`, run `334cd75a-39cf-4915-b1dc-3af9eede0df2`.
