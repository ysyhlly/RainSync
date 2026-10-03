# Proposed single stop probe; runtime not yet authorized

The static adapter and fake tests follow commit
`327de5ebc9954013c2024a4cf81912dcf9659e0c` (the preserved 72-test fixture
contract checkpoint). No command below has been executed. No actual owner,
test child, pidfd, signal or waitpid experiment has run. PostgreSQL, network
services, the existing F2 consumers and old ownership remain outside this scope.

## Exact scope for root to approve

One foreground Python owner creates one new isolated Python child itself. One
second exec runs the client, first requesting a fresh status, then requesting
one idempotent stop. The owner and client deliberately overlap. There are no
parallel owners, replacement owners, extra children, shell commands in the
child, network/DB connections, namespace mapping or imported PIDs.

Working directory for both commands:

`/workspace/scratch/8cbaa022c1e0/RainSync-owned-fixture-control`

First exec, remaining foreground:

```sh
python3 -u -B scripts/fixtures/owned-fixture-kernel-probe.py owner --phase stop --execute-reviewed-probe
```

Second exec, issued promptly while that original owner remains running:

```sh
python3 -u -B scripts/fixtures/owned-fixture-kernel-probe.py client --phase stop --action status_then_stop --execute-reviewed-probe
```

These are the only proposed runtime commands. They require separate root
approval after exact source review. An exec yielding a live owner handle is
expected; it must not terminate that owner on yield. No assumption of detached
survival after the outer owner exits is made. Do not background the command.

The client reads the task-private file channel, not the original exec's stdin.
The original owner performs every child operation with its own original Popen
and retained pidfd. At most three application processes overlap: owner, its one
child and the second-exec client. Normal owner has one filesystem thread in
addition to its actor/main thread. Failure recovery may make one bounded thread
restart attempt in that same owner and retains every attempted/started thread.
It never spawns another process or reconstructs ownership.

## Frozen child and authority

Probe source SHA256:
`8966f53f6dca7656bc1284ea2113371908f03f1d4b220de14f9e0d3e1a3bf817`.

Owner state-machine SHA256:
`bebc7bf712d7b2031a049aa3bfff7bb9363f563e5bfb9cccdd70e5d9e24b2875`.

RPC SHA256:
`1fa9aaa7fe61fbd35220587c912b40773ec0a57ebc5a990448912556fa7d3c55`.

Fixed child-code SHA256:
`a2e544f8aa852bed65a01e37fd1d9ed29276339ebb075beb79514dc6bc05d56e`.

The child's complete code is:

```python
import os,time
deadline=time.monotonic()+6.0
while time.monotonic()<deadline:
    time.sleep(min(0.02,max(0.0,deadline-time.monotonic())))
os._exit(0)
```

Its executable is the current owner interpreter's canonical path, hashed before
Popen. Its fixed argv is that interpreter followed by `-I -S -u -c` and the code
above. The child receives only `LC_ALL=C` and `PATH=/usr/bin:/bin`, with stdin,
stdout and stderr set to DEVNULL and close_fds enabled. It never forks, execs,
reads caller commands or starts a service. The adapter refuses pause/continue
and arbitrary signals; its only process mutations are SIGTERM and, if bounded
cleanup needs it, SIGKILL of the original admitted pidfd.

The initial capture checks the newly spawned direct child's parent/start and
interpreter inode/version against the pre-spawn image. Cleanup subsequently
uses this fixed no-exec lifetime's retained pidfd and original Popen; executable
filesystem hashing never runs on the cleanup actor. This deliberately narrow
authority is not an adapter for Worker exec transitions or PostgreSQL.

The fixed private root is `.owned-fixture-kernel-probes/stop` within this
checkout. It must be new; existing/symlinked paths, old `15e2d8bb` overlap and
reused nonce claims are rejected. The owner creates fresh run/owner/client
nonces, a purpose-separated `kernel_probe` scope, and an exclusive unused data
directory. Its database name is None and ports are empty; no allocator/binding
or connection is performed. Unknown old Server/PG ports are irrelevant here.

## Bounds and failure disposition

- Child self-expiry: six seconds of its monotonic clock after its code starts;
  SIGTERM/SIGKILL may shorten that lifetime. No SIGSTOP is supported
- Interpreter preparation and initial child capture each have a 0.5-second
  observation deadline; their filesystem work is outside the actor and may be
  blocked by the OS, so this is not a universal syscall wall-time guarantee
- Owner workload deadline: eight seconds from actor admission
- Owner driver lease: two seconds; ordinary stop-mode heartbeat cannot extend
  the fixed workload deadline
- Cleanup attempt: six seconds independent of driver/client failure, with
  reserved phase budgets and each action/report observation capped at 0.5 seconds
- Terminal reply/report publication: one additional second
- File-thread join observation: at most 0.2 seconds per original thread; normal
  path has one such thread
- Client total status/stop wait: four seconds; caller timeout never starts an
  additional owner or another stop key

The normal owner completion budget is at most 15.2 seconds after actor
admission, plus the observed pre-admission setup work. The proposed external
observation window is 20 seconds from the owner command starting. This is an
observation/stop condition, not permission to kill an unresolved owner at 20
seconds. Startup filesystem/process syscalls and scheduler stalls are not
claimed to have an unconditional maximum wall time.

If all owned resources are positively closed, missing terminal delivery may
produce nonzero `failed/unconfirmed_delivery` and end the owner. That requires:

1. Actual raw WNOHANG waitpid of the exact original Popen child (or structural
   evidence that no Popen attempt occurred before a setup failure)
2. Positive exit and close of every retained/wrapper-pending original pidfd
3. Every started/restarted filesystem thread positively joined/not alive; a
   stop_event or unconfirmed start does not suffice
4. All queued/in-flight filesystem jobs settled after thread closure
5. Positive close of both run/data directory descriptors and no unknown
   interpreter, capture, transient-file or descriptor-close obligation

A failed delivery never becomes experiment success. Directory partial close
keeps each successful close separate from each unknown close and never retries
an uncertain numeric fd. Known unknown resources preserve the existing control
worker/fds. ANY missing process/pin/thread/file closure evidence keeps the same
outer owner foreground and the outcome unresolved. That exceptional owner
lifetime can be unbounded pending root action; it is not hidden under the
child's six-second lifetime. No replacement owner, old-session operation or
alternative control route is authorized.

## Evidence required from the one proposed run

Success requires all of these exact observations:

1. Two distinct exec invocations at the reviewed source hashes, with the
   original foreground owner remaining active while its client runs
2. Client receives a matching fresh terminal status ACK showing positive
   original-pidfd alive evidence before the admitted stop sequence
3. That same client submits the persistent exact stop key; the owner issues the
   fixed stop while its original retained kernel object is still alive
4. Positive original pidfd exit and actual raw original-child waitpid status,
   with a signalled exit rather than the child's separate natural exit-zero
5. Exact original pin release, all owned thread/descriptor closure, immutable
   terminal stop reply and final artifact, and both owner/client returning zero
6. No exceeded cleanup/action/report/publication bound, no secondary unresolved
   resources or errors, and `bounded_phase_success=true`

Private run artifacts include `kernel-probe-ready.json`, ACK/result files,
resource journals and `kernel-probe-final.json`. The final artifact is written
before its producing thread and run/data descriptors close; the reviewed
owner's zero exit is the additional all-object closure gate. The document does
not infer final descriptor/thread closure solely from that artifact.

If the client reports control_unavailable/caller_timeout, returns nonzero, the
owner returns nonzero, the child exits naturally, or any required evidence is
missing: stop the experiment and retain the failed/pending observations. Do not
start another owner, change control routes or broaden scope to obtain a pass.
The already-owned autonomous cleanup may continue. If the outer owner stays
pending beyond the observation window, report the exact unresolved objects and
leave it retained for root's next explicit decision.

Only a complete stop/cross-exec pass permits proposing further PG-owner design
review. It does not authorize PG launch, F2 execution, old-process cleanup,
production acceptance or promotion of the failed old report. Natural-exit and
blocked-driver automatic-deadline runtime checks need their own later minimal
proposals; their runtime entry points are currently disabled. Fake tests do not
substitute for either check or for actual cross-exec evidence.

## Source-only checks already performed

43 new fake/static adapter checks plus 37 owner and 35 RPC regressions pass.
All real Popen/pidfd/signal/waitpid calls are patched to reject in the adapter
tests; process/clock/pin models are fake and filesystem tests use only local
temporary files. There is no subprocess-based controller test. Exact source,
log and local-commit hashes are recorded separately in the source checkpoint.
