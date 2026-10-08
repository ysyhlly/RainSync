# Other-platform clear live edge

This implementation has pure synthetic parser, grant and UI fixtures plus
compilation. No actual provider, extractor, cookie, media, FFmpeg, PostgreSQL,
listener, login, credentials, Git operation, flag activation or deployment was
used. Supported response shapes are a deliberately bounded subset, and real
platform/browser acceptance is still deferred.

## Inspected primary and maintained sources, 2026-10-05

- [yt-dlp TikTokLive](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py)
  supplies the room-info endpoint, live status 2, provider room identity,
  owner identity, HLS pull URL and clear video codec parameters. This adapter
  does not copy its impersonation, alternate guest endpoint or challenge paths.
- [TikTokLive client](https://github.com/isaackogan/TikTokLive/blob/master/TikTokLive/client/client.py)
  documents exact room-ID selection independent of user feeds.
- [TikTok live connector response evidence](https://github.com/thebubble7/tiktok_live_connector)
  shows provider `create_time`, explicit paid/gated flags and an HLS pull URL
  with H264 parameters. These source-shaped fields are parser evidence, not a
  current live account or a captured signed playback grant.
- [Douyin maintained API client](https://github.com/jiji262/douyin-downloader/blob/main/core/api_client.py)
  supplies one exact web-room selector and bounded room response envelope.
  RainSync does not implement its signer, fingerprint, browser/SSR fallback,
  arbitrary recursive room search or reflow API.
- [YouTube maintained video extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py)
  derives `release_timestamp` from provider broadcast start metadata. Only
  current public, unrestricted live metadata with exact video/channel IDs and
  selected clear HLS AVC/AAC is admitted, using the existing private subprocess
  custody. No from-start recording or VOD format fallback is permitted.

## Explicit scope

`RAINSYNC_OTHER_LIVE_ENABLED` defaults to 0. It must be exactly 0 or 1. YouTube
also requires an administrator-configured trusted executable and a separate
`Config.with_live()` opt-in. No executable is downloaded or activated. The live
command is simulated metadata only, has fixed extractor/format flags, disables
scripts, player-JS requests, PO-token fetching and remote components, and reuses tracked process-tree reap and private
viewer-cookie erasure. The process boundary is not an OS/network sandbox.

The public native request uses `live_version:2`; Bilibili remains version1.
Persisted context5 and media resource `other_live` are separate from legacy
UGC1/PGC2/BiliLive3/course4. Every identity binds provider, exact resource ID,
broadcaster ID, provider-observed start epoch, a namespaced SHA256 broadcast ID,
and exact canonical selector. No server-generated start time, truncated numeric
ID or Bilibili three-component broadcast convention is reused.

Douyin/TikTok use only fixed ordinary HTTPS APIs and the exact viewer's optional
provider-bound session. A TikTok handle performs one exact live-page room-ID
lookup and then the fixed room API. No profile feed is crawled. Missing bounded
SIGI metadata, login/challenge/signature gates or unknown response shapes stop
with a user-handoff/access error. They are genuine access blockers; no empty
stub or automatic bypass is presented as successful playback.

## Media and custody

Only clear full MPEG-TS HLS media playlists are admitted. Master/LL-HLS, maps,
byte ranges, keys/DRM, DVR/EVENT/VOD/end lists and alternate streams fail closed.
The source-grounded live CDN families are separate from finite-VOD policies.
Every HTTP request validates the complete public DNS answer, pins it, refuses
redirects, excludes cookies from CDN delivery and bounds bytes/deadlines.
Opaque signed CDN path escapes are preserved; resource identities remain closed
unescaped grammars. YouTube's manifest-to-segment hostname change is permitted
only inside its fixed Googlevideo family and closed manifest/segment path types.

YouTube reloads retain the original sealed signed playlist root for the short
immutable grant while separately revalidating current source metadata. Google
expiry/signature path changes do not justify stripping protected path identity
or replacing/renewing the original root. The initial recognized expiry already
shortens the grant. Other providers may renew signed queries only under the
unchanged source identity and original application deadline.

A rolling graph retains only the current window, with immutable sequence,
discontinuity, duration and origin/path edges. Rewinds and expired windows fail;
unchanged sequence cannot renew freshness beyond three target durations. There
is no original-media clock, seek, observation-v1, fabricated ASR timing or DVR.

Each viewer/login/account/member/room/media/plan/broadcast grant is immutable and
at most 120 seconds. The database source predicate additionally requires a
verified broadcast observation within 15 seconds. This lease lets queued-tail
custody expire without another HTTP poll. Source API denial or offline/change
revokes or blocks existing delivery; high-water epochs cannot decrease or
resurrect an offline-cleared broadcast. Reconnect, account replacement or
session revocation cannot substitute a different principal's account.

Server delivery uses a separate other-live route and registry, but the existing
tracked finite-delivery owner. It admits before source work, bounds source and
queued bodies, keeps permits owned until positive disposal, and joins shutdown
receipts. Memory is only a bounded graph, not the durable authority.
