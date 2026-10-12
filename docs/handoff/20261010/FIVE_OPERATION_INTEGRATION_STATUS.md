# Five-operation integration checkpoint

Recorded: 2026-10-10 14:19 UTC. This is a checkpoint, not a release verdict.

## Source scope

- Original: `5d976089e3f44a767264a7cb76fe0e23bd321f55` (handoff documentation over production baseline `990cf8a75b65c102279539fbce683c52196f4c67`).
- Integrated production and Rust-test checkpoint: `87be4e478769be23e084d07c0b5c477d4f0a3763`.
- Complete operations extracted: room kick, guest-policy GET/PUT, lifecycle, room directory list/create, and short-platform account status/import/unlink.
- This checkpoint additionally freezes native required-check sets, registers five independent CI owner gates, and corrects a synthetic kick resource seed.
- No migrations, P08/P09, merge, deployment, physical-media drain claim, or full native parity claim.

## Verified locally

| Check | Result | Applicability |
| --- | --- | --- |
| Workspace all-target Cargo check, locked/offline | Passed on final integrated Rust source | Original baseline and final five-operation integration both checked |
| Frontend Vitest | 167 files, 2,666 tests passed | Frontend source unchanged since baseline |
| Frontend production build | Passed | Unchanged frontend |
| Bundle contracts | 4 passed | Initial JS 405,441 / 409,600 bytes |
| Protocol / room-core / http-api Rust lib tests | 49 + 20 + 11 passed | Changed http-api guest-error contract included; tested sources unchanged afterward |
| Strict server Clippy, all targets | Passed after final test-only correction | Five integrated production units and final Rust test source |
| Selected server unit tests | 41 / 41 passed | Real execution at `87be4e4`; no database/socket tests selected |
| Backend contracts | 114 / 114 passed | Includes new fixture and required-check negative controls |
| Native-owner gate contracts | 25 / 25 passed | Static/pure Node checks, not native gate execution |
| Format, JavaScript syntax and whitespace | Passed | Current integration checkpoint |
| Frontend ESLint, zero warnings | Passed | Unchanged frontend |

The server lists 408 tests; listing is not execution. Only the explicitly selected 41 in-memory server tests are claimed above. Native tests remain separately pending.

The offline dependency install initially failed with ENOTCACHED. Validation reused already-installed dependencies from a checkout with the identical lockfile SHA256 `b46e28d3dbaaf2b1aa2cf3f26c52225558eaf92950c8eb13b00c742f2d5e7d39`, and verified that the workspace link resolves to this checkout.

## Preserved failures and corrections

1. Strict Clippy initially rejected a stale `PlaybackStatus` import after lifecycle extraction. The import was removed; the strict retry passed.
2. The first selected server run passed 16 tests, failed one new short-account test, and did not run the remaining 24. Its synthetic cookie `fixture-only` was shorter than the existing parser's 16-byte minimum. The corrected test retains that value as a rejection case and uses a valid-length synthetic cookie for the envelope check. Production parsing is unchanged. The full selected retry passed 41 / 41.
3. The first real PostgreSQL kick ORIGINAL run passed its first two groups, then returned the correct `401 / SESSION_EXPIRED` but failed strict full-row rollback equality. The remaining three groups were not run. Two resource keys had appeared: `upstream_io_uncertain` and `upstream_last_report_at`.

The kick failure's timestamp, matching playback ID warning and source path strongly correlate with the legacy maintenance reporter selecting the synthetic `{}` resource. There is no writing-transaction PID witness, so this is not a directly proven writer attribution. The seed now includes the production wrapper's existing `upstream_closed:true` marker for local media without an upstream base. It remains row-only synthetic data, not a playable encrypted resource or physical media owner. Background maintenance remains enabled. Snapshot SQL, successful-row comparison and full raw rollback equality remain unchanged, with pure mutation-negative tests proving that extra fields still fail.

Frozen corrected kick fixture SHA256: `db301814e53cb919313e9f42474638d224d27e8229f3b4ab52d88e77cefbf183`.

## Native validation status

- Original existing room-permissions authority, room-permissions and scoped-guests runs passed.
- Corrected kick ORIGINAL six-group rerun has been requested; outcome pending at this checkpoint.
- Five-operation CANDIDATE native execution is not yet claimed.
- Both sides must use byte-identical fixture/helper inputs, but independently bound production source and binaries in separate source trees. A candidate binding must never be reused against original source.
- Required ordered native check counts: kick 6, guest policy 5, lifecycle 10, directory 6, short accounts 8. A missing, duplicate, unknown, reordered or non-passed check fails the final assertion.
- CI adds five independent guarded owner-gate steps. Per-step budgets remain 5 minutes with an outer 240-second timeout and 45-second forced-stop grace; the job budget increases from 45 to 70 minutes. Private raw evidence upload scope is not expanded.

Keep earlier failure evidence and later retries distinct. Do not interpret this checkpoint as database parity, real-provider testing, browser validation or release readiness.

## Subsequent fixture cleanup review

Independent pure mocks reproduced two additional fixture defects: lifecycle's message callback could throw on malformed JSON and exit before cleanup; directory's observer could ignore a malformed terminal frame after its last sample. Both observers now retain the first frame/transport failure, finish owned close observation before reporting it, and retain cleanup failures alongside the original error. Pure mocks execute the actual fixture functions, not replacement validators. These changes do not establish actual WebSocket or database success.

Final observer mock counts: lifecycle 7 / 7 and directory 9 / 9, included in the 114 backend contracts. The directory tests run against the pre-fix function in memory yielded 2 passes / 7 failures, demonstrating that the new cases detect the old defects. All 25 owner-gate contract tests also passed. These are in-memory test results, not network tests.
