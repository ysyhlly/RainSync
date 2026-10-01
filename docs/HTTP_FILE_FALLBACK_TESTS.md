# HTTP file continuation verification

The feature contract is [HTTP_FILE_FALLBACK_CONTRACT.md](HTTP_FILE_FALLBACK_CONTRACT.md). These tests own disposable native PostgreSQL clusters, loopback listeners, child processes and generated legal media. They never accept an existing database URL, build a shared target, use Docker, write to remote services or operate a user device.

## Migration test

`tests/http-file-fallback-migration.mjs` applies the unchanged migrations 1–36, creates explicitly labeled migration fixture rows, snapshots every prior value, and applies migration 37. It verifies:

- Existing membership, request, grant, login, source and media values survive the upgrade; new continuation request fields stay absent
- The original source gate keeps legacy behavior when authorization context is absent
- Existing and newly inserted memberships have non-null independent epochs; explicit-column remove/rejoin creates a different epoch
- Current frozen login and membership scope is allowed; 37 malformed, missing, extra, JSON-null and foreign scope shapes fail closed
- Expired or deleted login, a different current login, removal/rejoin and stale source revision do not restore authority
- Context byte bounds include the 8192-byte limit and multibyte UTF-8; parent claims need context, an existing grant and one unique successor key
- PostgreSQL child closure, PID absence, `pg_ctl status` and loopback port closure are positively checked

Run against an already available native PostgreSQL installation:

```sh
RAINSYNC_NATIVE_POSTGRES_BIN=/absolute/postgresql/bin \
RAINSYNC_ARTIFACT_DIR=/absolute/owned/evidence \
node tests/http-file-fallback-migration.mjs
```

The focused native test passed 22 grouped checks against contract commit `9e39ddc`. Its report is written beneath the artifact directory. This result is a real isolated 1–36 → 37 upgrade, not evidence about a production database.

## Public API test

`tests/http-playback-continuation.mjs` exercises the enabled implementation. It does not build binaries. It requires a successful native backend binding containing migration 37 and verifies the exact service binary and source hashes before and after execution. An unimplemented checkpoint fails its positive continuation case.

```sh
CARGO_TARGET_DIR=/absolute/owned/bound/target \
RAINSYNC_HTTP_CONTINUATION_BINDING_FILE=/absolute/backend-binding.json \
RAINSYNC_NATIVE_POSTGRES_BIN=/absolute/postgresql/bin \
RAINSYNC_ARTIFACT_DIR=/absolute/owned/evidence \
node tests/http-playback-continuation.mjs
```

The coordinator reuses `isolatedMediaStack`, creates media/sources/rooms/plans through actual APIs, and uses WebSocket room control. Root/ordinary POSTs use `/api/v1/playback-sessions`; continuation POSTs and their identical-key replays use `/api/v1/playback-sessions/http-file-continuation`. An explicit ordinary-route rejection case verifies no parent claim, sample mutation or source I/O. This separate route prevents an older Server from silently treating a cached continuation marker as a fresh request after rollback; it uses the same atomic handler and adds no reservation handshake. The origin captures exact conditional headers and can hold child probe requests until a committed claim, final observation and stopped root have been observed. Membership deletion is explicitly labeled owned SQL fault injection; rejoin, logout, source policy changes and cancellation use public APIs.

Executed coverage includes known no-audio and one-audio success, strong ETag and reliable Last-Modified conditions, actual FFmpeg output decoding, final-sample/lost-response deduplication, cross-user/room/viewer/media fences, two independently live same-user logins failing each other's frozen root/child POST replay and continuation claim, concurrent successor keys, a retryable child failure retaining its frozen claim, caller timeout while queued on a real PostgreSQL room lock, cancel-before/after claim and late POST, changed validator/length/type and ignored conditions, authority changes during held initial-root and child probes, and legacy/unknown/ambiguous/HLS/weak/unknown-length rejection. Explicit-direct HTTP remains unprobed and ineligible; its weak/unknown-validator one-shot delivery remains usable.

The additional viewer-replacement race advances the same viewer from a claimed generation-2 child to an ordinary generation-3 intent while the child origin probe is held. The old request returns `STALE_PLAYBACK_PLAN`, its origin socket closes before the barrier releases, the Worker execution is durably reaped, and the replacement remains ready.

Four actual Worker HTTP delivery races hold origin headers during logout, membership remove/rejoin, source revision and viewer replacement. Each returns `INVALID_PLAYBACK_SESSION`, closes the origin socket before release with zero source headers/media bytes, records durable delivery reaping, and rejects later delivery before any new origin request. Native fixture revocation took 1.983–1.999 seconds.

All 31 grouped API checks passed against backend source commit `382002d6a20a628ca7a5fc3bccb4305421f36631`. The positive case decoded eight real video frames from the successor's generated HLS output. All 178 bound backend source inputs and three service binaries remained identical before and after both the original 26-case run and expanded 31-case run. Evidence identities for the expanded run:

- Backend source digest: `f7adcb9ff1798e224920a55f9a56242ab19edd6e31bb764b178537c23284d264`
- Coordinator SHA-256: `0dcf7344685f25f264c2306342b13792f75aea5fe462d4e84b6ca311acc4dd4b`
- Fixture/run ID: `60ffd54c-57e6-466f-bd3a-8753f255ccbf`
- Report SHA-256: `0c849d59b5e782837c99ec39e411dfac79703073be1091adee22cd07fc39cb57`

The incremental active-body case also passed in a full 32-group run against the same frozen source and binaries. The origin returned validated `206` headers with the pinned strong ETag and complete length, sent 2048 Binary bytes, and withheld the remaining 34,773 bytes behind a body gate. The real Node HTTP consumer received and compared the first 1024 bytes, then remained paused and retained throughout public logout and drain verification. Logout completed in 4 ms; origin socket closure was observed in 1990 ms and durable reaping of the exact live delivery execution in 2005 ms, both before releasing the origin gate. The Worker independently reset the client response with `ECONNRESET`; the test did not resume, consume, cancel or drop its body until after reaping. A later delivery request was rejected before any new origin I/O.

This case proves cancellation of an already-started Binary delivery with an idle retained consumer and blocked origin body. It does not claim a saturated kernel/client buffer or a bulk backpressure soak, and bytes sent before logout cannot be recalled. The timings include public logout and polling observation and are native-fixture results, not a production latency guarantee. The earlier 31-group report remains unchanged. Evidence identities for the 32-group run:

- Backend source digest: `f7adcb9ff1798e224920a55f9a56242ab19edd6e31bb764b178537c23284d264`
- Coordinator SHA-256: `20bc4606d056cd81c83227b4cfe4fcebcea46267b8d72da45cbb8078c1e09208`
- Fixture/run ID: `b48356f4-f647-4c7f-bcd2-ea7c4ff2f203`
- Report SHA-256: `9e119b5dab33226ac62b579c02225139ca3fb97dbbff03fa736e3bcad4d0ea10`

All Server/Worker/PostgreSQL/origin/decode process and listener teardown checks passed in the incremental run, including observed PostgreSQL child closure, PID absence and `pg_ctl status` 3. All bound source and service binary hashes remained identical before and after execution.

The final repository-Prettier-formatted coordinator passed the complete 32-group matrix again with the same frozen backend source and binaries. In this final run, public logout completed in 5 ms, the already-started origin response closed in 1979 ms and the exact delivery execution was durably reaped in 1998 ms while its consumer remained paused and retained and its remaining origin bytes stayed gated. All process, listener and native PostgreSQL teardown checks passed. The earlier reports remain unchanged. Final candidate evidence:

- Backend source digest: `f7adcb9ff1798e224920a55f9a56242ab19edd6e31bb764b178537c23284d264`
- Formatted coordinator SHA-256: `fda39dd9b3ee93679d38e896def8221966aa56e131f72d1850d52a3f897a5d54`
- Fixture/run ID: `21d595b3-2380-488a-b022-09b842c927d8`
- Report SHA-256: `29003700e331dad5a362a9047b3570acb052df5c89c455e44763a23fda41c06e`

Reports are written beneath `RAINSYNC_ARTIFACT_DIR/http-playback-continuation/<run-id>/report.json`. This matrix verifies unchanged encrypted claims across temporary retries. It does not claim a real-time 335-second deadline or 30-minute grant-lifetime run; completed-child replay follows the ordinary live child grant rather than extending preparation authority.

The JSON report distinguishes each executed case and includes positive Server/Worker/PostgreSQL/origin/decode-process teardown. It is focused API and media-processing evidence. Browser behavior, real devices, real upstream product compatibility, production migration and long-duration acceptance remain separate.
