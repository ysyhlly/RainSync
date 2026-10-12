# Bilibili renewal account operations

Baseline: `22277c4daf05cc81b49dfe5db176cc19088c700f`.
This is the last bounded account-operation extraction in this batch, following
`docs/handoff/20261010/REFACTOR_PLAN_20261009.md`. It does not complete P20 or
claim the P08/P09, playback, provider, deployment, or native runtime gates.

## Complete operation ownership

`platform_accounts/renewal/account_operations.rs` owns complete `status` and
`set_preference` operations and their operation-local `public_status` projection.
Both HTTP functions keep their Axum signatures and only pass
`app.identity_context()`, headers, and the existing preference body before
mapping the result to private HTTP 200 JSON.

Each operation receives `RequestContext`, not App, a service/repository, a raw
key, a crypto callback, or a provider transport. Authentication is the existing
`request::authenticate` path with the same read/write and non-guest arguments.
The existing maintenance pool-based begin, phase, and commit helpers retain
all timeout/error behavior and are not edited. There is one complete outer
transaction per operation, with no DAO transaction split.

`Preference` stays in `renewal.rs`, retaining required raw `expected_revision`,
required boolean `enabled`, and `deny_unknown_fields`. Shared account selects,
login helpers, revision parsing, account projection, and account locking remain
in their existing owner. `store_grant`, token/envelope handling, refresh passes,
refresh provider work, publication/reconciliation, and the original renewal
Rust test are unchanged. No playback implementation is changed or executed;
`playback_login_allowed` remains only the unchanged SQL identity predicate.

## Preserved differences from other account operations

### Status

The operation authenticates, derives the exact login hash, begins through
maintenance, and guards the login before reading `ACCOUNT_SELECT`.
It does not call account status, lock the account, create a tombstone, or clean
up expired credentials. In particular, there is no newly introduced
`credential_live` or credential-expiry filter.

The renewal query retains account ID and exact credential-revision equality,
owner, Bilibili provider, connected account state, originating consent login,
and `playback_login_allowed`. It does not filter renewal rows to scheduled or
running: the existing projection alone determines enabled state. The final
live-login guard precedes projection and maintenance commit.

### Set preference

1. Authenticate the same non-guest write and derive the exact login hash.
2. Parse expected revision before inspecting `enabled`. Invalid revision still
   fails as invalid input before the opt-in conflict.
3. `enabled: true` returns the existing 409
   `platform_renewal_new_consented_qr_required` before transaction begin or CAS.
4. For false, begin through maintenance, guard login, and call the existing
   `lock_account`. Its original tombstone and credential-expiry behavior stays
   intact, including any expiry revision increment within that transaction.
5. Require exact `Some(row.revision)`. Null is not an insertion permission or a
   wildcard. A conflict rolls the transaction back; the extraction does not
   separately commit a tombstone or expiry change.
6. Delete all renewal rows for the locked account ID. Do not add a consent-login,
   credential-revision, renewal-state, or affected-row restriction to this DELETE.
7. Retain the final live-login guard, project the original locked account row
   with no renewal row, and commit through maintenance.

The operation does not independently increment account revision, rewrite a
credential/token, reread the account, or adopt OAuth renewal semantics.
The seven-field renewal DTO and its complete four-field nested account DTO
remain identical; revisions remain decimal strings.

## Verification and retained evidence

- Dedicated pure Node source contract: 68/68 passed, including 57 in-memory
  negative controls. It covers exact capability/import/function shape, complete
  operation order, SQL predicates and binds, phase/commit use, projections,
  wrappers, routes, closed-lazy test containment, and finite inverse recovery.
- Combined dedicated, existing Bilibili account, and OAuth operation contracts:
  178/178 passed. These totals overlap and must not be summed.
- Existing QR operation plus renewal schema contracts: 75/77 passed before
  parent-owned integration adaptation. The two failures are preserved:
  - The old QR full-renewal hash needs the new operation inverse composed before
    its existing store-grant inverse.
  - The schema assertion for `new_consented_qr_login` needs the new production
    `public_status` owner, isolated from Rust tests, rather than the old parent
    file location. Its semantic condition must not be removed.
- Dedicated contract first run: 61/68. Seven harness failures were the old source
  reader not handling generic `phase`, two interface-only mutations being
  incorrectly expected to fail a body-only inverse, and four non-unique brace
  mutations. Generic-function bounding, explicit capability-plus-inverse
  validation, and uniquely anchored mutation construction fixed the harness.
  No production semantics changed to make these pass.
- Direct installed Rustfmt 1.98.1, edition 2024, `skip_children=true`, passes on
  both changed Rust files. `git diff --check` passes.

`tests/fixtures/bilibili-renewal-account-source-inverse.mjs` exports
`restoreBilibiliRenewalAccountParent(parent, core)`. It accepts source strings and
performs only finite replacements, without filesystem, subprocess, database,
or network access. Reconstructing the complete baseline `renewal.rs` gives:

`024b1189003887c466802cc08afc8245a11033952144b35729beb0535bda71c6`

Applying the new inverse and then the existing `restoreBilibiliRenewal` recovers
the earlier QR baseline full-file SHA-256 without changing its historical value:

`8d4a2d0c29096cd1e083c592c4493eeb03586fccd229c99422d74c26c6d92bed`

The dedicated contract also mutates each unmoved refresh/store owner to prove
that those edits cannot hide behind restoration of the extracted operations.
Interface shape is checked separately because the finite inverse intentionally
restores old HTTP signatures rather than treating current signatures as old
source text. Existing package/CI registration and historical source-contract
adaptation are left to the parent integration owner.

## Rust tests prepared, not run by this author

New exact paths under
`platform_accounts::renewal::account_operations::tests::`:

1. `preference_ingress_preserves_raw_revision_and_denies_unknown_fields`
2. `preference_revision_retains_null_and_exact_positive_i64_strings`
3. `renewal_projection_keeps_seven_fields_and_complete_nested_account`
4. `missing_login_precedes_revision_opt_in_and_transaction_work`
5. `closed_authentication_storage_precedes_origin_revision_opt_in_and_transaction_work`

The two async tests close a zero-minimum lazy pool before operation entry. Both
cover status and false/true preferences with null, invalid, and valid revisions.
They establish only authentication-error precedence when executed, not
successful authenticated transactions, provider behavior, locks, or rollback.
The pure DTO test exercises the no-renewal-row projection with absent and
complete nested account values; real PgRow state/timestamp branches are covered
by source equivalence and mutations, not claimed as executed Rust row fixtures.

The old exact path remains unchanged:

`platform_accounts::renewal::tests::refresh_envelope_requires_owner_revision_login_and_purpose`

Cargo compilation and execution of these Rust tests are exclusively owned by
the parent integration runner. No Cargo, database/socket, native fixture,
provider traffic, network/browser, user computer, push, merge, or deployment was
run here. In particular, the platform native PostgreSQL fixture also exercises
playback and was excluded. Static/source evidence is not native certification.

No GitNexus MCP or installed usable current-worktree CLI was available. Current
worktree source was inspected through the AGENTS fallback without installation.
No current graph index, complete graph impact, or graph detect-changes pass is
claimed.
