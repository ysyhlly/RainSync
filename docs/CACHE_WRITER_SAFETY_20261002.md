# Cache writer safety: bounded §7.4 / §10 correction

The scheduling lease fences publication, but is not process-exit evidence. Before this correction, whole-entry eviction checked only a running job with a live lease. A stopped session with a cancelled, still-running writer therefore passed that gate. Reservation snapshots also reclaimed expired/changed owners, and obsolete-attempt cleanup could delete a fenced writer's private directory before it exited.

## One existing durable boundary

No schema or historical-release policy is added. Cache operations reuse `media_executions.reaped_at`, matched to job, attempt, and the recorded owner when present. The production Worker writes this receipt only after its owned encoder, validation children, and execution scope drain. Database scheduling status, lease expiry, a replacement attempt, or a missing receipt never substitutes for that fact.

- Whole-entry eviction retains active-session and live-reader gates and protects every unresolved recorded writer attempt. A short job-row lock orders its check after an in-flight claim commits its execution record
- Obsolete-output candidate selection and admission both require the matching positive receipt; scoped and unscoped reader protections remain in force
- Budget snapshot and explicit release remove only positively reaped reservations. The single reservation slot per job cannot be overwritten by another owner/attempt while unresolved; a reaped or untracked attempt cannot reserve anew
- Positive job receipts are retained while cache deletion or budget release can still need them. Existing age-based pruning resumes only after whole-entry eviction and reservation removal; delivery-receipt retention is unchanged

A receipt is not fabricated for incomplete legacy bookkeeping. A recorded job/output/reservation attempt without a matching receipt, including an orphaned reservation, fails closed. Unknown reservations can therefore consume quota and prevent new attempts indefinitely. These cases need trustworthy owner/process evidence; an administrator assertion, elapsed time, or a fabricated receipt is not a recovery mechanism. Existing attempts and migration-provided evidence keep their established meaning.

## Focused regression

Run from the repository root with its Rust toolchain and supported PostgreSQL fixture configured:

```sh
RAINSYNC_ARTIFACT_DIR=/absolute/external/evidence node tests/cache-writer-safety.mjs
```

The runner creates a new PostgreSQL cluster/database and records hashes of sources and the exact copied example executables, command output, PostgreSQL identity, and verified cluster shutdown. No existing database URL is accepted by the runner. The dedicated regression starts a self-owned local file-writer child. It observes the former SQL predicate admitting cancellation while that child is alive, then checks the corrected API refuses eviction. Only a successful child wait precedes the positive receipt.

Coverage:

- Active, cancelled, expired-lease and obsolete-attempt writer protection
- Owner/attempt fencing, receipt-only budget release and refusal to overwrite an old reservation
- Matching positive reaping permits cleanup; current and legacy read-lease fencing remains covered by the existing examples
- Positive receipt retention before eviction and ordinary pruning afterward
- Missing old receipts and missing jobs retain unknown obligations rather than clearing them

The runner also executes `verify_cache_budget`, `verify_cache_leases`, and `verify_output_cleanup`. The database-only examples explicitly start no media process; their positive acknowledgements mark completion of fixture claims, not historical or external process proof. Unknown-row fixtures remain in the discarded isolated database for inspection.

## Evidence and limits

Executed on 2026-10-02 in the Linux x86_64 task workspace with Rust 1.98.1 and native PostgreSQL 17.11. Run `cache_writer_43988dcac71247fda3c1c876aa233b79` passed all four examples; its report records the `47f9813` base, exact source and copied-binary hashes, and confirmed PostgreSQL process/port shutdown. Evidence is retained in the task's external `cache-writer-safety` artifact directory.

Also passed `cargo fmt --all --check`, `node --check tests/cache-writer-safety.mjs`, `cargo clippy -p persistence --all-targets --locked -j1 -- -D warnings`, and `cargo test -p persistence --locked -j1` (4 tests). The existing nonfatal ts-rs message about `non_null_audio_rate_reports` was present; no new Clippy diagnostics occurred. Full workspace, service/Agent, migration-upgrade, and CI suites were not run for this lane.

This is local cache admission/accounting verification with a small owned writer, not an actual FFmpeg cancellation/validation test, a real full/read-only volume test, a resource-leak claim, an upgrade/rollback drill, a 72-hour run, or CI/release acceptance. No Agent transport or previously denied reproduction is exercised.
