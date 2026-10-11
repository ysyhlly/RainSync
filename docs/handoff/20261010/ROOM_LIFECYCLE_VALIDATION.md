# Room lifecycle operation validation

This is the source-level continuation of the frozen lifecycle v2 proposals.
It is not an original/candidate database test result, release gate, or disposal
receipt. Original production is commit
`5d976089e3f44a767264a7cb76fe0e23bd321f55`. Keep the original and candidate
checkouts, producer bindings, logs, and owned runtime/artifact directories
separate. Never pass a production `DATABASE_URL`.

## Preserved evidence and integration scope

The historical ZIP, source manifests, v1 rejection, v2 correction receipts, and
independent reviews under this handoff are unchanged. The production proposal
has 233 verified members, seven exact full-span inverses, four full-file
inverses, and 19 unchanged SQL literals. Its 210 source inputs differ from the
original production above only in the subsequent P22
`platform_media/delivery/owner_tests.rs` updates; that file must not be restored.
The v2 fixture has 113 verified members and all 106 source inputs still match.

All ten v2 cases and their assertions remain. The installed fixture updates its
first comment and corrects one independently found snapshot-construction defect:
the current schema selects 56 table keys, while one `jsonb_build_object` call
would require 112 arguments, above PostgreSQL's 100-function-argument limit.
The original `pairs` generation, filters, full rows, ordering, single statement,
and JSONB text comparison stay unchanged. A tiny fixture helper wraps each pair
in its own two-argument `jsonb_build_object`, concatenating the objects with
`||`. Its bytes join the native gate's coordinator binding and post-run recheck.
A no-DB unit test exercises 56 pairs without truncating any key or value. The
frozen v2 archive is retained unchanged, including the defective construction;
apply the fixture correction commit after the initial fixture-only commit for
both original and candidate runs. The initial fixture-only commit alone is not
a runnable accepted baseline.
The historical fixture SHA-256 is
`938d563147cc1c3fb43760ecb08f3b5bbce3a0e5d1b7254b4fec95a503728eda`.
The fixture-only commit can be applied to original production without the
operation extraction. No workflow or existing assertion is weakened.

The production integration moves status, close, retry-cleanup, reopen, archive,
and their complete common change transaction into
`rooms::lifecycle_operations`. It uses the existing borrowed request context,
monotonic start instant, and boot epoch. Sampling remains after the original
lock/authority/revision/lifecycle waits and checks. The HTTP adapters preserve
routes, DTO, error mapping, post-commit broadcast-before-response ordering, and
the three target lifecycle constants. Register only the new module in
`rooms.rs`; do not replace that file from a historical snapshot.

Keep final exact-login/delegated natural-expiry checks in the original
`Authority.commit`, and keep the cancellation observation in the complete
transaction until commit confirmation. Status remains entry-only authenticated,
REPEATABLE READ / READ ONLY with rollback. Retry retains its distinct complete
transaction, revision-before-lifecycle errors, and original lease-safe SQL.
The resource owners and background cleanup-to-closed operation are unchanged.
Logical cancellation/closing is not process, socket, file-reader, or durable
ACK proof. P08 and P09 remain excluded.

## Preconditions for actual runs

Run syntax/source checks before any runtime, and use the existing central
`scripts/bind-native-backend.mjs` producer in each checkout to build and freeze
that checkout's unchanged Server/Worker/Agent/helpers. Use its actual returned
binding as `W03_BACKEND_BINDING`. The candidate job-health source list must bind
both the adapter and `room_lifecycle_operations.rs`; the original source list
remains unchanged. Do not copy binaries or bindings across the two checkouts.

Require the supported Node dependencies, native PostgreSQL, and FFmpeg/FFprobe
for the media-stack rows below. Use absolute owned `CARGO_TARGET_DIR`,
`RAINSYNC_RUNTIME_ROOT`, `RAINSYNC_ARTIFACT_DIR`, and
`RAINSYNC_NATIVE_POSTGRES_BIN`. Serialize producer builds. Respect environment
permission gates: this integration lane does not start DB, HTTP/WS sockets,
browsers, or cargo compilation. Listing a command here does not authorize it.

## Original and candidate database checklist

Run every command below separately against original production plus the
fixture-only commit, then against the final composed candidate. Record each
exit code, named checks, exact source/binary binding, runtime prerequisites,
and positive owned cleanup. Preserve failures and do not skip later independent
rows because an earlier row failed.

Core lifecycle and shared-authority checks:

1. `node tests/room-lifecycle-authority-native.mjs`
2. `node tests/room-lifecycle.mjs`
3. `node tests/room-cleanup-native.mjs`
4. `node tests/room-cleanup.mjs`
5. `node tests/room-cleanup-upstream.mjs`
6. `node tests/room-diagnostics.mjs`
7. `node tests/room-permissions.mjs`
8. `node tests/room-ownership-authority-native.mjs`
9. `node tests/room-invitation-authority-native.mjs`
10. `node tests/scoped-guests.mjs`
11. `node tests/job-health-events.mjs` (full run, not `--child-reap-only`)
12. `node tests/job-timing-runtime.mjs`

Compatibility, shared room gates, and cleanup consumers:

13. `node tests/room-lifecycle-migration.mjs`
14. `node tests/room-cleanup-migration.mjs`
15. `node tests/room-diagnostics-migration.mjs`
16. `node tests/room-authority-consistency.mjs`
17. `node tests/queued-control-authority.mjs`
18. `node tests/playback-plan-generations.mjs`
19. `node tests/control-cluster-runtime.mjs`
20. `node tests/distributed-compute.mjs`
21. `node tests/legacy-nas-scope.mjs`
22. `node tests/nas-missing-root-receipts.mjs`
23. `node tests/nas-uplink-metrics.mjs`
24. `node tests/relay-lease-health.mjs`
25. `node tests/server-preparation-drain.mjs`
26. `node tests/worker-delivery-shutdown.mjs`
27. `node tests/upstream-graceful-shutdown.mjs`
28. `node tests/agent-drain-receipts.mjs`
29. `node tests/agent-graceful-shutdown.mjs`

These are the identified database/owner consumers, not a claim of exhaustive
dynamic API coverage. Static-HLS pending/owner/public-prepare runners remain
separate environment-gated acceptance with their existing fixed-image,
offline-dependency, permission, and disposal requirements; they must not be
replaced by synthetic rows in this fixture. Keep the original P22 delivery
owner contract/ACK-retry tests in the full candidate validation as well.

### Exact ten-case authority expectations

- Close after actual snapshot-row wait samples live monotonic time late;
  lifecycle becomes closing, revision and lifecycle epoch each increment.
- Reopen after the same wait samples late; state stays paused, epoch increments.
- Archive after the same wait samples late; lifecycle epoch stays unchanged.
- Close after control-epoch DELETE wait and natural exact-login expiry returns
  401 `SESSION_EXPIRED`; complete selected database state rolls back.
- Close at the same final wait and natural delegated Close expiry returns
  403 `FORBIDDEN`; complete selected state rolls back.
- Retry after an actual cleanup-task UPDATE wait and natural exact-login expiry
  returns 401 `SESSION_EXPIRED`; task changes roll back.
- Retry at the same UPDATE wait and natural delegated Close expiry returns
  403 `FORBIDDEN`; task changes roll back.
- Status after cleanup-table SELECT wait and natural login expiry preserves
  entry-only 200, while a new expired-cookie request is 401 and live-cookie
  control is 200.
- Common change waiting for the original users SHARE lock sees a committed
  admin demotion and returns 403 `FORBIDDEN`; only the holder's role write changes.
- Retry's independent transaction has the same current-role admission boundary.

Each edge requires one unchanged exact UTC-microsecond expiry where applicable,
the same unique holder/blocked PID and backend-start relationship before
release, qualified actual SQL, live independent clock replies where applicable,
full uncapped private row snapshots, and positive owned child/socket cleanup.
The close-clock future cleanup task and closed/closing setup are synthetic
barriers. The empty playback/jobs setup is not HLS/job cancellation or physical
drain coverage. Retry must actually wait on UPDATE; observing an INSERT wait
does not pass that case. Preserve any original qualification failure unchanged.

## Non-runtime gates and remaining limits

Run `node --test tests/room-lifecycle-snapshot.test.mjs` on both versions.
Run Node syntax checks, the existing backend/owner source-contract tests, the
candidate lifecycle source-contract file, rustfmt, central compiler/Clippy and
Server/workspace tests as supported. Source contracts only inspect code; they
do not substitute for the database checklist. No browser, provider account,
Windows device, remote CI, soak, unknown-commit transport, or physical HLS owner
acceptance is implied by this extraction. Raw rows, HTTP bodies, SQL witnesses,
clock frames, and exception details stay in private local evidence. The CI
upload allowlist is unchanged.
