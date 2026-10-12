# OAuth account operations: status, unlink and renewal disable

## Scope and baseline

This is the bounded backend operation extraction from baseline
`d5528e4d7ff3e9a6e770a1afe4cec22ff7d1f48b`, following the original refactor plan
in `docs/handoff/20261010/REFACTOR_PLAN_20261009.md` (§3, §4.1, §4.6 and P20).
It does not complete P20 or establish the broader deployment gates.

The existing OAuth owner now has a private `oauth/account_operations.rs` module
for three whole operations. Its HTTP functions retain the same State/Path/HeaderMap
and Json extractors, compose only capabilities, delegate once, and preserve
`responses::private_json(StatusCode::OK, value)`. No service layer or generic
repository is introduced. DTO declarations and routes stay in their original places.

Each operation receives `RequestContext` (borrowed PgPool and origin), an immutable
OAuth `Registry` reference, and its original request inputs. Only renewal disable
receives borrowed decrypt/encrypt callbacks with `Sync`; each HTTP callback closes
over the borrowed cipher key alone. No operation receives App, a raw key, provider
transport, upstream resolver, mutable registry, or native playback owner. Callback
construction does not encrypt or decrypt anything.

`status_value` was used only by these three endpoints and moves with them. It now
reads the immutable registry directly. The shared OAuth token-envelope, account
lock and scope helpers remain with their existing owner and are imported explicitly.
Other OAuth login/exchange/refresh owners are unchanged.

`maintenance::begin_db(&PgPool)` contains the original transaction acquisition and
SET LOCAL statements. Existing `begin(&App)` delegates to it. The 5-second begin,
phase and commit budgets, distinct error reasons, and maintenance start/drain bodies
are unchanged.

## Exact operation order

### Status

1. Parse provider, then authenticate as a non-guest read, then derive exact login hash.
2. Begin bounded transaction, acquire existing principal/login authority locks and check live login.
3. Retire stored tokens whose configuration binding differs, using the registry binding as the original third SQL bind.
4. Retire stored tokens whose refresh authority expired, retaining the original clock expressions and revision updates.
5. Read the OAuth account row, with the original optional-row behavior.
6. Check live login again, project the original private OAuth status, commit, and return the value.

### Unlink

1. Parse provider, authenticate as a non-guest write (including original origin/CSRF checks), derive login hash, parse expected revision.
2. Begin bounded transaction and acquire principal/login authority before account locking.
3. Insert-if-absent and lock the OAuth account via the existing helper; read scope and enforce expected-revision/inserted semantics.
4. Revoke the OAuth account and clear the original token/renewal/configuration/scopes/expiry fields with the original SQL revision increment.
5. Fail only its pending OAuth requests, clearing the original request secrets and operation fields.
6. Check live login again, read account, project status, commit, and return the value.

### Set renewal (disable)

1. Parse provider, authenticate as a non-guest write, derive login hash, parse expected revision.
2. Begin bounded transaction and acquire principal/login authority before account locking.
3. Insert-if-absent/lock account, read scope, then enforce revision match.
4. Reject `enabled=true` with the existing new-consented-OAuth-required conflict. Revision conflict retains priority over this rejection.
5. Compute the checked next revision. If there is a stored token, require its stored configuration binding, decrypt it, validate its existing owner/provider/revision/binding envelope, then re-encrypt the same tokens with the next revision. With no stored token, neither callback is invoked.
6. Disable renewal and clear the original consent/operation/next-refresh fields, preserving the existing optional-token and revision SQL binds.
7. Read account, project status, commit, and return the value.

The baseline disable operation has no final `guard_login_live` after waiting for
the account lock and no equivalent live predicate in its UPDATE. That difference
from status/unlink is preserved deliberately. This extraction does not claim to
repair or prove the safety of that existing behavior. No new configuration gate,
provider I/O, eager cipher work or post-lock validation has been introduced.

All three retain original SQL text and bind order, transaction boundaries, error
priority and reasons, projection fields and private/no-store response. OAuth account
and request tables remain separate from `platform_accounts` playback credentials
and native grants. P08/P09, frontend, migrations, package/CI setup, and shared test
manifests are outside this change.

## Local verification and limits

Author worktree: `/workspace/shared/rainsync-oauth-operations-lane-20261011`.
Evidence directory: `/workspace/shared/rainsync-local-validation-20261011/oauth-backend`.

- `node --test tests/oauth-account-operations-contract.test.mjs`: 38/38 final pass, including 30 in-memory mutation controls. Checks cover narrow capability signatures, order/error/cipher/live-check differences, HTTP-only composition and exact private response.
- The dedicated source contract inverts only the reviewed dependency/HTTP edits and recovers every byte of both baseline `oauth.rs` and `maintenance.rs`, checked by SHA-256. This includes unmoved DTOs, SQL, binds, login/exchange/refresh helpers, logs, shutdown and drain code.
- Combined final `node --test tests/oauth-account-operations-contract.test.mjs tests/youtube-account-ingress-contract.test.mjs`: 82/82 pass. The unchanged YouTube contract is a neighboring-boundary check, not OAuth runtime evidence.
- Direct installed `rustfmt --edition 2024 --check` on the two changed parent Rust modules, recursively covering their new child: pass. `git diff --check`: pass.
- Five Rust tests were added: complete unavailable-account projection for both providers; unchanged preference shape; invalid provider before authentication/body/cipher; missing login before revision/enabled/configuration/cipher; and closed authentication storage before body/cipher. Lazy pools are closed before operations, so these tests cannot open sockets. They were not run by the author; Cargo is reserved for the parent integration runner.
- The first dedicated Node run was 32/38: HTTP shape comparison did not account for rustfmt removing a trailing comma, and the mutable-registry mutation initially touched the projection rather than an operation signature. The second run was 37/38 because one mutation still targeted a pre-rustfmt line. Only the contract harness was corrected; all first and second failure logs remain. Production semantics were not modified to pass those tests.
- The pre-existing shared `platform-account-renewal-schema.test.mjs` run is 7/9, with its first failure log retained. Two location assumptions need integration-owned updates: the status projection now lives in the child module, and bounded `app.db.begin()` moved unchanged to bounded `db.begin()` behind `begin_db`. The shared test file was not edited here.

No Cargo compile/test, authenticated success path, live PostgreSQL lock/expiry race,
rollback, DB/socket/native/provider network, real browser, user computer, push or
deployment was run by this author. Pure source equivalence and closed-pool test
code do not establish those runtime properties.

No GitNexus MCP tool or installed local CLI was available in this task. Per
AGENTS.md, analysis used direct current-worktree source; no current graph index,
impact completeness, or graph-based detect_changes result is claimed.
