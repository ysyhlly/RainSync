# Playback Stop and job claim lock regression

`playback_observations::lock_grant` retains room → snapshot → grant lock order,
but now locks the grant `FOR NO KEY UPDATE`. Grant mutations do not change a
referenced key. This still excludes concurrent updates, `FOR UPDATE`, `FOR
SHARE`, and another `FOR NO KEY UPDATE`; it permits a foreign-key `KEY SHARE`
check for an execution receipt.

## Reproduced failure

The frozen HTTP Server matching source commit
`c59026e44cbe1cd023d6ee24b8b8fd76e5be5cea` has SHA256
`612777b122f68f41e86c9b6a809a222d169d1da44bc5b860af6ab20fa4ac0214`.
Its 192-input backend binding has SHA256
`0599a4bc8f0ca985697569eb5355bcebf9355175f4ba630061243ed95e642619`.

An owned PostgreSQL 17.11 cluster deterministically reproduced this cycle:

1. The actual `persistence::media_jobs::claim` owns the selected job, and pauses
   at its execution insertion behind a controlled table lock
2. Authenticated HTTP DELETE owns the room, snapshot and playback grant, and
   waits to cancel that same job
3. Releasing the table lock allows the claim to request the grant's FK `KEY
   SHARE`, which conflicts with the grant's former `FOR UPDATE`

PostgreSQL reports the job cancellation and execution insertion as the two
deadlocked statements. DELETE returns 500 `DATABASE_ERROR`; the claim commits,
but Stop rolls back, leaving the grant live and its job running. No retry or
relaxed HTTP assertion is used. This reproduces the published CI symptom; the
original CI run did not retain PostgreSQL details that would identify its
individual failing transaction.

## Authorization and serialization audit

All explicit `FOR KEY SHARE`/`FOR SHARE` uses in Rust and SQL were inspected.
None locks `playback_sessions` for authorization. Existing uses cover other
rows such as memberships, authenticated logins, sources and media items.
Playback grant readers that explicitly lock a session use `FOR UPDATE`, and
remain excluded by the new lock. Other grant mutations retain their row-update
serialization. All execution foreign keys reference the session primary key;
migration 0030 forbids changing that key or the grant's room identity.

Room/snapshot ordering, ownership predicates, membership checks, generation
checks, policy checks, expiry evaluation after contended locks, and observation
row locking are unchanged. Stop still retires the caller's owned grant when its
final sample is invalid or its membership has been revoked.

## Focused regression

`tests/stop-claim-race.mjs` seeds fixture state and controls lock boundaries,
then invokes the production claim through the guarded `stop_claim_fixture`
example and issues authenticated HTTP requests. It requires no Worker and does
not model the claim algorithm in test SQL. Every case tests wrong-owner DELETE
and rejection of a wrong-owner final sample before the authorized Stop.

Five cases passed with the fixed Server:

- Stop during a production claim
- Valid final observation, concurrent observation serialized behind Stop, and
  idempotent final replay
- Invalid final sample with cleanup
- Stale final generation with cleanup
- Revoked membership with final-sample rejection and cleanup

Each forced overlap produced no deadlock, cancelled the claimed job, marked the
grant stopped and retained the attempt's independent execution drain receipt.
The fixed Server SHA256 is
`326df87f6a42549e51d78a84e74f6283880d81cfff9719b86dd9349e9e747c71`.
Fixture cleanup positively verified process exit and closed Server/PostgreSQL
ports. Scoped Rust formatting, JavaScript syntax, Prettier and diff whitespace
checks and targeted strict Clippy passed. Full CI remains the integration owner's verification step.

To run, use an owned build target and an external artifact directory, build
`cargo build -p persistence --example stop_claim_fixture` and
`cargo build -p rainsync-server --bin rainsync-server`, then run
`node tests/stop-claim-race.mjs`. For native disposable PostgreSQL, set
`RAINSYNC_NATIVE_POSTGRES_BIN` to its bin directory. `RAINSYNC_STOP_CLAIM_SERVER`
can select an already frozen Server binary without rebuilding it.

The preserved baseline/fixed reports, PostgreSQL logs and provenance are under
`/workspace/shared/rainsync-stop-claim-evidence/`. The baseline and fixed
clusters remain retained under `/tmp/rainsync-stop-claim-evidence/` after their
verified shutdown.


The integrated event-counter plus Stop-fix candidate was also rebuilt and ran
the same five strict cases successfully. Report
`db6acbc8-a253-49da-8e0b-6919c965e1f1` has SHA256
`0f4f363c55cab13559e4bd60451f8695d0279b4fce6aa23157db5db458bc8ab4`.
This is an additional check of the combined changes, not a repeat claimed as
new distinct scenarios. The combined Server and claim-driver hashes are kept
in that report; owned PostgreSQL and service closure were verified. It does
not replace exact-head full CI.
