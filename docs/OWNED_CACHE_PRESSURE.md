# Owned cache-pressure operation

This lane supplies a concrete `cache-evict` operation for a newly owned native fixture. It does not change production cache logic or wire the existing standard soak scheduler, whose current preflight remains fail-closed. It is not F3, a final-image run, HTTP delivery/backpressure, or 72-hour acceptance.

## Real lifecycle and scope

- `apps/media-worker/examples/owned_cache_pressure.rs` includes the unchanged Worker cache, process, output-validation, first-fragment decode, and snapshot-builder implementations. Its minimal `App` contains only the owned PostgreSQL pool and cache root; it does not start a Server/Worker HTTP service or Agent
- Four small two-second, 160×90 FFmpeg HLS outputs are created under production job/attempt claims and write reservations. Structural/hash validation and the production first-fragment decoder precede snapshot publication. Actual encoder/validation tree drain precedes the matching positive execution receipt and reservation release
- A production `acquire_attempt` read lease is acquired before opening a verified segment handle. Its session is then stopped so the read lease, rather than the active-session predicate, pins the directory. The measured experiment completes within that existing lease and verifies it is still live. This is an API lease plus an actual open-file reader, **not an HTTP backpressure or renewal test**
- A separate, realtime FFmpeg encoder writes actual HLS files in its claimed output attempt. During the bounded experiment its session is cancelled and scheduling lease expired while its independent process owner keeps the encoder alive. Eviction and explicit reservation release must remain blocked. Output-byte growth and a live process observation demonstrate it remains a writer after pressure
- Low `CACHE_MAX_BYTES` values are confined to fresh sweep subprocess environments. Every sweep calls production `ensure_capacity`, which measures actual cache bytes and performs fenced, typed-UUID eviction. The production 10% disk-headroom rule is unchanged; neither disk filling nor permission/mount/network changes are performed
- Closing the owned encoder tree, positively draining its process scope, and releasing the reader handle/lease makes those known outputs eligible. A final production sweep must reach zero measured bytes
- A separately labeled fresh-fixture ledger fault removes a receipt, then the job row, leaving a 65,536-byte unknown reservation. No acknowledgement is invented. Missing-receipt and orphan-reservation eviction remain blocked, a new reservation is refused by effective budget accounting, and a one-byte application quota produces `cache_capacity_exceeded` while the unknown file stays present. This is not legacy recovery

Null-room non-v2 fixture jobs intentionally use the existing compatibility path. No renewal, v2 pruning, or legacy cleanup predicate is changed. These claims are not fabricated HTTP viewer or historical process receipts.

## Driver and source binding

`scripts/acceptance-cache-pressure.mjs` exposes `withOwnedCachePressure(config, callback)`. Its returned adapter implements the event-shaped `perform({run_id, owned_resource_ids, kind:'cache-evict'})` contract. Each instance owns one full bounded cycle and its PostgreSQL cluster/cache; create a new instance for another cycle. Caller-selected database URLs, external origins, cache roots, credentials, arbitrary operation callbacks, and arbitrary executable names are not accepted as driver configuration.

The adapter checks exact run/resource population, successful frozen backend and helper descriptors, every recorded source hash, and binary hashes before and after work. It verifies helper close/PID absence, production process-scope cleanup, native PostgreSQL PID/port shutdown, and final source/binary stability. Each sweep has a unique retained evidence file. Failed runs remain separate private reports with `accepted=false` and `release_ready=false`.

The build-only entry point copies the completed-build example into a new evidence directory and binds it to source hashes and build output. Its mutable Cargo target must first be granted by the coordinator; **never use a frozen directory as a Cargo target**. Touch/refresh this worktree's Rust/Cargo inputs before switching a shared mutable target across worktrees.

```sh
source /absolute/path/to/tooling/env.sh
export CARGO_TARGET_DIR=/absolute/path/to/coordinator-granted/mutable-target
export CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export RAINSYNC_OWNED_SOAK_BINDING=/absolute/path/to/frozen/backend-binding.json
node scripts/bind-owned-cache-helper.mjs
```

Use the returned `helper-binding.json` path for a run. The run never builds:

```sh
export RAINSYNC_OWNED_CACHE_HELPER=/absolute/path/to/helper-binding.json
node --test tests/acceptance-cache-pressure.test.mjs
node tests/cache-pressure-native.mjs
```

PostgreSQL must be configured as native via `RAINSYNC_NATIVE_POSTGRES_BIN`. Helper execution has a 60-second abort signal, with independent teardown still awaited. Each fixture has its own 120-second abort signal; optional negative cases are separate fixtures, not part of a single 120-second total harness window. Cancellation uses the helper's signal-aware production process-owner drain before its own close; forced or unconfirmed cleanup cannot produce a passing report. Newly created fixture artifacts use a private umask and disposable credentials are redacted from driver diagnostics.

## Initial local evidence (2026-10-02)

Report `7a568111-4eeb-48ce-9467-f99539323636` passed under the exact copied helper/source binding:

- 125,009 measured bytes exceeded the 106,911-byte application quota
- Production sweeps deleted eligible inactive outputs and reduced measured bytes to 97,131, then 83,822 while the active lease/open-file reader survived unchanged
- The actual cancelled/expired-lease FFmpeg writer grew from 13,497 to 28,066 bytes, retained its full 65,536-byte reservation, and stayed alive after the pressure sweeps
- Positive owned-process drain preceded the writer receipt; released known output directories then evicted to zero measured bytes
- Missing-receipt/job and effective-reservation negatives stayed fail-closed; native helper/process-scope and PostgreSQL cleanup and final source/binary verification were confirmed
- Disk headroom remained approximately 14.7%, above the production 10% rule

Private reports live under `$RAINSYNC_ARTIFACT_DIR/cache-pressure/<run-id>/report.json`; the copied helper and build binding are under `cache-pressure-build/<build-id>/`. These bounded observations do not establish final-image identity, sustained resource trends, full capacity, HTTP-reader renewal/backpressure, F1–F3, scheduler integration, or uninterrupted 72 hours.

## Final review and bounded regression

Implementation commit `5449f717bcb1d3c601e2dda95ae399fd3c64b250` received independent local source/evidence review. The final copied helper binding is build `f4b042d4-07ee-42d8-9094-f7ec0e7a0029`; all 225 helper source hashes, the unchanged frozen backend sources, and binary hashes were verified. Reviewed corrections add post-sweep writer liveness, fresh non-symlink ownership boundaries, strict integer-byte/effective-reservation validation, atomic phase-witness publication, and ownership of the exact in-flight operation Promise through teardown.

Final exact-source reports:

- `124cabee-2c32-4d6d-968d-2cb193da817d`: happy cycle passed, again observing 125,009 bytes against 106,911 quota, successive 97,131/83,822-byte cache plateaus, unchanged lease/open-handle reader content, actual writer growth 13,497→28,066 bytes with 65,536 reservation bytes, and zero known cache bytes after positive drain/release
- `2739aec7-706a-4cac-9d67-5e78fc295276`: deterministic lifetime abort after an actual `writer-live` witness failed as intended, preserved the original cancellation error, positively drained owned process trees/helper/PostgreSQL, and left the unfinished execution receipt unresolved
- `55081e01-b1b7-47bc-bba7-cc7995a95e13`: callback deliberately left `perform` unattended and threw after the actual writer witness. The factory preserved that exact error, cancelled and drained the tracked operation before PostgreSQL teardown, and left the unfinished writer receipt unresolved; no unhandled rejection or passing acceptance was substituted

All three reports retained final binding verification and confirmed cleanup. Earlier reports/builds remain retained for their exact earlier source hashes. The final check set passed 20 Node contract tests, syntax checks for the new scripts/harness, `cargo fmt --all --check`, and `cargo clippy --locked -p rainsync-media-worker --example owned_cache_pressure -j1 -- -D warnings`. The existing nonfatal ts-rs `non_null_audio_rate_reports` message remained; the final helper had no new compiler diagnostics. This is not a full-workspace, CI, Windows runtime, browser, image, full-fault-matrix, or release test.

To repeat both failure-cleanup cases in addition to the happy cycle:

```sh
RAINSYNC_OWNED_CACHE_NEGATIVE=1 node tests/cache-pressure-native.mjs
```

The negative cases never fabricate acknowledgements for unfinished claims. Disk headroom stayed above the unchanged production 10% gate throughout the final runs. Standard scheduler wiring and the previously listed formal acceptance gates remain open.
