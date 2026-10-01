# Committed job-transition observations

This bounded NEXT_PLAN §12.1 slice adds process-local observations to the
existing administrator metrics. It does not add routes, credentials, schema
columns, retry rules, cancellation reasons or cleanup authority. Production
wiring and finite transaction/API checks are complete locally; publication and
exact-head remote CI remain separate. This is not long-running acceptance.

## Definitions

Each Server and Worker process exposes a fixed set of series:

- `rainsync_media_job_retry_schedules_total{process,reason}` counts acknowledged
  transitions back to queued. Reasons are only `upstream_transport`,
  `worker_shutdown` and `lease_expired`. It counts a scheduled retry, not a
  subsequently started or successful attempt.
- `rainsync_media_job_cancellations_total{process}` counts queued/running rows
  actually changed to cancelled. Repeated Stop or cancellation requests do not
  add events after the first transition. No inferred cancellation reason label
  is attached to reconciliation of a previously stopped or expired session.
- `rainsync_media_job_lease_expiry_normalizations_total{process,result}` counts
  expired running rows actually normalized to requeued or exhausted. A queued
  row already at its attempt limit is not a new lease-expiry event. Cancellation
  retains precedence over expiry retry, matching existing production behavior.

`process` is limited to `server` or `worker`; no room, user, URL, token, source,
job or attempt identifier becomes a label. Logical cancellation or expiry does
not prove that a child process, file handle or remote transfer has been drained.
Existing execution owners and durable release receipts retain that job.

## Commit boundaries and coverage

Explicit transactions accumulate a fixed, non-cloneable pending delta. A guard
is armed immediately before awaiting commit and the delta is published only
after success. Ordinary rollback discards the delta. A cancelled or ambiguous
commit wait marks a possible observation gap without guessing committed rows.
Standalone normalization writes use the same acknowledgement boundary, with a
guard that knows no row count until the write has returned successfully.

Claim normalization already uses separate autocommitted writes. Each confirmed
write publishes its own delta before continuing; a later claim/output failure
cannot erase earlier committed observations. Exhausted-row normalization uses
a row-locked SQL aggregate to distinguish previous running state without
returning an unbounded collection. Finish and shutdown release observe the
actual resulting status after their entire existing transaction commits.

Server producers cover interrupted/obsolete viewer preparations, cancellation
by request key, explicit Stop, continuation parent retirement, room lifecycle,
source-policy retirement and upstream account-policy retirement. Control
commits in persistence also observe old-generation job cancellation. Paths
that only retire sessions are observed when the existing scheduler actually
changes the job row, rather than inventing an earlier job event.

## Availability and limits

Storage is six checked integer counters and a sticky quality flag, independent
of body-stream metrics. Publication and snapshots use a nonblocking lock;
neither waits for another producer or an administrator scrape. Overflow,
poisoning, publication contention or an unresolved acknowledgement can set
`rainsync_media_job_observation_incomplete{process}`. This means a possible gap,
not evidence that a particular unobserved transaction committed.

An unavailable snapshot emits `rainsync_media_job_observation_available 0` and
omits the counters. Known empty counters are emitted as zero. Formatting occurs
after releasing the lock. No collector lock survives a database await, and an
observation failure never changes a job mutation's success or failure.

These are observations of acknowledged commits, not durable global totals.
They reset at process restart; a crash between database commit and observation
can lose events without leaving a surviving local quality flag. A monitoring
consumer must handle counter resets and retain process identity externally.
No exact global total, once-only external delivery, process runtime or network
delivery acknowledgement is claimed.

Current task inventory, oldest queued creation age and cache observations keep
their separate definitions in [task health](TASK_HEALTH_OBSERVATIONS.md).
Per-attempt queue/run durations now have a separate [versioned phase contract](JOB_TIMING_CONTRACT.md):
neither creation age nor drain-receipt timestamps are substituted for those durations.


## Bounded evidence (2026-10-01 UTC)

The final build binds 194 backend inputs, source digest
`8780c586d2ebc411d825d1c86dd1bf47bdb812484c6317865c589a3c14623753`,
and the three production services plus the separate persistence test driver.
Binding SHA256 is
`fdb77cd7437fcc7a7b2d2411774481a6a246bad6a14188d60b6fa26bac3bae29`.
Strict workspace Clippy, formatting, the frozen workspace binary/example build
and all 22 collector/guard tests passed. The unchanged HTTP frontend retains
its own 457-test result; it is not counted again as new event-metric evidence.

`tests/job-health-events.mjs` passed 13 finite groups against real owned
PostgreSQL, Server and Worker. One group includes 17 checks calling production
persistence methods: duplicate/stale finish and release, actual rollback after
an output fence or constraint failure, concurrent expiry normalization, queued
exhaustion distinction, cancellation precedence, an acknowledged normalization
prefix before a later claim failure, and dropped acknowledgement without guessed
credit. The helper is a separate process; its rendered counters are not claimed
as Worker endpoint evidence.

The API groups exercise Stop and a foreign owner, cancellation keys including
cancel-before-prepare, viewer replacement and replay, real WebSocket media
change/end and command replay, room closing, quota rollback and cleanup that
commits before an error response. Actual Worker requests exercise transient
transport retry, expiry normalization, exhaustion and process-restart resets.
Source-policy, upstream-policy and continuation cancellation hooks were reviewed
in source; this fixture does not claim to have rerun those three API matrices.

The full report `a0e1cca2-5f14-4621-bea2-735be0384c13` has SHA256
`893636f18d986072d3f6ce9a636971e13a6605e0553380619f5da57c666efd41`.
It verifies frozen inputs/executables before and after and positive closure of
owned services, the helper, PostgreSQL and ports. Its original positive child
PID witness identifies a direct Worker child, not an exact job identity; the
job's durable execution receipt is checked separately. A focused follow-up
passed exactly one check requiring the current job UUID as a command-line path
component and a request at the controlled HTTP source before cancellation. It
observed that PID disappear and the separate durable receipt complete; no raw
command line or token was retained. Report `fb7f2705-773a-4b08-96d9-9884236a0636`
has SHA256 `5a78fc3b92cee1914272b33657f8c5fce95603ed0255f4a4b4d511a11ee67f7b`. This refinement uses the same frozen
backend and is separate evidence, not a relabeling or rerun of the original
13 groups.
