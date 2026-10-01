# Per-attempt job timing observations

This is the bounded continuation of NEXT_PLAN §12.1. It measures logical queue
and running phases, not FFmpeg CPU time, operating-system lifetime or delivery.
It adds no authority, route, retry rule or historical timing reconstruction.

Migration 0039 adds nullable `timing_version`, `timing_attempt`,
`queue_entered_at` and `run_started_at`, with no defaults or backfill. All-null
means unknown. Version 1 requires a nonnegative attempt tag and exactly one
finite phase-entry timestamp. The database shape constraint deliberately does
not equate these fields with scheduling status or attempt: older writers may
still mutate those fields without knowing this observation contract.

Every producer validates the locked pre-transition row. Queue timing requires
old status queued, version 1, matching old attempt, queue timestamp only and a
finite nonnegative elapsed duration. Running timing analogously requires old
status running and the run timestamp only. An equal-attempt old-writer requeue
leaves a stale run tuple; it produces a missing queue sample, never a run sample.
All new phase entries replace the entire four-field tuple. A new claim starts
known run timing even when the preceding queue timing was unknown.

Use the PostgreSQL authority clock after the required row locks. Queue time
includes retry backoff and scheduling/lock wait. Running time extends from the
successful claim mutation until the logical terminal/requeue normalization;
lease-expiry normalization can include detection delay. Validation or cleanup
that happens before this logical mutation is included; later commit
acknowledgement or subsequent physical drainage does not extend the sample.
Shutdown release already follows child reap, whereas explicit cancellation can
precede it. Neither interval is presented as pure process runtime.
Wall-clock rollback and invalid timestamps produce missing samples. This does
not promise monotonic elapsed time across arbitrary database clock changes.

All observations remain owned by `PendingJobHealth` and its existing commit
guard. Rollback publishes nothing, unknown acknowledgements do not guess, and
collection is fixed-size/nonblocking. Success includes complete
`media_outputs::publish`; partial output publication is not a terminal event.
Bulk mutations must aggregate in SQL and return bounded summaries, never a
backlog-sized vector. Capturing only the new cancelled status is insufficient
to distinguish old queue/run phases safely.

## Shared aggregate interface

`media_core::job_health` exports:

- `TimingKind`: QueueStarted, QueueFailed, QueueCancelled, RunSucceeded,
  RunFailed, RunCancelled, RunRetry
- `TIMING_BUCKET_SECONDS: [f64; 12]`: 0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120,
  600, 3600, 21600, 86400; known count supplies the +Inf bucket
- `TimingAggregate::new(total: u64, known: u64, sum_seconds: f64,
  buckets: [u64; 12]) -> Option<TimingAggregate>` validates known <= total,
  finite nonnegative sum, monotonic cumulative buckets <= known, and zero sum
  and buckets when known is zero
- `PendingJobHealth::timing(kind, aggregate)` merges a fixed summary into the
  same acknowledged-commit observation as the existing six event counters
- `PendingJobHealth::mark_incomplete()` records malformed/undecodable internal
  aggregate evidence only in the pending observation; it does not fail the
  business mutation or set a global flag for an ordinary rollback

The fixed histogram families are `rainsync_media_job_queue_duration_seconds`
with outcomes started/failed/cancelled and
`rainsync_media_job_run_duration_seconds` with outcomes
succeeded/failed/cancelled/retry. Unknown duration observations are counted as
`rainsync_media_job_timing_unknown_total{process,phase,outcome}` using
`total - known`; they never become zero durations. `process` remains only
server/worker. No source, job, session, room, user or URL is a label.

The existing observation availability/possible-gap indicators also cover these
fixed summaries. Unknown legacy timings are intentional missing samples,
distinct from publication contention/overflow or ambiguous commit evidence.
Process restart resets these observations; they are not durable global totals.

## Essential verification

Use fresh and through-0038 isolated database upgrades, preserving old rows and
historical checksums; reject malformed timing tuples and verify transaction
rollback. Actual mutation checks must cover lock wait, old writer phase/attempt
mismatch, complete versus partial publication, retry and cancellation, stale
owners, duplicate calls, independent normalization prefixes, and rollback.
Maintain current authorization predicates and independent physical drain proof.
Device and long-duration acceptance are separate from this implementation.


## Current evidence boundary

Migration 0039 passed 13 checks on owned PostgreSQL 17.11 databases, including
21 malformed tuple rejections, through-0038 upgrade preservation, rollback,
old-writer phase/attempt compatibility and a fresh through-0039 install. Earlier
migration bytes and SHA-384 ledger values were checked without rewriting them.
Report `9342556d-ae2e-41c6-8b81-4d045cf4ef00` has SHA256
`ee4f0cd7781991b4867e37a2c2fce26e617bdbd7ca6893491023261b44b89872`;
0039 itself has SHA256
`7dcb25d6961089ed355f73a1cde65a00ae19c712b4e2706696b60cbc1cb6d4a3`.
Both generated database processes and ports were positively closed. This does
not prove production old-database migration or runtime timing producers.

The pure collector passed 39 focused checks using the actual two source modules
and a minimal process-label stub, compiled with warnings denied. The tests cover
fixed series, unknown durations, overflow/merge atomicity, guard ownership,
contention, reset and concurrent publication. The same 39 checks also passed in the actual workspace crate. Workspace
formatting, strict Clippy and a serial frozen build of binaries/examples passed.


The final runtime report `7481081b-a17d-4c3f-9cf6-51a1fc0e859a` passed eight
finite groups, including one group with 40 actual PostgreSQL producer checks.
Its SHA256 is
`9ebd7f255637260b5d3b9172bd71f1591c6b6efdcf466a9ca3d6bf6bc99dac06`;
the nested helper report SHA256 is
`f8fa96de58da9f3cf5c029bc334f5b051486c263faa97c3a3d2b338e5c462962`.
The two counts are nested, not 48 separate API groups.

The build binds 199 inputs, all three services and three test helpers, with
source digest
`e2d962062a1971ec2fea6c14ad717bfa8198351c9fea7139ebe241f4de74ad03`
and binding SHA256
`a63cebcc06dfa3f883ecc7ea00765239493fb21253345f47ad6553bcb507bad3`.
Those inputs and executables matched before and after the run. All owned
Server, Worker, helper and PostgreSQL processes exited, listeners closed, and
PostgreSQL returned pg_ctl status 3; generated database evidence was retained.

The helper invokes production enqueue/claim/finish/release/cancellation and
output publication. It covers mixed writers, current ownership and all scopes,
96-row fixed aggregates, clocks after advisory/job/output/second-row lock waits,
final expiry checks, partial versus complete publication, rollback/replay/stale
owners and unknown acknowledgement without guessed samples. SQL seeds or faults
are explicitly synthetic; the helper's process-labelled renderer is separate
from actual Server/Worker endpoint evidence. The endpoint groups verify admin
authorization, known and unknown queue cancellation, actual Worker retry and
expiry transitions, and restart resets. They do not claim an actual successful
FFmpeg playback run: complete publication timing is proven at the production
persistence entry point with owned synthetic proofs.

An earlier run passed 34 helper checks and then correctly failed a fixture that
assigned room identity after insertion. The fixture now sets immutable scope
when inserting. The failed report and cleanup remain preserved; no production
constraint was removed. Exact-head remote CI and physical/long-duration
acceptance remain separate from these finite local results.


The final timing backend also passed the five actual claim/HTTP Stop overlap
cases after adapting the fixture's query identification to the new closed-scope
cancellation CTE. The assertion still requires the exact claim PID to block
the authenticated owned-session Stop. Report
`069d445a-16f8-4eb6-ab87-7abef05c5c7f` has SHA256
`5ffc105381c3dfe2d28c2c682ab1da81376eac77fb3979762b6e03a196d9b732`. The first query-prefix-only fixture timeout and
its verified cleanup were retained; no production lock or deadline was relaxed.
