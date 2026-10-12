# Private source/settings/scan ingress extraction: bounded validation

Date: 2026-10-10 (UTC).
Base: `ffee0ab83a84ee010a0043f863a4e37d43e48003`.
Worktree: `/workspace/shared/rainsync-library-sources-lane-20261010`.
Branch: `dot/library-sources-ingress-20261010`.

## Implemented scope

The seven existing private-library source operations now admit their request
inside their existing catalog owner. Their HTTP adapters only keep Axum
extraction, the narrow composition-root capability arguments and `ok_json`.

- `add_source`, `update_source`, `attach_source`, and private `scan`: the original
  live feature gate precedes registered-account write authentication.
- `source_detail` and `scan_status`: registered-account read authentication,
  without a feature gate or Origin/CSRF requirement.
- `remove_source`: registered-account write authentication, without a feature
  gate. Retiring a source remains available when the feature is disabled.
- `attach_source` additionally retains its request admin check before beginning
  the original transaction, followed by its existing current admin rechecks.
- Each cipher operation receives only its required callback(s), and constructs
  the existing `Source*Context` from the same request's database reference.
  No callback is invoked during capability construction.
- `update_source`, `remove_source`, and `attach_source` consume their existing
  `CommittedLibraryChange` after confirmed commit and return the existing
  response even if the separate retirement attempt fails.

No new owner, repository, transaction, authorization token, credential format,
route, DTO, migration, package dependency, CI gate, or retry policy was added.
The other private-library families are not implemented or qualified by this lane.

## Preserved behavior checked directly against the base

A read-only comparison extracted each original function body and compared it
byte-for-byte with the candidate after removing only the new admission/context
prefix and normalizing the three receipt return expressions. For `scan`, the
new local context's reference at the delegation call was also normalized.
All seven original bodies matched. All original HTTP extractor signatures and
all other private-library handlers, including `authorize_media`, matched.

The entire original production section from the `One resumable, atomically
checkpointed page` comment to the end of `scan_source_page_as` matched byte-for-
byte after trimming only trailing whitespace. SHA-256 of that section:
`b2fca6383dc8c444bd378ac93fa7f7ac7537d4797f6b14d4af53427a245d868e`.
The new `#[cfg(test)]` module is outside that preserved section.

SQL literals and their order in both changed catalog files matched the base.
The following files remained byte-unchanged in this lane: `catalog/mod.rs`,
`catalog/library_authority.rs`, `catalog/source_rules.rs`, `catalog/scans.rs`,
`identity/request.rs`, `bootstrap/routes.rs`, and `main.rs`.

This preserves the source/library revision distinction, request admin snapshot
field interpretation plus transaction-current operator checks, source CAS before
decryption, config-only encryption, idle checks before deletion encryption, and
transaction-local response projections/current authority checks.

The scan scope check still precedes slot acquisition. HTTP scanning retains its
original single transaction. S3 retains initialization/completed-return, external
LIST/HEAD (100 items, concurrency 4, 60-second budget), and separate failed/success
checkpoint transactions. Both checkpoint paths preserve exact caller, manage,
source revision, scan generation and cursor fences. A failed checkpoint must be
authorized and committed before the original 502; authorization or stale-fence
errors can still take priority. Only a successful final page retires unseen
media. Shared-S3 dispatch remains in its original owner and uses the same page
core with the original restart selection and count alias.

## Executed checks

1. Node v24.19.0:

   `node --test tests/private-library-sources-ingress-contract.test.mjs tests/catalog-boundaries.test.mjs`

   Final result: **47 passed, 0 failed, 0 skipped**. This comprises 6 positive
   source-contract checks, 37 actual in-memory deletion/modification negative
   controls, and the 4 unchanged catalog capability checks. The controls mutate
   current production text, require the mutation anchor to exist, and require
   the relevant guard to reject the result. They never modify production files.

   The initial new-contract run exposed three assertion gaps and an incorrect
   test assumption about shared scan restart. The guards were strengthened and
   the baseline expectation corrected; the final rerun above is clean. No
   production semantics were changed to satisfy those test corrections.

2. Existing local formatter, without invoking Cargo:

   `/workspace/shared/refactor-tools/rust-1.98.1/bin/rustfmt --edition 2024 --check apps/server/src/catalog/private_sources.rs apps/server/src/catalog/scan_pages.rs apps/server/src/private_library.rs`

   Result: passed. `rustfmt` was not initially on PATH; the existing task tools
   installation was used. No installation or download was performed.

3. `git diff --check`: passed.

4. The original-body, SQL-order, scan-core and untouched-file comparisons
   described above: passed. These are source-equality checks, not runtime proof.

GitNexus MCP was absent from the active tools, no `gitnexus` command was on PATH,
and the worktree had no usable installed GitNexus runner or task index. Per
AGENTS.md, analysis used direct source and call-site checks. There is no current
indexed graph/impact completeness claim.

## Added Rust coverage: not run in this lane

Six unit tests were added in the two existing catalog modules:

- Closed lazy pool: read/removal authentication rejects before any database
  acquisition, business revision validation or cipher callback.
- Closed lazy pool: add/update/attach reject according to the process's existing
  feature setting and missing-cookie authentication before business validation
  or cipher callbacks.
- Library versus source name/revision reasons and leading-zero rules.
- Existing source DTO unknown-field and string-revision rules.
- Scan restart default and strict DTO shape.
- Closed lazy pool: private status/scan admission before database work or
  decryption, respecting the existing process feature setting.

The pool is constructed with zero minimum connections using `connect_lazy` and
is closed before operation invocation. These tests require no PostgreSQL server
or network/socket connection. Cipher callbacks panic if invoked. Tests do not
mutate environment variables; the parent may run the filtered tests in separate
processes with the flag disabled and with `PRIVATE_LIBRARIES_ENABLED=true` to
exercise both gate configurations. Such execution has **not** happened in this
lane, and writing the tests does not establish that they compile or pass.

## Explicit remaining qualification

Cargo build/test/clippy, complete workspace formatting, DB fixtures, socket or
HTTP fixtures, native Server runs, current-session/guest/Origin/CSRF matrices,
lock-wait expiry/demotion, commit failure/retirement failure injection, provider
pages/races, and shared-S3 behavior were **not run** here. The parent owns the
combined compilation and runtime qualification. The Node guards and six written
Rust tests do not replace those checks.

No network, database, socket, provider account, user computer, push, deployment,
P08/P09 work, or physical media/resource-disposal test was performed. No child
work was delegated by this lane.

## Candidate file fingerprints

SHA-256, before this document's commit:

- `apps/server/src/catalog/private_sources.rs`: `3ff6510f8c76b0c9d5bcd0190f9b63f3dcb04993e4e7bd5bc5c652f7e513a78f`
- `apps/server/src/catalog/scan_pages.rs`: `179a491a97e1034afa8d24b76c4914cb3ea2f50dac0b737523aa5c0199b5d65c`
- `apps/server/src/private_library.rs`: `c1d719a320012fb7ccaa7908f7dbcdc4b4ac4876ac561e1b87cc40aecda6958d`
- `tests/private-library-sources-ingress-contract.test.mjs`: `9a8001638d860242be1f00d578f4684619bfd6aa0d10ea98aba1d97f3aade2de`
