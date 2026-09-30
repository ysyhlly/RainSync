# Room lifecycle and epoch fencing

Room lifecycle is independent of shared playback state. `END_MEDIA` and playlist advancement do not close the room. The lifecycle is `active → closing → closed → archived`; only a closed room can explicitly reopen to active. Archived rooms remain read-only under existing membership and retention rules.

## Management contract

- `GET /api/v1/rooms/{id}/lifecycle` returns lifecycle, lifecycle_epoch, owner_id, authoritative state, and current cleanup attempts/last_error/completion
- `POST /api/v1/rooms/{id}/{close|reopen|archive}` accepts only `{ "expected_revision": number }`
- Management checks the durable owner or instance administrator. A non-admin also requires current room membership. Revision mismatch never overrides another command
- Every transition increments the snapshot revision and records both a control event and a durable lifecycle audit row. Cleanup's closing→closed transition has no user actor
- Close and reopen each increment lifecycle_epoch. Archive retains its closed epoch. Existing rooms and grants migrate to epoch zero
- Close pauses the timeline and transactionally revokes every command credential, invite, playback request and playback session before cleanup is enqueued. Reopening is paused and does not resurrect any old credential or invitation

## Admission and cleanup

All room mutations acquire the room row `FOR NO KEY UPDATE` before the snapshot or other resource locks. `persistence::room_lifecycle::lock_active` returns the epoch; `lock_epoch` validates an already captured epoch at final publication. A preparation must not recapture a fresh epoch after close/reopen and publish work from the previous room lifetime.

Closing rejects new room controls, invitation changes, joins, playlist mutations, ownership transfers and chat writes with `ROOM_NOT_ACTIVE`. Playback admission/publication and renewal enforce the lifecycle and captured epoch. Existing members can still connect to a history WebSocket; its snapshot contains lifecycle metadata and no command credential. Close clears existing client credentials, stops the local player, and leaves the chat and playlist readable.

The close transaction does not wait for processes or upstream HTTP. A durable cleanup task remains observable in `closing` until its independently tracked preparation, upstream and operating-system resource owners report disposal. Merely setting a media job to `cancelled`, or expiring a lease, is not proof of process reaping. See `0029_room_cleanup.sql` and the cleanup implementation for receipts, retries and fail-closed recovery. Migration `0030_legacy_nas_scope.sql` excludes only rooms provably created after an unproven legacy NAS transfer; possible earlier rooms retain the legacy barrier, with no fabricated drain or operator override. The shared transactional birth order and upgrade boundary are described in [ROOM_CLEANUP](ROOM_CLEANUP.md).

## Validation

- `tests/room-runtime.test.ts` covers readonly lifecycle state, stale metadata/credentials, history connection retention and late management responses after navigation
- `tests/room-lifecycle-playback.test.ts` exercises the actual room/player runtime: same-generation close disposes the old URL and request; reopen obtains a new plan without calling play
- `tests/room-lifecycle-filter.test.ts` covers room list filters, legacy active defaults and archived history entry
- `tests/room-lifecycle.mjs` covers actual PostgreSQL close/PLAY locking, owner/admin/revision checks, natural END_MEDIA, multi-device revocation, stale invites/epochs, restart while closing, owner acknowledgement and archived history authorization
- `tests/room-lifecycle-migration.mjs` applies actual migrations 1–27 with legacy rows, then upgrades and checks epoch-zero compatibility
- `tests/browser/room-lifecycle.spec.ts` covers confirmation/cancel, readonly history, player disposal and paused reopen. Browser execution is subject to the separately recorded cloud Chromium restriction; authored test bodies are not an execution pass

The original 399d699 package through migration 0029 passed focused lifecycle/migration/ownership/chat checks; the candidate including 0030 has also passed its separate 13-script lifecycle chain and full legacy chain, with results tracked in [the current phase report](PHASE2_LIFECYCLE_NEGOTIATION.md). Earlier 6227469 evidence included:  lifecycle PostgreSQL test (both close/PLAY serialization orders), actual migration, ownership regression, chat idempotency/restart, eight focused TypeScript tests, vue-tsc and production web build. Evidence logs use the `room-lifecycle-*` prefix under the validation artifact directory; ownership/chat keep their existing log names. This is focused evidence, not a blanket end-to-end media cleanup pass.

No private-library permission model is introduced by lifecycle management. Room ownership, source ownership and application-level media visibility remain separate.
