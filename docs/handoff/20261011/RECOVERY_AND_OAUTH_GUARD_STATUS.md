# Recovery and OAuth disable guard status

Recorded 2026-10-11 11:48 UTC. The executor was replaced during the final local validation session. The original worktrees, incremental Git objects, dependency caches and raw test logs are no longer accessible in the replacement environment. Historical reports remain historical evidence; unfinished selected-test/Clippy/check sessions are not counted as successful.

## Exact snapshot recovery and remote preservation

The retained transfer payload contained all 151 changed UTF-8 blobs relative to the published baseline 5d976089e3f44a767264a7cb76fe0e23bd321f55. Reapplying those bytes to that baseline recovered all 1,679 tracked files and the exact tree `8eb3c78783aa2232bce5f1b595f133d6c163c82f`, equal to the former local checkpoint 29a3f69. Local recovery commit e11872c is new; this does not recover the lost incremental history.

Remote branch `dot/refactor-continue-20261010` now preserves this snapshot at `32f104545ec60ea777299b4b88a6db603f2d63f9`. A fresh fetch verified both the remote commit and the exact tree. The transfer was split into bounded tree-object requests, with no intermediate branch states. The transfer commit uses `[skip ci]`; the post-publication Actions query returned zero runs. CI has not passed or qualified this transfer. No merge or deployment occurred.

Fresh baseline checks in the replacement environment passed: backend 604/604, CI contracts 172/172, owner pure contracts 25/25.

## Reconstructed OAuth behavior fix

The later OAuth guard patch was reconstructed from its author's retained task material and independently reviewed again. Reconstructed producer commit is 6213412, integrated on the remote snapshot as 05cb48c; pure gate registration is 5b9746c and fixture formatting is 3d6bdaa. These are not the original lost 07b9013/e50e095 commits.

The production account_operations.rs blob is `36d29bb92d3a3331a17c75c84b0d2da1064259c9`, matching the retained original fix record. The production change adds one bounded exact-login check after the final account read, before projection and COMMIT. It intentionally changes previously successful expired-login disables into a login failure and rolls back the transaction. Earlier CAS/enabled/overflow/token errors retain their ordering. It guarantees the final SQL check observes a live login, not that the login remains live until COMMIT finishes.

The single ignored database regression matrix is reconstructed test code, not a completed database run. It requires an explicitly named disposable database and opt-in, runs 20 cases serially, and checks both account-lock and UPDATE-trigger waits with a second blocked/expiry witness before release. It remains excluded from pure gates and has not run in this environment.

Fresh relevant pure Node contracts passed 85/85, including the behavior-change witness and fixture safety controls. Independent literal inverse checks restore the original production core without changing historical hashes. Official Rust 1.98.1 was restored and checksum-verified; Rust formatting passed after correcting reconstructed test-only formatting. The first formatting failure is retained. The fresh offline cargo check stopped before compilation because aes-gcm was absent from the new cache; no lockfile, registry mirror or network access rule was changed to bypass this. Therefore new-environment Rust compilation and native qualification remain pending.

## Next verification

Use the exact final published commit/tree, not a moving branch or old local SHA, for RainSync candidate materialization. Preserve the ORIGINAL bindings, protected executables, old databases and all remaining remote evidence. Re-freeze identical test/helper closures before ORIGINAL/CANDIDATE comparisons. The guard regression needs original failure, candidate success and guard-removal failure under real PostgreSQL blocking; source contracts do not substitute for it.

P08/P09, playlist/chat and dependent denied playback execution remain excluded. The saved RainSync environment is for validation; no real provider/browser or user-computer work was performed. Existing candidate build capacity and native admission checks still apply.

## Dependency restoration and bounded compiler checks (2026-10-11 12:43 UTC)

After explicit permission to restore locked dependencies from official crates.io, `cargo fetch --locked` completed successfully. The Cargo.lock checksum remained unchanged. The recovered Rust 1.98.1 toolchain then completed `cargo check -p rainsync-server --locked --offline -j3` and the narrower test-mode check `cargo check -p rainsync-server --bin rainsync-server --profile test --locked --offline -j3`. The latter type-checks the ignored OAuth database fixture without executing it or selecting server integration-test targets.

Strict test-mode Clippy initially rejected one nested cleanup condition in the reconstructed fixture (`collapsible_if`). The follow-up changes only that condition to an equivalent let-chain, preserving optional blocker rollback and error collection. `cargo clippy -p rainsync-server --bin rainsync-server --profile test --locked --offline -j3 -- -D warnings` then passed. Fresh pure backend contracts passed 639/639 and verification contracts passed 174/174; the focused guard subset passed 35/35. Rustfmt and diff whitespace checks passed. The existing ts-rs diagnostic about `non_null_audio_rate_reports` still appears; compiler/Clippy success is not a claim of empty diagnostic output.

No database test, server process, socket probe, or native runtime qualification was executed here. The saved RainSync environment still cannot fetch the candidate through its configured proxy port 8080; its last bounded retry exited before candidate materialization. PostgreSQL regression qualification remains blocked, and CI remains unqualified. These compiler results do not alter the earlier runtime exclusions or constitute completion of the overall refactor.
