# Bilibili account operations

## Bounded extraction

Baseline: `719a387841fd291316ec514ff4e8903a0824bd81` (complete QR login operation extraction).
This follows `docs/handoff/20261010/REFACTOR_PLAN_20261009.md` and does not complete
P20 or claim the P08/P09, playback, deployment, or native runtime gates.

`platform_accounts/account_operations.rs` now owns complete `status`,
`check_login`, and `unlink` operations. The original HTTP functions retain their
Axum signatures, pass narrow capabilities once, and return private JSON with
HTTP 200. Routes and the 1024-byte check request limit remain unchanged.

- Status and unlink receive only `RequestContext` and request headers.
- Check additionally receives the existing `CheckLogin`, `PlatformHttp` by value
  (its existing Copy transport), and a borrowed Sync decrypt callback. The HTTP
  closure captures only the borrowed key. Callback construction performs no
  decryption and does not advance credential work before authentication.
- The three check-specific pure helpers move with check. The two original Rust
  tests stay at their existing `platform_accounts::tests` paths through a
  test-only import. `CheckLogin` and shared account/credential/login helpers,
  SQL selects, and `HTTP_SECONDS` stay in the parent.
- Parent imports of Bilibili `Client` and `LoginValidity` remain necessary:
  unchanged renewal code uses them through its existing `use super::*`.

There is no whole App, raw key, generic service/repository, new transport trait,
mutable owner, encryption callback, or new QR/renewal dependency in these
operations. QR and renewal production files are unchanged. The existing
`playback_login_allowed` SQL function remains an identity predicate; no playback
preparation, publication, delivery, or provenance implementation is changed.

## Preserved behavior and order

All three operations retain their original bare `db.begin()` and
`tx.commit()`. No maintenance timeout, retry, new CAS, or extra final check has
been added.

### Status

Authenticate the same non-guest read, derive the exact login hash, begin, guard
login, lock an optional existing account, and load `ACCOUNT_SELECT`. Only an
existing `connected` row with false `credential_live` uses the unchanged
`lock_account` expiration path. An absent GET never creates a tombstone.
The final live-login guard still precedes the original four-field account
projection and commit.

### Check

1. Authenticate the same non-guest write, derive login hash, parse the required
   expected revision, then spend the independent 20-per-600-second check rate
   limit. Its unchanged helper commits its own rate transaction.
2. Begin the first transaction, guard login, lock/read the optional Bilibili
   account, and compare the observed revision before any local expiration.
   Null still matches only no account. An existing revoked/expired row is not
   equivalent to absence. Stale observations still fail before expiry handling.
3. Apply the unchanged connected-expired helper path and live-login guard.
   No live credential produces verification `none` and null `checked_at`, commits,
   and returns without decrypting or calling the provider.
4. For a live credential, read scope, expiry, and ciphertext in that original
   transaction; decrypt, validate every credential envelope binding, parse the
   cookie, and commit. Missing or invalid secrets retain the redacted error.
5. Make exactly one existing provider check outside a transaction, using the
   original 20-second deadline. There is no automatic retry.
6. Begin the second transaction; guard login, lock/read the account, and require
   exact user/account/revision scope, liveness, and expiry equality. Snapshot
   conflict remains prior to every provider outcome.
7. Verified only reports. Explicit invalidity uses checked revision increment,
   the original owner/provider/revision/live-login SQL CAS, exact affected-row
   check, pending-QR retirement, and reread. Provider errors remain `unknown` and
   preserve the credential. Finally keep live guard, database timestamp,
   four-field check DTO, and commit in their original order.

### Unlink

Authenticate the same non-guest write and derive login hash; begin, guard login,
and call the original account lock. An absent account still creates its revoked
tombstone before the checked revision increment. Existing credential expiration
still happens inside that unchanged lock helper before unlink increments again.
The original account-ID-only update clears the credential and expiry, retires
pending QR requests, rechecks the login, reloads, projects, and commits.

Unlink continues to have no body, expected revision, rate limit, or added CAS.
Historical grant provenance stays immutable; the existing revision-based
revalidation behavior is not changed or executed by this work.

## Verification evidence

- Dedicated pure Node contract: 72/72 pass, including 60 in-memory negative
  controls. These check exact capabilities/imports/production shape, whole
  operation ordering, SQL predicates/binds, DTO, HTTP composition, routes,
  authentication-only test containment, and finite inverse hashes.
- Combined dedicated + existing OAuth operation + renewal schema contracts:
  121/121 pass.
- Direct installed Rustfmt, edition 2024, with `skip_children=true` passes on the
  two changed Rust files. `git diff --check` passes.
- Source-only first run: 69/72. The failures were harness assumptions about a
  blank line at the child test boundary, whitespace in the expected wrapper,
  and omission of `/v1` in the expected route. Correcting the route yielded
  70/72; correcting boundary/expected whitespace yielded 72/72. No operation
  semantics were changed to satisfy these checks.

`tests/fixtures/bilibili-account-source-inverse.mjs` exports the pure
`restoreBilibiliAccountParent(parent, core)` function. The caller supplies text;
it performs no reads, subprocesses, database work, or network calls. Its finite
edits restore the complete baseline parent file, including all unmoved code:

- Baseline `platform_accounts.rs` SHA-256:
  `cb5353b5fd892f880f63a484d041229291d3e57a1d70c88fe07309c6ca8fb350`
- Applying account inverse, then the existing QR inverse, recovers the unchanged
  older parent SHA-256:
  `209a350414d22549f5272c704fa05b18439593e619c184d49d3fd8f8a7071e4a`

Parent integration must compose account inverse before QR inverse before the
existing YouTube inverse. Existing historical hashes must not be updated to
accept changed behavior. Public package scripts, CI, native source locators,
and other slices' existing contracts are left to the integration owner.

### Rust tests prepared, not run by the author

New exact paths under `platform_accounts::account_operations::tests::`:

1. `check_ingress_keeps_required_raw_revision_and_defers_semantic_validation`
2. `check_projection_preserves_complete_receipts_and_absent_account_shape`
3. `exact_revision_and_expiry_snapshot_match_without_lossy_numeric_conversion`
4. `missing_login_precedes_revision_and_all_credential_work`
5. `closed_authentication_storage_precedes_origin_revision_and_credential_work`

The last two create and close a lazy pool before invoking any operation. Both
exercise all three operations; check's invalid revision cannot outrank missing
or closed-storage authentication, and its decrypt callback must remain unused.
The transport remains the real `PlatformHttp` type, not a fake provider. These
tests therefore do not establish provider outcomes, authenticated success,
transaction races, or live storage behavior.

Original exact paths remain:

- `platform_accounts::tests::validity_checks_require_observed_revision_and_reacquire_live_exact_scope`
- `platform_accounts::tests::check_ingress_and_response_never_accept_or_expose_secrets`

Cargo compilation/tests are exclusively owned by the parent integration runner.
No Cargo, database/socket, native runner, provider traffic, real browser, user
computer, push, merge, or deployment was executed here. The native platform
PostgreSQL runner also exercises playback behavior and remains excluded.

No GitNexus MCP or installed current-worktree CLI was available. Analysis used
current-worktree source under the documented fallback, without tool installs.
No current graph index, complete graph impact, or graph detect-changes result
is claimed. Exact source recovery and source contracts do not prove PostgreSQL
lock waits, expiry races, rollback, or provider success.
