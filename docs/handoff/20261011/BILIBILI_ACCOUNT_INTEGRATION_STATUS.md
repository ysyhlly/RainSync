# Bilibili account operation integration

Recorded 2026-10-11 02:07 UTC. Producer `a7813b14bd62da2977e265bdbd6250b5407e8f00` was integrated as `7453dcc`; source-witness/registration checkpoint is `22277c4daf05cc81b49dfe5db176cc19088c700f`. No remote publication or native qualification is claimed.

The complete status, check_login and unlink operations now live in platform_accounts/account_operations.rs. Adapters preserve the original Axum signatures, routes, body shapes and private HTTP 200 responses. Operations borrow RequestContext; check additionally receives PlatformHttp by value and a key-only decrypt callback. The old shared guards, locks, status projection and existing test paths remain.

Status retains its original conditional expiry normalization and does not create an account for an absent GET. Check retains authentication/revision/rate ordering, decrypt-before-first-COMMIT, exactly one provider check outside the transaction, then exact scope/live/expiry comparison before interpreting any provider result. Invalid follows its original conditional update; provider error returns unknown without deleting credentials. Unlink still has no body, expected-revision CAS or rate gate; its tombstone and expiry/revision behavior is unchanged. Bare begin/commit operations were not replaced with new maintenance timeouts.

## Verification

- Backend contracts 535/535; CI contracts 170/170; owner-gate pure contracts 25/25.
- Composed YouTube/QR/account pure contracts 182/182; these overlap the aggregate counts.
- Server listed 463 tests, executed 104 distinct explicitly selected tests with 125 successful invocations (21 private-enabled reruns).
- Selected binary SHA256: `b0f1ca4aeda49a5a47f758b1f7b332361d99d57603ad0e0f93993d74c0db8a75`.
- Strict server all-target Clippy, workspace all-target check and Rust formatting passed, locked/offline.
- Five new Rust tests cover pure ingress/projection/snapshot matching and authentication rejection against a lazy pool closed before invocation. They do not verify live PostgreSQL/provider behavior.
- Independent review matched complete operation bodies, 11 SQL chains and the full historical parent file. Its 38 independent mutations were all rejected; frozen producer contract rerun was 72/72.
- Four-file parent test integration independently reviewed without weakening: account inverse precedes QR inverse and then YouTube inverse; historical hashes and old negative controls remain. Exact backend command registration retains missing/duplicate/injected-command guards.

No frontend source changed from the preceding account-boundary checkpoint; its frontend tests/build are historical evidence, not claimed as a rerun here. No database, native fixture, real provider, browser, user computer or P08/P09 execution occurred. Real expiry/lock/COMMIT outcomes remain unverified.

Bilibili renewal status/set_preference is the final planned slice of this implementation batch and is still in progress at this timestamp. OAuth exchange/refresh ownership will not be mechanically split as an incidental change. See [operation details](../../BILIBILI_ACCOUNT_OPERATIONS_20261011.md).

The final renewal slice and integrated batch checks are now recorded in [final account batch status](ACCOUNT_BATCH_FINAL_STATUS.md); this earlier checkpoint remains unchanged evidence.
