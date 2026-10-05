# Bilibili live-edge playback

This is a distinct rolling HLS path. It is not finite VOD, a static-HLS capture,
a recording, DVR, FFmpeg job, or a shared frame-aligned time map. The provider's
optional program-date-time values are validated but are not exposed as proof
of room-wide timeline synchronization.

## Contract

- Preview accepts exact HTTPS `live.bilibili.com/ROOM` and `/blanc/ROOM` pages.
  The metadata endpoint resolves a positively identified short-room alias to
  its canonical room before the preview receipt is keyed. Tracking queries,
  fragments, arbitrary manifests and external segment references are refused.
- Import requires `live_version: 1`. Native metadata is version 3 with the
  tagged resource `{kind: "bilibili_live", room_id, uid, broadcast_id}`.
  Broadcast identity is canonical room, streamer UID and UTC start timestamp
  obtained from the provider's exact live_time. Each broadcast has an immutable
  room-private media ID. A restart requires importing and selecting a fresh row.
- Prepare requires `native_platform.live_version: 1`, an exact viewer/positive
  plan generation, a supported HLS capability, and position zero. It does not
  admit quality selectors, finite seek/audio/candidate/fallback recipes, or
  arbitrary playback URLs. Provider qn 150/80 is not a measured pixel height.
- The plan contains `native_platform.live` with `sync_mode: "live_edge_control"`
  and the exact broadcast ID. Duration is null; the room and player additionally
  use explicit live semantics. Play/pause controls are shared, resume returns to
  the live edge, seek and non-unit rate are refused, and finite EndMedia/autonext
  and the ordinary VOD correction clock are disabled. Live plans never advertise
  observation-v1 or create its original-media-position mapping rows. Phase and
  buffering playback metrics remain available; authoritative room status
  sanitization removes client-supplied live drift measurements.

## Authority and delivery

Playlist and segment routes are private and same-origin beneath
`/api/v1/platform-live-delivery/{session}`. A token is not authority on its own.
Every reload and each bounded output chunk rechecks the originating login,
current membership, room lifecycle, exact media/generation, viewer plan,
account revision and verified broadcast. Live ciphertext also binds the exact
session/viewer/plan/media-generation/login/lifecycle scope, preventing a valid
ciphertext from being transplanted into another grant.

An observed newer broadcast invalidates old grants. The observation table keeps
its start-time high-water even while offline, so an older observation cannot
replace a newer broadcast. A confirmed offline observation terminally stops
existing grants; a later response cannot resurrect a stopped capability.
Encrypted grants and media bindings are not changed during refresh.

A grant lasts at most 120 seconds and is shortened by known URL/account/login
expiry. Replay only shrinks its remaining lifetime. A subsequent fresh prepare
uses a higher viewer plan generation. CDN requests are independently capped by
known signed-URL expiry and a 20-second deadline. Cookies are confined to the
provider's two fixed APIs and never accompany CDN or browser delivery.

The rolling graph contains at most 120 segments / 180 seconds. Encryption,
DRM/sample encryption, keys, masters, LL-HLS, byte ranges, maps, ENDLIST,
unverified TS programs/codecs and unsafe references are refused. Only admitted
sequence/discontinuity/path edges produce opaque same-session segment keys.
Edges removed by a later window stop producing bytes even during delivery.
A validated forward window gap has the specific `NATIVE_LIVE_WINDOW_EXPIRED`
response (409). The player may recover once using a fresh viewer-plan generation
for the same media/broadcast. The old rolling fence is never reset in place;
rewinds, overlapping mutations, impossible discontinuities and broadcast changes
remain hard errors.

Resource bounds are 64 retained live grants, 4 segment streams per grant,
8 process-wide segment streams, 16 MiB per segment, and 256 MiB total segment
fetch bytes per grant. Unknown-size failed fetches consume their full cap.
Manifest polls and segment requests have separate finite per-minute budgets;
CDN playlist reloads are no faster than half the target duration (at least one
second). Fast manifest polls reuse a verified graph and revalidate broadcast and
ordinary authority. The graph is memory-only and disappears at expiry or server
restart; it is never a recording or an alternate source of authorization.
Delivery ownership is admitted before semaphore acquisition and all account,
provider and header work, including HEAD. Source work is cancelled and disposed
on shutdown, request-drop or expiry, and the same owner transfers into delivery.
Delivery uses the shared `media_core::finite_delivery` owner independently of
HTTP consumer polling. It queues at most two copied 16 KiB frames, checks
authority while backpressured, and disposes the full payload and permits on
expiry, revocation, receiver drop or shutdown. Source EOF does not end ownership:
queued tails remain independently monitored until consumed or discarded, and
a blocked read confirmation holds no untracked frame. Positive source-and-queue
disposal receipts precede owner removal; shutdown closes admission and drains
the registry. The receiver does not retain a slice
of the full segment or a strong reference to expired rolling graphs.

## Verification boundary

Rust fixtures cover closed import/prepare contracts, expiry, immutable restart
identities, grant-scope/ciphertext corruption, revocation predicates, bounded
request/byte/state budgets, and rewritten playlist-to-segment keys. Provider
fixtures cover clear HLS graph/sequence/discontinuity/PDT rules and clear TS
program/AVC/AAC validation. The Web/room fixtures cover explicit live control
semantics and stale grants.

No real provider request, credentials, live broadcast, PostgreSQL migration
execution, application listener, physical browser playback, Git publication or
deployment was performed for this slice. Those acceptance checks remain deferred.
Provider provenance and narrower codec/CDN restrictions are recorded in
`crates/providers/src/platform/bilibili/live/BOUNDARY.md`.
