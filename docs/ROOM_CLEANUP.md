# Durable room-close cleanup

Room lifecycle and media resource lifetime are separate. Closing immediately
revokes invitations, controls, playback grants and queued/running jobs in the
same transaction as `active → closing`; it also inserts one cleanup task for the
new lifecycle epoch. No transaction waits for FFmpeg or an upstream HTTP call.

## Completion evidence

The Server reconciler resumes pending tasks at startup and retries failures with
bounded backoff. It transitions only the matching `closing` epoch to `closed`,
updates the room snapshot revision, and appends a system lifecycle audit event
in one transaction. Repeated reconciliation produces no duplicate close event.

A close requires all prior-epoch obligations to have positive receipts:

- Every immutable `playback_preparations` attempt has drained. Reusing an
  idempotency key cannot erase an older outstanding executor.
- Every `media_executions` job attempt and delivery owner has acknowledged local
  process/resource disposal. A job claim registers its execution atomically.
  Cancellation, retry exhaustion and lease expiry are not disposal evidence.
- FFmpeg's process owner has reaped the entire Unix process group/subreaper tree
  or the Windows Job Object. The encoder and first-segment validator both drain
  before the Worker records an execution acknowledgement. Scoped probe/subtitle
  cancellation also waits for those owners, independently of the HTTP waiter.
  Scoped blocking file reads, open/proof work, encoder input validation and
  first-segment reads retain a disposal receipt when their waiter is cancelled.
  An uninterruptible filesystem operation keeps cleanup pending.
- A mapped NAS transfer has an Agent receipt after remote file operations drain,
  or was positively retired before dispatch. Local socket/body disposal and a
  terminal transfer status alone do not prove the remote file was closed.
- The existing `upstream_reservations` ledger is closed only on its positive
  proof: a confirmed no-call, or successful stop plus Emby encoder stop where
  required, with no uncertain outstanding I/O. Its negotiation checkpoint,
  captured playback observations, bounded/fair per-origin cleanup lanes,
  five-attempt budget and 60-second total deadline remain authoritative.
  Lifecycle epoch gating is added to reserve/activate/start/progress admission;
  no parallel upstream ledger is created. `cleanup_failed` keeps the room
  visibly `closing` and never silently resets the upstream retry budget.

Positive local execution/preparation receipts expire after 48 hours unless
their room has a pending cleanup task. Unknown receipts and legacy barriers
never age out. The upstream ledger keeps its 48-hour retention only when no
room cleanup is pending and a linked grant has its positive upstream-close
marker. Maintenance repairs that marker solely from an already-closed ledger;
a failed marker write cannot erase the last positive disposal evidence.

The final check holds the room lifecycle lock. New grants, delivery owners,
upstream starts and detached NAS offer insertion take that same admission lock,
so they either precede close and become tracked obligations, or are rejected.

## Retry and uncertainty

`GET /api/v1/rooms/{id}/lifecycle` exposes the lifecycle epoch and cleanup attempt,
last-error and completion fields to an authorized room member or administrator.
Transient upstream stop failures and database failures remain retryable.
Server restart retains both tasks and resource receipts. Reopen creates a new
active epoch and never reactivates old grants, invitations or control epochs.

A crashed or unresponsive owner without a receipt remains `closing`. In
particular, a SIGSTOPped Worker may still own FFmpeg even after its lease expires.
Resuming it allows cancellation, reaping and the durable receipt to complete.
A lost negotiation response can leave an upstream identity unknown; a lost
start/progress response may leave a remote operation in flight. These remain
observable as `upstream_operation_unconfirmed`, not guessed successful cleanup.
No numeric PID is signalled by a new process to infer recovery from PID reuse.

Ordinary Server shutdown closes upstream admission, cancels waiting permit
acquisitions, and drains actual admitted negotiation/report/cleanup owners
through their checkpoint/finish paths. Separate per-origin lanes stay intact.
The owner drain has a 45-second fail-closed bound; expiration returns an explicit
`upstream_owner_drain_unconfirmed` error and never fabricates a receipt.

A process crash after real disposal but before persisting the receipt also leaves
uncertainty. There is deliberately no timeout that fabricates that missing proof.
Do not clear these receipts or set `closed` merely because a lease has expired.

## Upgrade boundary

**Deployment gate: an unproven legacy NAS transfer still blocks every room
that could have existed before it, as `legacy_agent_drain_unconfirmed`.**
Migration `0030_legacy_nas_scope.sql` excludes only provably later rooms. This is
a limit on possible ownership, not an acknowledgement that an old source drained.
Every room already present before 0030 remains inside every pre-0030 legacy
record's range, regardless of old `completed`, `cancelled`, `failed` or active
status. These affected rooms can remain `closing` indefinitely. There is still
no operator reconciliation or force-close endpoint.

Each room has a database-assigned, immutable `rooms.cleanup_birth_ordinal`.
Each `legacy_unconfirmed` transfer has an immutable `possible_room_cutoff`.
Both INSERT paths update the same singleton `room_cleanup_birth_counter` row,
holding its transaction lock through commit. This orders room visibility and
legacy-transfer scope without relying on `created_at`, wall clocks, or a
sequence allocated before an uncommitted room becomes visible. Cleanup blocks
when `possible_room_cutoff >= cleanup_birth_ordinal`; a missing cutoff is
handled conservatively as global uncertainty. Room IDs, room birth ordinals,
playback-session room identity, the legacy flag and its cutoff cannot be edited
to move old ownership outside that range.

Migration 0029's safe `legacy_unconfirmed=true` default remains for old Workers.
A late mixed-version INSERT captures the then-current cutoff and may therefore
cover rooms that were exempt from earlier records. Only the new instrumented
Worker explicitly marks its tracked room or preview offers non-legacy. A fresh
tracked database has no such legacy barrier; a room excluded from one legacy
record still needs all its own positive disposal receipts and must be outside
all other legacy ranges.

The barrier never expires with record age, lease expiry, terminal status or a
later ordinary transfer receipt. Maintenance does not delete flagged records;
the existing database deletion guard also rejects an old Server's unaware
retention query. The 0030 scope change neither clears a flag nor invents a drain
receipt. Ordinary direct changes to the shared counter are rejected; privileged
schema/trigger changes are outside the application trust model.

Upgrade still requires stopping and draining the old Server, Worker and Agent,
then running matched components. Arbitrary old-Worker insertion after the final
room-close check is unsupported; the counter orders INSERTs, not future work
from an uncooperative old process. Stopping old components does not erase missing
proof for rooms within a legacy range. Inventory every host/container for each
Agent identity, fence old issuance and automatic restarts, retain the frozen
legacy ID set, and require positive whole-process/tree supervisor evidence or a
verified host boot generation. A new heartbeat, status, lease expiry or missing
PID is insufficient. Historical 24-hour maintenance may already have deleted
old transfer records, so no remaining rows is not proof that old owners exited.
No production installation has supplied this operational evidence here. Treat those affected rooms as a deployment
blocker until a separately reviewed, positively validated reconciliation path
exists. See the [read-only diagnostic checklist](PHASE2_LIFECYCLE_NEGOTIATION.md#2-升级门槛与无损诊断).

Migration 0029 is additive. Successful legacy terminal output is downstream of
an explicit wait and can retain that evidence. Legacy abandoned/cancelled/failed
attempts do not all have the same guarantee and remain unconfirmed. Legacy NAS
records have no room-session association or Agent close receipt; upgrades must
quiesce and verify legacy Server/Worker/Agent resources before enabling room
lifecycle traffic. An online mixed-version deployment cannot provide these new
cleanup guarantees. Historical unresolved attempts can keep an existing room
`closing` indefinitely. Merely stopping the old services does not synthesize the
missing durable acknowledgements. This implementation does not include an
operator reconciliation/force-close endpoint: recovery needs a separately,
explicitly validated reconciliation mechanism after actual resource inspection.
There is no automatic expiry or blanket positive backfill of unknown records.
This legacy recovery limit is separate from the tested restart-safe retry of
current, instrumented owners that remain alive and can report their own drain.

## Verification

`tests/room-cleanup.mjs` uses disposable PostgreSQL, the real Server/Worker,
real FFmpeg and an owned HTTP upstream. It covers stop failure and retry after
Server restart; close during negotiation; close while upstream start is in
flight; lost upstream identity; paused Worker plus expired lease/cancelled job;
process reaping; no late output publication; and old-grant rejection after
reopen. Synthetic expired NAS records also verify that missing remote receipts
are retained and cannot close the room. Scoped process/blocking-I/O unit tests
verify cancellation receipts, late-value disposal and closed admission. NAS receipt and lifecycle API tests complement this suite.

`tests/room-cleanup-migration.mjs` applies real migrations 1–28, seeds legacy
NULL owners and validated/failed/cancelled/missing-output attempts, then applies
29/30. It preserves unknown resource evidence, restart behavior, positive-only
retention and the deletion guard; causally later rooms can close while possible
earlier rooms remain blocked.

`tests/legacy-nas-scope.mjs` has passed 13 focused cases: actual 1–29→30 upgrade,
old/new room boundaries, late old-Worker insertion, both concurrent lock orders,
room/legacy transaction rollback, stale REPEATABLE READ failing with 40001,
modern tracked inserts, identity/counter tampering rejection, both old/current
retention paths, mapped positive-receipt requirements and restart. No check
clears legacy uncertainty. The final 13-script lifecycle chain and full legacy chain have also passed; bound candidate evidence is recorded in the
[current phase report](PHASE2_LIFECYCLE_NEGOTIATION.md). The related Docker
process fixture has been adapted and syntax-checked, not Docker-executed here.

`tests/upstream-graceful-shutdown.mjs` verifies a delayed negotiation beyond the
10-second HTTP grace still checkpoints its SID during SIGTERM, then cleans up
after restart; delayed Start/Progress owners persist their observation/report
acknowledgements before exit. Genuine process-death tests explicitly use SIGKILL.
