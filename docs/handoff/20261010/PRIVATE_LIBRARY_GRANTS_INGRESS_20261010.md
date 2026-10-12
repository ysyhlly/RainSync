# Private-library library/grants ingress

Date: 2026-10-10. Local implementation and source-contract evidence only; Rust compilation and runtime qualification are pending parent integration.

## Scope and baseline

- Baseline: `ffee0ab83a84ee010a0043f863a4e37d43e48003`.
- Worktree: `/workspace/shared/rainsync-library-grants-lane-20261010`.
- Branch: `dot/library-grants-ingress-20261010`.
- Production edits: `catalog/libraries.rs`, `catalog/media_reads.rs`, and only the ten corresponding handlers in `private_library.rs`, all beneath `apps/server/src/`.
- No changes to `main.rs`, `library_authority.rs`, `identity`, other handler families, routes, DTO fields, migrations, protocol, package scripts, or CI.

All ten ingress operations now accept the existing `identity::RequestContext` and original headers. Each owns its original request admission before its existing work:

| Operation | Admission before original body | Return |
| --- | --- | --- |
| list | read, registered only | original value, with current `enabled()` |
| issued_shares | read, registered only | original filtered page |
| create | feature gate, then write, registered only | original committed snapshot |
| detail | read, registered only | original detail projection |
| rename | write, registered only; no feature gate | original committed snapshot |
| grant | feature gate, then write, registered only | original committed snapshot |
| revoke | write, registered only; no feature gate | original committed snapshot |
| remove | write, registered only; no feature gate | original committed deletion value |
| transfer | feature gate, then write, registered only | original committed transfer value |
| list_private media | read, registered only | original current-visibility page |

The three gated writes still read the existing exact-`true` environment flag at request time. No universal feature middleware or cached setting is introduced. HTTP handlers retain their original extractors, compose the narrow inputs, and call `responses::ok_json` once. `remove` uses the baseline's no-side-effect `catalog_encryptor` factory; its `SourceWriteContext` is constructed inside the operation from the same request pool after authentication. Its actual encryption call remains after source locks, managed-source rejection, and idle/cleanup checks.

The six mutations still own exactly their original transaction. They consume the existing `CommittedLibraryChange` only after `commit_caller(...).await?`, returning `Value`; none creates a second transaction owner, generic authorization token, post-commit detail read, or retirement task. `library_authority` retains the existing warning-and-original-value behavior on retirement failure and remains unchanged. This does not prove actual physical media disposal.

## Executed checks

Executed locally, without Cargo, a database, server, network, or socket fixture:

1. Node v24.19.0:
   `node --test tests/private-library-grants-ingress-contract.test.mjs tests/catalog-boundaries.test.mjs`
   Result: 37 passed, 0 failed/skipped. The new file has 33 tests, comprising 9 positive source checks and 24 in-memory mutation negative controls; the existing catalog boundary file contributes 4 tests.
2. Standalone rustfmt 1.9.0-stable from the existing Rust 1.98.1 toolchain:
   `rustfmt --edition 2024 --check apps/server/src/catalog/libraries.rs apps/server/src/catalog/media_reads.rs apps/server/src/private_library.rs`
   Result: passed. This is parsing/formatting evidence, not Rust type-checking.
3. `git diff --check`: passed.
4. One-off baseline source comparison: for each of the ten operations, remove only the added request-pool binding, admission, local narrow context construction, and receipt-consumption change; the remaining original operation body matches baseline with formatting whitespace normalized.
5. Exact production Rust string-literal sequence comparison against baseline: all 162 strings in `catalog/libraries.rs` and all 6 in `catalog/media_reads.rs` match, including SQL/projection strings. No test-only strings were included.
6. Exact function comparison: existing `name`, `revision`, `library_value`, `detail_value`, shared media `list`, and shared media `read` are unchanged.
7. Removing only the ten authorized HTTP handler definitions leaves the entirety of `private_library.rs` byte-identical to baseline. This includes its other ten handlers, imports, playback `authorize_media` adapter, and `enabled`/`retire_maintenance` re-exports.

The new source-contract tests cover the exact ten adapters, narrow capabilities, 3/3/4 gate/write/read classification in this family, guest rejection modes, ordered validation and locks, current media visibility/pagination, library leading-zero revisions, transaction-local projection before commit, receipt consumption after commit, and retained maintenance semantics. Negative controls mutate actual production text in memory, including misplaced feature checks/authentication, broad cipher capture, early receipt construction, extra transaction, weaker create lock, skipped final manage check, early encryption, lost current visibility, and retirement error propagation. These checks are architectural guards, not database/HTTP behavioral qualification.

## Added Rust tests, not executed in this lane

Nine new tests were added:

- Four pure tests: library positive leading-zero/ASCII/i64 revision bounds; trimmed Unicode name length/control rules; write DTO unknown-field rejection; private media query defaults/type rejection.
- Five async admission tests covering all ten real operation functions with missing session headers. Each constructs a lazy zero-minimum pool, closes it before invocation, and asserts it is closed. No connection is opened, and accidental SQL fails immediately without opening a socket.
- The `remove` admission test supplies a counting, deliberately failing encryption callback and asserts zero calls for the missing-session rejection, before revision/shared-protection logic. It does not claim every later rejection avoids encryption.
- The three gated operations share a test which follows the process's actual flag. It never mutates environment variables. Parent qualification must run this test in separate enabled and disabled processes to cover both expected outcomes: `401/login_required` versus `503/private_libraries_disabled` ahead of invalid business input.

Suggested parent test filters after compiling the integrated source:

- `catalog::libraries::tests::`
- `catalog::media_reads::private_admission_tests::`
- Repeat the gated-write test with `PRIVATE_LIBRARIES_ENABLED=true`, and with the variable unset (or any value other than exact `true`).

These tests have not been compiled or run here. They cannot prove exact-session expiry, Origin/CSRF behavior with a valid session, transactional lock waits, CAS, committed state, or post-commit retirement failure behavior.

## Limits and integration requirements

No available GitNexus MCP tools or existing CLI runner were found in this task's tool catalog/current checkout. As required by `AGENTS.md`, analysis used direct current-source inspection and baseline comparison; there is no graph/impact completeness claim. No tooling was installed or downloaded.

Per lane constraints, no Cargo command, database/socket fixture, network operation, user-computer action, push, or delegation was performed. No P08/P09 work is included.

The parent owns final build/type-check/clippy/unit-test execution, package/CI integration, and any separately authorized HTTP/PostgreSQL qualification. Still unverified here: callback lifetimes/type-checking, the full authenticated ingress matrix, natural-expiry/lock races, all original committed-change runtime scenarios (including deferred retirement failure), and live private media pagination. Existing private-library settings/expiry/committed-change and catalog-media behavioral suites remain necessary; static source checks do not replace them. Unknown-result COMMIT disconnects and real media/process/socket disposal remain outside this lane's evidence.
