# Short-platform account production extraction, 2026-10-10

## Delivered scope

Baseline: `5d976089e3f44a767264a7cb76fe0e23bd321f55`.

The complete Douyin/TikTok account status, credential import and unlink
operations now have one owner in `apps/server/src/platform_accounts/short.rs`.
The existing public handlers retain their HTTP extractors, response types,
private JSON response handling and route/body-limit registrations. The child
accepts the existing narrow `RequestContext`, provider, headers, and request
body; import additionally borrows the existing `Aes256Gcm`. It receives no
`App`, application callback or new service locator.

`ImportCredential` moved with its deserialize-only, deny-unknown-fields policy
and original public re-export. Shared `UnlinkCredential`, provider parsing,
account/session guards, revision validation, account selection and locking
remain at their existing owner for the other account families. The existing
projection test changes only its canonical helper path.

The original `App::encrypt` implementation moved to `encrypt_value`. The
same-signature method delegates to that one implementation; import uses the
same helper directly. `App::decrypt` is unchanged. This is an applied source
extraction, not a compiler or native-runtime acceptance claim.

## Preserved invariants

- Provider parsing still precedes handler authentication. Existing origin,
  CSRF, guest denial, login hashing and JSON-extractor precedence are retained.
- Consent, expected-revision validation and bounded allowlisted cookie parsing
  keep their original order and error mappings.
- Import's existing rate-limit increment remains outside the account
  transaction. A failed import must not be described as full-database rollback.
- Principal, originating session and account admission locks; SQL and bind
  order; conditional update row-count checks; exact-login rechecks; checked
  revision increments; projection and commit order are unchanged.
- Status retains its possible expired-credential tombstone write. Unlink
  retains immutable historical provenance and existing stale-revision fencing.
- Encryption still serializes the same JSON, obtains a fresh 12-byte OsRng
  nonce, uses AES-256-GCM with no AAD and the existing key, and STANDARD-base64
  encodes nonce followed by ciphertext/tag. `encryption_failed` and import's
  credential-error conversion are unchanged. Random ciphertext is not expected
  to be identical between calls.
- Credential envelopes retain their exact provider/user/account/revision
  bindings. Imported accounts remain explicitly unverified with no guessed
  expiry. No raw-cookie Debug/Serialize derive, secret logging, public secret
  field, provider URL, upstream request or key-management change was introduced.

An explicit source inventory reconfirmed 39 baseline `app.encrypt` calls.
There are now 38 unchanged calls through the compatibility method; the moved
short import reaches the same helper directly. This count is source evidence,
not runtime coverage of those consumers.

## Frozen candidate and reversibility evidence

The source is the frozen
`short-platform-account-whole-family-v2-20261010T1316Z` candidate in the original
handoff ZIP. All 136 member byte counts/hashes and all 122 captured dependency
inputs were independently checked against this baseline. Its POSIX-string-sorted
aggregate is
`95cbdf091b55dbf0e4b951eb15a7c536fa9032dfbe206f1434de5450da915cec`.
The archived ZIP, manifests, snapshots and historical review were not modified.

After removing only the newly authored `cfg(test)` additions, each of the three
actual production files equals rustfmt output of its frozen candidate byte for
byte. Formatting reordered/wrapped imports and function arguments, collapsed
the unchanged rate-limit call, wrapped the encryption helper call, and removed
the candidate's extra EOF blank line. No production policy adjustment was made.

A fresh inverse patch made from the actual four changed Rust files passed
reverse application in a separate probe directory. It restored both original
files byte for byte and removed only the two new Rust files. Exact original,
formatted-production and final-file hashes are recorded in
[the validation record](SHORT_ACCOUNT_PRODUCTION_VALIDATION_20261010.json).

No GitNexus MCP, usable CLI installation or current index was available in this
task. Direct source inspection and byte reconstruction were used under the
repository's fallback guidance; no graph/caller completeness is claimed.

## Checks actually run

- Frozen candidate `git apply --check`: passed.
- rustfmt 1.9.0-stable (Rust 1.98.1 toolchain), edition 2024, explicit
  `skip_children=true`, for all four changed Rust files: passed.
- Existing short-account schema/route source checks: 3 passed.
- Combined short-account schema, backend-cleanup and server-bootstrap Node
  source checks: 16 passed, 0 failed, 0 skipped, on Node v24.19.0.
- Actual-file/formatted-candidate and inverse byte checks: passed.
- `git diff --check`: passed.

These checks ran on this isolated production lane based on the stated baseline;
they do not validate a later tree combining the other operation extractions.

## Tests authored but not run

Four pure Rust tests use only fixed synthetic key bytes, synthetic values and
in-memory AES/JSON operations. They construct no App, database pool, HTTP client
or external account:

1. Shared cipher framing and exact serialized JSON for null, booleans, integer
   extremes, Unicode, nested values and revision strings.
2. Nonce/ciphertext/tag tampering, wrong-key rejection and unchanged empty-AAD
   framing.
3. Fresh nonces for repeated values.
4. Both short providers' parsed synthetic cookie envelopes through the actual
   shared encryption helper, preserving exact bigint-as-string revision and
   rejecting wrong provider/user/account/revision bindings.

Existing ingress, projection and envelope tests remain. The new tests are
ordinary non-ignored tests under `encryption_tests` and
`platform_accounts::short::tests`; the parent owns their compiler/test run.

## Remaining gates and limits

No Cargo command, Rust compilation, Rust test, Clippy, PostgreSQL, server,
socket, native original/candidate comparison, browser, real provider account or
upstream request was run in this lane. The native fixture and its BigInt/drain
cleanup work are owned by a separate lane and were not edited here.

Before native acceptance, the final independently reviewed fixture must run
against the original baseline first and then the candidate, preserving exact
401/session-expiry assertions, the committed import rate-limit increment,
lossless snapshots and positive owned cleanup. Shared crypto-consumer behavior,
full compiler/strict Clippy and relevant aggregate gates remain to be checked.

No new real credential, migration, push, merge, deployment, P08/P09 work or
user-computer operation is included. This does not establish full P03/P17 or
release readiness.
