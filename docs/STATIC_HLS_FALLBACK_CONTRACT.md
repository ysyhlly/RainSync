# Static HLS fallback: prerequisite evidence and proposed authority contract

## Current status

**Automatic static-HLS fallback is not implemented or enabled.** The initial
source-timeline prerequisite below changed no public protocol or production
continuation path. Local Stage A now adds internal guarded capture custody,
per-connection reader compatibility and a purpose-separated logical queue; see
[Stage A foundation](STATIC_HLS_STAGE_A.md). It still provides no public parent
offer, child-creation path or production activation. Legacy NULL contracts and
Binary version 1 retain their meaning.

The new reusable modules and owned native fixture establish a deliberately narrow
source-timeline prerequisite. They do not establish a browser clock contract,
prove the earliest generated child output, capture a remote source, or authorize
any playback request. Results keep `accepted=false`, `release_ready=false` and
`production_fallback_enabled=false`.

Relevant requirements are `NEXT_PLAN.md` §§8.3, 9.1–9.3 and 11.2. Existing
`http_file_fallback_version=1` continues to mean one reliable **Binary** target.
An HLS graph must never be smuggled into that contract.

## Implemented source-timeline prerequisite

- `scripts/static-hls-timeline.mjs` is a pure, fail-closed analyzer of actual
  manifest/init/media bytes and complete packet/decoded-frame observations
- `scripts/static-hls-timeline-owned.mjs` is the Linux local-only owned runner
- `tests/static-hls-timeline-contract.test.mjs` generates media with installed
  FFmpeg/Pillow, scans it, checks source-visible pixel clocks and tests rejection

The runner accepts only local basename references, uses a file-only FFprobe
protocol allowlist, rejects symlinks at file open, and checks every input's bytes
again after decoding. No network request, source credential, HTTP validator,
redirect or arbitrary URL is accepted by this runner. This is not a replacement
for the production source-access gateway or immutable capture storage.

### Supported syntax and encoding

The closed prerequisite subset is:

- One complete `PLAYLIST-TYPE:VOD` media playlist with `ENDLIST`, HLS version 6/7
- One initialization resource and 1–64 distinct media resources
- Any nonnegative safe-integer media sequence; the number is never an offset
- One `avc1` H.264 video track without B-frame reordering, CFR 25 or 30 fps,
  dimensions no larger than 1920×1080
- Optional one muxed AAC track, 48 kHz, mono or stereo; absence must be proven by
  both initialization and every fragment, not inferred from an omitted field
- Explicit, self-contained fMP4 fragments with one `moof`, one `mdat`, one `traf`
  for each initialization track, explicit `tfhd` duration/size defaults,
  `tfdt`, and the tested `trun` shape without composition offsets
- A single identity video edit and a single tested audio edit: zero, or exactly
  the AAC 1024-sample encoder priming offset; unknown edit lists fail closed

This intentionally refuses some otherwise valid HLS. It is not a general ISO
BMFF validator or a promise of arbitrary AVC/AAC interoperability.

### What is actually compared

1. Parse the entire selected manifest; reject unknown clock/URI tags rather than
   ignoring them. Every segment duration is matched against its actual samples
2. Parse actual init track IDs, timescales, sample entries and edit lists
3. Parse each actual segment's track set and complete sample table. A missing,
   added or changed track in the final segment fails just as it does in the first
4. Before decode, bound cumulative sample counts, init dimensions/sample rate,
   resource bytes and manifest duration
5. Decode the complete source with FFprobe. Require a successful process, no
   decoder error output, bounded stdout, and a reaped process group
6. Match every reported packet PTS/DTS to the corresponding fragment sample and
   every actual decoded frame PTS/duration to its presented sample. Missing or
   best-effort-invented timestamps, missing frames, gaps, overlap, geometry changes
   and additional tracks are rejected
7. Require zero video and decoded-audio origin, exact per-stream continuity, and
   matching video and raw audio media end. The only permitted end discrepancy is the explicit
   final AAC frame padding, no larger than 1024 samples
8. Record SHA-256 and actual size for all manifest/init/media bytes, including
   the last segment. `staticHlsByteIdentity` keeps byte inventory separate from
   timeline eligibility; `requireSameStaticHlsClosure` rejects a different graph
   even when its timestamps would also be valid

A pure analyzer cannot authenticate a caller's probe JSON. The owned runner records
real decoder execution with before/after byte hashes under an explicit assumption
that no concurrent writer changes its owned fixture directory. Equal hashes do
not rule out a change-and-restore race, an intermediate-directory replacement,
or other mutation while FFprobe has a file open. This runner is not a production
immutable-snapshot mechanism. A future production caller
must instead read only an immutable, authorized, byte-verified capture. It must
never accept this JSON, manifest, URLs or digest claims from a browser.

### AAC priming is not media zero

The owned four-second 25 fps source has video PTS 0 and audio raw packet PTS
−1024 at timebase 1/48000. The initialization edit, first packet's explicit
`Skip Samples=1024`, absence of other skip/discard metadata and complete decoded
scan jointly establish the first presented audio sample at zero. The final AAC
sample is short in its BMFF table but the decoder emits a full 1024-sample frame;
the report preserves this tail padding separately.

`format.start_time`, first packet PTS, first decoded video PTS, and displayed
content time are different observations. None is silently substituted for
another. A generated child whose output PTS is zero still needs source-frame
mapping evidence: seeking relative to FFmpeg's raw format start can be affected
by priming. The source prerequisite alone does not certify that child recipe.
The separate [file-only sealed child fixture](STATIC_HLS_CHILD_TIMELINE_FIXTURE.md)
now verifies a purpose-specific sequential presentation trim on an actual
25 fps mono synthetic HLS source, retaining the failing generic input-seek
counterexample. It provides no public continuation or production authority.

### Fixed implementation bounds

| Bound                            |                          Value | Failure behavior                                    |
| -------------------------------- | -----------------------------: | --------------------------------------------------- |
| Media segments                   |                             64 | Unsupported, no partial closure                     |
| Manifest                         |                        256 KiB | Unsupported                                         |
| Initialization                   |                          2 MiB | Unsupported before decode                           |
| Individual media resource        |                         32 MiB | Unsupported                                         |
| Actual total source bytes        |                        128 MiB | Unsupported while reading                           |
| Source duration                  |                    300 seconds | Unsupported                                         |
| Segment duration/target duration |                     32 seconds | Unsupported                                         |
| Video                            |          ≤1080p, CFR 25/30 fps | Unsupported                                         |
| Audio                            |        ≤2 channels, AAC 48 kHz | Unsupported                                         |
| All packet + frame records       |                         70,000 | Unsupported; sample count bounded before allocation |
| Decoder stdout                   |                         16 MiB | Kill group, await close, unsupported                |
| Decoder error output             |   64 KiB, any error is failure | Kill on overflow, await close                       |
| Capture/decode wall time         |               35 seconds total | Kill group, await close, unsupported                |
| Decoder address space            |  1 GiB via installed `prlimit` | Unsupported on process failure                      |
| Single decoder allocation        |                        128 MiB | Unsupported on process failure                      |
| Decoder CPU                      | 35 seconds, one decoder thread | Unsupported on failure                              |

The owned suite runs sequentially. No global production capture admission is
claimed. The offline pure analyzer holds at most the bounded source closure in
memory plus bounded sample/probe data; the subprocess has a separate address-space
limit. These are not a measured total RSS guarantee. Future production capture
must stream/hash into reserved owned temporary storage, not load a movie into
Server memory. The fixture generator has its own small fixed 100-frame workload;
its pixels are evidence assets, not a production capture.

A slow or unusually encoded source can be rejected below the byte/duration
ceiling. Bounds must not increase automatically to make a source or test pass.

## Run and evidence

Prerequisites: installed Node, Linux `prlimit`, FFmpeg/FFprobe, Python and Pillow.
No Cargo build, browser, Docker, installation, database or external account is used.

```sh
node --test tests/static-hls-timeline-contract.test.mjs
```

The unique `.runtime/static-hls-contract-*` directory retains:

- Original generated pixel provenance and source video
- Exact positive and negative manifests/init/media bytes
- Complete decoded packet/frame JSON, actual byte counts and file hashes
- Tool versions, argv hashes, exit status, elapsed time and process-reaping checks
- First and later HLS-decoded PNGs with independently decoded original timecodes
- `report.json`; the Node test exit status remains the suite verdict

Native FFmpeg 7.1.5 evidence demonstrates:

- Positive complete four-second muxed AVC/AAC source at 25 fps; source pixel clocks
  0, 1000, 2400 and 3960 ms agree with its actual decoded timestamps
- Independently decoded 30 fps and video-only positive variants
- Nonzero sequence numbers preserve the proven zero-origin result
- Actual +4 s timestamp offset, an undeclared +1 s jump halfway through the
  source, and delayed audio are rejected; their raw decoder observations are
  retained even when the structural gate rejects first
- Unknown priming/edit semantics, missing/forged decoded samples, changed final
  segment tracks, shortened/lengthened final raw AAC duration, same-size byte
  mutations and resource/diagnostic bounds fail
- Timeout and oversized stdout terminate and reap the owned process group

The installed codec build is recorded, not treated as universal evidence.
Missing duration fields in negative decoder diagnostics remain explicitly unknown;
they are not reported as observed discontinuities.

## Proposed production continuation contract, not implemented

### Negotiation and scope

Use a purpose-separated `static_hls_fallback_version=1` and a dedicated parent
reference carrying only parent session ID plus optional final observation and
normal immutable request fields. Never overload Binary version 1, accept client
URLs/manifests/proofs, or combine this authority with candidate/profile fallback.

The parent must negotiate before publication. Its entire selected finite closure
and source timeline must be verified before it advertises decoder continuation.
An explicit browser/native-HLS media-clock contract and child earliest/later frame
mapping proof are still prerequisites, especially around AAC priming.

First intended production scope stays narrow: a directly selected static media
playlist, no master selection, encryption, alternate renditions, BYTERANGE,
discontinuity, live/sliding/EVENT, MPEG-TS or unknown-offset input. Unsupported
sources do not receive the new marker. Existing unnegotiated paths retain their
current semantics.

### Complete immutable graph

Freeze each resource's exact canonical original and final target digest,
strong ETag, actual size and body SHA-256; persist the exact manifest and selected
track/timeline contract. Include every selected resource, not merely those a
parent happened to read. Query order and signed query changes remain identity.

Every capture request goes through the existing controlled media-request gateway:
per-hop source-policy validation, DNS/address pinning and exact-origin credential
rules. Graph data must not bypass its redirect or credential boundaries.

Before any child output, independently recapture and compare the **entire** graph
under the child's authority, including unread future segments and init. Encoding
uses that verified child-owned snapshot, independent of retired parent URLs.
This proposed snapshot behavior freezes that read: a later remote mutation cannot
change already verified local bytes, while policy/login revocation must still
stop reads and output. This needs explicit production implementation and tests.

### Authority and one-hop claim

Atomically bind exact live login, membership epoch, room lifecycle epoch, source
and account-policy revisions, media ID/generation, same viewer, strictly newer
plan generation, selected audio, unique parent claim and immutable child request
hash. A parent ID is a lookup key, not a credential.

The existing request attempt budget and cancellation tombstones must remain.
One real decoder failure may claim one transcode child. Retried HTTP preparation
uses the same frozen authority and never creates another route. Timeout, 401,
network failure, native code 4, unsupported timeline and capacity errors create
zero fallback children. The generated child cannot advertise another continuation.

Stop, leave/rejoin, logout, source switch, newer plan, expiry and policy changes
must revoke collection, queued work, active streams and publication. Every async
completion repeats current authority checks. No transaction lock is held over
network reads, hashing or decode.

### Proposed persistent/temporary ownership

A future migration after the coordinator's current migration set should own
purpose-separated roots/claims plus normalized graph rows. Do not enlarge or
reinterpret the Binary 8 KiB encrypted ledger.

Proposed initial ceilings: graph encrypted payload ≤256 KiB, ≤66 resource rows;
root retained no later than parent expiry (maximum 30 min); frozen child claim
and tombstone retained with the immutable request for 48 h. Signed URLs and source
configuration remain encrypted and absent from logs. Resource manifests/references
must fit the ledger ceiling even if the standalone syntax byte ceiling is larger.

Reserve the whole 128 MiB temporary budget before writes. Proposed admission is
one capture per user and two globally, at most two upstream reads per capture,
no waiting capture queue. The reservation must participate in shared cache/disk
accounting; repeated roots, candidates and retries cannot evade it. Capacity
failure is explicit and never triggers fallback.

A capture attempt owns its streams, decoder, files and reservation. On failure,
stop/reap the process and close streams, remove its directory, then release the
reservation. A crash or expired lease does not prove a writer stopped; uncertain
writers remain counted until reaping is established. Retained evidence rows are
small; media bytes are not stored in the request ledger.

### Mixed reader compatibility

New graph restrictions need a dedicated minimum-reader contract outside encrypted
resource data and a database-enforced read/admission gate. A candidate approach
is an explicit new per-connection reader capability checked only for marked
grants. Its semantics must be reviewed before implementation; do not assume old
Worker binaries understand or honor a new JSON key.

Frozen old/new Server and Worker combinations must prove marked-grant denial or
correct enforcement at preparation, probe, delivery, active body, job claim,
readiness, replay, renewal and publication. Legacy `None` grants and existing
source-policy/B exact-login semantics remain unchanged. No minimum-reader gate
is added by this prerequisite slice.

### Remaining integration evidence

Before enabling: actual owned HTTP+PostgreSQL+Server+Worker graph capture and
claim; source/init/unread-segment/final-query mutation; exact-login replacement;
remove/rejoin; lifecycle/source/account/media/viewer epochs; immutable replay and
simultaneous child claims; cancellation during capture/queue/output; stale worker
publication; reservation cleanup and crash ownership; mixed old readers; runtime
error classification; and source-bound earliest/later child frame mapping.

Browser/native-HLS presented time remains unverified here. No production claim,
release gate, third-party interoperability or device acceptance follows from this
source-timeline prerequisite alone.
