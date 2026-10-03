# Composed partial-plan validation — 2026-10-02

This is a local review checkpoint, not publication or final release acceptance.
The exact code checkpoint is `3dceebd`; its backend source digest is
`0f42e0bff4536af82b6fabd3cb6c270429cc2d0d1ed7549e942f67963c0c313f`.

## Frozen inputs and evidence

- Independent executable/helper copies: `tooling/partial-plan-final42-frozen/backend-binding.json`
- Complete result/hash index: `tooling/partial-plan-final42-validation-index.json`
- Post-run source and executable remeasurement: `post-run-binding-verification.json` beside the frozen binding
- Compatible baseline: `tooling/partial-plan-login-metrics-frozen/backend-binding.json`, source digest `84905c40844e3f0813355e0183f913f6063475f0b0283132cb218a48a2697ae7`, with matching `RainSync-login-metrics-baseline` checkout

All backend inputs and the three service binaries plus12 native helpers were rechecked after the runs. Native build settings are recorded in the binding: incremental compilation and debug information were disabled in an isolated compact target to preserve disk headroom; ordinary unoptimized/debug-assertion semantics were not changed. This is not release-build performance evidence.

## Results on composed source

| Check | Actual result |
| --- | --- |
| Workspace/all-target Rust, repeated after final null-room fix | 518 passed;14 pre-existing database tests ignored |
| Strict workspace/all-target Clippy; formatting; protocol export | Passed |
| Frontend tests and strict production build | 720 passed; build passed |
| Acceptance/deployment/recovery Node tooling |49 passed;2 explicit optional checks skipped (browser and unspecified old-binary entrypoint input) |
| Queue prefix/pruner PostgreSQL matrix |15 groups passed, including claim rollback, exact renewal/snapshot interleaving and null-room legacy/v2 boundaries |
| Native cache invariants |4 examples passed, including actual owned writer exit and positive eviction/receipt retention |
| Actual Worker output-entry cohort |5 groups passed |
| Actual v2 metrics receiver |33 groups passed, including same-account cross-login rate isolation and original-grant first-frame attribution |
| Actual frontend sender/runtime wire |5 groups passed; synthetic media events, not browser decoding |
| Membership transaction gates |7 groups passed |
| Job queue/run timing |8 groups passed |
| Local guarded probe/version binding |7 groups passed |
| Actual old Server grants through full current migration set |6 groups passed |
| Login-bound Server/Worker API and delivery |7 groups passed |

Earlier source-bound checks also passed26 REST/legacy-WS authority,25 queued-control authority and12 diagnostics/replay groups. Those original reports remain separate; they are not relabeled as reruns on a different binary.

## Compatible cutover and fresh recovery

Run `preview-transition/154e6979-8eb3-4137-9459-d285101ab2c4` passed8 stages.
Report SHA256: `34d9b7f441321ff5b105f10868ebc92b9ce0838a4b9cae1c2471336aedb4d066`.
Both Server builds passed the exact `media-login-binding-v1` gate before startup.

The41 baseline upgraded to42. Reverting to the compatible41 baseline required restoring the quiescent backup into a new database; post-backup changes are outside that restored database. This is not arbitrary old-binary rollback against the upgraded database. A separate fresh database, empty cache and recovered configuration/source key/owned synthetic Agent credential then ran the final42 candidate and its direct/transcode/seek/Stop checks. `production_recovery_accepted` remains false.

Pre0041 Server rejection was separately exercised after0041 existed: the offline gate rejected it without receiving database credentials or changing the database/grant/current Server PID. The exact contract declaration is required, not merely a numerically higher version.

## Failed attempts and corrections retained

- Environment ENOSPC and later Worker10% free-space admission failures were retained, never reclassified as passes. Only regenerable compiler/test caches were cleaned; source, frozen binaries and evidence remain
- The former metrics fixture cleanup masked a pre-start primary error. The exact original exception remains unknown; new reporting preserves primary and cleanup failures separately, including never-started state
- One old fixture tried to clean an expired/login-revoked grant through another login. The correct denial is retained; the fixture now observes server-owned retirement
- The pruner's first one-statement CTE shared a stale MVCC snapshot. The final two-statement READ COMMITTED transaction is covered by a deterministic renewal interleaving and independent static review
- Final composition exposed forgotten room-null legacy cache receipts. The narrow non-v2 branch restores prior positive-proof cleanup, retaining all writer/cache/reservation safeguards; actual cache group4 and15 SQL groups pass
- Missing helper packaging, obsolete39/41 migration-count assumptions and explicit-login fixture seeding were corrected without weakening production admission

## Unmet external or broader implementation gates

No actual browser/device decode, dual physical-client synchronization, packet-level fault experiment,72-hour run, Docker/arm64 release image or production restore was completed. Controlled Jellyfin/Emby peers are protocol mocks; they do not replace pinned real-product acceptance. The denied Agent WebSocket receipt-race task was not rerun or rephrased. Historical unknown release obligations remain blocked rather than guessed.

The original19-unit implementation ledger remains authoritative. Concrete capability/route explanations and opt-in controlled media redirects are the next isolated coding slices; broader HLS/upstream fallback, generic discontinuity mapping and the remaining concrete acceptance adapters are still open.
