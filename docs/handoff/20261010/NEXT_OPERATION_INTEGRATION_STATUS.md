# Preview, playlist and response-boundary integration checkpoint

Recorded: 2026-10-10 14:50 UTC. This is local qualification, not native parity or release readiness.

## Frozen source and scope

The implementation and test checkpoint is `e2b03519c2e92b9f28ffdb47b35e4d04fd8e2e8e` on `dot/refactor-next-20261010`. It descends from the separately retained five-operation checkpoint `aebc55df2a3f132955261b848814e5a664a78e31`. No publication, merge or deployment is claimed.

- Preview request/status/image now own their complete admission in the existing catalog owner. Registered/viewer distinctions, queue-limit read timing, image transaction and HTTP ETag behavior remain unchanged.
- Playlist list/add/remove now return typed operation results. Existing authorization, SQL, ordering, private-library filtering and final checks remain; the original runtime broadcasts only committed changes.
- The selected account status/check and administrator-settings response families now retain network values as unknown until the existing parser and request-identity fences have run. This is a partial P20 delivery, not completion of all response boundaries. The explicit `updated_at` validation is an acceptance-set tightening to null or safe integers, including zero and negative integers; PATCH uncertainty classification is retained.

Production changes were independently reviewed against their original sources. No P08/P09 implementation, real-provider, browser or physical-drain acceptance is included.

## Actual local results

| Check | Result |
| --- | --- |
| Selected server unit tests | 54 / 54 executed and passed on integrated Rust source |
| Workspace all-target Cargo check | Passed, locked and offline |
| Server all-target strict Clippy | Passed with `-D warnings`, locked and offline |
| Backend Node contracts | 163 / 163 passed |
| Owner-gate Node contracts | 25 / 25 passed; not native execution |
| CI verification-layer contracts | 106 / 106 passed on retry |
| Full Vitest suite | 168 files, 2,758 tests passed on retry |
| Response-boundary compiler checks | Passed; in-memory unsafe DTO bypass rejected with TS2344 / TS2578 |
| Production frontend type check and build | Passed |
| ESLint | Passed with zero warnings |
| Emitted-bundle contracts | 4 / 4 passed; initial JS 405,725 / 409,600 bytes; 15 deferred pages |
| Format, syntax and whitespace | Passed |

The server binary lists 419 tests. Listing all tests is not running them: only the selected 54 are claimed here. The selected-run binary SHA256 is `d3d04a933bd3f3f5801c585471b51156240ce737911dcc41687dce040eb28609`.

The existing ts-rs warning about the ignored `deserialize_with` attribute remains visible in compile output. The Vite large-chunk notice is also retained; emitted dependency-graph and initial-bundle limits passed without raising budgets.

## Failures retained, not erased

- Preview integration initially retained package conflict markers after a failed merge-helper assertion. The next local commit corrected the complete script list; no production Rust was changed by that repair. Both command outcomes are retained.
- The new CI verification run exposed an old assertion expecting three npm installs although the existing independent owner-gate runner made four. The fix explicitly checks that owner's install and the total. Initial result: 105 / 106; focused retry: 2 / 2; final full retry: 106 / 106.
- The first integrated Vitest run passed 2,757 tests and timed out one unchanged player-recovery test at the existing five-second limit. The focused 39-test file passed on retry, followed by the full 2,758-test run with one worker. The timeout was not increased. Separate producer-lane timeout evidence remains in its own report.
- An npm-wrapper run was interrupted by denied registry access. No registry bypass or dependency replacement was attempted. Already-completed Vitest/type/build stages were preserved, and the remaining bundle/lint/compiler checks were completed using already-installed local executables directly.
- Playlist's initial observer could ignore a terminal malformed frame or transport failure. Its first error now remains visible through owned termination and positive close observation, including concurrent cleanup failure. Twenty-one actual-helper EventEmitter tests passed. Running them against the old helper in memory produced 4 passes / 17 failures. These are pure mocks, not WebSocket success claims.

## Native status and remaining gates

The six new authority fixtures require 43 exact ordered checks in total. Their pure registration and negative controls passed. They have not all completed ORIGINAL/CANDIDATE native qualification.

- Kick ORIGINAL completed six groups successfully using the corrected frozen fixture `db301814e53cb919313e9f42474638d224d27e8229f3b4ab52d88e77cefbf183`; the earlier failed run remains retained. Its 18 binding artifacts were unchanged and final owned-service cleanup audit passed.
- Preview ORIGINAL preflight stopped with exit code 2 because the saved test environment had only 26 MiB free. No preview test or service was started. The `preview_queue` helper received an independent path/hash/build-source receipt; it was not incorrectly treated as a member of the existing 18 binding artifacts.
- Space recovery assessment is read-only at this checkpoint. No evidence or bound executable has been deleted.
- Candidate transfer and native comparison remain pending. Each side needs its own source tree and independently bound executables, with identical coordinator/helper inputs. Verifying one executable and running another path is not acceptable.
- Prefer the existing `media-previews.mjs` fixture for preview behavior, plus the new playlist gate and focused playlist regressions. Do not replace these with broad aggregates that enter excluded playback scope.

The playlist owner gate is independently guarded on successful binding, with the existing five-minute step budget and 240-second timeout plus 45-second kill grace. The owner job budget is 75 minutes. The response-boundary compiler check is registered in the independent frontend CI job. Private raw evidence upload scope is unchanged.

No database parity, whole-project test pass, real-browser result, complete refactor-plan completion or release approval follows from this checkpoint.
