# Bilibili live room controls

Live is explicitly negotiated, not inferred from an unknown duration. Public native metadata v3 binds one immutable Bilibili room, uid and broadcast identifier. A restarted broadcast requires a fresh import and media identity. Native prepare intent requires `live_version: 1`; the public v1 native binding carries `live: {version: 1, broadcast_id, sync_mode: "live_edge_control"}`. A live HLS plan has null duration, zero timeline origin, no seek rebuild and a known empty global seekable range list.

The server authority transaction locks the selected room-private media identity and compares its live binding with the room snapshot. Client capability flags cannot create live mode. Live room commands also require explicit `live_version: 1`. Global seeks, any rate except 1, and EndMedia are rejected. Play/pause leave the room anchor at zero and keep the generation; play returns each decoder to its locally observed edge. Live exhaustion or provider closure fails the viewer locally without automatic playlist advancement. Ordinary unknown-duration media retains existing VOD behavior.

The Web player labels this as live-edge/play-pause control sync. No shared program-date-time mapping or frame alignment is certified. Global progress/rate controls are hidden for live. Pause/resume and playback reloads return to the local edge. Native subtitle/danmaku VOD cues are unsupported for live and retired with the old grant. A changed generation, broadcast, account, room lifecycle or intent retires stale callbacks and the old decoder.

Delivery is private same-origin `/api/v1/platform-live-delivery/{session}/playlist.m3u8` and `/segments/{opaque-lowercase-hex64-key}`, with an exact lowercase-hex64 token. The Web plan validator fences origin and session, rejects URL aliases, and the Hls.js loader applies the same fence to every playlist/segment request. Closed/stale delivery errors stop live playback rather than invoking VOD decoder or timeline recovery.

## Upgrade boundary

Deploy the live-aware Server and migration together before enabling live import. All Server processes serving shared rooms must understand the live snapshot and immutable selection semantics. An old Server binary is not compatible with a live room, even though legacy clients fail closed against the live-aware Server. Existing VOD fields and canonical serialization omit the new optional fields when unnegotiated. Legacy client prepare/import/control requests cannot opt into live accidentally.

## Offline verification

- `cargo test -p protocol -p room-core --offline`: ordinary replay/authority regression coverage plus live timeline, legacy capability, seek/rate/EndMedia rejection, pause/resume, stale generation and immutable-fact diagnostic replay fixtures
- `vitest run tests/native-live-contract.test.ts tests/native-platform-ui-runtime.test.ts`: pure plan/import/URL fences and native HLS runtime pause/resume, ended/offline and stale callback fixtures
- Existing native platform UGC/PGC/quality/import/UI suites and Web TypeScript validation are also required

These checks use synthetic local fixtures. They do not establish browser rendering, real-provider behavior, authentication, PostgreSQL execution or deployment success.

## Forward-window expiry recovery

A validated forward rolling-window gap in the same broadcast has the distinct non-retryable public code `NATIVE_LIVE_WINDOW_EXPIRED` (409). The Web player may rejoin the current edge with one fresh viewer-plan generation for the unchanged login, room, media generation, broadcast and credential scope. It never reimports a broadcast automatically. Rewind, overlap mutation, invalid discontinuity, authorization errors and a changed broadcast remain terminal.

Native HTML HLS exposes only a generic network error. For that error, the player may probe its already validated private same-session playlist once using same-origin credentials and no redirects. The entire fetch and body read share a 2.5-second absolute deadline and a 16-KiB error-body cap. Only an exact JSON 409 `NATIVE_LIVE_WINDOW_EXPIRED` authorizes the fresh generation; 2xx and unknown errors do not.

Neither successful preparation nor a scheduled refresh resets the recovery budget. The replacement must emit actual playing plus bounded monotonic media progress (at least 0.5 seconds across at least one second) before another healthy pause/background episode may rejoin. Seek jumps do not count as resumed playback. Cancellation and login/media/broadcast/account changes abort or fence pending probes and old callbacks. Terminal live failures also stop first-frame and media-data deadlines so later timers cannot replace the actual failure.
