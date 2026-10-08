# Bounded platform collection imports

## Current v2 scope

Every expansion is explicit and read-only. Paste one collection, review one
bounded page, and choose up to 20 child items to import. A next-page button makes
one additional request; there is no automatic crawl, import, playback or enqueue.

- Bilibili ordinary video parts and public UP season/series pages
- Bilibili whole PGC and course season selectors, producing exact episode
  references with the existing per-viewer whole-playback entitlement gates
- YouTube ordinary public/unlisted PL playlists, using explicit flat/lazy slices
  of 20 items plus a validated sentinel
- TikTok saved collections and creator playlist/mix selectors
- Douyin collection/mix selectors through a closed unsigned API adapter

Douyin and TikTok may require login, an approved app, signatures or a challenge.
These are genuine access blockers. This implementation does not generate
signatures or fingerprints, solve challenges, harvest browser cookies, use an
alternative app API, bypass protection, or claim real acceptance was verified.

## Version and account contract

POST /api/v1/rooms/{room}/platform-media/preview uses collection:true and
collection_version:2. Further pages pass only the returned opaque continuation
string. The server binds it to the original room/controller/login/server epoch,
canonical collection/provider, frozen account identity/revision, fixed expiry,
and internal page/cursor/snapshot. Caller-supplied endpoints or raw cursors are
never authority. Unknown fields fail closed.

Anonymous mode consults no vault. Own-or-anonymous is supported only for the
caller’s YouTube playlist or Bilibili PGC/course metadata and is frozen before
work, then guarded before and after it. Other collections remain anonymous.
Credentials stay out of public DTOs and CDN headers. Private/no-store title
handling and room-controller checks apply to every page and batch.

PGC/course/parts metadata is a finite snapshot sliced locally, explicitly rather
than described as provider pagination. Snapshot changes require re-review.
YouTube provides fresh bounded views: the previous validated canonical sentinel
hash must equal the next page’s first identity. This detects boundary reordering
or deletion; it does not certify unseen rows or whole-playlist immutability.

TikTok’s genuine 30-row saved-collection response is reviewed as 20 plus 10, with
an identity/title snapshot check before the second slice. Only then can an
explicit request move its provider cursor by 30. Creator mixes and Douyin use
actual returned cursors, checked for matching collection identity and progress.
Native UP season/series pages use the source’s numbered pagination.

At most 100 explicit pages and 2,000 accumulated UI items are reviewed. Every
response has at most 20 visible items; every batch has at most 20 selections.
Source has_more remains visible as truncated even if the bounded page cap stops
continuation. No unverifiable next page or completed full list is invented.

## Legacy v1 compatibility

Omitting collection_version retains the old first-page contract: ordinary Bili
parts/UP collections, YouTube PL and saved TikTok collections. Newly added whole
PGC/course, TikTok creator and Douyin selectors require v2. V1 does not follow a
cursor, does not gain new account scope, and never silently enters v2.

## Selection and cancellation

Only canonical references, bounded titles, hashed keys, sanitized failures,
truncated, limit:20, next and omitted counts are public. Raw media URLs,
extractor dictionaries, credentials and headers are not exposed. Collections
start unselected. Explicit pages append deduplicated references while preserving
up to 20 selections. Input/provider/account mode/room/login changes retire stale
work. Cancelled or repeated batches preserve partial successes and existing
room/provider/content/part idempotency; every child still verifies its own rights.

## Provenance and verification

See [source and bounds](../crates/providers/src/platform/imports/BOUNDARY.md) for
maintained source URLs and [other live](PLATFORM_OTHER_LIVE.md) for the distinct
live adapters. Pure fixtures cover identity, source envelopes, pagination,
sentinels, snapshot changes, account intent, limits and cancellation. Real
platforms, yt-dlp execution, media, credentials, PostgreSQL/listeners and browser
playback acceptance were not exercised; deployment and activation remain deferred.
