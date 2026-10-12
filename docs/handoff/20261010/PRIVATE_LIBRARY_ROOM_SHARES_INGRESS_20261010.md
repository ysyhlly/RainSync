# Private-library room-share ingress

Date: 2026-10-10. Base: `ffee0ab83a84ee010a0043f863a4e37d43e48003`.
Branch: `dot/library-shares-ingress-20261010`.
Worktree: `/workspace/shared/rainsync-library-shares-lane-20261010`.

## Scope and resulting boundary

Only these production locations change:

- `apps/server/src/catalog/room_shares.rs`: `share`, `update_share`, and `revoke_share` now receive the existing `identity::RequestContext` and original headers. Each performs its original non-guest write authentication before its original business validation and transaction. Only `share` and `update_share` require the existing live feature flag before authentication. The original `update_share` and `revoke_share` receipts are consumed inside the operation, after `commit_caller(...).await?`, and all three operations return `Result<Value>`.
- `apps/server/src/private_library.rs`: only the bodies of those same three HTTP adapters change. Their extractor signatures are unchanged; each now supplies `app.identity_context()`, delegates once, and calls `responses::ok_json`.

There is no new owner, service, cipher, authority token, transaction helper, or authorized bypass. The existing `CommittedLibraryChange::response` remains the single committed-retirement policy. COMMIT errors still propagate; retirement failure after confirmed COMMIT still returns the captured successful response through the existing maintenance retry policy.

All original SQL, binds, business validation, error ordering, response JSON, and transaction bodies are byte-preserved after reversing the limited admission/receipt edits. `preserve_current_room_shares` is unchanged. A local reversal comparison also proves every HTTP byte outside the three function bodies is unchanged, including the playback `authorize_media` compatibility adapter and the `enabled` / `retire_maintenance` exports.

## Authority and ordering retained

- `share`: gate → request authentication → mode/duration → active room SHARE → membership KEY SHARE → exact caller → library share permission UPDATE → revision → source/media SHARE → insert → revision-only advance → audit → current permission → exact caller/COMMIT. No new receipt or retirement is added to this operation.
- `update_share`: gate → request authentication → mode/expiry → authorized target → active room → membership → caller → library/revision → current source/media/epoch/share → original 24-hour expiry cap → mutation/epoch advance → migrate current shares → audit → current permission → both original and requested expiry plus current grantor permission → exact caller/COMMIT → existing receipt response. An expired old share cannot be revived by extension.
- `revoke_share`: request authentication, without a feature gate → caller → library/manage-or-own-grantor → revision → revoke → epoch advance/current-row migration → audit → manage-or-own-grantor final check → exact caller/COMMIT → existing receipt response. A grantor who has lost library access still retains the original ability to withdraw their own share. No room membership, browse, or share-to-room permission is newly required.
- Current-row migration still excludes stale epochs, revoked/expired shares, deleted or moved sources, stale source generation, unavailable media, and grantors without current share permission.

`library_authority.rs`, `identity/request.rs`, `main.rs`, all other catalog and HTTP operations, routes, migrations, P08/P09 playback work, package manifests, and CI are untouched.

## Validation performed

- `node --test tests/private-library-room-shares-ingress-contract.test.mjs tests/catalog-boundaries.test.mjs`: **32/32 passed**, including 9 new positive source contracts, 19 new in-memory deletion/change negative controls, and the 4 existing catalog boundary checks.
- `/workspace/shared/refactor-tools/rust-1.98.1/bin/rustfmt --edition 2024 --check apps/server/src/catalog/room_shares.rs apps/server/src/private_library.rs`: passed.
- `git diff --check`: passed.
- Independent local byte comparisons: reversing only the reviewed production edits recovers the base room-share module exactly; replacing the three HTTP bodies with their base versions recovers `private_library.rs` exactly.

The new source contracts cover exact ingress signatures/arguments, feature-gate classification, non-guest write authentication, byte-exact original bodies, room-first versus caller-first order, own-share revocation, old/new expiry checks, current-row migration, exact-login final-check delegation, commit-before-receipt, committed-retirement error handling, exact HTTP adapter bodies, DTOs, routes, and compatibility exports. Negative controls must mutate actual production text and be rejected by the corresponding guard; production files are never modified by the controls.

Five pure Rust tests were added inside `catalog::room_shares::tests`:

1. Share entry failure precedes invalid body and room storage.
2. Update entry failure precedes invalid body and target storage.
3. Revoke has no feature gate and rejects missing login before body/storage.
4. Share DTO required fields, original wire types, and unknown-field rejection.
5. Update DTO keeps semantic validation outside deserialization.

The three async tests construct a lazy pool and close it before invoking production operations. This prevents connection attempts even if a regression reaches storage. They do not create a DB, server, or socket. The gated tests read the existing feature flag and never modify process-global environment.

## Not run and integration follow-through

No Cargo build/test, PostgreSQL fixture, server, socket, network request, user-computer action, push, package/CI change, or delegation was performed in this implementation lane. Rust tests are **added but unexecuted** here. The integration owner should compile and run `catalog::room_shares::tests` in separate processes with `PRIVATE_LIBRARIES_ENABLED=true` and with `PRIVATE_LIBRARIES_ENABLED=false` or unset. A single process only exercises its configured gate branch.

Source contracts are not runtime proof of authenticated success, guest/Origin/CSRF handling, PostgreSQL lock waits or natural expiry, rollback, successful writes, or retirement behavior. The existing private-library native settings, expiry, and committed-change fixtures remain the relevant behavioral follow-through under the integration owner's authorization. No unknown-COMMIT or physical media-disposal claim is made.

AGENTS navigation limitation: no GitNexus MCP is exposed and no current task CLI was found through the available command/current checkout/tool installation checks. No current graph index exists for this worktree. Direct source analysis and exact local comparisons were used under AGENTS' documented fallback, without installing tools or claiming graph/impact coverage.
