# Owned PostgreSQL process probe: source-only proposal

This is design review, not runtime authorization or implementation. Baseline:
`2d3a8ebe3a9da0f8ad054099606ef7b7e21c6df9`; controller source is the unchanged
`7119036e415eb152bd573c7175bbfbe40456e791`, cherry-picked as `dd5bb0e`.
The independently checked single-child stop manifest has SHA256
`93ae7e2e6c7c7a13d09259e78040c304473c3f361ee4b345e8a58d730438d141`.
It proves that run's original-child file-RPC stop and resource exit gate only.
It proves no PostgreSQL tree, resume, natural-exit or lost-client deadline.

No PG binary, service, signal, live process inspection or old-scope control was
run during this design. Old F2 `15e2d8bb-b544-4985-9b72-c69dd5598d81` and the
older failed HLS scope remain unresolved. Known old TCP ports 33535 and 33637
are sealed; the unknown old Server port is not inferred. The finished fixed
child experiment is not extended or rerun. No tracing, cgroups, namespaces,
security changes, Server/Worker/F1/F2 integration or general controller is
proposed.

## Source comparison and the next boundary

- `tests/fixtures/postgres.mjs:237` synchronously runs initdb, then directly
  spawns foreground postgres at line 280. Node retains its child object and
  close callback. `stop()` at line 397 signals its numeric child and waits for
  callbacks; `verifyStopped()` at line 126 uses PID absence, pg_ctl status and
  a TCP connection refusal. These are existing fixture checks, not exhaustive
  lifetime closure or an independent cleanup owner
- In reviewed checkout 7119036, `scripts/owned-native-faults.mjs:492`
  `processTree()` preserves snapshot start/ancestry; `pauseOwnedDatabase()` at
  line 622 stops root before children; `restoreOwnedDatabaseProcesses()` at
  line 596 attempts children sequentially and root last despite failure.
  `continuedExact()` at line 573 cannot discharge an exit-after-SIGCONT race.
  `owned-process-identity.py:276` `signal_exact()` opens/closes a new pin for
  each call. Neither this per-call helper nor Node-owned lifecycle is the new
  lifetime owner
- `FixtureOwner._admit()` at `owned-fixture-owner.py:241` accepts exactly one
  original direct root and a fixed ledger. `_observe()` at line 314 already
  distinguishes exit, closure and suspension discharge. `_restore_step()` at
  line 534 preserves child-before-root attempts; `tick()` at line 678 checks
  lease expiry before a later backend heartbeat. It has no admission path for
  later births or separate bootstrap roots. Normal standalone restore dispatch
  creates no phase deadline until stop starts; its PG bound needs explicit work
- The fixed kernel adapter's `spawn_fixed()`/`capture()` and
  `KernelBackend.observe()` rely on an immutable no-exec child. Its
  `ProbeContext.initialize()` creates the actor after spawn/capture. Its
  failure observation can wait for the child's six-second self-expiry. None
  of those lifetime assumptions transfers to initdb or postgres

Use one new foreground Python context that directly creates initdb and later
the postmaster. Retain each original Popen, partial-construction handle,
waitpid obligation and original pidfd in that same context. Do not use pg_ctl
start/stop or import postmaster.pid as authority. Keep bootstrap resources
separate from the actor's single PG root. Do not launch the postmaster until
bootstrap disposition meets its separately reviewed closure proof.

The context must exist before the first spawn attempt and own setup deadlines
independently of Node, SQL, stdio and the client. Failed capture never grants
signal authority. No self-expiry of an unadmitted PG process is assumed;
unknown startup resources keep this original foreground context pending.

## Two possible coverage proofs, kept distinct

**A. Exact retained lifetime evidence.** For every observed candidate, retain
its original PID/start/parent chain, one original pidfd and pre-spawn or
otherwise verified executable identity. Validate the chain before and after
admission. Exec transitions are permitted only when specifically witnessed
within that same pin/start/chain and the fixed reviewed program image set;
they do not justify opening another pin or borrowing a replacement PID.
Retain failed/unadmitted candidate records and partial pin objects.

Pause the pinned postmaster first; capture and independently pause its actual
children, then verify the frozen set. A snapshot or repeated empty scan alone
does not prove all bootstrap or later births covered. New postmaster children
after resume require newly minted admissions from the still-owned original
family, or proof B. A changed/missing ancestor cannot admit a new candidate.
Once admitted, original-pin exit may still be observed after parent exit;
ancestry loss never erases the original pin or authorizes a replacement.
Future discovery must stay within the newly owned root/recorded child lineage;
do not copy the legacy helper's broad host /proc enumeration into this probe.

The owner raw-WNOHANG-waits its original direct initdb, postmaster and any fixed
psql child. For PG children normally reaped by their live parent, closure is
their own retained-pidfd exit AND positive original-lifetime absence, with
`actual_waitpid=false`. Same-start zombies remain open. Missing /proc alone,
root exit and ECHILD alone do not close a child. If an orphan becomes a real
direct child, only its actual matched waitpid may supply direct-child closure;
no new orphan-adoption mechanism is authorized by this proposal.

**B. Trusted managed-family shutdown contract.** A separately reviewed exact
initdb/postmaster implementation could establish that a positively identified
normal successful exit after its reviewed completion/shutdown path waits for
and disposes all children that this fixed program/configuration manages.
That would cover unobserved managed births without pretending their individual
pidfds or waitpid calls were observed. A family receipt must bind the original
pin/Popen, exact binary and source/configuration, requested action, actual raw
wait status and the proved completion-path conditions. It reports its own
closure method, never fabricated per-child evidence.

The official [PostgreSQL 17 shutdown manual](https://www.postgresql.org/docs/17/server-shutdown.html)
documents fast SIGINT shutdown waiting for all server processes before the
supervisor shuts down, and warns that SIGKILL can leave subordinate processes.
The exact upstream [REL_17_11 postmaster source](https://raw.githubusercontent.com/postgres/postgres/REL_17_11/src/backend/postmaster/postmaster.c)
at lines 3064–3121 additionally supports a normal-exit candidate after tracked
backend/special-child closure, with an explicit syslogger exclusion. Require
`logging_collector=off`, positively observed normal readiness, the fixed
requested SIGINT, original raw waitpid exit 0, and no extension/external-program
configuration. Review the complete state path and package provenance before
accepting this receipt. This is positive primary support for a specific pinned
postmaster contract; it does not establish initdb's bootstrap closure or cover
arbitrary abnormal/early exit.

A distinct initdb normal-success candidate now has exact primary-source
support. The [REL_17_11 initdb source](https://raw.githubusercontent.com/postgres/postgres/REL_17_11/src/bin/initdb/initdb.c)
at lines 308–312, 1136–1171, 1508–1515, 2932–2966 and 3301–3354 uses synchronous
`system()` for configuration checks and `PG_CMD_CLOSE`/`pclose_check` for the
bootstrap and standalone initialization commands before `success=true` and
return 0. The corresponding [REL_17_11 exec helper](https://raw.githubusercontent.com/postgres/postgres/REL_17_11/src/common/exec.c)
at lines 383–405 supports reviewing the command/pipe-close path. These specific
synchronous normal-success semantics can support a managed-family receipt;
a universal kernel birth ledger is not assumed to be the only possible proof.

For root review, bind the complete fixed initdb argv, original pin/Popen and
raw original-initdb waitpid exit 0 to the exact initdb/postgres/helper images,
shipped bootstrap scripts and input files, environment, generated fixture
configuration and permitted normal-success source path. Freeze/hash the full
source-identified bootstrap input set and relevant interpreter/library
dependencies before launch; no caller-supplied scripts, custom SQL or extra
program/configuration may enter that contract. The receipt covers only those
managed initialization commands and never invents individually observed child
pidfds or waitpid statuses. It is separate from the postmaster's normal-ready
fast-shutdown receipt and from the context's file/thread/descriptor exit gate.

An initdb failure, cancellation, nonzero/unknown wait status, forced kill,
unmatched input/environment or unproved command path does not receive this
normal-success coverage. Keep its bootstrap ledger and every abnormal/unknown
object with the same original owner unless independently positively proved
closed. `--no-clean` preserves failed data; it is not child-disposal proof.

Local 17.11 manpages establish that initdb invokes a bootstrap backend and that
pg_ctl --wait checks PID-file removal. The complete source-bound family proof
is still pending. Root waitpid 0, a shutdown log line, pg_ctl status, elapsed
time or an administrative assertion cannot substitute for its conditions.
SIGKILL escalation invalidates the normal-graceful proof unless separately
covered by an actually reviewed contract.

Remaining primary evidence: applicable packaged-source patches/provenance
matching `17.11-0+deb13u1`, the complete fixed input/environment/image bindings
for the supplied initdb normal-success path, and the complete postmaster
SIGINT shutdown state path and child-launch/reap dependencies. Failure paths
remain distinct and receive no normal-success inference.
Check whether any allowed child can create an untracked descendant or escape
the invariant. Installed version headers and current hashes identify the local
toolchain but do not by themselves review these source-path conditions.
The exact upstream [REL_17_11 initialization source](https://raw.githubusercontent.com/postgres/postgres/REL_17_11/src/backend/utils/init/miscinit.c)
at lines 130–138 shows children using setsid. Therefore even an empty original
process group cannot stand in for PostgreSQL whole-tree closure.

Neither proof may waive a known unknown descriptor/thread/pin-close obligation,
an uncovered spawn or an object outside the proved managed set. Keep exact
per-object evidence wherever available. A whole-family pass requires a positive
coverage proof as well as the resource gate; failure of coverage stays pending.

## First pure slice, before any runtime adapter

Add only a pure data/event/action-plan model and proof predicates in new
`scripts/fixtures/owned-postgres-probe.py`, with
`tests/owned-postgres-probe.test.py`. Inputs are explicit modeled times, opaque
original-object references and fake observation/control events; outputs are
state/proof results and action descriptions, never executed operations. No
process/pin/thread/directory/resource constructors, backend, syscall adapter,
filesystem access, RPC client/front end, executable CLI or real-launch entry
point belong in this slice. Do not edit existing owner/RPC/kernel modules or
legacy consumers. Tests 1/2/9/10 below are event-model tests, not controller
integration or actual deadline/Node-error evidence.

Required first tests:

1. Original pin/Popen identity and same-key restore/stop replay; concurrent
   restore/stop share one action pass; closed/continued objects never re-signal
2. Issued child actions precede root. With up to 32 lifetimes and 2-second
   sequential action observations, the 6-second child phase cannot promise
   every child an issued attempt. Each remaining child gets explicit
   `not_issued: child_phase_expired`, stays unresolved/suspension-possible and
   never counts as attempted/continued. Child errors and phase exhaustion do
   not consume root's independent 6–8-second window; root is issued only if
   the modeled clock still permits it. Clock jumps beyond that window record
   `not_issued: root_phase_expired`, never invent an attempt. Standalone resume
   retains its original deadline; stop or lease expiry during resume creates
   a fresh cleanup deadline without extending the in-flight continuation or
   issuing a duplicate. Stop after unresolved resume cannot revive its expired
   pass or re-signal positively completed objects. Unknown outcomes stay unknown
3. SIGCONT followed by original-pin natural exit discharges suspension without
   inventing running-state confirmation; a zombie is not closed
4. Parent-reaped child: own exit plus original-lifetime absence succeeds with
   `actual_waitpid=false`; root-only exit, PID disappearance and ECHILD fail
5. Bootstrap root, possible shell/bootstrap children, failed Popen/capture and
   pending raw/wrapped pin handles remain independently represented
6. Observed births after the initial ledger invalidate fixed-ledger coverage;
   unseen births cannot be erased by an empty topology or process-count check
7. Fake managed-family proof binds the exact original pin/Popen objects,
   positive root-exit observation and raw matched wait status 0, complete
   source/image/bootstrap-input/environment/configuration bindings and reviewed
   normal path. Wrong/copied original objects, wrong image/config, unexplained
   error path, SIGKILL, fabricated bool/assertion-only receipt and incomplete
   coverage fail. Neither success nor failure clears an existing candidate,
   pin/FD/thread obligation or invents an individual child pin/wait status
8. Reused PID/start/ancestor, unknown IO and unwitnessed exec remain unadmitted;
   no numeric signal or reopened pin is possible
9. Model expiry is evaluated before processing control/renewal events, including
   the current owner's `_service_control()` ordering gap. Receipt time is
   created by the modeled owner when it accepts a unique sequence, not supplied
   in client timestamps. Reject future, stale, replayed or foreign receipts;
   renew once from original receipt time. Test just-before, exactly-at and
   after-expiry events, queued activity delivered late and workload expiry
   despite a lease-renewal event. At the exact boundary expiry wins. Owner ticks
   and replayed status events cannot manufacture client activity
10. Lost/crashed client and future Node error cause independent bounded cleanup;
    root attempts do not depend on a Node callback or successful reply write
11. Pin/file/directory partial-close, blocked worker, uncertain thread start,
    unsettled job and publication failure preserve each unknown resource.
    Delivery-only nonzero exit requires the full positive resource gate

The new suite performs no filesystem/process/thread/signal work. Proof B is a
contract model, not a claim about PostgreSQL or a permit for a real owner.
After implementation review, run this suite plus existing owner/RPC/kernel
regressions (whose existing local temporary-file tests remain separate). No
subprocess-based runtime test or real controller construction is in this slice.

## Future fixed fixture shape and commands

The smallest proposed first PG run is Unix-socket-only: `-h ""`, one exclusively
new private socket directory and no TCP bind/connect. Its numeric `-p` value is
only a socket filename selector. A narrow `postgres_process_probe` purpose must
allow `ports=()` and fixed database `postgres`; current `postgres_future`
requires nonempty TCP ports. Do not weaken that existing purpose. If root
requires TCP instead, defer its proposal until the unknown old Server exclusion
is sourced from permitted sealed evidence and reservation-to-PG-bind behavior
is reviewed. No port availability probe may connect to an occupant.
The Unix-only shape is design only: socket creation, bind/connect permission
and execution feasibility have not been tested or authorized. A later exact
runtime approval must cover this socket scope. If its actual OS/tool permission
or availability check fails, keep execution blocked and retain any original
resources; do not assume availability or substitute another control route.

These are proposed closed argv arrays, not commands run during review. `B` is
exactly `/workspace/scratch/8cbaa022c1e0/tooling/toolchains/postgresql-17.11/usr/lib/postgresql/17/bin`;
`SH` is that toolchain's `usr/share/postgresql/17`. `R` is the new owner-minted
32-hex run ID. For phase 1 the fixed new private root is
`/tmp/rainsync-owned-pg-probe-p1` (must previously be absent), containing
`owned-R/data`, `owned-R/socket` and `owned-R/password`. Derive `D`, `S`, `W`
only from this exclusive root; attest and retain every directory identity/fd.
Keep the socket path below the platform length bound. Later phases use their
own previously absent `p2`/`p3` roots, fresh data/nonces and a fresh owner.

- initdb: `[B/initdb, '-D', D, '-L', SH, '-U', 'owned_fixture',
  '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8',
  '--no-locale', '--no-clean', '--no-instructions', '--pwfile='+W]`
- postmaster: `[B/postgres, '-D', D, '-h', '', '-p', '55473', '-k', S,
  '-c', 'unix_socket_permissions=0700', '-c', 'logging_collector=off',
  '-c', 'shared_preload_libraries=', '-c', 'session_preload_libraries=',
  '-c', 'local_preload_libraries=', '-c', 'archive_mode=off',
  '-c', 'archive_command=', '-c', 'archive_library=', '-c', 'restore_command=',
  '-c', 'max_connections=8',
  '-c', 'max_worker_processes=0', '-c', 'max_parallel_workers=0',
  '-c', 'autovacuum=off', '-c', 'max_wal_senders=0']`
- Only a separately reviewed phase needing SQL may add `[B/psql, '-X', '-w',
  '-h', S, '-p', '55473', '-U', 'owned_fixture', '-d', 'postgres', '-At',
  '-v', 'ON_ERROR_STOP=1']`, with fixed fixture SQL and its own original
  Popen/pin/raw waitpid ledger. It does not accept arbitrary queries

Normal-ready evidence must be bound to this original postmaster and new data
directory. The owned PID-file readiness marker may be an observation only,
never spawn/signal authority; its exact source meaning still needs review.
Alternatively approve one fixed SELECT 1 readiness child with the psql argv
above, held interactive until its original pin is admitted and then supplied
only fixed input by the owner. Its own raw waitpid/pipe closure remains required.

Fixed environment: private fixture HOME, `LC_ALL=C`, the exact toolchain bin
directory plus `/usr/bin:/bin` as PATH, its package library/share locations and
only required fixed PG settings. Scrub inherited PG service/URL/options/preload
variables. Synthetic random fixture password lives in a private 0600 file and
bounded memory/environment only; never log it or a credential-bearing URL.
All data/failed artifacts remain private and retained; no real account changes.

Read-only binary hashes observed for this proposal:

| Binary | SHA256 |
| --- | --- |
| initdb | a0363354125bc00f25075bb47fc32a2838fa7668c008326227f5bc04d628ca1d |
| postgres | 6468a969338215cb3912cf9c0b894bdbbd37b9a709926db078e9a5bf8bdc3e16 |
| psql | 3c94c29652ea7ff8803ab1ca35e48c38a39c8a94a8c8eeadbb1d87c68494506c |
| pg_ctl (comparison only) | c8a0fa6df90600186575e3f3c47a352bafac73547416cf67675b41991b5b5d74 |

Before future execution, bind the reviewed owner interpreter, all source and
toolchain dependencies/configuration into a fresh immutable manifest and
reverify. Fixed CLI accepts only phase/owner/client action choices and a separate
execution guard; no caller PID, path, executable, signal, SQL or credential.
The eventual exact outer commands must be proposed at those final hashes;
this document supplies no executable runtime entry point.

## Budgets, owners and failure disposition

Proposed observational limits, starting before first spawn: image preparation
2 seconds; initdb setup 20 seconds; postmaster admission/startup 8 seconds;
total setup 30 seconds. PG workload then has an absolute 30-second lifetime;
client lease 5 seconds, fresh authenticated activity every second. Cleanup is
a separate 20 seconds; each action at most 2 seconds, report at most 1 second;
at most 32 admitted lifetimes, with excess/unknown candidates retained as
failure. No heartbeat can extend workload or setup limits.

Cleanup retains existing phase reservations: child resume through 6 seconds,
root resume through 8, root SIGINT request/observation through 12, original
child-pin force attempts through 15, root force through 17, closed-pin release
through 18 and sink through 20. SIGKILL, if separately approved for that run,
is original admitted children first and original root last; it never signals
unadmitted records. Resume is SIGCONT of owned paused processes, not data
restore. Root SIGINT does not wait indefinitely on client callbacks.
The 32-lifetime ceiling is a retention limit, not a promise of 32 sequential
resume attempts in 6 seconds. Phase-expired unissued children remain explicitly
unresolved and cannot count as attempted or continued. Root's reserved 6–8-
second window remains independent of child failures; a scheduler/OS stall that
misses it is an observational failure, not a claimed root attempt or guarantee.
Standalone restore needs its own 8-second child/root observation attempt,
preserving the 6/8-second split and the original workload/lease limits. A later
stop still receives its independent 20-second cleanup budget; it shares cached
positive resume/exit evidence and never starts a concurrent continuation.
Stop/lease loss during standalone resume retains its original continuation
action/pass deadlines and shares in-flight work; the new cleanup deadline cannot
extend or revive that pass. Stop after unresolved resume preserves its unknown
outcomes and never repeats positive completed actions. Any later explicit retry
of unresolved original objects is a distinct future design, outside this slice.

Terminal publication has 1 additional second; each retained file/setup thread
has a 0.2-second join observation, maximum three normal threads. Client waits
are 8 seconds for status/pause/restore and 22 seconds for stop including
publication, bounded by its fixed 50-second phase script.
External observation window: 90 seconds after owner command start. This is a
stop/report condition, never permission to kill an unresolved owner. OS spawn,
filesystem and scheduler stalls have no unconditional wall-time guarantee.

The original outer context owns every startup Popen/pin, direct waitpid,
candidate record, file/setup worker and file/dir handle. The actor owns the
PG operation ledger; workers only publish observations and files. Client/Node
own no cleanup authority. A bounded fresh authenticated status request can
carry client activity without changing the four RPC verbs, but only with an
actor-validated owner-created original receipt time/unique sequence,
expiry-before-control/renewal and no replay renewal; client timestamps are never
authority. Current `tick()` services controls before checking deadlines, so the
future adapter must close that ordering gap before any control can renew a lease.
Existing `DriverEvent(kind)`, control-ticket receipt metadata,
`_service_control()` and `tick()` need a reviewed receipt-time extension;
polling status internally is not a heartbeat. Startup and any paused-before-
actor admission must carry existing suspension responsibility into the ledger;
constructing a fresh default LifetimeState cannot erase a possible SIGSTOP.
Track directory construction's parent/nonce/transient handles before they are
returned as a PrivateRunDirectory, including failed creation/close. The current
create() exception/finally closes are not proof that unknown startup fds vanished.

Positive process/family disposition, actual original-root waitpid, every pin
close, all attempted threads positively joined, all jobs settled and every
directory/transient file obligation positively closed are required before
owner exit. Retain uncertain numeric fds without blind close retry. A failed
delivery after this complete gate may return nonzero, never experiment success.
Any other unknown retains the same foreground owner/control workers/fds and
reports unresolved, potentially unbounded pending root decision. Final artifact
publication precedes thread/fd closure, so the source-bound owner exit gate is
additional evidence. Preserve original primary and all secondary failures.

## Minimal stages for root to choose

1. Review and implement the first pure ledger/proof predicates only. Review
   the supplied normal-success program contracts and all image/input/environment
   bindings, adding any missing primary evidence; independently decide
   whether A, B or a justified combination covers this fixed toolchain. Until
   coverage and pre-admission ownership are reviewed, no PG runtime proposal
   is ready
2. Separately implement/review one PG-specific backend/context and purpose
   variant, with bootstrap retention, bounded dynamic admissions if needed,
   receipt-time lease handling and full all-object exit gate. Proposed affected
   owner functions: `_admit`, `_validate_observation`, `_observe`,
   `_restore_step`, `_service_control`, `tick`, plus `ControlTicket` and
   `DriverEvent` receipt fields; RPC: `PrivateRunDirectory.create`,
   `FileRPC.poll`/ticket receipt metadata. Keep kernel adapter and all legacy
   PostgreSQL/Server/Worker consumers unchanged
3. Only with separate exact approval: one fresh PG startup/status/stop run,
   including bootstrap coverage, real pinned postmaster children, fixed SIGINT,
   root raw waitpid and all-object closure. No pause or lost-client claim
4. Only after that pass and another exact approval: a fresh pause/restore/stop
   run, repeated same restore/stop keys, children observed before root, and a
   fixed fixture backend naturally exiting after SIGCONT. Exit discharges
   suspension; database health needs its own fixed SQL evidence if claimed
5. After another review/approval: fresh paused PG plus client deliberately
   exiting without stop/renewal. Owner observes lease loss, autonomously resumes
   children/root and stops/reaps within bounds. Record the expected
   `driver_lease_lost` primary error and actual renewal/expiry/action times.
   This proves that file-client-loss scenario only; a blocked Node/SQL driver
   remains a later separately scoped integration

Each stage fails on uncovered birth, identity loss, pending process/pin/thread/
fd, exceeded bound, missing original waitpid, incorrect idempotency or delivery
failure. Retain evidence, stop adding work and let only already-owned authorized
cleanup continue. No rerun, owner reconstruction, admin restore assertion,
UUID/timeout waiver or old-scope repair follows. All broad acceptance and
release flags remain false.
