# Owned native RainSync soak workload

`scripts/acceptance-owned-soak.mjs` now implements concrete workload operations, not an arbitrary `perform` callback. `tests/fixtures/owned-native-soak.mjs` owns deployment and teardown using the existing isolated native PostgreSQL/Server/Worker fixtures. It never starts Agent, Docker, a browser, Cargo, host network changes or a real account. All application accounts use newly generated disposable fixture credentials.

## Exact boundary

- `withOwnedNativeSoak({binding_path,signal}, callback)` verifies the successful frozen native build descriptor, every backend source hash, and all three binary hashes before/after the callback, together with the coordinator/fixture source hashes. Only Server and Worker run; hashing the Agent binary does not execute it
- PostgreSQL is a newly created native cluster. Its exact fixture ID, database name, data directory and loopback port must match. Application/Worker URLs come only from that fixture. Delivery redirects, arbitrary origins and HLS output-path escapes are rejected
- `createOwnedSoakWorkload` binds the run ID and exact Server/Worker/PostgreSQL resource IDs. Every `perform(event)` must carry that same run/resource population. The helper is intended to be called from `withOwnedNativeSoak`, never with production credentials or a hand-built fixture
- `nativeIdentity()` records actual `/proc/PID/exe` hashes, start ticks and process identity. Resource samples include owned process-tree RSS, FD count, socket-FD count, process count and shared owned cache bytes/quota; PostgreSQL also reports DB connections and queued jobs. Cache bytes are repeated per resource for visibility and are not additive. Short-lived process disappearance can fail a sample rather than silently reduce the population
- `artifactIdentity()` deliberately fails `NATIVE_IMAGE_UNOBSERVABLE`. A native executable is not evidence of a running final candidate image

## Implemented actions

- `phase`: distinct fixture users prepare exact-login-bound direct/transcode sessions and fetch real delivery bytes; plans are retained until the next phase. The evidence labels native concurrency as admitted sessions with delivery probes. It is not rendered/sustained video concurrency. Known explicit capacity rejections retain HTTP status/error; other failures fail the action
- `slice`: a separate fixture user requests a real transcode plan, reads its actual HLS playlist, fetches init/media segments and records each byte count and SHA-256. Empty/error responses fail. FFmpeg-produced segments are not claimed as browser-presented frames
- `join` / `leave`: an invited fixture user connects/disconnects. A separate live presence monitor must observe distinct online user count changing by exactly one, then a fresh authoritative snapshot must equal the pre-action snapshot. This tests online presence, not durable membership removal (there is no normal member-leave API). A churn member is connected initially because the scheduler's first leave precedes its first join
- `F4`: the exact owned independent viewer's `room_members` row is deleted as explicitly labeled SQL fixture fault injection (there is no member-removal API). A live execution witness must exist beforehand, become reaped after revocation, and the backpressured stream must close within 10 seconds without normal EOF. Old-grant requests must return 401. A healthy viewer must keep reading; a normal invite rejoin must create a new membership epoch and must not revive the old grant. This covers the room-member branch, not account/Agent revocation
- `checkStopStream()`: retains the separate passing normal session-DELETE long-response check, clearly outside F4 permissions-revocation evidence

Playback viewer IDs remain stable and plan generations increase; repeated slices do not accumulate a new high-water identity per request. Unneeded unsolicited WebSocket frames are discarded rather than retained for 72 hours.

## Presented-frame integration

`createOwnedPagePresentation({pageFactory,decodeTimecode,saveFrame})` accepts already-owned real Playwright pages, an independent decoder and a private screenshot sink. It does not launch a browser. It creates one video per admitted direct session and composes `createBrowserMeasurementDriver` for actual rVFC observations and visible-timecode checks. Page/video/source changes, autoplay failure, background/unavailable frames and seeks outside the sample fail. All destination clients must present new frames near the requested seek point.

`loop-playback` / `seek` without that integration fail `PRESENTATION_REQUIRED`; no `currentTime` or decoder-only output substitutes for a presented frame. Transcoded presentation currently requires a separately measured native-HLS/MSE integration and fails explicitly. The bounded native harness generates a non-timecoded MP4, so it intentionally does not exercise this page driver. To test the page composition separately, supply pages playing the decoder worker's authorized visible-timecode sample at its exact geometry and origin.

## Not implemented / not accepted

`ownedSoakPreflight` enumerates unsupported prerequisites before process creation:

- Final candidate image identity and uninterrupted 72h execution
- Cache eviction under measured quota pressure with proof that active readers/files survived
- F1 external supervision plus independent old-generation write/drain witnesses
- F2 isolated lock-loss injection plus false-ACK and post-loss-write witnesses
- F3 a separately approved isolated capacity-limited volume; this adapter will not fill the host disk or change permissions to simulate failure

`createAdapter(config)` exposes the scheduler contract, including cleanup after partial preparation. The complete standard/formal schedule is rejected before fixture preparation for these missing gates. `runSoak` always uses `bindRun` and `assertArtifactIdentity`; JSON cannot select a native identity verifier or reduce its action matrix. `faults_approved` is not a substitute for authorization.

## Bounded native scheduler qualification

`runNativeSoakQualification` and `tests/soak-native-qualification.mjs` are a separate, explicitly non-formal entry using the same scheduling core. They call the real owned workload; test doubles are used only in the dedicated no-service unit suite. Scope must be `native-qualification`, its scheduled workload window is at most 180 seconds, and callers supply explicit direct phases (at most ten streams) and an explicit `actions` subset drawn from `slice`, `join`, `leave`, `stop-stream`, and `fault`. Join/leave must be selected together; fault selection requires exactly `faults:["F4"]`, otherwise `faults:[]`. Presentation, seek, eviction, transcode phases, F1–F3 and unknown actions are rejected before prepare. Native slice production may use its existing owned transcode session; it does not prove presented transcode concurrency.

For an independently authorized native runtime attempt, supply the frozen `native_binding_path`, existing native PostgreSQL/runtime environment described below, a new private output directory, and the trusted real adapter:

```sh
node tests/soak-native-qualification.mjs --config=/private/native-qualification.json --adapter=scripts/acceptance-owned-soak.mjs --output=/private/qualification-001
```

The 180-second limit is the scheduled workload window, not a proven total wall-clock limit. Reports expose separate prepare, action, final-identity, cleanup-wait and finalized-artifact-collection adapter-call budgets (the existing `adapter_timeout_ms`, default 30000), existing per-fixture-resource cleanup deadlines (5000), the latest scheduled workload start and latest allowed adapter-call deadline (planned start + allowed start lateness + action-call budget). Filesystem source/journal I/O and externally ignoring work have no proven total drain bound, recorded as null. Cleanup ownership remains with the adapter until its fixture task actually settles; a public timeout is unconfirmed cleanup, never proof that owned resources stopped.

The config kind is `soak-native-qualification`. It also supports `phase_seconds`, `sample_seconds`, `identity_seconds`, selected-action `cadence_seconds` and `action_start_seconds`, and the shared timeout/lateness/redaction fields. Default selected actions occur once, staggered through the window; callers can request repetition explicitly. Every selected action must complete with observed receipts. Stop is a `stop-stream` action with `check:"stop-stream"` and `revocation:"session-delete"`; F4 is a separate `fault` receipt requiring `revocation:"owned-membership-sql-fault"`, healthy-viewer survival, changed membership epoch and denial of the old grant after rejoin. Neither can substitute for the other. They share one long-stream actor, so overlapping scheduled starts fail explicitly. A phase transition drains all pending workload, checks its lateness, and takes source/native identity checkpoints before and after the phase.

The fixed filesystem verifier `verifyOwnedNativeBinding` can check/freeze the native descriptor, backend source/binaries and coordinator bytes without launching any service. Qualification checks those bytes around every action receipt and observes actual native fixture/database/process identity at checkpoints. It pins the complete Server/Worker/PostgreSQL resource population and PID/start-tick generations; missing, duplicate, foreign, unavailable or substituted sample rows fail. A separate lifetime signal stays linked after prepare. Finalization drains scheduled work, obtains independent final live identity, releases the fixture callback for workload/service disposal, retains its finalized report (including `error.report`), then collects artifacts and finishes the journal. A failed final source check is recorded separately and does not suppress the independent live identity read. Observation, cleanup and report-sink failures do not replace the primary scheduler failure; absent cleanup proof remains unconfirmed.

`result:"passed"` here means only the selected bounded qualification completed. Reports carry `qualification_only:true`, `formal_gates_fulfilled:false`, every remaining formal gate marked `unfulfilled`, and always `accepted:false`/`release_ready:false`. Resource trends may be reported, but this short native subset cannot close capacity, trend, final-image, presentation, eviction, F1–F4 or uninterrupted-72h acceptance. `membership_sql_f4_completed` tracks only the selected native subcase; full F4 remains unfulfilled because upstream-account and Agent revocation are untested. This implementation did not run a new native runtime fixture; those attempts remain paused.

Pure verification (no listeners, processes, browser, database, Docker, HTTP/WS or real `/proc` operations):

```sh
node --test --test-isolation=none --test-concurrency=1 tests/acceptance-native-qualification.test.mjs tests/acceptance-runners.test.mjs
```

## Bounded executable test

Set an existing native PostgreSQL installation's runtime environment, `RAINSYNC_NATIVE_POSTGRES_BIN`, private `RAINSYNC_ARTIFACT_DIR`, `CARGO_TARGET_DIR` to the coordinator's read-only frozen build, and `RAINSYNC_OWNED_SOAK_BINDING` to its binding JSON. The harness never builds:

```sh
node --test tests/acceptance-owned-soak.test.mjs
node tests/owned-soak-native.mjs
```

The latter has a 180-second total deadline; workload calls have a 30-second abort deadline. Newly created fixture artifacts inherit a private process-local umask. It generates an eight-second local MP4 with a sparse 128 MiB tail for backpressure, verifies its scan/source association, then executes direct-1, leave/join, direct-2, slice, separate Stop and membership F4. The Worker production disk-headroom policy is unchanged. It verifies native fixture/Worker PID and listener disappearance after cleanup and writes private, redacted `owned-soak-report.json`. Source/binary hashes are verified again; failed attempts retain their failed reports. No account tokens, signed URL queries or passwords are intentionally written to evidence.

A short native run has neither the full 1/2/5/10 capacity matrix nor enough phase-matched samples for trend analysis. Its result always retains `accepted=false`, `release_ready=false`, and an explicit remaining-gate list. Browser, physical device, final image, fault-matrix and 72h acceptance remain unexecuted.

## Local verification and corrected scope (2026-10-02)

- 59 Node tests passed across the owned adapter and existing runner/measurement/release-evidence suites; the real-browser test was explicitly skipped. All 21 owned-adapter checks passed, including synthetic partial preparation, lifetime/action cancellation composition, independent bounded cleanup, cleanup failure aggregation, failed report-sink and pending/late page-allocation negatives
- Owned native report `7d7eac5d-c68f-41ac-957c-7c84ae4517e3` proved the Stop/session-DELETE long-stream path. Its earlier `F4` label was incorrect; it is **not** permissions-revocation F4 evidence
- Report `9575a9ed-3839-477d-845b-60aa6e87a4e8` passed the corrected explicit owned membership SQL-injection F4 subcase, healthy-viewer isolation, rejoin epoch change and non-revival of the old grant, with Stop reported separately. It does not cover upstream-account or Agent revocation
- Intermediate cleanup-repair reports `9cdac70b-0df6-4e87-82ee-5e40bf11ae36` (passed) and `d84fef46-7e3f-498c-b698-1a62bacea058` (intentional lifetime-abort failure) retain evidence for their exact earlier source hashes
- Final post-race-repair report `88d57b30-4f6a-4b15-9014-2bea0e7eac9d` passed the bounded native workload with membership-SQL F4 closure in 1.993 seconds, independent healthy-viewer delivery and rejoin epoch/old-grant checks. All nine coordinator source hashes matched the final repaired adapter/harness/fixture files; frozen backend source and binary hashes were verified again
- Final deliberate lifetime-cancellation report `dd1f6bd1-e443-49a0-8d41-467cd1cf0e5b` failed as intended, preserving `intentional owned lifetime cancellation` as the primary error without secondary errors. Both final runs confirmed workload cleanup and owned Server/Worker/PostgreSQL PID/listener disappearance with independent cleanup signals; neither run claims formal acceptance
- Reports are private fixture artifacts under `$RAINSYNC_ARTIFACT_DIR/owned-soak/<report-id>/owned-soak-report.json`; failed development attempts were retained rather than overwritten
- These are native bounded checks only. Formal image identity, measured eviction, F1–F3, actual browser presentation, full capacity/resource trends and uninterrupted 72h remain open
