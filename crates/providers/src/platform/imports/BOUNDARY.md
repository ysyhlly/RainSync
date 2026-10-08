# Explicit collection pages

This is an implementation with offline fixtures and type checking. No real
platform request, cookie, signature, extractor, database migration, listener,
media request or deployment was exercised for this change.

## Provenance inspected 2026-10-05

- [Maintained yt-dlp Bilibili adapters](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)
  ground UP season/series native numbered pages and separate PGC/PUGV season
  metadata selectors. The PUGV season adapter uses `season_id` and filters
  episode access. Existing RainSync episode parsers retain their positive access
  and whole-playback gates; listing cannot mint or replace those proofs.
- [PGC metadata schema](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/bangumi/info.md)
  and [course metadata schema](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/cheese/info.md)
  explicitly document `season_id` as an alternative to `ep_id` at the two fixed
  metadata endpoints. These mutable maintained response schemas are additional
  request/envelope evidence, not a current account acceptance receipt.
- [Maintained yt-dlp saved TikTok collection adapter](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py)
  grounds the fixed 30-row web response and cursor increments of 30. RainSync
  explicitly reviews its first 20 and remaining 10, binding the second slice to
  the complete response's identity/title hash before requesting a new API page.
- [Maintained TikTok-Api creator playlist adapter](https://github.com/davidteather/TikTok-Api/blob/main/TikTokApi/api/playlist.py)
  grounds the fixed mix endpoint, bounded count and returned cursor. Only one
  explicit playlist is admitted. Each record must echo the requested mix ID.
- [Maintained Douyin downloader API adapter](https://github.com/jiji262/douyin-downloader/blob/main/core/api_client.py)
  grounds the mix endpoint and returned cursor. It reports a current signature
  gate. RainSync makes only a plain, fixed unsigned request and stops on denial;
  its implementation does not include that project's signer, impersonation,
  fingerprint, browser fallback or challenge path. Real Douyin collection access
  remains blocked wherever the platform requires those mechanisms.
- [Maintained yt-dlp CLI](https://github.com/yt-dlp/yt-dlp/blob/master/README.md)
  grounds fixed flat/lazy playlist index slices. YouTube's configured resolver
  requests 20 entries plus one sentinel, with a maximum 100 explicit UI pages.
  The validated canonical 21st sentinel is hashed into the encrypted
  continuation; the next page's first identity must match before rows are
  exposed. This detects page-boundary reorder/deletion. Each page remains a
  fresh bounded view, and this does not certify unseen-row or whole-list
  immutability.

## Authority and bounds

The v2 server response returns an encrypted, short-lived continuation bound to
room, controller, original login, provider, canonical collection, frozen own
account state and the internal page/cursor/snapshot/offset. The client cannot
supply a raw endpoint or continuation cursor. Every page is read-only, has at
most 20 visible rows, and requires an explicit next-page action. Selection is
preserved by exact canonical identity, but a batch remains at most 20. No page
or preview automatically imports, resolves child media, plays, or enqueues.

PGC/course/parts APIs return finite metadata snapshots; local slicing is labelled
as snapshot slicing rather than invented provider pagination. Snapshot changes
require re-review. Course/PGC output uses exact episode routes, never a UGC BV/AV
fallback. Restricted episode metadata is omitted. Actual import and playback
still require every child's existing whole-entitlement proof for each viewer.
Only the current user's Bilibili cookie reaches the two fixed whole-season APIs;
other new collection endpoints remain unsigned anonymous reads.

JSON is bounded to 2 MiB, duplicate keys are refused for new paged parsers, and
IDs/collection echoes/cursor types/advancement are checked. Complete Bilibili
metadata is bounded to 2,000 episodes; only the requested 20-row slice runs the
existing selected metadata parser, avoiding quadratic full-season reparsing.
UP native numbered pages have no immutable provider revision; they are fresh
bounded pages. Actual account/provider/browser acceptance remains unverified.
