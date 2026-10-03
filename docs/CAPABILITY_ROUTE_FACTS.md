# Concrete local/HTTP capability and route facts

This is an additive schema-v1 implementation slice for NEXT_PLAN §8.1/8.2.
It is not generalized all-source capability negotiation or physical-device acceptance.

## Offered route explanations

Successful actual-file candidate discovery adds optional `route_decisions` with
exactly the four existing route IDs. `offered` means the server has a candidate
configuration for the client to test; it never means the device can decode it.
The bounded reason enum distinguishes source configuration, constrained encoder
recipe, missing video/audio configuration, unsupported container or video-copy
path, explicit track mapping, no audio, video transformation and nonzero copy
origin. An omitted field retains the old provider/legacy contract.

## Selected configuration provenance

A fresh local or reliable single-file HTTP plan may add `selected_output`.
Its `configuration` is the exact bound server-selected candidate. The current
preparation's guarded probe must reproduce that complete candidate before the
field is emitted. Local resources/jobs retain the same source version and final
version recheck. HTTP keeps its existing current representation pin. The fact
is absent when current probe/candidate equivalence cannot be established; it is
not retrofitted into old stored plans or upstream provider envelopes.

`video_basis` and optional `audio_basis` are independently `source_probe` or
`constrained_encoder_recipe`. Thus audio-only transcoding labels copied video
and encoded audio separately. Null audio is genuinely no audio, not a fictitious
AAC stream. The plan and encrypted resource persist these same facts, and owned
idempotent replay retains them. These are configuration provenance, not measured
encoded output, browser playback, hardware support or presented-frame evidence.
The UI explains audio-only transcoding and distinguishes source configuration
from encoder targets; all device capability results remain estimates.

## Supported additions and source boundaries

- AAC-LC copy requires AudioSpecificConfig sample frequency and channel mapping
  to agree with ffprobe. Configuration 7 means eight channels, not seven;
  program configuration elements, contradictory metadata and unbounded bitrate
  do not acquire a fabricated passthrough configuration
- HEVC MP4 direct-only supports explicit BT.709 SDR Main/8-bit and Main10/10-bit
  with actual hvc1/hev1 sample entry, hvcC profile/compatibility/tier/constraint/
  level/chroma/depth fields and agreeing ffprobe profile/level/pixel format
- HEVC requires the exact positive file decodingInfo result. MIME hints, the
  fixed illustrative HEVC sample and AVC support do not enable this route
- Direct MP4 MIME requires a positively known ISO-BMFF/MP4 major brand. The
  shared ffprobe mov,mp4,... demuxer name alone does not prove the container;
  QuickTime/unknown brands retain eligible remux/encode routes without MP4
  original-file facts. An owned QuickTime→fMP4 copy verifies that fallback
- AVC direct requires an actual avc1 MP4 sample entry. Missing/other MP4
  entries, including avc3, do not acquire avc1 direct or copy configurations;
  the constrained encode route remains available when its source range is
  eligible. Legal non-MP4 AVC copy explicitly sets the output avc1 sample entry
  and has an owned MKV→fMP4 mux-output fixture
- HEVC copy-to-HLS is not offered. Explicit audio selection or ambiguous tracks
  does not claim that original MP4 bytes enforce a selected native audio track
- The fixed 720p30 SDR recipe fits display aspect ratio, including input SAR
  after FFmpeg autorotation, before square-pixel padding. It no longer stretches
  anamorphic content. VFR takes the CFR recipe; no-audio inputs remain silent
- PQ/HLG and Dolby Vision configuration are explicit HDR evidence and produce
  terminal `HDR_UNSUPPORTED`; encv/enca or explicit ffprobe encryption side-data
  produce terminal `DRM_UNSUPPORTED`, meaning unsupported protected/encrypted
  tracks, not proof that a particular DRM licensing system is present
- Missing color metadata is not affirmative SDR evidence for HEVC direct or
  high-bit-depth or unknown-pixel-format conversion. The legacy missing-transfer
  default applies only to a bounded explicit set of known <=8-bit pixel formats;
  missing/zero bits_per_raw_sample cannot bypass this. Missing protection indicators do not certify
  DRM-free content. Ordinary AES-128 HLS key handling is unchanged
- Text subtitle delivery still uses the existing separately authorized VTT
  pipeline and `subtitle_mode`. No image-subtitle burn-in or arbitrary subtitle
  selection is added by these fields

Codec-string basis: [W3C HEVC registration](https://www.w3.org/TR/webcodecs-hevc-codec-registration/)
and [ETSI TS 103 285 §4.4.3](https://www.etsi.org/deliver/etsi_ts/103200_103299/103285/01.01.01_60/ts_103285v010101p.pdf).
Compatibility flags reverse bit order; constraint bytes retain their order.

## Owned verification

`cargo test -p media-core --test capability_output -- --ignored --test-threads=1`
uses short owned FFmpeg files only. Its five groups include an actual avc3
source refusal/encode path and an AVC MKV copy with proved avc1 output entry. It checks Main/Main10 SDR source headers,
actual generated AVC High3.1/720p30/8-bit headers, silent output, anamorphic and
rotated image geometry by decoded pixel bounds, VFR output frame timestamps,
six-channel AAC copy and stereo audio-only conversion at zero origin.
The new local/HTTP API suite is `node tests/capability-route-facts.mjs`, requiring
`RAINSYNC_CAPABILITY_FACTS_BINDING_FILE` from an unchanged native backend build.
libx265 uses `pools=none:frame-threads=1`; all child commands have bounded time
and captured output. Optional `RAINSYNC_CAPABILITY_OUTPUT_REPORT_DIR` records
source content hash, source stat version and observed source/output facts.
The production local-input demuxer policy still rejects arbitrary local HLS;
only this owned generated-output verifier invokes ffprobe on its own playlist.

The first fixture attempt correctly failed because its source did not carry
explicit x265 BT.709 VUI and its generic guarded-file probe disallowed local HLS.
The fixture was corrected, not those production restrictions. Rotation fixtures
use actual display-matrix metadata via `-display_rotation`; the metadata-only
legacy FFmpeg option did not produce the intended test input on this toolchain.

Unit/protocol tests preserve absent v1 fields, reject unsupported enum claims,
keep terminal errors non-retryable, and require exact current-candidate equality.
Frontend tests cover explicit recipe/copy/no-audio descriptions and malformed or
mismatched facts. The separate local/HTTP API fixture verifies grant/version,
job and replay wiring. No Agent channel, NAS, browser or external account tests
are part of this slice. Browser/device acceptance remains unrun.
