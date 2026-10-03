# Owned PostgreSQL probe: pure model slice

This implements the first pure slice of `OWNED_POSTGRES_PROBE_PROPOSAL.md`
(SHA256 `e9de50a5e65e3eaf5bb24196626dd075ec1497a4ed73393b2c325d21656ceaae`)
on integration `ccb6898d0bb0e599a8432256efe51d740594cda6`, tree
`2f2470bb1e3eff218330ac2fe72c61b8eb5c75c3`. The imported source snapshot has
the original shallow boundary `464dc39fba02431807aef0bb924fd0b0e46ba11a`;
it does not claim complete earlier history.

The independent module is `scripts/fixtures/owned-postgres-probe.py`.
It imports only dataclasses and a finite-number predicate. Every input is
modeled data: explicit monotonic time, original opaque references, capture,
observation, receipt and resource records. It creates no operating-system
resource, calls no supplied handle, and has no filesystem, backend, RPC,
CLI or launch entry point. Existing owner/kernel/RPC source is unchanged.

## Modeled behavior

- `receive` evaluates absolute workload and lease expiry before accepting a
  unique client sequence and freezes key/verb/original receipt at acceptance.
  Same-key replay reserves only its transport sequence and returns the exact
  first receipt/time; a conflicting verb is rejected before service. The owner
  creates the receipt timestamp. `step`
  checks expiry again before dispatch; only the exact retained receipt can
  renew once, from its receipt time. Replayed operation keys and owner ticks
  supply no new activity. Exactly at a deadline, expiry wins.
- A single immutable resume pass describes sequential original-child
  continuation before the original root. Child and root phase deadlines are
  start+6 and start+8; each issued description has at most two seconds.
  Unissued expired children have explicit `not_issued: child_phase_expired`
  status and remain suspension-possible. A missed root window describes no
  root continuation attempt. Stop/lease loss opens a separate 20-second
  cleanup budget while preserving every original resume/action deadline.
- `ActionPlan` describes continuation or the separately bounded root SIGINT
  request. It executes neither. Results alone do not prove running state or
  disposal. Each continuation separately retains `action_result`/status and
  process `disposition`; either event order preserves timely success/error/
  unknown and later running/exit. A positive observation cannot manufacture an
  ACK or erase an error. Deadline-external ACKs cannot finish a timed-out pass.
  Original-pin exit discharges suspension, including natural exit
  after continuation, without claiming running-state confirmation. A zombie
  remains open. An exited root with missing wait evidence is never re-signaled.
- Direct closure requires original-pin exit and a matched terminal raw wait
  bound to the original Popen. Both observations can arrive separately in either
  order; raw wait is retained before pin exit. Parent-reaped child closure requires its own
  original-pin exit plus positive original-lifetime absence; `actual_waitpid`
  stays false. PID absence, ECHILD, root-only exit and empty topology fail.
- Bootstrap roots, children, failed admissions and raw/wrapped handle
  obligations remain separate. Later observed births invalidate fixed-ledger
  coverage and are retained unadmitted. Numeric/copied handles, changed
  start/ancestry, unknown IO and unwitnessed exec do not admit action targets.
- Exact-launch and normal-managed-family coverage are distinct fake proof
  inputs. Family receipts bind original objects, root exit/raw wait 0, complete
  package/source/image/input/dependency/environment/configuration/argv data,
  and original reviewed-path references. Postmaster requires an independently
  retained `NormalReadiness` event bound to its exact reviewed readiness path
  and configuration before the original owner-described SIGINT request, whose
  exact action reference and accepted timely successful `ActionResult` are
  also bound. Missing/error/unknown send results plus natural root wait 0 do
  not prove normal shutdown. Observed root capture images must belong to the
  contract's bound image set; independent admission alone is insufficient.
  A running observation cannot supply readiness. Initdb normal
  success and postmaster ready SIGINT shutdown have separate predicates. Failed/forced/uncovered
  paths, mismatches and assertion-only receipts fail.
- Family coverage never mutates an individual process or resource record.
  Each known child, including new births, needs an exact `ManagedMembership`
  event retained by this owner while the original root is still live and named
  by this receipt. It binds original capture/parent/ancestry/images, full program
  binding and the reviewed complete launch path. Parent references, failed
  capture, unknown images and unchecked `uncovered_birth=False` cannot supply
  membership. Positively bound managed births can receive fake coverage without
  installing an action admission or erasing their old candidate obligations.
  Every retained candidate, pin, FD, file/directory, thread and job still needs
  its own positive disposition. Every known original pin also requires a
  matching positive pin-close record, even if a caller omitted that obligation.
  Partial-close, uncertain-start, blocked and
  unsettled outcomes stay pending. Publication failure cannot clear them.
  Only a full positive gate permits modeled exit; delivery/budget/action
  failure then yields nonzero. Primary errors and per-attempt outcomes remain.

`ActionPlan`, `ModeledProof` and `ExitGate` all expose
`runtime_authority=False`. Opaque fake review references are not authentication,
source verification, kernel evidence or real PostgreSQL family proof.
`exit_code=0` describes a supplied complete modeled case, never acceptance.
Force escalation, resource-close scheduling, startup/backend construction,
socket feasibility, real pause/restore and lost-Node behavior require later
separately reviewed implementation and authorization. All runtime/production
acceptance and public HLS activation remain unestablished.

## Validation scope

`python3 -B tests/owned-postgres-probe.test.py` runs 59 pure checks. During every
case, file opens/mutations and process/pin/thread/signal constructors are guarded
against use. Test import reads source as ordinary harness work; no test fixture
creates a directory, process, thread or file. Required proposal groups 1–11
are modeled positive/negative cases, not real deadline or PostgreSQL evidence.

The first 38-case run had two failures in no-op pass identity preservation.
The implementation now preserves the unchanged immutable pass, and the
expired-standalone-resume test explicitly keeps its lease alive before stop.
The final suite additionally checks numeric/assertion-only inputs, action ACK
vs observation, late completion, budget failure and matched original-root wait.

Existing regressions run separately in one Python interpreter: 37 owner,
35 private-file RPC and 43 kernel fake/static cases (115 total). Their existing
temporary-file fixtures remain distinct from the new filesystem-free suite;
their kernel operations and thread objects are fake. No runtime probe, PG,
service, listener, browser, database fixture or new child experiment was run.
These checks do not clear the historical failed/unresolved F2 or HLS scopes.

## Review correction checkpoint

The parent review held `d10055a5957aafe84426402ad15a1971bcb469f5` for four
concrete issues and the managed-child boundary. Pure negative tests against
that model reproduced unbound root images and unsuccessful/missing SIGINT
results: two tests, ten failing subcases. The corrected suite covers all five
boundaries above, fixed 2-event order permutations, receive-time key conflicts,
4.999/5/5.001 expiry, and raw-wait/pin-exit order. The 31-child fixed case and
original 6/8-second deadlines remain in the suite. An intermediate run's one
failure was the old test expecting parent-only family coverage; it is now a
negative, with a separate positively bound managed-birth case. No general
fuzzer, syscall adapter or runtime experiment is added.
