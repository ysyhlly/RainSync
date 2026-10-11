# Bilibili QR login operations

## Scope and capability boundary

This bounded extraction starts at `b50b2e9ed32673cd42655d02cb7500236865f5ab`.
It follows the existing operation-boundary direction in
`docs/handoff/20261010/REFACTOR_PLAN_20261009.md`; it does not finish P20 or claim
P08/P09, playback preparation/publication, deployment, or native runtime gates.

`platform_accounts/qr_login.rs` owns complete `start_login`, `poll_login`, and
`cancel_login` operations. The HTTP functions retain their original extractors,
compose borrowed capabilities, delegate once, and return private JSON. Start
returns named `StartLoginOutcome::Replay(Value)` and `Created(Value)` variants;
the HTTP adapter explicitly maps these to the original 200 and 201 statuses.
Poll and cancel return the original JSON value with HTTP 200.

All three operations receive `RequestContext` and the original request inputs.
Start and poll borrow `PlatformHttp` plus `Sync` decrypt/encrypt callbacks whose
HTTP closures capture only the borrowed cipher key. Because `PlatformHttp` is
Copy and its reference does not implement the provider transport trait, the
existing clients are constructed with `Client::new(*http, None)`. Cancel receives
no transport or cipher capability. No service, replacement state machine,
generic repository, raw cipher key, whole App, or playback owner is introduced.

The existing conditional payload read becomes `qr_payload(decrypt, request)`:
only start invokes it, at the same response-construction points, and only a live
pending request can decrypt its payload. `qr_response` is the unchanged eight-field
pure projection, with start passing the conditional result and poll/cancel
passing `None`. The projection still clears stage only for non-pending status.
Shared login/account/request locks, scope/envelope validation, deadline,
terminalization, low-cardinality upstream diagnostics, and original QR tests
stay in the parent module. The `playback_login_allowed` name remains the existing
identity predicate; no playback preparation/publication code is introduced.

`renewal::store_grant` changes only from `&App` to a borrowed encryption callback.
Its consent-first/token-second checks, envelope, bounded SQL call, scheduling,
and binds stay in order. All other renewal code and all other platform owners
remain unchanged.

## Preserved complete operation order

### Start

1. Authenticate a non-guest write, including the existing origin/CSRF checks;
   derive exact login hash; then reject nil idempotency key or missing storage consent.
2. Begin the original transaction and acquire principal/login, account, and
   request locks in order. An existing request checks renewal-consent equality;
   pending requests retire on expiry, account mismatch, or unknown generation
   outcome with no active lease. Project, commit, and return replay (200).
3. Retire expired/orphaned pending requests, then reject another active request.
   Claim the existing 10-per-600-second start rate limit inside this transaction;
   even a denied claim commits before returning its rate error.
4. Insert the original exact-login/account/revision/consent-bound request and
   operation nonce; compute the original bounded deadline; commit before the
   single provider generation call.
5. Begin a second transaction; reacquire login, account, and request authority.
   Preserve status/nonce/account conflict precedence, expiry, then `can_complete`.
   Encrypt the existing key and payload envelopes only after these checks.
   A generation error terminalizes and commits before returning the redacted error.
6. Reload, conditionally decrypt the payload, project, commit, and return created
   (201), including the original created-but-expired branch behavior.

### Poll

1. Authenticate the same non-guest write and derive exact login. Begin, guard
   login, lock account, then lock request. Preserve expiry/account mismatch
   terminalization before non-pending, active-lease, or not-yet-due early returns.
2. Missing key terminalizes and commits without generating a replacement QR.
   Otherwise decrypt and validate the original bound key, claim a nonce with the
   original overall-expiry cap and next-poll time, compute deadline, and commit.
3. Make the single read-only provider poll outside a transaction, then begin and
   reacquire login/account/request authority. Preserve conflict precedence,
   current expiry, and completion-lease checks.
4. Waiting/scanned releases only the claim and advances cadence. Expired retires
   the request. Confirmed requires a session, checked revision increment,
   credential envelope, and the unchanged account/request/live-login SQL CAS.
   Store an optional renewal grant with original consent, terminalize confirmed,
   and fail other pending requests before final read/project/commit.
5. On upstream failure, release the poll claim and preserve the immutable request
   expiry before committing and returning the redacted error. A later poll may
   retry the same original key; this extraction adds no automatic retry.

### Cancel

1. Authenticate the non-guest write and derive exact login.
2. Spend the original 30-per-600-second cancellation rate limit using its own
   committing helper before opening the cancellation transaction. This placement
   remains before later nil-ID, missing authority, or request-binding errors.
3. Begin, guard login, reject nil ID, lock account, then insert the original failed
   tombstone with `ON CONFLICT(id) DO NOTHING` to fence reordered starts.
4. Lock the exact-login request, fail it only if pending, project with no payload,
   commit, and return 200. No remote request or cryptographic callback is available.

No guard, timeout, SQL predicate, bind, error priority, lock, retry, consent,
nonce, log, or transaction behavior is silently repaired by this extraction.

## Validation and limits

- Dedicated pure Node contract: 64/64 pass, including 51 in-memory negative controls.
  The contract checks complete operation shape and order, exact narrow signatures,
  HTTP composition and status mapping, split projection, renewal scope, and both
  full-file inverse hashes.
- Combined pure Node run with existing OAuth operation and renewal-schema contracts:
  113/113 pass. These adjacent contracts are source checks, not runtime proof.
- A finite exported inverse in `tests/fixtures/bilibili-login-source-inverse.mjs`
  reconstructs every byte of the baseline parent module and renewal module:
  - `platform_accounts.rs`: `209a350414d22549f5272c704fa05b18439593e619c184d49d3fd8f8a7071e4a`
  - `platform_accounts/renewal.rs`: `8d4a2d0c29096cd1e083c592c4493eeb03586fccd229c99422d74c26c6d92bed`
  The parent integration can compose `restoreBilibiliLoginParent(parent, core)`
  before its existing YouTube inverse; the old YouTube whole-parent hash must
  remain unchanged. No shared test, package script, CI file, or old hash was
  modified by this author.
- Direct installed Rustfmt with edition 2024 passes on the changed modules and
  child. `git diff --check` passes.
- Six new Rust tests cover original StartLogin parsing, complete projection and
  payload gates, corruption/every envelope binding, distinct named outcomes,
  missing-authentication precedence, and closed-authentication-storage precedence.
  Both operation tests close their lazy pools before use. All original QR test
  names remain unchanged. These six tests were not run by the author; Cargo is
  exclusively owned by the parent integration runner.
- The first dedicated Node run passed 61/64. Three signature mutations were
  correctly rejected by capability checks but an additional assertion wrongly
  expected body-only inversion to reject discarded signatures too. The harness
  was corrected to combine capability checking and inversion. The later requested
  no-cipher cancel split was reflected in source assertions and the finite inverse;
  production SQL/order was not changed to make a contract pass. Failure evidence
  is retained with the subsequent passing runs.

No Cargo, DB/socket/native runner, authenticated success, provider network,
real browser, user computer, push, or deployment was run here. The existing
`native-platform-postgres.mjs` locates the completion SQL in the old parent file;
its source locator needs an integration-owned update to `qr_login.rs`, but the
runner is excluded because it also exercises playback tables. Source equivalence
and closed-pool test code do not establish live PostgreSQL lock waits, expiry
races, rollback, or provider success behavior.

No GitNexus MCP or installed repository-local CLI was available. Analysis used
direct current-worktree source under the documented fallback; no current graph
index, graph impact completeness, or graph detect_changes result is claimed.
