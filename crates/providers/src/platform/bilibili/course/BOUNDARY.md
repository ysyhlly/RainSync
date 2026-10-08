# Bilibili course single-episode boundary

This is an offline-verified, source-grounded first slice. It does not claim that
Bilibili accepted a real course, cookie or media request. No provider API,
authentication, course purchase, real media download, database migration,
listener, deployment or publication was exercised for this slice.

## Source provenance, inspected 2026-10-04

- Maintained yt-dlp at commit
  `51bab8a0116f4d8004c315706d809782607d5847`,
  [course extraction](https://github.com/yt-dlp/yt-dlp/blob/51bab8a0116f4d8004c315706d809782607d5847/yt_dlp/extractor/bilibili.py):
  the separate `/pugv/view/web/season` and `/pugv/player/web/playurl` APIs,
  selected episode `id`, `aid`, `cid`, publication denial `ep_status=-1`,
  `playable` purchase/access gate and season-level `episode_can_view` filtering.
  Its normal course query uses `avid`, `cid`, `ep_id`, `fnval=16`, `fourk=1`.
  Its format extractor selects the main DASH/durl content, without stitching
  `fragment_videos` into the lesson.
- Maintained yutto at commit `46d4bc0a0fe62dbcf9eba67db33d3e50ede5ed96`,
  [course API](https://github.com/yutto-dev/yutto/blob/46d4bc0a0fe62dbcf9eba67db33d3e50ede5ed96/src/yutto/api/cheese.py):
  the PUGV handler explicitly classifies `data.is_preview=1` as preview, and
  selects only the main `data.dash.video`/`audio`. RainSync rejects previews;
  it does not reproduce yutto's warning-and-continue behavior, DRM request
  parameter or unsupported media routes.
- Independent maintained 48tools at commit
  `9090c974f17e979f149018d2cba343651e668f96`,
  [course metadata fixture](https://github.com/duan602728596/48tools/blob/9090c974f17e979f149018d2cba343651e668f96/packages/48tools/src/__mocks__/services/bilibili/download/pugv%24view%24web%24season%40ep_id%3D215167.mock.json)
  and [PUGV playback fixture](https://github.com/duan602728596/48tools/blob/9090c974f17e979f149018d2cba343651e668f96/packages/48tools/src/__mocks__/services/bilibili/download/pugv%24player%24web%24playurl%40avid%3D960526794%23ep_id%3D215167%23cid%3D1255148570.mockdata.json):
  known selected metadata `playable=true`, `episode_can_view=true`,
  `ep_status=0`, `status=1`, `from=pugv`, duration 2637 seconds. The main
  playback has numeric `is_preview=0`, duration 2636133 milliseconds,
  `has_paid=false` and clear AVC/AAC tracks. Its extra fragment is separately
  identified as `PUGV_FRAGMENT`, position `POST`, index 0, a different aid/cid
  and duration 10.68 seconds. Audio sampling rate is absent, so it must be
  obtained from bytes rather than guessed. These public source fixtures are
  independent evidence of response shape, not current platform acceptance.
- The public [course metadata schema](https://raw.githubusercontent.com/bilibili-plugins/bilibili-api-collect/master/docs/cheese/info.md)
  identifies course IDs as separate from PGC, metadata duration as seconds,
  and `status` values 1/2 as viewable/not viewable. The
  [course playback schema](https://raw.githubusercontent.com/bilibili-plugins/bilibili-api-collect/master/docs/cheese/videostream_url.md)
  specifies the normal query and `timelength` milliseconds; it documents
  `-403` as permission insufficient and explicitly leaves `has_paid` meaning
  unknown. These mutable schema links are inspection references, not stability
  guarantees or substitutes for the pinned playback evidence above.

No upstream implementation is copied into the adapter. The existing RainSync
bounded Bilibili JSON, URL, video, quality and SegmentBase helpers are reused.
The narrow reusable MP4 initialization parser uses the existing audited
single-track fragmented MP4 parser, not a default AAC rate.

## Supported contract

- `course:ep<ID>` or exact HTTPS Bilibili `/cheese/play/ep<ID>` URLs, optionally
  ending in one slash. Positive canonical decimal IDs preserve the full u64
  range. Bare `ep<ID>` belongs to PGC, not this adapter. Season selection,
  batches, short links, queries/fragments and UGC/live identifiers are refused
- One matching episode in a bounded metadata list. Duplicates or contradictory
  IDs fail. Known `playable=true`, `episode_can_view=true`, `ep_status=0`,
  `status=1`, and `from=pugv` are all required; absent/malformed/unfamiliar
  values fail closed. A private proof binds exact ep/aid/cid/season and duration
  against caller mutation. Metadata has no BVID and never invents one
- One fixed metadata call, one fixed normal course playback call and, only when
  needed, one selected-audio initialization request, sharing the caller's
  absolute deadline. The viewer's normal Bilibili cookie is confined to the
  two fixed APIs. Anonymous fully authorized introductions/free episodes may
  pass. Login, tier, purchase booleans, labels and URL presence cannot grant
  full playback. No other account, API, region, credential refresh or denial
  retry exists
- Direct API root and `data` both require code 0. Numeric `data.is_preview=0`
  is mandatory, and known preview/access/geo/protection contradictions are
  refused. `is_preview=1`, missing, null, boolean, string and unfamiliar values
  cannot mint an opaque whole-episode entitlement. `has_paid` is ignored;
  false is compatible with a provider-authorized complete free episode
- Main `timelength` and DASH duration must each agree with the selected
  metadata's complete lesson duration within 1.5 seconds. This consistency is
  additional truncation detection, not standalone access permission
- Main clear AVC MP4 video and AAC-LC `mp4a.40.2` audio only. All main raw tracks
  are structurally checked, including filtered-out known codec families. The
  AAC rates are bounded to 8–96 kHz and clear audio bandwidth to 512 kbit/s. The
  actual pixel-height ceiling and requested qn ceiling both apply. No compatible
  stream means refusal, not a second request or higher stream
- Maintained consumer behavior and independent duration/identity evidence ground
  selecting the main lesson DASH. At most one known unrelated `PUGV_FRAGMENT`
  `POST`/index-0 metadata record is accepted without fetching or exposing any
  fragment descriptor. It cannot replace or extend the complete main lesson.
  Pre-roll, unknown sequencing/type, main-identity reuse, contradictory fragment
  identity and extra fragment records are unsupported. Post-roll playback and
  lesson sequencing beyond the main episode require a separate reviewed design

## Quality discovery and selection

The server uses the same single, viewer-bound normal playback request with
`qn=127` to discover every admitted clear AVC rendition, independently of the
selected pixel ceiling. The provider's whole-playback, exact-content and
returned-current-quality checks remain mandatory; advertised qualities without
an admitted track never become menu options. Auto still selects at most 1080p.
Manual downgrades keep the complete authorized menu, and selecting an upgrade
performs fresh discovery with the same account and identity checks. No denied
request is retried, and no alternate account or route is used for discovery.

The selected AAC initialization proof remains required when the rate is absent,
and its byte length and strong validator remain bound to the selected audio.

## Missing-rate byte probe

Course audio parsing preserves missing sampling rate as unknown in private
`PendingResolved`/`PendingAudio` values. These cannot expose a playable DASH
result. The unchanged UGC parser continues requiring its existing rate field.

When the selected highest-bandwidth compatible AAC-LC track lacks the rate:

1. Entitlement, exact identity, duration, codec, CDN addresses and SegmentBase
   ranges must already pass before any byte-request descriptor is minted
2. Read exactly the declared initialization range from byte zero, at most
   256 KiB, from that selected primary URL only. No backup retry, media scan,
   full download, selected-quality change or codec fallback is available
3. PlatformHttp retains fixed Bilibili media origins, complete public-DNS answer
   validation and pinning, redirect refusal and credential-free CDN headers
4. Validate exact 206, one Content-Range with known total, exact Content-Length,
   identity encoding and a syntactically valid nonduplicate ETag header
   before consuming a chunk. Last-Modified is checked only for a single bounded
   printable value, not parsed as an HTTP date; this course path discards it
   and does not use it as an access or representation proof. Stream accumulation is bounded to the exact range;
   too much/too little body, an index beyond total and late completion fail
5. Parse exact complete ftyp plus a clear single fragmented moov. AAC-LC rate
   comes from the sample entry and AudioSpecificConfig and must agree with the
   track timescale. Encryption, external references, wrong kind, multiple tracks,
   invalid/truncated/unknown structural boxes, SIDX/media content and rate/channel
   contradictions fail. The parser's existing count/depth/2-MiB bounds apply
6. Only then emit Resolved with its whole-access proof and real sampling rate.
   Observed total length and optional strong ETag remain available to pin the
   selected audio descriptor. Weak ETags are syntax-checked but never used as
   strong representation validators

The checked-in JSON and 44.1-kHz initialization MP4 are explicitly synthetic
source-shaped fixtures. Their IDs, addresses, expiry values, titles and media
bytes are fabricated testing data, not captured signed URLs, credentials or
real account state. The AAC rate is read from deterministic synthetic esds
bytes in tests; no production rate is inferred from the synthetic value.

## Remaining gates

Provider/account/full-episode acceptance, real CDN initialization compatibility,
a real browser lesson playback loop, database migrations and deployment remain
unverified. Different publication/permission values, historical aliases,
progressive/FLAC/Dolby/HEVC/AV1 playback, protected courses, captions/danmaku,
season discovery and additional lesson sequences require reviewed fixtures and
separate work. A failed gate must remain a clear denial/unsupported result.
