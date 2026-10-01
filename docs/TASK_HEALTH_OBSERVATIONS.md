# Task-health observations

This bounded NEXT_PLAN §12.1 slice exposes current job, process-owner and cache
observations through the existing administrator-only metrics endpoints. It adds
no route, migration, credential, job transition or cleanup authority.

## Server job inventory

`/api/v1/metrics` reports `rainsync_media_jobs` with the fixed states queued,
running, succeeded, failed, cancelled and other. It counts persisted rows; it is
not a count of active processes or cumulative transitions. The existing
`rainsync_media_jobs_queued` remains the same queued count.

`rainsync_media_jobs_expired_running` counts running rows whose recorded lease
has passed at one database-clock sample. Missing leases have their own
`rainsync_media_jobs_missing_running_lease` gauge. Neither observation changes
job ownership or declares resources released.

`rainsync_media_jobs_oldest_queued_age_seconds` measures the age of the oldest
queued row's creation. It is not per-attempt queue waiting time: `available_at`
is retry eligibility, and a retried row retains its original creation time.
Empty queues and invalid, nonfinite or future creation timestamps emit
`rainsync_media_jobs_oldest_queued_age_available 0` and omit the age sample.
A known age of zero remains a valid sample.

The existing 16 concurrent scrape permits, three-second overall deadline,
one-second statement timeout and half-second lock timeout bound observation.
Cancellation closes the owned database connection rather than stranding a pool
slot. The exact login's expiry and current administrator role are checked again
after inventory queries and the room-map wait, under the original deadline.
No connection is held while waiting for the room map. A busy or unavailable
backend returns the existing unavailable response instead of invented counts.

## Process-owner registry

Server and Worker each expose four fixed `process`-labelled gauges:

- `rainsync_process_owner_observation_available`
- `rainsync_owned_process_tree_owners`
- `rainsync_process_admission_closed`
- `rainsync_process_cleanup_failed`

The read uses a nonblocking snapshot of the existing process-tree registry.
Contention or poisoned state emits availability zero and omits the other
samples. Registered owners are not all OS descendants; zero owners does not
prove physical drainage, and a retained cleanup failure stays visible even
when the owner count is zero. Spawning, shutdown, disposal and drain receipts
retain their existing behavior.

## Worker cache inventory

Worker `/metrics` reuses completed scans from the existing readiness monitor.
It adds no per-scrape filesystem traversal or extra polling task. Successful
scans count regular file entries and their logical lengths. Hard-linked entries
count separately; directories, symlinks and special files do not add file or
byte counts. This differs intentionally from the existing conservative quota
accounting, which is unchanged. The scan is not an atomic filesystem snapshot
and does not strengthen existing traversal race guarantees.

`rainsync_cache_inventory_available{process="worker"}` is always present.
`rainsync_cache_regular_files`, `rainsync_cache_logical_bytes` and
`rainsync_cache_inventory_age_seconds` appear only with known fresh evidence.
A failed, partial, stale, future-dated or unavailable scan omits those samples;
a successful empty scan can report zero. Completion time is recorded inside
the blocking scan owner. The age includes any delay before async publication,
and evidence older than six seconds is unavailable. Existing readiness's own
publication-time semantics are unchanged.

Existing scan bounds remain: one second of traversal, 100,000 entries, depth
64, two-second async wait and positive disposal before another scan. The
existing ten-percent free-space reserve remains an admission rule, not a
metric threshold that this change weakens.

## Evidence and limits

`tests/task-health-observations.mjs` runs finite real Server/Worker/PostgreSQL
checks against a frozen backend binding. Its job rows are synthetic persisted
inventory, with Worker stopped while they are seeded; they do not prove actual
execution transitions. It checks current authentication after contended
queries, observed pool-capacity reuse while a lock stays held, real cache
entries and recovery, and registered owners during a real tool-version probe.
The existing runtime metrics fixture separately keeps its byte, outcome,
histogram and actual cache-decision assertions. Only the four new inventory
names are excluded from that older collector's selector.

Exact final report identities and results are recorded in VALIDATION.md.
The separate [committed event observations](JOB_HEALTH_EVENTS.md) now cover
retry schedules, cancellations and lease-expiry normalization. Per-attempt queue/run duration
histograms are now implemented with [versioned logical phase evidence](JOB_TIMING_CONTRACT.md);
they do not reinterpret this inventory or its oldest creation-age gauge. These finite observations
do not close device, filesystem, sustained-load or long-running acceptance.
