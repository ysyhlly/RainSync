# Legacy stream mapping admission

This change admits new local and reliable single-file HTTP generated playback
only when a current probe proves that the existing analyzer facts and existing
Worker maps refer to the same streams. It does not activate the opt-in indexed
recipe. Jobs, queue dispatch, completed idempotent replay and the public schema
retain their original shapes. Worker video remains `0:v:0`, default audio
remains `0:a:0?`, and explicit audio retains `Some(index)`, including zero.

## Proof and admission

`motion_video::legacy_mapping_equivalent` is a separate strict pure check.
Success from the compatible opt-in `select`/`select_audio` helpers is not proof:
those helpers intentionally interpret incomplete legacy catalogs and unknown
attached-picture disposition values.

The strict gate assumes the caller supplies this attempt's trustworthy complete
FFprobe inventory. It requires:

- A streams array with identifiable video/audio/subtitle/data/attachment types
- Valid unsigned 32-bit absolute stream indices on every row, unique across all
  types; gaps are allowed and vector positions are never substituted
- Selected motion video with explicit numeric `attached_pic=0`, equal to both
  the lowest absolute video index including covers and the JSON-first video
  row used by the current legacy analyzer
- Default audio equal to both the lowest absolute audio index and the
  JSON-first audio row used by the current legacy analyzer
- Explicit audio identifying exactly one globally unambiguous audio stream at
  the requested absolute index; a complete catalog with no audio may match the
  optional default map, but missing inventory cannot prove no audio

The sole job producer in `media::prepare_playback` calls the independent gate
after explicit-audio conversion, candidate selection and device transport
negotiation converge on the actual `local_job`. A candidate report is not
authority to bypass it. Local admission reuses the existing held-file probe
and final file-version recheck. The stat-v1 identity detects ordinary changes;
it is not cryptographic immutability or a content snapshot.

HTTP admission reuses the existing preparation probe. Under the existing final
source-policy/representation fence, it also requires exactly one existing
eligible Binary identity whose target matches the actual resource. Eligible
identity retains the existing reliable length plus strong ETag or reliable
Last-Modified requirements. Existing source revision, pin, deadline, login,
membership, request and lifecycle checks remain in place. No new probe/RPC
sequence is added.

Agent/NAS jobs and JF/Emby upstream negotiation are outside this change.
Ordinary original-file/direct playback that creates no local job retains its
existing behavior. In particular, legacy direct/auto is not silently tightened
to the concrete candidate route's exactly-one-total-video rule.

## Compatibility

| Source/request | New generated local/HTTP admission |
| --- | --- |
| Ordinary complete video/default-audio catalog and current source proof | Retained |
| Noncontiguous absolute indices | Retained |
| Cover after selected motion in absolute and analyzer order | Retained |
| Multiple motion streams with selected/lowest/analyzer-first agreement | Retained; candidate direct remains excluded |
| Valid explicit alternate audio or audio index zero | Retained |
| Complete no-audio catalog | Retained with optional default map |
| Cover before motion, or reordered JSON-first video/default audio | Refused even when codec/configuration or fixed transcode output matches |
| Missing/malformed/duplicate/cross-type indices or missing stream types | Refused |
| Selected video disposition absent, string, Boolean or nonzero | Refused |
| Cached inventory without this attempt's current probe | Refused |
| Legacy HTTP HLS, multiple targets, or missing/unreliable Binary identity | Refused |
| Forced-direct HTTP plus explicit audio that becomes generated without probing | Refused when current probe proof is absent; no extra probe is introduced |

Local/reliable-HTTP candidate discovery filters generated routes with the same
strict proof. Concrete direct candidates retain their existing one-total-video
and at-most-one-audio rules, counting covers. Refused empty candidate sets have
no HTTP marker, a null binding and four not-offered decisions using existing
finite reasons. The web may fall back from an unmarked empty set to legacy
preparation, so independent final-job admission is mandatory.

Local generated continuation hints require the same mapping proof. A direct
HTTP root is marked only after that proof and its existing unique-audio and
reliable-Binary-identity checks. HTTP original/direct fallback hints are cleared
when root marking does not succeed. Original playback itself is retained.

Mapping refusal uses HTTP 422 and the existing `UNSUPPORTED_VIDEO_OR_HDR`
public code through the known internal `legacy_stream_mapping_unsupported`
alias. Its fixed public message describes unsupported media-track mapping and
does not assert HDR. Genuine existing HDR/DRM reasons retain their original
messages. Missing reliable HTTP identity remains HTTP 409
`SOURCE_VERSION_REQUIRED`; changed source/pin and stale capability reports keep
their existing errors. Invalid explicit audio remains `INVALID_AUDIO_TRACK`.
The current web displays the server's structured message.

## Evidence and limits

Read-only retained fixture inspection confirmed numeric `attached_pic=0` for
ordinary FFprobe video: source audio0, motion video1 with disposition0, audio2,
attached video3 with disposition1; the retained generated output also has
ordinary video0 with disposition0. The source mux put cover art last. These
artifacts establish that requiring explicit zero is compatible with ordinary
FFprobe output; no new media run was performed or claimed.

Pure tests cover complete ordinary/cover-last/multiple-video equivalence,
noncontiguous indices, explicit alternate/zero audio, no audio, cover-first,
video/default-audio JSON reorder even with identical codecs, all malformed
index/type/disposition classes, candidate omissions, converged final-guard
scope/freshness, continuation hint filtering and error normalization. Existing
legacy argument-array tests remain applicable. The guard matrix tests the pure
converged admission function; source review verifies its placement after route
choices converge on `local_job`. A later remux-to-transcode promotion preserves
that generated-job decision and both legacy maps. This is not end-to-end API/PG qualification.

On the task-local compact target, offline and locked with incremental and
dev/test debug information disabled, 59 selected pure tests passed: motion
selection/equivalence 22, candidate analysis 18, legacy compatibility 3, Server
plan guards 6, Server candidate selection 6, protocol error alias 1, HTTP error
normalization 1, and existing reliable HTTP identity/target checks 2. Focused
Clippy for media-core, Server, protocol and http-api passed for production and
test targets with `-D warnings`. The existing ts-rs unsupported
`deserialize_with` attribute notice remains in the retained logs. One initial
exact protocol filter matched zero tests; its log is retained, and the corrected
`errors::tests` exact filter ran and passed the required test.

Before compilation, the shared Cargo output lock was acquired and only
workspace-package fingerprint directories were moved to a retained cache
folder using the coordinator-approved helper. Source, compiled outputs and
third-party fingerprints were preserved. Source hashes, target/profile flags,
the retirement receipt/helper hash, exact commands and logs are recorded in
the implementation evidence. The old job-spec source line is unchanged.

No PostgreSQL, Server or Worker service, browser, media rerun, network
change or deployment is part of this validation. API/PG behavior remains
unvalidated. Old unresolved F2, pending Agent/NAS qualification, indexed recipe
cutover, HLS contracts and new PG runtime work remain separate.
