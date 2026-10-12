# Private-library ingress integration checkpoint

Recorded: 2026-10-10 15:21 UTC. Local qualification only; not native parity or release readiness.

## Source and scope

The Rust implementation checkpoint is `af1bb109fabf89b942d05772b26dbe9fc8dac01e`. The subsequent verified Node/CI hardening checkpoint is `27906dbf48d1b6c5ace26d10de335234a89c2714`; it changes no Rust source or backend package command. Both descend from the separately retained preview/playlist/response-boundary checkpoint `c436efe3adce74faa9a47092195664fc9a583420`.

All 20 private-library HTTP adapters now delegate to their existing named catalog operation owners: ten library/grants/private-media entrypoints, three room-share entrypoints, and seven private-source/settings/scan entrypoints. The existing classification remains nine gated writes, five ungated writes and six ungated reads. No uniform gate or cached authorization token was introduced.

The operations own their original admission, complete original business transaction and existing post-commit receipt response where applicable. Independent reviews reversed only those boundary edits and recovered all 20 original business bodies exactly. Extractor signatures, routes, playback compatibility adapter, public reexports, shared authority, source rules and private/shared scan core are unchanged. Cipher factories borrow only the key and perform no eager encryption/decryption; the original stored envelope and ordered decode failures remain.

The library/source revision parsing differences, room-first versus caller-first locks, grantor self-revocation, admin snapshot versus current checks, no-op/rename encryption timing, scan page checkpoints and 60-second fetch budget remain. Confirmed COMMIT errors propagate; existing retirement failure handling after a confirmed COMMIT still returns the captured successful response. These source findings do not prove database behavior.

## Actual results

| Check | Result |
| --- | --- |
| Selected server Rust tests | 77 distinct tests passed; 98 actual invocations |
| Private feature branches | 77 selected tests with flag `false`, then the 21 private catalog tests with flag `true`, all passed |
| Server test discovery | 441 listed, **not all executed** |
| Server all-target strict Clippy | Passed, locked/offline, `-D warnings` |
| Workspace all-target Cargo check | Passed, locked/offline |
| Backend Node contracts | 283 / 283 passed, no skipped tests |
| Final CI verification contracts | 126 / 126 passed, no skipped tests |
| Newly registered private/cipher/catalog contracts | 120 / 120 passed, included in the backend total |
| Formatting and whitespace | Passed |

Selected-test executable SHA256: `3e4dee5964ab032f75512fd3631cf6d256482a79935b307516c64c469629dafc`. This binds the historical selected run, not a promise that a shared Cargo target will never be rebuilt. The exact five-module libtest OR-filter list was separately checked to select precisely the same 21 private tests; listing is not another execution.

The new async admission tests close their lazy pools before invoking the real operations and use missing-session input. They cannot create a DB connection; cipher callbacks are counters or deliberate panic sentinels. They establish only pre-storage admission, not valid-session/Origin/CSRF, wait races or committed data.

No frontend production files, lockfile or build configuration changed in this batch. The prior 2,758-test frontend/build/type/lint/bundle evidence remains at its separately identified checkpoint; it was not rerun or re-counted as a new frontend pass here. The existing ts-rs `deserialize_with` warning remains visible.

## CI regression protection

The existing backend gate now owns the five added source-contract files, including the pre-existing catalog capability test. An independent reviewer found that the initial registration assertion could accept a skip filter, shell comment or appended native command despite containing the five filenames. The actual package command was correct and its 283 tests passed; the assertion was strengthened to the exact 20-file pure command, with real string mutation controls. Missing/duplicate filenames and all three bypasses now fail.

A bounded, uniquely registered enabled-feature Cargo step immediately follows the ordinary workspace Cargo tests. It has exact five-module filters, `PRIVATE_LIBRARIES_ENABLED="true"`, one test thread, a three-minute job-step budget and 150-second TERM/15-second kill grace. It executes only the audited 21 pure private tests. Exact step-block, ordering and mutation checks reject changed flags, skipped/continued failures, missing/duplicate modules, comments and native suffixes. The default disabled branch and enabled branch are therefore not confused.

The initial 106-contract pass, focused 20-contract hardening pass, final 126-contract pass and independent reviewer mutations are retained separately. No failure was converted into a native success claim.

## Native status and next evidence

The saved RainSync environment completed the existing ORIGINAL media-preview fixture with exit 0 and 21 post-run checks. Its raw evidence was preserved and restored/verified independently; this is preview baseline evidence, not private-library parity.

For this private batch the audited no-playback ORIGINAL core is `private-library-expiry-native.mjs`, `catalog-media-reads.mjs`, and `catalog-scan-pages.mjs`. At this checkpoint those new ORIGINAL runs are pending. This core does not cover all 20 entrypoints or private semantic configuration no-op, and the expiry fixture changes a grant expiry into the past rather than demonstrating natural exact-login expiry. Broad private-library/settings/committed-change runners contain excluded playback setup and are not substitutes.

Candidate transfer and ORIGINAL/CANDIDATE comparison remain pending. Each side needs its own successful source/binary binding, identical fixture/helper input bytes, independent tool receipts and positive owned-service cleanup. The 18th owner executable must be protected explicitly when a fixture's ordinary binding loader does not require it; protection does not authorize executing its playback owner test.

No database parity, complete refactor-plan completion, actual-provider/browser result, physical media drain, publication, merge or deployment is claimed. P08/P09 remain excluded.
