# Completed local account refactor batch

Recorded 2026-10-11 02:16 UTC. Final production/test-registration checkpoint: `204f9ae151629e822677d2b41019944ce7c0a3c9`. This closes the current implementation batch, not the entire refactor plan and not native/release qualification. GitHub transfer remains paused; no new remote branch, merge or deployment is claimed.

## Completed implementation

- Account frontend: Bilibili renewal and QR, plus seven OAuth response methods, use unknown transport boundaries and complete DTO copies after their existing identity/request fences. Earlier selected frontend tests and type/compiler controls are documented in [frontend/OAuth checkpoint](ACCOUNT_BOUNDARY_INTEGRATION_STATUS.md).
- OAuth account status, disable-renewal and unlink are complete operations with narrow request/registry/cipher capabilities.
- Bilibili QR start/poll/cancel are complete operations, retaining original claim transactions, provider-call boundaries, HTTP 200/201 and payload handling; cancel has no provider or cipher capability. See [QR checkpoint](BILIBILI_QR_INTEGRATION_STATUS.md).
- Bilibili account status/check/unlink are complete operations, preserving expiry normalization, snapshot/revision comparisons, provider check handling and unlink tombstone semantics. See [account checkpoint](BILIBILI_ACCOUNT_INTEGRATION_STATUS.md).
- Bilibili renewal status/set_preference are complete operations borrowing only RequestContext. Producer `86ea3585f35f38cae5c38241b229893a3a2144da` was integrated as `cfa9bcd`; HTTP wrappers retain private HTTP 200, request shape and existing error mapping. See [renewal details](../../BILIBILI_RENEWAL_ACCOUNT_OPERATIONS_20261011.md).

Renewal status intentionally does not lock the account or normalize expired credentials. The exact originating login and account revision still govern consent visibility. Enable=true is rejected before starting a transaction or account CAS; disable still requires Some(current revision), deletes all grants for the account, then performs the original final login guard and COMMIT. Disable itself does not increment revision or re-encrypt a token; the shared lock's existing expiry side effects remain. The five-second maintenance budgets and commit-unknown mapping are unchanged.

## Final integrated verification

| Check | Final result |
| --- | --- |
| Backend pure contracts | 604/604 |
| CI verification contracts | 172/172 |
| Owner-gate pure contracts | 25/25; not native owner execution |
| Selected Server Rust | 110 distinct, 131 successful invocations including 21 private-enabled reruns |
| Server discovery | 468 listed, not all executed |
| Strict Server all-target Clippy | Passed, locked/offline, -D warnings |
| Workspace all-target check | Passed, locked/offline |
| Rust formatting | Passed |

Final selected binary SHA256: `5d48abedc2671bda868349c2aa2815e58d62bf95201bcc17428530f97cb3aee6`.

The final increment adds five renewal pure/closed-storage tests and executes the existing refresh-envelope binding test. Closed lazy authentication pools are closed before operation invocation; no database service or real provider was contacted. The prior frontend checkpoint's 16 files/459 passing tests, exact-unknown compiler checks, Vue typecheck, ESLint, Vite build and bundle gate remain applicable to unchanged frontend files but were not rerun for the later backend-only slices. Counts overlap; do not add them as unique coverage.

## Independent verification and retained diagnostics

Each backend slice has an independent complete-operation/SQL/bind/order review and mutation controls. Renewal's independent finite inverse recovered every byte of its 23,285-byte predecessor and rejected 45 additional mutations. Its frozen author-related contract run was 178/178; the final six related contract groups were independently rerun at 428/428, with overlap. No production-equivalence finding remains open in this batch.

Parent contracts compose the account, QR and renewal finite inverses before the earlier historical witnesses; historical hashes were not refreshed or deleted. Renewal schema now checks the production public_status function, with negative controls excluding Rust test text and unrelated functions. Exact backend registration keeps all previous files and missing/duplicate/command-injection guards. No new native runner was registered.

Retained non-final failures include the old QR/schema source-location run (75/77 before parent adaptation), YouTube negative controls initially targeting an earlier QR callback, an incorrect parent command key, and a duplicate-name discovery rejection before any Rust test ran. Later successful runs do not erase these records. Existing ts-rs serde-attribute warnings remain; strict Clippy still passed. Earlier checkpoint reports retain their own failures and test boundaries.

## Deliberate stopping boundary and remaining work

The account batch stops here rather than mechanically splitting OAuth exchange/refresh helpers. Existing application-owned token custody, local persistence/reconciliation, rotation and positive shutdown drain are meaningful ownership boundaries. A future OAuth login slice needs its own complete-use-case design and evidence.

The full plan remains incomplete:

- Candidate native/database validation is still outstanding: exact-login expiry after lock waits, refresh/disable/unlink races, revision triggers and ambiguous COMMIT outcomes need actual ORIGINAL/CANDIDATE evidence with identical frozen test closures.
- The known OAuth disable path's missing final live-login guard after its account lock remains intentionally preserved and documented. Fixing it requires a separately scoped behavior change and blocking database regression test; extraction alone does not solve it.
- Real provider code/token single-use, rotation, lost-response custody and shutdown drain need controlled credentials and fault scenarios. Pure source equivalence and closed pools do not qualify them.
- The legacy native-platform-postgres fixture stops at migration 0051 and does not execute application transactions/provider flows; it cannot qualify renewal/OAuth migration behavior.
- P20 still includes unmigrated consumers and the move from source contracts toward production behavioral tests. P17/P20/P24 and whole-plan completion are not claimed.
- P08/P09 and previously denied dependent playback paths remain excluded. No user-computer/Codex operation, real DB/socket/provider/browser test, merge or deployment occurred in this batch.

The prior b50b2e9 baseline-dependent bundle was independently restored and all 1,664 tracked files checked. Newer bundles require their own restore verification; a bundle verify alone is not that evidence.

## Later, separately scoped OAuth behavior fix

The historical extraction status above remains a record of the completed batch.
A follow-on change now adds the missing final exact-login check to OAuth disable
inside its transaction, after the final account read and before projection and
COMMIT. This deliberately changes expired-login behavior; it is not another
claim of extraction equivalence. The old hashes remain intact behind an
explicit, narrowly checked behavior-fix inverse. See
[the fix, guard placement and blocking DB regression](../../OAUTH_DISABLE_FINAL_LOGIN_GUARD_20261011.md).
The dedicated PostgreSQL fixture is authored and ignored by default; real
ORIGINAL/CANDIDATE execution is still outstanding. This does not reopen or
complete any excluded native/playback or provider qualification.

The executor-loss recovery and reconstructed OAuth behavior fix are tracked separately in [recovery and guard status](RECOVERY_AND_OAUTH_GUARD_STATUS.md). Do not treat the earlier local paths or unfinished validation sessions as presently available evidence.
