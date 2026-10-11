# Short-platform account independent review, 2026-10-10

## Decision and scope

Baseline: `5d976089e3f44a767264a7cb76fe0e23bd321f55`.

The frozen production extraction has no identified source-level behavior defect. Its complete operations can be reconstructed from the baseline using only the declared transformations, and its patch passes `git apply --check`. It is **not approved as runtime-validated or ready for release**. The production candidate has not been applied by this review. Compilation, formatting, real original/candidate PostgreSQL runs and shared-cipher behavioral checks remain pending.

The frozen native fixture is **not acceptable unchanged as evidence**. Its import rollback comparator rounded PostgreSQL bigint JSON tokens through JavaScript `Number`. This review adds the formal native fixture with a lossless snapshot comparator and pure negative controls, without changing production code or the archived proposals.

A second test-only revision fixes the source-level response-drain/trigger-cleanup issue described below. Neither syntax checks nor the pure tests establish native execution or real process cleanup.

Read inputs: repository AGENTS.md, the handoff README, original refactor plan, status and source-index records, and short-account production/native members independently extracted from `docs/handoff/20261010/pending-source-proposals.zip`. No usable GitNexus MCP, CLI or current index was available; direct source inspection was used. No graph completeness claim is made.

## Frozen-input verification and metadata correction

- Production proposal: `short-platform-account-whole-family-v2-20261010T1316Z`; all 122 dependency inputs match the current baseline, and all 136 member sizes and hashes match.
- Native proposal: `short-platform-account-authority-native-20261010T1340Z`; all 131 dependency inputs match the current baseline, and all 136 member sizes and hashes match.
- Production POSIX-string-sorted aggregate matches `95cbdf091b55dbf0e4b951eb15a7c536fa9032dfbe206f1434de5450da915cec`.
- Native registered aggregate `b938df53a179a6ea1c78486d21a0bd83823fc4b56373ed10a08e1b948e98280a` is reproduced by Python pathlib component ordering.
- Under the documented POSIX path **string** ordering, the native aggregate is `39642976dfd0e4eea4b3d0769d96d8dd149419a58204af100474336751450828`.
- Both calculations use uint64BE path-byte-length, UTF-8 relative POSIX path, uint64BE raw-byte-length, raw bytes, with manifest.json excluded. This is an aggregate ordering metadata discrepancy, not member byte corruption. The original archive, manifests and input snapshots remain unchanged.

## Exact production changes proposed, but not applied

1. `apps/server/src/platform_accounts.rs`: retain the three HTTP extractor/response adapters, delegate complete status/import/unlink operations to the child, re-export the moved deserialize-only ImportCredential, and change only the canonical projection path in the existing Rust test.
2. New `apps/server/src/platform_accounts/short.rs`: own complete status/import/unlink operations, their existing status projection and ImportCredential. Dependencies are existing RequestContext, HeaderMap, PgPool and a borrowed Aes256Gcm primitive for import.
3. `apps/server/src/main.rs`: move the exact App::encrypt implementation to encrypt_value, retaining App::encrypt as the same-signature forwarder. Decrypt is unchanged.

No migration, route, frontend, lock SQL, parameter bind, body cap, error mapping, cookie parser, rate-limit policy, shared account/identity guard or shared UnlinkCredential is changed. The operations retain provider parsing before authentication, exact origin/CSRF/guest behavior, consent and revision validation, account admission, conditional UPDATE row-count checks, final exact-login checks, projection, commit and private HTTP response order. Status can retain its existing expired-credential tombstone write.

Independent reconstruction verified the whole original/candidate parent account file, all three complete operation spans and wrappers, the exact moved DTO/projection, whole main.rs, and whole-file inverse bytes/hashes. This exceeds simply accepting the prior static-byte-checks report, but remains source evidence.

## Shared encryption consumers and sensitive data

Direct source enumeration found 39 baseline `app.encrypt` call sites, including the moved short import and existing tests. The unchanged App forwarder therefore serves the other 38 sites; the child short import reaches the same single implementation directly. Catalog callback consumers remain reached through the existing closures.

Reviewed families include Bilibili QR and credential storage, OAuth request/token envelopes, renewal tokens, YouTube imports, platform pagination continuations, native VOD/live/other-live resources, playback requests/capabilities, distributed playback, HTTP fallback, upstream bindings/configuration, agent configuration, source/source-setting/private-library/catalog writes, static-HLS contract and existing crypto-using tests. Independent static-HLS input/operation ciphers and direct key-based test helpers are separate existing schemes and are unchanged.

The moved implementation preserves 12-byte OsRng nonce generation, serde_json byte serialization, AES-256-GCM call, encryption_failed mapping, concatenation and STANDARD base64 encoding. Old consumers retain the same input values, error handling and call positions. Random ciphertext is not claimed byte-identical across calls. No Debug/Serialize derive was added to imported raw cookies. The projection remains the closed, non-secret public DTO; logging, upstream clients, wire errors and private_json handling are unchanged. Compiler and behavioral validation across these consumers remain pending.

## Native fixture review

The fixture contains eight named groups, each exercising both Douyin and TikTok, with synthetic local cookies only:

- ingress/canonical parsing, import/status/unlink revisions, replacement and stale conflicts
- provider/authentication/origin/CSRF/JSON/body-cap priority and guest denial
- status, import and unlink exact-login expiry at the account admission lock
- import and unlink exact-login expiry at the final conditional UPDATE
- credential expiry and revision overflow

The final UPDATE groups require exactly HTTP 401 with `SESSION_EXPIRED`. They do not accept a 409 alternative. Their fixture-only BEFORE UPDATE trigger is target-account-UUID scoped, leaves product triggers installed, and witnesses the exact original SQL, unique blocked backend, holder, backend_start and blocking edge before and after one naturally expiring three-second deadline. The original live baseline must establish those expectations before candidate comparison; a differing outcome blocks and must not be hidden by loosening assertions.

Import's rate limiter commits in its own transaction before the account transaction. Failed imports must retain that one committed increment and otherwise preserve all selected rows. Status/unlink failures require unchanged selected snapshots. Requiring full-database rollback for import would be incorrect.

### Fixed: bigint rollback false negative

Original `rateChange` parsed snapshots with ordinary JSON.parse and compared the resulting numbers. The distinct tokens 9223372036854775807 and 9223372036854775806 both become the same Number. Consequently an import failure could incorrectly pass the unchanged-account assertion. Other selected bigint columns were affected too.

New `tests/fixtures/short-platform-account-snapshot.mjs` revives each integer from JSON.parse's exact source token directly into BigInt, keeps string and numeric types distinct, and fails closed on unexpected fractional numeric columns. Raw snapshot text and private receipts are retained. Every selected table, complete row, field and integer is compared; only one expected rate bucket increment or its initial insertion is allowed. New bucket fields are limited to the actual five-column schema. Duplicate keys and missing/extra tables fail. Both production provider paths use this same comparator; the expiry projection assertion uses BigInt consistently. The helper is included in the coordinator source hash and final recheck.

Pure controls distinguish extremes in the existing account and login-request revision columns and check fields across every selected table. Negative cases cover ordinary field changes, exact bigint changes, type changes, row/table additions and removals, other buckets, modified target timestamps/key/scope/extra fields, missing/double/string attempts, malformed new buckets and unexpected fractional tokens. Existing-bucket timestamp strings remain exact. A further test-only revision replaces the insufficient new-bucket end>start check with request-bracketing database-clock evidence, while retaining the increasing-window requirement.

### Fixed in third test-only revision: new-bucket 600-second window evidence

The inherited new-bucket comparison accepted any finite increasing timestamp pair, so even a one-millisecond or arbitrarily long window could pass. That was a fixture blind spot, not a demonstrated production rate-limit defect.

Each native snapshot now returns one SQL result containing the complete selected row JSON as text plus a separate `clock_timestamp()` normalized to six-digit UTC fractional seconds. The private receipt retains both; selected-row rollback comparisons still compare the original complete row content. Before-request and after-response snapshots provide the database time witnesses to the comparator. No JavaScript system clock supplies these witnesses.

For a new import bucket, the helper parses timestamps to exact BigInt microseconds, including numeric timezone offsets, and independently requires both `window_started` and `expires_at - 600 seconds` to lie inclusively within those database witnesses. This models the two separate production `clock_timestamp()` calls without asserting an incorrect exactly-600000-ms difference between the stored fields. Missing/reversed witnesses, invalid dates, extra fractional digits, non-increasing windows and out-of-bounds samples fail. Existing buckets still permit only attempts+1, with all other fields unchanged.

Added pure controls reject one-millisecond and twenty-minute windows, arbitrarily future windows, and either sampled instant one microsecond outside either bound. They accept exact microsecond endpoints and different within-bound samples, verify equivalent timezone representations, preserve the original increasing-window check even under broad witnesses, and check native evidence wiring. These checks validate fixture code with synthetic timestamps only; no PostgreSQL clock behavior has been executed or accepted.

### Fixed in follow-on test-only revision: pending response drain before trigger DROP

The archived expiryCase finally block caught a pending-response rejection/timeout, recorded the cleanup error, and nevertheless proceeded to DROP the trigger/function. It also treated bodyUsed as a sufficient reason to skip awaiting the body, although that flag means consumption started rather than completed. The archived README's unconditional drain-before-DROP claim was therefore not established.

The formal fixture now shares one memoized response.text() promise between HTTP assertion handling and finally cleanup. `bodyDrained` becomes true only when that exact read fulfills. Cleanup first attempts holder release, retains the existing separate 12000-ms response/read waits, and may DROP only when no request was started or successful drain is confirmed. Pending rejection, read rejection or timeout leaves an explicit `short_body_drain_unconfirmed` failure and skips DROP. The owned teardown still stops its Server/PostgreSQL resources; skipped DROP is not represented as completed cleanup. A late EOF after failed cleanup does not schedule another DROP.

Primary and cleanup errors remain ordered in AggregateError, with the original failure first. The existing mode-0600 private error receipt now serializes nested AggregateError details too; previously its top-level-only JSON could lose the actual primary error. Public reports still contain fixed failure categories and private-file digests/paths only. The response helper joins the coordinator's hash binding and final input recheck.

Pure fake-response/deferred-promise tests cover shared successful drain, pending rejection, read rejection despite bodyUsed, read timeout and late fulfillment, primary/holder/read failures together, primary plus DROP failure, prior assertion failure after successful drain, no-started-request cleanup, private-receipt failure, preservation of nested private error details, and native fixture wiring. No network or database is used. All original deadlines, three-second expiry setup, exact 401/SESSION_EXPIRED assertions and unrelated native case expectations remain unchanged.

## Actual checks in this review

- Node v24.19.0: snapshot pure/negative tests, 32 passed, zero failed/skipped.
- The first snapshot revision plus existing schema/route source tests passed 35/35.
- Follow-on response cleanup tests: 11 passed, zero failed/skipped.
- The response revision combined run passed 46/46.
- Final database-window revision: snapshot/precision/window controls 47/47; response cleanup controls 11/11; existing schema/route tests 3/3. Combined 61 passed, zero failed/skipped.
- Syntax checks for the formal native fixture and both pure helpers: passed.
- Frozen production `git apply --check` against this unchanged production baseline: passed; no application performed.
- Independent full-member/input hashes and source/inverse reconstruction: passed, except the explicitly corrected native aggregate ordering metadata.

Not run: Cargo, Rust compiler/rustfmt/Clippy, real native fixture, PostgreSQL, HTTP server, browser, sockets, provider accounts/network or original/candidate runtime comparisons. No production mutation, push, merge, deploy, P08/P09 or user-computer operation occurred.

## Required next gates

1. Independently review the now-corrected pending-response/trigger cleanup source and pure controls; real process/transaction cleanup remains untested.
2. Freeze and independently review the final fixture bytes, including helper and negative tests, and run that identical fixture against the original baseline first when database execution is authorized.
3. Apply only the three reviewed production paths in an independent candidate worktree; record any mechanical formatting changes and fresh inverse/hash evidence.
4. Run compiler, focused Rust/JS tests, strict Clippy and relevant aggregate checks; then run the identical native fixture against the candidate and compare full private evidence within the allowed nondeterminism.
5. Exercise shared App encryption/decryption consumers and preserve synthetic-only secret-safe evidence. Do not infer provider upstream validity, playback/drain correctness, full P03/P17 or full-plan acceptance from this local account extraction.
