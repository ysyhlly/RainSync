# YouTube account ingress

Date: 2026-10-10. Base: `af1bb109fabf89b942d05772b26dbe9fc8dac01e`.
Branch: `dot/youtube-account-ingress-20261010`.
Worktree: `/workspace/shared/rainsync-youtube-ingress-lane-20261010`.

## Scope and resulting boundary

Only two production files change:

- `apps/server/src/platform_accounts.rs`: replace the three YouTube handler re-exports with same-name, same-extractor HTTP wrappers and re-export the existing `ImportYoutubeCredential`. Each wrapper assembles narrow dependencies, delegates once, and preserves `responses::private_json(StatusCode::OK, value)`.
- `apps/server/src/platform_accounts/youtube.rs`: complete `status`, `import`, and `unlink` operations receive the existing `RequestContext`, an immutable startup opt-in boolean, and original headers/body. Import alone receives `&(dyn Fn(&Value) -> anyhow::Result<String> + Sync)`. Operations perform request admission through the same request authenticator, then all original validation, transaction work, response capture, and COMMIT.

The import wrapper first borrows `app.key.as_ref()` and constructs a closure capturing that reference, using the existing `crate::encrypt_value`. Construction performs no encryption. No operation receives App, raw cipher/key, decryption, provider resolver, or a catalog-specific context/factory. The existing private response helper and ten-field status projection remain unchanged. DTO acceptance is not tightened.

The original shared account/login/revision helpers remain in their existing owner. No separate transaction, admission token, service, or helper state machine is added.

## Original order preserved

- Status: non-guest read authentication → login hash → begin → principal/session guard → YouTube account UPDATE lock → select → only connected-but-expired account normalization → live guard → response snapshot → COMMIT. Missing accounts are not created just for status.
- Import: non-guest write authentication → login hash → opt-in → consent → expected revision → one `SystemTime::now` at its original location → parse → rate limit outside the operation transaction → begin → principal/session guard → provider account lock → CAS → checked overflow → encrypt → live guard → exact-login-predicated UPDATE and affected-row check → live guard → select/response snapshot → COMMIT.
- Unlink: non-guest write authentication → login hash → expected revision → begin → principal/session guard → provider account lock → CAS → checked overflow → exact-login-predicated UPDATE and affected-row check → live guard → select/response snapshot → COMMIT. There is no new pre-UPDATE guard, rate limit, or cipher call.

Status/unlink are not gated by import opt-in. They report its value in the existing response fields. Import evaluates that gate after authentication/hash and before body validation.

YouTube's cipher position is deliberately different from the short-platform operation: CAS/overflow precede encryption, and its next live guard follows encryption. A later session-expiry rejection can therefore occur after encryption. Rate limiting remains outside the transaction, so some subsequent failures can retain the original rate increment. This extraction does not alter either behavior.

All SQL, binds, errors, CAS/overflow handling, cookie expiry projection, login checks, response fields, and commit propagation retain their original bytes after reversing only the reviewed boundary edits. No additional wall-clock call or clock injection is introduced.

## Local checks passed

Command:

`node --test tests/youtube-account-ingress-contract.test.mjs tests/youtube-platform-account-schema.test.mjs tests/server-bootstrap-contract.test.mjs`

Result: **53/53 passed**:

- 8 new positive source contracts.
- 36 new in-memory negative controls against actual production source, including four explicit ordering changes. Each first validates its pristine guard, requires an actual mutation, then requires rejection.
- 2 existing YouTube schema/route checks.
- 7 existing server bootstrap contracts.

The new contracts check narrow operation signatures/capabilities, exact request flags and HTTP wrappers, opt-in classification, original order of clock/parse/rate/CAS/overflow/cipher/guards, SQL predicates and expiry binding, private responses, lazy-pool closure, and absence of eager encryption or full App capture. They include two reversible baseline checks:

1. Inverting only the explicit dependency/auth/return substitutions recovers the complete pre-test production prefix of baseline `youtube.rs` byte-for-byte, including its DTO and status projection.
2. Removing the three thin wrappers and restoring the original re-export recovers all baseline `platform_accounts.rs` bytes, including shared guards, revision helpers, and every unrelated platform operation/test.

Commands also passed:

- `/workspace/shared/refactor-tools/rust-1.98.1/bin/rustfmt --edition 2024 --config skip_children=true --check apps/server/src/platform_accounts.rs apps/server/src/platform_accounts/youtube.rs`
- `git diff --check`

GitNexus navigation limitation: no MCP tools or available task/current-checkout/shared-tool-installation runner were found. No current worktree index was available. The documented AGENTS fallback was used: direct source inspection and exact baseline comparison, without installing tools or claiming graph/impact coverage.

## Rust tests added, not executed in this lane

The two original pure Rust tests remain. Six additional synthetic tests cover:

1. Status requires login with either startup opt-in value.
2. Import rejects missing login before opt-in/body validation and never invokes the supplied cipher callback.
3. Unlink rejects missing login before revision validation with either opt-in value.
4. A closed authentication pool yields the existing safe database error before import gate/body/cipher work.
5. Import/unlink DTOs retain arbitrary JSON revision shapes for later semantic validation, original string/bool wire types, and unknown-field rejection.
6. Synthetic YouTube Netscape input is parsed and placed in the original six-field provider-bound envelope, encrypted via the same narrow callback shape, and decrypted in the test. Wrong provider/user/account/revision and numeric revision representations fail the existing scope checks.

All four async entry tests construct a lazy pool with zero minimum connections and close it before invoking any operation. Even an accidental query cannot open a socket. They do not simulate a valid database-authenticated session, and do not dynamically instrument the system clock. Cipher roundtrip tests exercise the shared cipher/envelope path, not a successful database import.

The integration owner should compile the new source and run `platform_accounts::youtube::tests`, alongside the existing platform scope/revision and provider YouTube account tests. This lane did not invoke Cargo or reuse an old binary as evidence for new source.

## Remaining validation and exclusions

Source contracts are not runtime proof of valid-session success, guest/Origin/CSRF precedence, opt-in-disabled successful status/unlink, post-auth gate/consent/revision failures, PostgreSQL lock waits or natural expiry, successful writes, rollback, rate increments, COMMIT outcomes, or private HTTP headers. These need the separately authorized native YouTube authority fixture described by the implementation design. Short-platform runtime evidence does not substitute for YouTube-specific tests.

No Cargo, DB, server, socket, network, real account/credential, extractor, user-computer action, push, or delegation was performed in this implementation lane. No package/CI/main/shared guard/provider/playback changes were made. P08/P09 and all playback work are excluded. This is a local structural extraction with pure source verification, not native authority parity or release readiness.
