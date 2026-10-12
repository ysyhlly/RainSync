# OAuth disable: final exact-login authorization fix

## Reconstruction notice

This is a reconstructed version, prepared on 2026-10-11 after the previous
execution environment disappeared. It is based on recovered snapshot commit
`e11872c05ae12a3c31ae402fc42cebe5fdefa37b`, whose tree is exactly
`8eb3c78783aa2232bce5f1b595f133d6c163c82f`, the retained tree of the original
`29a3f69fca10a49135380bbc2ab073594fc01afe` baseline.

The worker's retained task/tool-call context supplied the original production
patch, complete source contracts, database fixture creation and revision steps,
and documentation. This is not a recovered original Git object and is not
claimed to be original fix commit `07b901373b3d7232fff9a15c6e240445466bafbe`.
The production operation has exact retained before/after SHA-256 witnesses;
reconstructed fixture/documentation bytes require new review and validation.
Historical approvals and test reports are not current-run evidence.

## Status and scope

This is a deliberately **non-equivalent behavior fix** after the completed
account extraction batch. It closes the known source-level omission in OAuth
`set_renewal`. It does not claim a passed PostgreSQL regression, release
qualification, P20 completion, provider qualification, or a completed plan.

Only production `set_renewal` changes: it now awaits
`maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?` after
its final account SELECT and before status projection and COMMIT. One test-only
module declaration registers an explicitly ignored database regression. No
shared package/CI registration is changed.

Reconstructed author lane:
`/workspace/shared/rainsync-oauth-disable-guard-reconstructed-20261011`.
Direct current-source analysis was used because no usable GitNexus MCP/CLI
or current index was available. No graph-impact completeness is claimed.

## Why this boundary

Request authentication alone is preliminary. `guard_login` then locks the
principal with `FOR KEY SHARE`, the exact session with `FOR SHARE`, and checks
`guard_login_live`. The OAuth account lock follows. These row locks prevent
concurrent revocation from changing the protected authority rows, but they do
not stop time: the exact session can naturally expire while waiting for the
account or during the later UPDATE/read.

The existing login helper calls `playback_login_allowed(user, exact_login_hash)`.
Its original SQL is VOLATILE and checks matching user/hash and
`expires_at > clock_timestamp()`. The current guest wrapper retains that
predicate. This is the shared authentication predicate; the fix does not invoke
any playback owner, provider, or P08/P09 implementation.

The added final SQL check is inside the same transaction. If it returns false,
the operation returns `401 session_expired`, and the transaction is dropped
without calling COMMIT. All of that transaction's account/token/revision/consent
changes must roll back. The added SQL phase can also fail with the existing
`database_error` conversion or time out with
`platform_renewal_database_phase_unknown`; those new-phase failures likewise
return before COMMIT. The number of phases increases by one, while their
per-phase budgets and error mappings do not change. Another live session
belonging to the same user cannot satisfy this exact-session check. Runtime
rollback still requires the separately controlled PostgreSQL evidence below.

### Why not insert only before crypto or UPDATE?

An early check alone would miss a subsequent UPDATE/trigger/read wait crossing
the expiry deadline. Adding it as well would change the existing precedence of
revision overflow, stored-binding/envelope failures and cipher failures relative
to expiry. This narrow fix preserves those earlier errors: validation and local
cipher work still occur in their original order, and the complete transaction
is rejected at the final authority boundary if all earlier phases succeeded.
The callbacks are local serialization/encryption operations, not provider token
rotation or other irreversible external effects. The SQL mutations remain
transactional. No new provider capability or lock-order edge is introduced.

The check establishes liveness at the **final SQL authorization fence**, not at
the exact instant COMMIT finishes. A clock deadline can still pass after that
check. The existing separate five-second COMMIT budget, uncertainty mapping and
no-retry behavior remain unchanged; this fix does not promise stronger temporal
atomicity or alter ambiguous-COMMIT reconciliation.

## Complete operation contract

1. Parse provider; authenticate non-guest write with existing origin/CSRF
   checks; derive the originating cookie's login hash; parse expected revision.
2. Begin through `maintenance::begin_db`; retain five-second acquisition,
   statement and lock limits. Acquire principal, exact-session, then account
   locks in the existing order.
3. Keep insert-if-absent and `revision_matches(expected, revision, inserted)`.
   Revision conflict wins over `enabled=true`. Reject enabling with the existing
   `platform_renewal_new_consented_oauth_required` conflict.
4. Calculate the checked next revision. On a stored token, require its binding,
   decrypt, validate owner/provider/account/current-revision/binding envelope,
   and encrypt the same tokens under the next-revision envelope. With no token,
   neither callback runs. Error reasons and order stay unchanged.
5. Run the identical UPDATE, with identical account/cipher/next-revision binds:
   clear auto-renew, consent, renewal operation and scheduling state; preserve
   all other columns. Read the identical ACCOUNT projection with user/provider
   binds and `fetch_one` semantics. SQL failures still precede the new check.
6. **New behavior:** await exactly one bounded final `guard_login_live` with
   `user.id` and the request-derived `&login`. Expiry returns
   `401 session_expired` before projection and COMMIT, rolling back the write.
   A failure/timeout of this new SQL phase uses unchanged database-error /
   phase-unknown mappings and also prevents COMMIT.
7. Project the same private status and perform the same bounded COMMIT with
   unchanged errors. Return the same value/HTTP wrapper/private HTTP 200 response
   on success. No OAuth request mutation, provider call, fresh authority lock,
   registry/config gate, revision rule, token purpose or cipher call is added.

## Source evidence, not historical equivalence

`tests/oauth-disable-login-guard-contract.test.mjs` is a separate forward
witness for the intentional fix. The complete `set_renewal` SHA-256 is
`ab7dc938e1a459ce5796b2746fd05484cdda31b2a845396b926e6c75614036fb`.
Its immediately preceding operation remains recorded independently as
`fe29da4207e8a2e78b7e2d470009b9346ebc5a28e2f9f9488cae298605a3837d`.

`tests/fixtures/oauth-disable-login-guard-inverse.mjs` removes only the uniquely
located new fence/comment from `set_renewal`, asserting its exact final-read /
projection / COMMIT position. It does not remove similarly spelled checks in
status/unlink. After that explicitly non-equivalent inverse, the complete
pre-fix production module still hashes to
`b1adc158be3998a9a6cac3e0451862a29cc1b64aaecac5c801937309341185da`.

The older extraction contract then applies its original finite inverse and
still requires the original complete `oauth.rs` hash
`0ec042950f5bca66aa6fd3d12cd29a464c92deb3c40158516d78b922c16c6316`.
The maintenance historical hash is unchanged as well. Old extraction witnesses
are retained, but current behavior is not mislabeled equivalent to the old
unguarded disable operation. The old operation fails the new forward contract.

Negative controls target the extracted operation with unique replacements.
They reject absent/duplicated/conditional/unawaited/error-ignored checks; wrong
user/login or consent-login substitution; a new lock instead of a live recheck;
removed/changed phase budgets; moving the fence before lock/CAS/enabled/crypto/
UPDATE/final-read or after COMMIT; matches hidden in comments, test text or an
unrelated function; SQL-bind/revision/envelope drift; provider calls; and ignored
COMMIT errors. Separate fixture controls reject unignored tests, ambient
DATABASE_URL, missing isolated-database checks, missing real wait observation,
and missing rollback assertions.

## Authored PostgreSQL regression, not executed

File:
`apps/server/src/platform_accounts/oauth/account_operations/disable_login_db_tests.rs`.
The test is `#[ignore]`. Its cases call actual production `set_renewal`, with
`Registry::disabled()` and counting synthetic JSON cipher callbacks. They do
not start application/router/maintenance/exchange owners, make provider
requests, use browsers, or invoke broad native-platform/owned-playback scripts.
No migration runner is included.

### Required isolated environment

A future authorized runner must provide a fresh disposable database, named
`rainsync_oauth_guard_test_<32 hex UUID digits>`, and provision the **entire
current migration chain through 0088** separately. Record all migration
versions/checksums and verify them against the frozen checkout. The fixture
only checks presence of 0066, 0081 and 0088 as an early rejection check; that is
not a replacement for full migration provenance. The old fixture ending at
0051 is insufficient and must not be reused.

The fixture requires both:

- `RAINSYNC_OAUTH_GUARD_DB_TEST=disposable-database-authorized`
- `RAINSYNC_OAUTH_GUARD_DATABASE_URL` pointing to that disposable database

There is no DATABASE_URL fallback. The authorization marker is checked before
opening pools. Before any fixture writes, `current_database()` must match the
unique test naming rule. Connection search_path is fixed to public, with
five-second statement and acquisition timeouts for setup, observations and
cleanup. The runner must independently verify ownership/isolation before
provisioning. Do not print or retain connection credentials in evidence.

The role needs its own test schema/table/trigger permissions and visibility of
test connections in pg_stat_activity/pg_blocking_pids. It must not point to a
production/shared database. Every returned case outcome attempts blocker
rollback, flushes actor rollback, removes only its synthetic rows/unique
trigger/function, and preserves cleanup errors alongside the original error.
The single serial test closes its pools on returned success or failure.
Process crashes and panics still require external disposal. On infrastructure
failure, stop the isolated process, confirm connections/locks are gone and
discard the disposable database instead of rerunning against unknown residue.
Do not loosen five-second production budgets to make a slow environment pass.

### Blocking matrix and exact oracle

`exact_login_disable_regression_matrix` serially runs 20 cases. It covers both
Douyin and TikTok, each at two observed waits, with live and expired controls:

- Account-row wait: another transaction holds the OAuth account `FOR UPDATE`.
- Late UPDATE wait: a uniquely named, synthetic-account-only BEFORE UPDATE
  trigger waits on an advisory transaction lock. The real operation already
  passed account locking and crypto. This catches an insufficient fence placed
  only before UPDATE.

The observer requires the actor's exact SQL, `wait_event_type='Lock'` and sole
specific blocker PID. It observes lock entry while the exact login is live.
The deadline was set before admission; the test waits for PostgreSQL's clock
to cross it naturally, without UPDATE of the share-locked session. Immediately
before release it rechecks the same actor/complete SQL, sole blocker and
unchanged deadline in one observation. Only then does it release the blocker
inside the existing five-second phase budget. A second login for the same user
stays live; account consent deliberately belongs to that sibling login.

For expired cases, require `401 session_expired`, one decrypt and one encrypt,
and exact equality of whole-account and whole-pending-request JSON snapshots
before/after, including token ciphertext, revision, consent, nonce, scheduling,
configuration, expiry, scopes, state and timestamps. A query through the same
single-connection actor pool flushes the dropped transaction's rollback before
the observer reads durable state.

For live controls, require success, revision 7→8, identical stored token values
under the next-revision envelope, the original cleared renewal fields, and all
other account/request columns unchanged.

The same test uses the observed account wait for both providers and requires
original errors for stale revision, enabled=true, revision overflow, bad token
envelope and encrypt failure even though login expired during the wait. It
verifies whole-row rollback and cipher call counts. A no-token expired account
must return session_expired without either callback and remain byte-identical.

### ORIGINAL / CANDIDATE protocol

Freeze these exact test bytes, source contracts, migrations and invocation
closure. Run the same ignored test with the same assertions on the pre-fix
operation and candidate in separate identically provisioned databases. On
ORIGINAL, the main expiry oracle is expected to fail because the old operation
returns success and mutates revision/token/renewal fields. Do not change
expectations with a baseline flag. On CANDIDATE, all cases must pass. Also test
the candidate with only the new guard removed: the same expiry oracle must
fail. Retain failures, stdout/exit codes, source/test/migration hashes,
lock observations and sanitized environment identity for every run.

Run only the exact module-qualified test name, with `--exact --ignored` and
serial execution; do not invoke generic native/owner suites:

- `platform_accounts::oauth::account_operations::disable_login_db_tests::exact_login_disable_regression_matrix`

Further release work remains separate: fresh-tombstone rollback on a failed
final fence, logout/account-exit scheduling, trigger/database phase faults,
commit-unknown outcomes, refresh/disable/unlink races and controlled real
provider custody/rotation. This fixture is the blocking regression for this
bug, not proof that all account/native validation is covered.

## Verification boundaries

The vanished original lane reported 85/85 pure Node source checks, rustfmt,
diff-check and independent source review. Those are historical records only;
their old filesystem logs and compiled artifacts are not present in this
reconstructed environment. The reconstructed patch must receive fresh Node /
diff verification and an independent review under its new commit identity.

No Rust toolchain is available to this reconstruction worker. No Cargo,
rustfmt, live PostgreSQL lock/rollback test, socket/native/provider/network /
browser test, user-computer/Codex operation, push, merge or deployment is
performed in this reconstruction. Rust parsing, formatting, type-check and
actual database execution remain separate parent-owned validation tasks.

Fresh reconstruction checks: the operation, new guard/fixture, and renewal
schema source contracts passed 85/85 under Node; `git diff --check` passed.
The complete reconstructed production file has Git blob
`36d29bb92d3a3331a17c75c84b0d2da1064259c9`, matching the retained original diff's
`36d29bb` prefix. The reconstructed earlier operation-contract file has blob
`9eeb37743405542569687fa835c130d1314e72a8`, matching retained `9eeb377`.
The runtime/formatting/compilation exclusions above remain unchanged.
