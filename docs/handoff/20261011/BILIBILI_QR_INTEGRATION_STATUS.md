# Bilibili QR backend integration

Recorded 2026-10-11 01:57 UTC. Production producer `a4d18ed16917273f51a707e78a68e8c538b4f0c4` was integrated as `719a387841fd291316ec514ff4e8903a0824bd81`; parent source-witness/registration checkpoint is `c3a457fbd623881355292c1baac748889a297378`. The preceding account checkpoint `b50b2e9` is retained. No remote publication, merge or deployment is claimed.

## Completed scope

`platform_accounts/qr_login.rs` owns the complete start, poll and cancel operations. HTTP adapters retain original extractors and private JSON responses. Start returns a named Replay/Created result preserving HTTP 200/201. Start and poll borrow RequestContext, PlatformHttp, and key-only cipher callbacks; cancel borrows only RequestContext. Conditional QR payload decryption occurs only for start at its original position; the response projection retains all eight fields. Existing shared helpers and old Rust test names remain in place.

All original transaction/lock/SQL/bind/nonce/expiry/consent/crypto/provider ordering is retained. Provider calls occur after their original claim commit and outside the database transaction. Failed start generation commits terminal state before returning the mapped error; failed poll releases its claim with the original cooldown before returning its error. Cancel's rate-limit transaction remains independent, so later invalid-ID/conflict failures can still consume rate allowance. Confirmed poll calls renewal store_grant inside the original account transaction; that helper now takes an encrypt callback instead of App without owning a new transaction.

This extraction does not add exact-result reconciliation, remote cancellation, provider retries or new login guards. Existing commit-unknown and provider-confirmed/local-persistence recovery limitations remain. See [operation details](../../BILIBILI_LOGIN_OPERATIONS_20261011.md).

## Verified at the integrated checkpoint

- Backend pure contracts: 463/463.
- CI verification contracts: 168/168.
- Owner-gate pure contracts: 25/25; no native owner execution.
- Server: 458 tests listed, only 99 explicitly selected tests executed; 120 successful invocations including 21 private-flag true reruns.
- Six new QR tests cover DTO/projection/cipher binding, Replay/Created outcomes, missing login and closed lazy authentication storage. They do not open PostgreSQL or contact a provider.
- Selected binary SHA256: `43a3367772deb700e99dbfe899cc75acc75966ccd7cfa86fc7d9fe14e33b892b`.
- Server all-target strict Clippy, workspace all-target check and all Rust formatting passed, locked/offline.
- Native runner syntax check passed, but the runner was not executed.

Source files were unchanged between the listed build and the selected run; c3a457f adds only parent test integration. Counts overlap and must not be summed as unique coverage. Frontend source is unchanged from b50b2e9; that checkpoint's 459 tests and frontend build were not rerun for this backend-only slice.

## Independent evidence and preserved failures

Independent review reconstructed the complete old operation token sequences and rejected 64 additional in-memory mutations. Entire old parent and renewal bytes were recovered by finite inverse transforms with unchanged historical hashes. Frozen producer source and integrated source match. Reviewer reran the final composed YouTube/QR tests: 110/110, including two parent locator tests.

The YouTube parent-file witness now first reverses the QR extraction and then its original extraction; its historical hash is unchanged. Three old negative controls initially hit the newly earlier QR callback rather than their owned YouTube wrapper (105/108); they now target the unique import_youtube_credential function, with the original pristine-pass and must-reject assertions retained. The initial failure log is retained. A parent command also used a nonexistent test:ci-contracts key after the backend passed; rerun uses the actual test:verification-contracts command. The first selected-Rust script rejected duplicate names from the all-target listing before executing tests; the retained discovery log was followed by an explicit server-bin-only listing and the successful exact-name run.

The legacy native-platform-postgres runner now hashes and extracts its completion SQL from the production-only QR child. Two pure positive/negative source tests prevent stale parent reads, omitted input identity or Rust test-fixture pollution. The runner also touches playback fixtures, so it remains unexecuted and outside runtime scope.

## Recovery and remaining limits

The preceding b50b2e9 bundle was independently restored in a new bare repository using only its required 5d976089 baseline bundle and then the candidate bundle. All 1,664 tracked paths, modes, object IDs and bytes matched; both fsck checks passed. The package is baseline-dependent, not standalone. This recovery result concerns b50b2e9, not the later QR slice.

No candidate native/database lock-wait, real expiry, HTTP, provider, browser or ORIGINAL/CANDIDATE qualification is claimed. P08/P09 and dependent denied playback paths remain excluded. The Bilibili account status/check/unlink slice is a separate ongoing implementation, not part of these completed results.

The subsequent account status/check/unlink slice has since been implemented and locally checked: [account integration](BILIBILI_ACCOUNT_INTEGRATION_STATUS.md). This page's own counts remain bound to its earlier checkpoint.
