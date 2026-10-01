# Bounded room diagnostics

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
