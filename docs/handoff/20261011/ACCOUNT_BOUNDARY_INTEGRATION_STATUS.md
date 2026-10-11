# Account response and OAuth operation integration

Recorded 2026-10-11 01:38 UTC. Implementation/test-registration checkpoint: `a69e04e4b283b73363688bf60a128c3300c38dcd`, based on the unchanged-tree transfer tip `d5528e4`. The prior `d9c05dc` checkpoint and its local bundle remain retained. This batch follows the instruction to continue implementation; GitHub transfer is paused, and no new remote branch, merge or deployment is claimed.

## Integrated complete scopes

| Scope | Producer | Integrated commit |
| --- | --- | --- |
| Bilibili renewal frontend GET/PUT | `1aece2ee071150bfc072aba501806af78db3ba24` | `7d98876` |
| Bilibili QR frontend start/poll/cancel | `57f097e974fac3480e58c88a74920314bf750d5b` | `d72a25d` |
| OAuth frontend seven response methods | `c5705ec7f1a4cecdae48751907e24bd016f952ef` | `428aeeb` |
| OAuth backend status/set-renewal/unlink operations | `e30841cea13dcafd1ca609b46fce9af17cb2aeb6` | `f71bcf3` |

Frontend methods now return unknown. Consumed responses pass their existing request/identity fences before parsing; validators return complete DTO field copies. Cancel responses were and remain ignored opaque values, not validated cancellation receipts. Public request URLs, methods, request bodies and consent behavior remain unchanged. Two Vue component templates/styles were independently confirmed unchanged.

This is not a claim that every path has the same fence: QR retains its existing post-await deadline. OAuth intentionally retains its prior late in-flight terminal acceptance and lack of new write-operation serial/post-await deadline checks. No new capability URL, consent or upstream authorization flow was added.

The shape changes are explicit, not described as only type annotations: renewal now fully validates its nested Bilibili account instead of only provider; QR requires its declared stage and nullable payload fields; OAuth rejects non-string revisions that old regex coercion admitted. JSON primitive/array records are rejected and extra DTO fields are not propagated. Existing state/revision/expiry and provider distinctions remain, including large revisions as strings. The boundary is JSON values, not arbitrary current Proxy objects or sparse non-JSON arrays.

Backend HTTP handlers retain their extractors and private/no-store response mapping. Complete OAuth operations own authentication, all original SQL/binds, locks, cryptographic work, projection and COMMIT. They borrow RequestContext and a read-only Registry; disable additionally receives key-borrowing decrypt/encrypt callbacks, not App/raw key/provider I/O. The pool-based maintenance begin helper preserves the five-second begin/statement/lock budgets and error mapping; existing App callers delegate to it.

Status's two cleanup UPDATEs remain distinct. Unlink still revokes the OAuth account and terminates pending OAuth requests atomically. Disable retains the token under its new revision while disabling renewal. Its original missing final live-login recheck after the account wait is explicitly preserved; this extraction does not claim to close that behavior. P08/P09, native playback credentials/grants, exchange/refresh owners and provider transports were not changed.

## Actual integrated verification

| Check | Result |
| --- | --- |
| Selected frontend account/identity suite | 16 files, 459/459 passed, one worker |
| Shared response type compiler | Passed; 21 methods required to return unknown |
| Compiler-memory negative controls | 13 single-method typed bypasses, each rejected with TS2344 and TS2578 |
| Additional QR compiler contract | 1/1 passed, 3 per-method negative controls; overlaps shared controls |
| Vue application typecheck | Passed |
| Full frontend/packages ESLint | Passed |
| Vite production build | Passed; existing large-lazy-chunk warning retained |
| Bundle gates | 4/4 passed; initial JS 405734/409600 bytes, 15 lazy pages |
| Backend pure contracts | 397/397 passed |
| CI verification contracts | 166/166 passed |
| Owner-gate pure contracts | 25/25 passed, not native owner execution |
| Selected Server Rust tests | 93 distinct, 114 successful invocations: false flag 93, then private flag true 21 |
| Server discovery | 452 listed, not all executed |
| Server all-target strict Clippy | Passed, locked/offline, `-D warnings` |
| Workspace all-target check / Rust formatting | Passed, locked/offline |

The selected Server binary SHA256 was `02d1c12deb5455f7a712cb1615c007e67e0403b73cc22a4cd4c1dfe376761881`. Ten additionally selected tests comprise five new operation projection/input/closed-auth-storage tests, three existing OAuth token/callback tests and two existing maintenance pure-budget tests. Closed lazy storage tests do not open a database. The callback test constructs an HTTP response in memory, not a provider/browser exchange.

Counts overlap across producer/reviewer/integrated suites and must not be summed into a distinct overall total. This run deliberately did not execute the full frontend playback suite, native DB/server fixtures or all 452 Rust tests.

## Independent review and retained failures

- Frontend reviewer established a baseline 91/91 oracle, then separately ran renewal 23, QR 27 and OAuth 41 against the frozen producers, all passing. Independent exact-unknown type assertions passed; the same type oracle on baseline failed as intended. Cross-worktree duplicate Pinia caused an initial reviewer-only 24-test failure; its initial log remains, and only reviewer module resolution was corrected.
- Backend reviewer recovered complete original operation token sequences and reviewed 22 independent mutations. Exact five-file patch reverse/forward restoration matched baseline and producer. No production acceptance change was found.
- Parent adapted the old renewal-schema location assertions without weakening ownership: production projection is isolated from `#[cfg(test)]`, both maintenance functions have separate bounded assertions, native-account-table prohibitions cover parent and child. Two negative tests prevent test-fixture or unrelated-function text from satisfying production assertions.
- Producer contract first runs 32/38 and 37/38, old schema 7/9, renewal's poisoned-getter assertion formatter failure, and the additional Vue.mergeModels test-helper declaration limitation remain in their original evidence. Later passing runs do not erase them.

Detailed scope reports: [renewal](../../BILIBILI_RENEWAL_RESPONSE_BOUNDARY_20261011.md), [QR](P20_BILIBILI_QR_RESPONSE_BOUNDARY.md), [OAuth frontend](../20261010/P20_OAUTH_RESPONSE_BOUNDARIES.md), [OAuth backend](../../OAUTH_ACCOUNT_OPERATIONS_20261011.md).

## Unverified and next boundaries

No ORIGINAL/CANDIDATE native pairing, real database lock/expiry/COMMIT result, real provider account, browser, deployment or whole-plan completion is claimed. Existing ORIGINAL evidence remains bound to its earlier sources/helpers. Full P20 still includes unmigrated transport consumers and DTO/SQL work. Bilibili backend QR operations remain a separate design/implementation candidate, not part of this completed scope. P08/P09 and previously denied dependent paths remain excluded.

## Later checkpoint

The subsequent Bilibili backend QR slice is now integrated and locally checked; see [QR integration status](BILIBILI_QR_INTEGRATION_STATUS.md). The historical verification above remains bound to its stated checkpoint.
