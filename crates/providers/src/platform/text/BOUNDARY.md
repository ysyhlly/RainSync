# Native platform text boundary (2026-10-05)

Implemented code and synthetic fixtures only. No live site, login, cookie,
provider request, WS connection, PostgreSQL acceptance or deployment was run.
A successful offline parser/type check is not provider acceptance.

## Source-grounded adapters

- Bilibili UGC keeps existing bvid/cid metadata. PGC first rechecks its imported
  ep/cid/season with the existing episode adapter, then uses verified aid/cid
  plus ep/season at x/player/v2. Course rechecks ep/aid/cid/season and uses its
  aid/cid; neither maps an episode identifier to an ordinary BV identifier.
  Metadata never creates playback entitlement: the text gate first requires the
  existing full-content immutable viewer/login/account/media delivery grant.
  [Player response contract](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/video/player.md)
- TikTok subtitleInfos and claInfo/captionInfos; ByteDance interaction_stickers
  auto_captions utterances JSON. VTT and SRT are converted to plain bounded
  source-time cues. Metadata must first pass the existing ordinary-video
  identity, access, DRM, duration and media-origin checks. Caption transport is
  restricted to the existing provider CDN roots and .vtt/.srt/.json paths.
  Unknown caption metadata, format or origin gets a precise refusal, never
  fabricated empty success. No mirror/signature/fingerprint/challenge fallback.
  [Maintained extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py)
- Bili protobuf seg.so uses cid and a six-minute package index. At most current
  and previous packages are fetched per request; actual sealed duration bounds
  requested playback time. Mode7 positioned JSON keeps only its text value;
  mode6 is plain scroll. Script/BAS/action/URLs/styles/identities never execute
  or leave the server. XML remains a legacy parser, no silent format fallback.
  [Protobuf schema](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/grpc_api/bilibili/community/service/dm/v1/dm.proto)
- Bili live recent history is a separate explicit five-second polling mode,
  bounded to recent messages and the exact current broadcast. It is not the
  complete realtime feed.
  [Recent-history contract](https://github.com/renmu123/bilibili-API-collect-next/blob/master/docs/live/danmaku.md)
- Bili realtime uses legitimately returned nav WBI keys, ordinary timestamp
  signing, one SPI-issued transient buvid3 and one getDanmuInfo. Issuance needs
  the separate disclosed runtime opt-in; no ID is synthesized, saved, reused
  across viewers or reissued on challenge. The ID goes only to fixed discovery
  and that socket's auth payload. Account cookie goes only to fixed metadata
  APIs, never caption/media CDN or WS headers. Auth UID is the nav-returned
  exact session UID, anonymous remains 0. One discovery-listed WSS host is
  public-DNS checked, TCP pinned, TLS certificate/SNI checked on 443 / 2245.
  There are no alternate-host, blank-token or anonymous retry paths.
  [Current protocol](https://github.com/streetartist/BiliKit/blob/main/Bilibili-Live-API-master/API.WebSocket.md),
  [SPI contract](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/misc/buvid3_4.md)

## Bounds and ownership

- Text bodies 2 MiB, catalog 64 tracks, cues 20,000, plain cue text bounded.
- WS frames 2 MiB, recursively inflated total 2 MiB, nesting 3, packets 256 per frame;
  only text and timestamp from DANMU_MSG survive. Auth ACK is mandatory.
  Thirty-second heartbeats, sixty-second missing reply cutoff, output 2 MiB.
- No global text/socket/client-ID cache. Realtime is owned by existing
  finite_delivery registry, exact durable gate and its independently checked
  two-minute live grant. Source/current-broadcast checks additionally recur
  every 10 seconds; queue/source disposal runs on cancel, logout, stale plan,
  grant/account/room revocation and shutdown. No automatic reconnect.
- Frontend fences serial, selection, login epoch and AbortController; switching
  media, Off, replacing video or disposing the runtime removes managed cues.
  Finite transform seek origin maps original source timestamps; live maps
  broadcast timestamps to decoder-local arrival time without a room seek.
- Live subtitles use actual decoder-observed CEA/native captions only. Hls.js
  CUES_PARSED captures timed captions; native caption tracks are accepted only
  after the exact current source URL matches the live grant. Plain cloned cues
  have no upstream styles. WebVTT/IMSC external subtitle fetching is disabled
  in live Hls.js. No absent track is advertised, ASR timing is not invented.
  Other-live v2 permits only this in-band path; remote subtitles/chat explicitly
  remain unsupported.
  [SDK event contract](https://hlsjs.video-dev.org/api-docs/hls.js.cuesparseddata)

## Still requires controlled acceptance

Real platform availability, provider anti-bot/login/entitlement behavior,
long-lived socket behavior, actual CEA broadcast presence, Safari native track
behavior, provider CDN caption shapes outside the narrow current path policy,
PGC/course caption availability and runtime stop/revoke/shutdown integration.
Script/BAS rendering, interactive actions and undocumented live ASR schemas are
intentionally not executable adapters. Their absence is not reported as an
empty, successful subtitle/chat result.
