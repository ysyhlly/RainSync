# Private-library local mutations: finite native qualification

Status (2026-10-10): **authored and pure-checked only; ORIGINAL and CANDIDATE native runs have not been performed.** This file is deliberately not registered in package scripts or CI. Neither syntax checks, these pure tests, nor bound-but-unexecuted artifacts imply a native pass.

## Purpose and fixed scope

`tests/private-library-local-mutations-native.mjs` supplies the missing bounded metadata-only cases without importing or running the mixed playback portions of `private-library-settings-native.mjs`, `private-library-committed-change.mjs`, or `private-library-native.mjs`.

Exactly four ordered groups and 36 independently frozen named checks run against one new owned Server/native PostgreSQL fixture:

1. **Library/grants/transfer (10):** create, rename with exact revision/audit changes, stale rename rejection, grant, manager grant-revoke and transfer denials, grant DELETE, regrant, owner transfer, old-owner denial/new-owner access. Grants have all four permissions explicitly true; no implicit administrator library access is assumed. Grant expiry must be within the exact database-observed request window plus 24 hours.
2. **Private source metadata (7):** safe manager detail, administrator/stranger denial, source rename, real `{config:{}}` no-op, same-header config no-op, stale source revision rejection, nonadministrator policy rejection. A semantic no-op must retain the complete source row, ciphertext, policy snapshot, library revision/epoch, media generations, grants, shares, audit and room snapshots. Name-only mutation advances source settings and library revisions exactly once, without changing cipher/policy/media identity or library epoch.
3. **Configuration/deletion (8):** reject cross-origin credentials without explicit clearing; change URL while explicitly clearing headers; reject stale source DELETE; delete source; hide its tombstone; delete a library with a different live source; hide its library tombstone; retain owned marker bytes. Compare exact source settings/policy revisions, full current policy snapshot, media identity/generation/availability, library revision/epoch and audit. Decrypt only the owned synthetic ciphertext with the fixture's in-memory key: config update must equal the prior complete config with only URL/headers/public-origin policy replaced; source/library deletion must encrypt `{}`. No secret/key/config plaintext enters the safe receipt.
4. **Room shares (11):** three share creations, invalid-expiry rejection, update with exact requested expiry and carried current shares, stale CAS rejection, revoke while preserving other current shares, inactive-share update rejection, revoke grantor's library access, redacted issued-shares, denial when withdrawing another grantor's share, successful withdrawal of one's own share after losing library access, and zero forbidden work. The final withdrawal cannot revive the already-stale owner share.

Setup uses existing authenticated HTTP user/library/source/room endpoints plus fixed SQL inserting owned synthetic media and a room membership. The source URLs use reserved `example.test` names solely as stored metadata. No provider is started or called. There is no new fake provider.

The complete small fixture snapshots contain all rows of `private_libraries`, `sources`, `source_access_policy_snapshots`, `media_items`, `library_grants`, `room_media_grants`, `library_permission_audit`, `rooms`, `room_members`, `room_snapshots`, `room_events`, and `source_scans`. SQL-produced revision strings avoid JSON integer rounding. Mutable timestamps are exact PostgreSQL microsecond strings. Rejected/no-op requests must leave the entire snapshot unchanged. Successful operations construct the expected delta from the preimage; unexpected column/row/table changes fail. Generated audit UUIDs are unique, and all generated audit/tombstone/expiry times must be in a closed before/after database request window. Share PATCH expiry equals the requested integer milliseconds exactly after conversion to microseconds.

The final zero-work check and each snapshot count `playback_requests`, `playback_sessions`, `media_jobs`, `upstream_reservations`, and `media_previews`. They must remain empty. This does not assert that production code never reads an empty playback table: existing idle/retirement operations still retain their original queries. The fixture never seeds or requests those objects, P08/P09, preparation/publication, playback media, scans, previews, FFmpeg, Worker, NAS or a real provider.

## What this does not qualify

This is not a 20/20 ingress matrix. Successful library list/detail/create/rename/remove, grants POST/DELETE, transfer, source POST/detail/PATCH/DELETE, issued-shares, and room-share POST/PATCH/DELETE are exercised with the finite assertions above. List/detail/setup calls do not become full permission/admission coverage merely by succeeding.

Not covered here:

- Private media browse/play/pagination; source attach; private or shared source scan POST/status GET; provider pagination/failure/restart/concurrency
- All-entry missing cookie, guest, exact-login expiry, Origin/CSRF/extractor priority, feature-disabled/unset combinations, limits, validation precedence or distinct revision spelling matrices
- Caller/room/source/library lock waits, naturally expiring grants/logins during a wait, admin promotion/demotion races, or proof of transfer caller-lock ordering
- Cipher call counts or rejection timing; cryptographic primitive compatibility beyond decrypting this fixture's legitimate envelope
- Stale library CAS on every mutation, all grant capability combinations, repeated/idempotent revocation, room nonmembership, expired/stale/source-mismatched share combinations
- Source-in-use/upstream-reservation cleanup refusal, agent-managed/shared-library protection, attachment locks, preservation of actual media files
- COMMIT fault/unknown-COMMIT transport outcomes, postcommit projection faults, injected retirement failures, maintenance recovery, socket/FD/media-worker disposal, cross-node behavior, Windows, CI, soak or deployment

The owned marker is an ordinary static file that proves this finite run did not alter that file. It is not proof of physical media cleanup or of all filesystem behavior.

## Pure checks allowed in a no-DB/no-socket environment

Run from the checkout:

```sh
node --check tests/private-library-local-mutations-native.mjs
node --check tests/private-library-local-mutations-contract.test.mjs
node --test tests/private-library-local-mutations-contract.test.mjs
```

The pure contract reads the native source as text and extracts the **actual** pure definitions into an in-memory function. It does not import the native entry point or its service/helper dependency graph. It runs genuine negative mutations of the frozen checklist, full-snapshot comparator, microsecond windows, cipher replacement checks, 18-item artifact validator, positive-stop validator, HTTP origin/redirect guard, response-body consumption, primary-plus-diagnostic failure aggregation, and exhaustive receipt checks after earlier binding/read/hash failures. Additional tests extract the actual nested `transition` and full `main` function bodies and inject only in-memory filesystem, process, catalog and cleanup dependencies. They test every listed falsy value and hostile getters as business, post-catalog, cleanup, diagnostic, integrity and final-save failures, including completed checklists before rejection and original-value ordering across combined failures. In-memory `Response` instances and a stub fetch require no listener or network. Syntax checking likewise executes no module body.

Native execution is guarded by a direct-entry check and requires exactly `--original` or `--candidate`. This is an accidental-invocation guard, not permission to run it in a prohibited environment.

## Native admission, only in the explicitly authorized saved test environment

The authoring environment must not run the following commands. The parent/operator owns native admission and ORIGINAL-before-CANDIDATE qualification.

1. Freeze this coordinator, its pure contract, this document, all common helpers and binding producers. Use byte-identical files, checks and order for both builds. Do not weaken assertions after an ORIGINAL failure to call the candidate qualified. A necessary fixture correction restarts ORIGINAL qualification with newly frozen bytes.
2. Use the correct source/binary pairing. Set absolute `RAINSYNC_ARTIFACT_DIR` (an existing directory outside the real checkout), `CARGO_TARGET_DIR`, `W03_BACKEND_BINDING`, and `RAINSYNC_NATIVE_POSTGRES_BIN`. Run as non-root. Completely unset `DATABASE_URL`, including an empty inherited value. The fixture requires a single coherent native PG bin directory and rejects Docker fallback. Verify current free disk/inodes and retained evidence/build needs independently; no invented minimum capacity threshold is provided.
3. Require the existing successful `bind-native-backend --owner-fixtures` manifest with **all 18** actual artifacts: 3 production binaries, 14 helper/test drivers, and the Cargo-discovered Server owner executable. `loadOwnerBinding(requireTest:true)` verifies owner build provenance, producer bytes, backend source snapshot, binding bytes, and all artifact hashes. A separate frozen exact-name/path/18-item receipt records every artifact; owner test and other helpers are **not executed**. Only the bound production Server is executed by this fixture. The owner path must come from the manifest; never guess `debug/deps` names.
4. Independent receipts capture absolute paths, SHA-256 and versions of Node and `initdb`, `postgres`, `psql`, `pg_ctl`; all four PG versions must match. Tool executable hashes are rechecked afterward. Before and after verification independently recompute the complete backend source set (including additions/removals), then attempt every frozen binding/source/producer/artifact/helper/tool item even if an earlier item or the shared binding verifier fails; fixed categories and per-item digests record all outcomes. Node/PG/JavaScript helpers are not smuggled into the 18 Rust artifacts. `playback-admission.mjs` appears only as a hashed existing helper input, never an import or execution.
5. Run ORIGINAL first under an external bounded supervisor, keeping stdout/stderr in a restricted evidence directory. On ORIGINAL success, repeat in a distinct CANDIDATE evidence root with the identical frozen coordinator files, against its separately successful matching build binding. The phase argument labels evidence; it does not select a weaker assertion branch. No automatic cross-phase scheduler or CI registration is included.

Example invocation for the **authorized native host only**, after all admission checks and environment variables are set:

```sh
timeout --signal=TERM --kill-after=45s 240s node tests/private-library-local-mutations-native.mjs --original
# Only after the ORIGINAL result and cleanup are verified, in the candidate checkout:
timeout --signal=TERM --kill-after=45s 240s node tests/private-library-local-mutations-native.mjs --candidate
```

## HTTP, secrets, cleanup and failure evidence

`catalogFixture` remains the Server/PG owner and provides its normal 180-second work signal, termination signal, source/binary/helper rechecks and `fixture-cleanup.json`. The dedicated wrapper pins the exact loopback origin on the existing helper's first GET `/health`, rejects any different origin or route outside the finite whitelist, forces `redirect: "error"`, and immediately checks the pinned origin equals the actual `f.origin` before business work. The existing helper creates the fresh loopback port; the wrapper does not reuse a supplied endpoint. Every startup health body is drained, including unsuccessful health responses. Business response bodies are read fully before JSON/status/privacy assertions; the same consumer has pure negative tests. Auth helper responses use its existing full-body JSON reader.

Full before/after rows and raw HTTP bodies are saved as mode-0600 private files under the unique owned fixture root, and are never copied into the safe report. The report contains fixed check names, fixed failure categories, digests, paths, counts and positive cleanup receipts only; not credentials, cookies, SQL rows, config plaintext, cipher bytes or error messages/causes. The Server log is checked for the synthetic source-header secret after shutdown. Raw Server/PG logs, fixture DB/data/media/cache paths, and failed attempts remain retained; no evidence is deleted or overwritten by a later attempt.

The request outcome and post-request snapshot/evidence failures are captured separately. Explicit ordered failure arrays distinguish successful completion from every rejection value, including `undefined`, `null`, `false`, `0`, `-0`, `0n`, `""`, and `NaN`; no error truthiness or missing-value sentinel decides pass/fail. The dedicated safe classifier also catches throwing `code`/`name` getters, so classification cannot replace the original rejection or skip later evidence. Their original in-memory values/identities remain in arrival order rather than allowing a secondary diagnostic/save failure to replace the primary failure. A transition rethrows its sole original rejection unchanged or an ordered `AggregateError` for multiple rejections. The final main reporting boundary exposes only a fixed error message and `failure_count`, never raw `cause`/`errors` values. Final binding/cleanup/evidence errors are also recorded independently; failure of the final receipt write itself fails the run and cannot create a pass.

Qualification requires all three together: **the coordinator process exits 0**, a complete outer receipt passes every required check, and the external supervisor reports no timeout or termination escalation. A JSON `result: "passed"` alone is never sufficient: a failed final write can have already written some or all of a passed document before the command reports failure.

Pass also requires exact fixed-check completion, unchanged before/after binding (including the eighteenth owner artifact and all tools), and positive `verifyStopped` evidence: all owned Server and psql children closed, Server and PostgreSQL PIDs absent, both loopback ports refused, `pg_ctl status` exactly 3 for the owned cluster, and observed zero process exit with no terminating signal. SIGKILL, nonzero exit, unconfirmed close or port checks fail. No fake-provider resource exists to close.

**Known lifecycle limitation:** the reused native PG helper has unbounded waits for child close/stream close during shutdown. The 180-second work signal is not a hard shutdown deadline. The parent must use the external bounded supervisor above and inspect the owned PID/port/PG receipts. If termination escalates, the command times out, or positive closure is unconfirmed, the run is failed/incomplete; neither a `finally` block nor an inner report marked passed is sufficient. The outer `private-library-local-mutations-native/{phase}/{unique-id}/receipt.json` is the authoritative additional result. The parent remains responsible for settling any retained owned process after an interrupted run, under the environment's permissions. This fixture never kills unknown PIDs or claims cleanup merely because a timeout elapsed.

## Authoring provenance

Authored in the separate `dot/private-mutations-fixture-20261010` worktree based on `27906dbf48d1b6c5ace26d10de335234a89c2714`. Existing production SQL/triggers and original private settings/expiry/committed-change/catalog fixtures were read for behavior. No production files, shared helpers, migrations, package scripts or CI were changed. No Cargo, DB, socket, service, network, user-computer, push or provider execution was used for authoring.

The checkout's AGENTS guidance was read. No GitNexus MCP was available and executable/current-node_modules discovery found no usable installed runner/index, so source inspection used the documented direct-read fallback. There is no graph-impact or native-coverage pass claim.
