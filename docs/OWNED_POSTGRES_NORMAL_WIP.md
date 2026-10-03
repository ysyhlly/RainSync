# Owned PostgreSQL normal adapter: isolated WIP handoff

Stopped at the user's request to stop RainSync feature work and preserve a
complete handoff. This branch is an unfinished source checkpoint. It is not
merged into the integration worktree, pushed, runtime-reviewed, or authorized
for execution. Base: `558530a36e93105fee85e850f0b18afde288b618`.

## What is actually written

The new `scripts/fixtures/owned-postgres-normal-probe.py` is 1,259 lines of
static Python source. It contains real syscall implementations, not merely a
third pure model: retained original/partial Popen construction, original
pidfd acquisition, original-Popen raw WNOHANG waitpid, fixed pidfd SIGINT,
private create-new directories/files, a retained file/setup worker, normal
initdb/postmaster sequencing, owner deadlines, status/stop RPC, and an exit
gate. Those paths have never been imported, constructed, or exercised.

All CLI modes reject before context/resource creation because the compiled
`_APPROVED_REVIEW` remains `None`. The execution flag alone cannot enable them.
`ReviewedPaths` is proposed binding data; constructing it grants no authority.
The original pure model is neither imported nor treated as a kernel permit.
Existing owner, RPC, kernel adapter, pure model, and their tests are unchanged.

Proposed process shape remains one foreground Python owner, its separately
owned normal-success initdb followed by the original postmaster, and one
second-exec status/stop client. The new private Unix socket has no TCP listener
or SQL workload. Only original-pidfd SIGINT is implemented: no SIGSTOP,
SIGCONT, SIGTERM, SIGKILL, imported PID, process enumeration, pg_ctl, arbitrary
command/path/signal arguments, migrations, Server, or Worker.

## Verification actually performed

One AST syntax parse passed. The source was read as text without importing or
executing it. At that checkpoint its SHA256 was
`7ad99b678bd71955e5951c0404c5030a2d114af5a333d907f5dd5e85a09707cd`.

New adapter tests written: **0**. New adapter tests run: **0**. Existing tests
run in this worktree: **0**. No runtime command or PostgreSQL binary was run.
No real Popen, pidfd, waitpid, signal, worker thread, private runtime directory,
socket, listener, or fixture was constructed. No Cargo target was used.
The AST parse is not behavioral verification or a source-security review.

## Unfinished work and known review risks

The following are review/implementation blockers, not requests to resume:

1. No pure adapter suite exists. Future tests must patch native process,
   pin, signal, waitpid, thread, file/directory and other resource constructors
   fail-closed, use fake clocks/handles, and exercise the actual adapter's
   retention/failure branches without subprocess tests
2. Complete source-bound normal-family contracts and an immutable launch
   manifest are not installed. The new receipt code has not been independently
   reviewed and cannot discharge real managed-child coverage today
3. File publication currently uses create-new writes directly to final names.
   The partial-publication/read race still needs review and likely a retained
   atomic publication protocol. Current errors start cleanup and preserve the
   owner; this is not evidence of reliable cross-exec operation
4. Main-thread pin close can overlap an in-flight capture/readiness worker.
   Each original pin must remain retained until all jobs using it have settled;
   that synchronization has not been reviewed or completed
5. Readiness is provisional. The owned PID-file `ready` line is corroborating
   supervisor-state evidence only, with original live capture/image/config
   checks. It is not signal authority or independently checked SQL health.
   Bind the normal fresh-cluster path and exclude the separate hot-standby
   ready path. Whether a future fixed read-only handshake is necessary belongs
   to the later root review, and would expand this two-child proposal
6. Private-channel construction/attachment, partial Popen resources, uncertain
   worker construction/start, raw/wrapped pin allocation and partial closes
   require exhaustive negative review. Unknowns currently retain the same
   context; that intent does not prove every branch is implemented correctly
7. CLI construction-failure handling, reply/replay/error handling, malformed or
   late control delivery, client partial attachment, delivery-only nonzero
   termination and all-job/thread/descriptor gate ordering are untested
8. Generated configuration hashing is not a complete semantic configuration
   exclusion. Active includes, extension/library selection, and source-identified
   bootstrap dependencies require fixed reviewed restrictions. The exact
   runtime environment and loader/library/shell/interpreter byte inventory is
   still incomplete. No additional dependencies or software were installed
9. No source/log manifest, tested-count acceptance report, final source hashes
   for a reviewed runnable proposal, or independent diff approval was produced

## Source/package evidence available for a later reviewer

The supplied read-only toolchain is
`/workspace/scratch/8cbaa022c1e0/tooling/toolchains/postgresql-17.11`.
The two image hashes were read and matched the earlier proposal:

- initdb: `a0363354125bc00f25075bb47fc32a2838fa7668c008326227f5bc04d628ca1d`
- postgres: `6468a969338215cb3912cf9c0b894bdbbd37b9a709926db078e9a5bf8bdc3e16`

Existing signed-package evidence under `tooling/restore-20261002` was read
without executing packaged binaries. Server package SHA256:
`d2ce1ddffafa783f9acda4c92c86fc21e8288bff3782d739294f14fa797d7886`;
client package SHA256:
`9d8558f8dd57c8e92e218a20698383575d53742ca3f9e7c2b7fe5f246d5216ae`.

The parent separately reported a newer exact source-chain review directory at
`tooling/pg-normal-source-review` and source-chain manifest SHA256
`89c92a5bf5898d5ad0e306bd11e42a005127352aae8e3819cd939252ea4d58de`.
Its official source archive hash was reported as
`dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979`.
Those source-chain results were received as parent findings; this worker did
not independently verify that directory before the stop instruction.

Use the actual archive sources for later review. The parent reported that
cached web REL_17_11 source line counts differ from those files. Relevant
archive locations reported by the parent: initdb `system()` 1236, bootstrap
PG_CMD_CLOSE 1610, final standalone PG_CMD_CLOSE 3135, success 3539;
postmaster ready 2475 (separate hot-standby ready 3743), WAIT_BACKENDS 3177,
NO_CHILDREN/normal exit 3329. Do not substitute cached web line references.
The Debian extension_destdir patch requires explicit empty fixed binding.

The remaining bounded source review is the exact initdb normal-success managed
commands and the postmaster child launch/reap/fast shutdown path, using normal
vendor/OS system/pclose/waitpid semantics. This is not a general libc source
or reproducible-build project. Root wait 0, group emptiness, log messages,
ELF hashes, or modeled proofs alone cannot close a managed family.

## Unrun command proposal and bounds

These are exact *draft* commands for a future source review, not runtime-ready
commands or authorization. Both currently return runtime-admission-disabled
(code 3) before resource creation. Do not run them to complete this handoff.
Working directory: this isolated worktree,
`/workspace/scratch/8cbaa022c1e0/RainSync-owned-pg-normal`.

```sh
python3 -u -B scripts/fixtures/owned-postgres-normal-probe.py owner --phase normal --execute-reviewed-normal-probe
python3 -u -B scripts/fixtures/owned-postgres-normal-probe.py client --phase normal --action status_then_stop --execute-reviewed-normal-probe
```

The proposed failure entrypoint is the same retained foreground OwnerContext:
setup, CLI/client delivery, RPC, worker and syscall failures stop admission of
new work and begin its independent cleanup observation. No replacement owner,
alternate control route or numeric-PID cleanup is proposed. Failed/nonzero
initdb, failed startup, unknown signal/capture, or uncovered family disposition
has no normal-family receipt and keeps that owner retained. No force action is
implemented. Final delivery failure can produce nonzero only after every
process/family/pin/job/thread/file/descriptor obligation is positively closed.

Draft monotonic observation budgets: image binding 2 seconds, initdb 20,
postmaster admission/ready 8, setup total 30 from before first spawn; normal
ready workload 30, owner-created authenticated activity lease 5; independent
cleanup 20, action 2, publication 1 and normal retained-worker join observation
0.2. A successful normal return would fit an 81.2-second observation budget
from owner start; the longest proposed postmaster normal lifecycle is at most
8 startup + 30 ready + 20 cleanup seconds within that budget. A 90-second outer
observation window reports failures and unknowns. It never authorizes killing
an owner. OS/scheduler/filesystem stalls are not unconditionally bounded;
an owner retaining unknown resources may remain foreground indefinitely.
These numbers describe the unfinished design, not measured closure guarantees.

The first approved run, if ever requested after review, must use a previously
absent `/tmp/rainsync-owned-pg-normal-v1`, fresh run/owner/client nonces, new
data/home/password/socket paths and the same original retained context.
Only initdb success, normal readiness, fresh cross-exec status, fixed stop,
original raw wait 0 and all-resource closure could satisfy that future scope.
No pause, fault, lost-client experimental claim, rerun or workload is bundled.

Old F2 `15e2d8bb-b544-4985-9b72-c69dd5598d81` and the old HLS scope remain
unresolved. Their processes, data and ports were not inspected or controlled.
This new source checkpoint implies no cleanup or acceptance of those scopes.
