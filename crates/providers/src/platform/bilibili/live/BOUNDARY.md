# Bilibili clear HLS live-edge boundary

This is an offline-verified first slice. No actual Bilibili broadcast, provider
login, cookie, signed CDN download, live-account acceptance or deployment was
exercised. The tests are explicitly synthetic, source-shaped fixtures.

## Provenance

- Maintained SyncTV checkout at commit
  `ca91048b9da595e50642a61618b0eabfbc05e09b`,
  [Bilibili client](https://github.com/synctv-org/synctv/blob/ca91048b9da595e50642a61618b0eabfbc05e09b/synctv-media-providers/src/bilibili/client.rs)
  `parse_live_page` and `get_live_streams`: fixed room/get_info and
  xlive/web-room/v2/index/getRoomPlayInfo endpoints; canonical room/UID,
  live_status/live_time; http_hls, format and codec nesting; host+base_url+extra
  construction; explicit expires query field.
- [Maintained yt-dlp BiliLiveIE](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py),
  inspected 2026-10-04: same room/play-info envelopes and room live status,
  normal web query selector semantics and qn labels. The qn label is never a
  measured pixel resolution. No extractor process or fallback is used here.
- [Observed API response documentation](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/live/info.md),
  inspected 2026-10-04: http_hls/ts/avc on HTTPS bilivideo.com subdomains under
  /live-bvc/, and fmp4 alternatives. Only the observed bilivideo.com live family
  and clear TS path are admitted; fmp4, FLV, image/static/VOD hosts and broader
  Bilibili/third-party CDN families are absent. This response example is not a
  current provider acceptance guarantee.

- [RFC8216 §3.2](https://www.rfc-editor.org/rfc/rfc8216.html#section-3.2):
  one-program TS and per-segment PAT/PMT requirements when EXT-X-MAP is absent.
  [FFmpeg TS parser vocabulary](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/mpegts.c)
  supplies reviewed AVC/AAC and HLS sample-encryption stream-kind references.
  No FFmpeg execution or media transcoding is involved.

## Supported contract

- Exact HTTPS live.bilibili.com/ROOM and /blanc/ROOM pages only, optional trailing
  slash; no query/fragment, shortlink follow, embedded player, AV/BV/PGC alias.
- One room metadata and one normal fixed play-info API request, with the exact
  viewer's optional ordinary Bilibili cookie confined to those two APIs. No
  token refresh, anonymous retry, account substitution, alternate region/API,
  browser scraping or entitlement workaround.
- Room must positively be live_status=1. Offline and looping/replay status2 are
  refused. Canonical room, streamer UID and UTC start time form the immutable
  broadcast_id. Aliases require a matching returned short_id. A changed start
  time or supplied play-info identity fails closed.
- The caller must bind broadcast_id into the room media entry and viewer grant.
  A later broadcast requires fresh media identity or an explicit versioned entry
  rebind, never silent reuse of an old immutable grant. Every manifest/segment
  request revalidates account/login/member/viewer/plan/source authority and the
  current broadcast. One grant is at most120 seconds and may be shorter than a
  signed URL's known expiry. A provider denial never triggers a fallback.
- Only normal clear http_hls/ts/avc with actual current_qn80 or150 is admitted.
  qn150 is requested once. No pixel-height promise, quality hopping or rendition
  ladder is inferred. Explicit protection/access/payment/preview/geo denials
  are refused before any address is retained.
- CDN requests are cookie/auth-free, redirect-free and full public-DNS-answer
  checked/pinned per request. APIs2MiB, playlist128KiB and segment16MiB under
  20-second deadlines, also capped to any recognized signed CDN expiry. Each
  segment must carry a CRC-valid single-program PAT/PMT identifying exactly one
  AVC video and one ADTS AAC audio stream. PSI reassembly is bounded to1024-byte
  sections/64sections per PID; conditional-access tables/descriptors,
  registration descriptors, unknown/sample-encrypted stream kinds, malformed
  framing and scrambled packets fail closed. This is structural admission, not
  a decoder/profile compatibility guarantee.
- The playlist is a closed media graph with explicit media-sequence. Every
  reference is resolved within the exact playlist origin and live-bvc subtree,
  must be a full TS segment and must appear in the admitted latest rolling
  inventory. Keys (including METHOD=NONE), master/alternative/LLHLS routes,
  byte ranges, init maps, variable references, GAP, ENDLIST, EVENT/VOD and unknown
  EXT tags fail closed. No upstream tag, URI or comment is copied to browser
  responses. Application routes carry per-grant sequence/discontinuity fences.
- Rolling windows are at most180 seconds/120segments, preserve monotonic
  sequences and overlapping segment/path/discontinuity/duration/PDT identity,
  and retain only the latest window. They are neither a finite capture nor DVR
  recording; ordinary/static-HLS Workers and generic download pipelines are not
  involved.

## Synchronization honesty

The first slice is explicitly live-edge viewing/control sync. It does not claim
frame-aligned viewers. A valid upstream PROGRAM-DATE-TIME is parsed and fenced,
but withheld from rewritten output because merely having PDT does not establish
one shared, verified room timeline mapping. Tight synchronization would require
a separately validated shared timestamp map and a protocol capable of using it.

Live room state must not extrapolate a finite VOD position. Global seeking,
playback rates other than1, finite EndMedia and auto-next are disabled. Local
pause is permitted, but resume returns to live edge. A provider end/offline/error
is a live failure/end condition, not permission to mark finite media complete.
