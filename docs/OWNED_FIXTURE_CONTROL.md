# Future fixture owner and control contract

This is a future-run-only source slice. Real launch is explicitly unavailable;
there is no PostgreSQL, process discovery, pidfd syscall, signal, subprocess,
SQL, network listener, credential or Node-driver adapter in these new modules.
The existing F1/F2 helpers and default DB-stop gate are unchanged by this slice.
`launch_real_fixture()` always refuses. Nothing here promotes, repairs or
operates the failed old run `15e2d8bb-b544-4985-9b72-c69dd5598d81`.

The isolated checkout starts at `b5db286904aa48406b4279a99fa57155559398b2`.
Reviewed V7 patch SHA256:
`305253335eca806cd66608177052561db04d412936f1932342e695a48ad203e7`.
That patch is a separate baseline commit:
`45d1917a10f57e957517ea95ec13feb83c509aa7`. The original checkout, failed
report and review artifacts are not modified.

## Architecture and authority

`scripts/fixtures/owned-fixture-owner.py` defines a single owner actor. Its
backend must eventually spawn the new root itself, retain the genuine original
`Popen` child/waitpid obligation, and mint each immutable lifetime admission
around an original retained pidfd. The owner consumes only backend-minted
admission objects; copying fields or importing a PID/receipt does not mint
authority. Each admission fixes run/owner identity, parent lifetime, PID/start,
executable/hash, original child handle and pin. No operation reopens a PID or
reconstructs an owner. One backend scope claim prevents a replacement owner.

All backend operations are nonblocking. `begin` issues one bounded mutation
exactly once before returning. Its token is observation-only; it cannot queue
a signal to arrive after timeout/restoration. `poll`, `observe` and driver events
are observations, with exact token/pin/child identities checked by the actor.
Signal success is not exit, health, closure or release evidence.
Late positive evidence stays truthful, while the exceeded action deadline is
retained independently and `observed_bound_satisfied=false` is reported.

The future single Python owner must run independently of Node and SQL. The
workload is a client; no Node event-loop callback, SQL wait, stdin handle or
caller timeout is a cleanup owner. The owner remains responsible through driver
work and cleanup, or explicit pending ownership. This contract does not claim
survival after the outer owner exec itself ends. Owner/control loss is sticky
unresolved, and no replacement owner may take over its resources.

Failed admission retains all startup objects as unresolved. It independently
attempts bounded cleanup only on a freshly minted and positively admitted exact
root. Unknown/unadmitted records are never signalled or silently dropped. Failed
scope attestation raises a startup error carrying the original input handles;
the launcher must preserve them and their original owner's responsibility.

## Independent deadlines and cleanup

Default workload deadline is 240 seconds from owner startup; the renewable
driver lease is 45 seconds and cannot extend the workload deadline. Lease expiry
is checked before consuming a later heartbeat. This lease leaves margin over
the legacy driver's 30-second bounded synchronous SQL, but integration must
verify actual heartbeat and operation timing. Fake tests use smaller deadlines.

Driver failure/cancellation, lease loss and explicit stop start a separate
30-second total cleanup deadline. An active pause is bounded; unstarted pauses
are interrupted as soon as restore/stop takes priority. A single restore pass
sequentially attempts children and then the root, even after a child failure.
It caches positive continuation/exit evidence. Completed lifetimes are never
reopened or re-signalled. Concurrent requests share the same in-flight pass.

Cleanup reserves monotonic phase windows instead of allowing 128 child timeouts
to consume the root's entire budget:

| Phase | Fraction of cleanup budget |
| --- | --- |
| Child restoration | 0–30% |
| Root restoration | through 40% |
| Exact original root graceful-stop request | through 60% |
| Stronger stop of pending original child pins | through 75% |
| Stronger stop of pending original root pin | through 85% |
| Release of positively closed pins | through 90% |
| Report sink observation | through 100% |

Each action also has a two-second maximum; report sink has two seconds. Expired
phase deadlines never issue a mutation. Child phase exhaustion preserves
unknown records and advances to the reserved root attempt. Scheduler stalls
past the total deadline remain unresolved rather than claiming a missed root
action happened. Unknown descendant restoration does not gate the bounded
stop of the still-owned exact root. A future real adapter should map graceful
root stop to the explicitly reviewed PostgreSQL shutdown operation and stronger
stop only to these retained admitted pins; this slice issues no real signals.

Positive retained-pidfd exit discharges suspension. Direct-root closure requires
actual waitpid status tied to the original child object. A normal descendant's
closure requires its own retained-pidfd exit plus explicit original-lifetime
absence; it reports `actual_waitpid=false`. A zombie/exit readiness alone does
not prove disappearance or release. Root waitpid never proves descendant
closure. A pin is released only after its separate positive closure evidence
and a successful bounded release result.

After an unresolved attempt the actor keeps passive observation/status alive.
Late positive exit evidence updates its ledger without fabricating an old
continuation, clearing errors, releasing a pin or ending ownership. A new
explicit restore/stop key can start one bounded pass over unresolved objects
using the same original pins; successful continuations/exits/releases are
skipped. Replaying the old key retains its original result. A lost control
channel cannot authorize a replacement/retry owner.

## Private file RPC

`scripts/fixtures/owned-fixture-rpc.py` is the file front end. It is deliberately
outside the owner tick and uses a bounded actor control queue. The future
runtime must isolate this synchronous local filesystem front end in its own
worker/thread; a stalled scan/read/fsync must not block the owner clock. No
real worker, actor-thread startup or persistence across exec handles is proven
by these tests.

Create a previously absent direct run directory and data child under a verified
private root, all mode 0700. Reject existing paths, symlinks and path components
overlapping the sealed old scope. Bind control attachment to the original run
and data-directory device/inode identities, run ID and fresh distinct owner and
client nonces.
Persistent mode-0600 exclusive nonce claims in that private root reject reuse
across fresh runs, including after failed startup. These claims are never
deleted to permit a retry.
Attaching only gives a caller file access; it has no backend, spawn, pin or
child handle. The old artifacts are not a control address.

Requests contain exactly version, run ID, owner nonce, client nonce, sequence,
idempotency key and one verb: `status`, `pause_fixture`, `restore_fixture` or
`stop_fixture`. No PID, signal, path, URL, shell, executable, credential or
caller timestamp field is accepted. Requests are at most 2 KiB; replies at most
256 KiB. At most 128 sequence slots/requests are accepted, with a bounded queue
and directory size. Exact JSON types, duplicate fields, non-finite values,
filename/payload conflicts, stale/cross-run values and conflicting keys fail.

Writes create a new mode-0600 temporary regular file exclusively, write/fsync
the complete bounded payload, and atomically link a previously absent final
name. They never replace an existing final file or follow symlinks. The short
two-link publication window is recognized only with its exact temporary alias,
deferred using a two-second monotonic deadline, then refused if it does not
finish. Accepted files have one link and exact retained inode/size/mtime/ctime
and content digest; replacement, removal or mutation becomes sticky channel
loss. Partial temporary files are never dispatched. Malformed completed files
receive a bounded rejection without echoing their untrusted content.

Every accepted request has an immutable ACK file. Operations also get a separate
immutable result file when complete; status returns a terminal ACK directly.
Idempotency reuses the admitted ticket and does not issue another action.
Concurrent restore and stop tickets share the owner operation. A caller timeout
returns explicit pending and neither cancels cleanup nor starts another owner.
A later terminal result is still readable. Responses bind both nonces as well
as run/key/sequence/verb. Rejections cannot be repaired in place.

Run scope uses a fresh database name derived from the new run ID and exclusively
reserved fresh ports. The known sealed ports 33535 (PG) and 33637 (Worker) are
always rejected, alongside caller-supplied sealed exclusions. These numbers
come from already-reviewed old owner evidence, not a connection or scan. The
old Server port is unknown and must be resolved from permitted sealed evidence
before a real proposal. A future allocator must atomically bind/reserve the
requested loopback ports and abort on occupation; it must never connect to an
occupant. Only a fake allocator is exercised now. Startup failure preserves its
exclusive directory/reservation as pending instead of deleting or reusing it.

## Truthful outcomes and verification

Owner reports preserve the first driver/startup error and all secondary errors,
including control/reply and report-sink errors. Original exception objects stay
private; report error codes/stages never serialize arbitrary credential-bearing
exception strings. The report sink receives an explicitly named provisional
resource journal. Its own write outcome cannot be truthfully claimed within
that same write; live owner status separately reports sink success/failure.
Late control loss makes current owner status unresolved without rewriting
an already-issued positive resource-closure receipt.

All generated state keeps `real_launch_available=false`,
`actual_runtime_validated=false`, `database_health_proved=false`,
`accepted=false` and `release_ready=false`. Fake cleanup confirmation is only
the state machine outcome for the supplied fake evidence. Test fixtures contain
fake nonces/credentials only.

Pure tests:

```sh
python3 -B tests/owned-fixture-owner.test.py -v
python3 -B tests/owned-fixture-rpc.test.py -v
```

They use fake clocks/processes/pidfds/events and local temporary regular files.
No test starts a controller subprocess, a service, PostgreSQL, SQL, an external
driver, a network listener or a real signal target. Coverage includes malformed,
stale, oversized, partial, linked, replaced and conflicting RPC; cross-run/old
scope/old ports; shared operations; caller timeout/late result; blocking/crashed
driver; identity reuse; parent loss; natural exit; invalid readiness/lost pin;
inaccessible/replaced channel; phase/total timeouts; root closure with unknown
descendants; and non-manufactured waitpid/continuation/health/release outcomes.

## Prerequisites for one later run proposal

1. Independent review of the exact source/test hashes and local commit, with
   all fake tests passing; no inference of real runtime safety from mocks
2. Separate explicit authorization for one fresh bounded real launch, including
   scope/ports/cleanup operations and the actual process backend
3. A reviewed single Python launcher that spawns PG itself, keeps the genuine
   original Popen/waitpid and admitted pidfds, and starts an independent actor
   plus bounded filesystem worker; original outer owner stays responsible
4. Exclusive directory/data identities, fresh nonces/database/credentials,
   full sealed old-port exclusions, atomic port reservation, and an immutable
   source manifest bound to the unchanged frozen native backend
5. Actual verified pidfd readiness/identity/lifetime-absence and genuine direct
   waitpid behavior, including natural exits/zombies/parent death; no numeric
   PID fallback, namespace mapping, old-session controls or imported ownership
6. Actual file IPC access from another exec while the original owner remains
   active, independent deadline behavior during blocked Node/SQL/stdio, and
   explicit unavailable/lost-owner behavior
7. Actual bounded PG resume/graceful stop/strong-stop/reaping and every retained
   descendant disposition; no root-exit-only cleanup claim
8. Only after those gates, a separately reviewed F2 SQL/media observation scope,
   fixed stop conditions and retained primary/secondary failure evidence

The first proposal should stop at one fresh isolated startup/control/shutdown
validation, not claim F2 acceptance. Existing unresolved ownership is not
repaired or waived, and this source slice does not authorize runtime.
