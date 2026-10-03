# Sealed static-HLS child timeline: file-only fixture

Automatic fallback, public parent/child issuance and production activation remain
off. This is an opt-in `cfg(test)` native helper and independent media oracle.
It adds no production route, database schema, reader contract or authority API.
Binary version 1 and Stage A reader 1 retain their existing scope.

## Actual supported evidence

The measured source is fourteen seconds of authored RST1 pixels, 640×360,
H.264/avc1 without B frames, CFR 25 fps and one muxed AAC-LC mono 48 kHz track.
It has fourteen one-second fMP4 segments. The output is actually probed as
1280×720 AVC/avc1, CFR 30 fps, no B frames and AAC-LC stereo 48 kHz. Source
30 fps, stereo, silent sources and the full 300-second ceiling are not qualified
by this child matrix.

The source HLS is encoded directly from the authored PNGs and deterministic
aperiodic PCM. Every original HLS frame is decoded and independently read as
RST1; every child frame is independently read too. A generator MP4 is not used
as HLS origin or child correspondence evidence. Actual source manifest/init/all
fourteen media hashes bind each native scanner proof to the fixture bytes.

The native helper copies only bounded basename resources into a fresh private
`OwnedDirectory`, closes all writers, seals it and runs the existing complete
structural/packet/decoded-frame scanner. It derives selected audio from that
actual proof and uses `scanner::qualify_source`, rather than accepting metadata
or track claims. Both scanner and child inherit a held directory descriptor;
input is `/proc/self/fd/<held>/index.m3u8`, with file-only protocols and HLS/mov
formats. The helper exposes no decoder path or authority constructor in a
production build. This direct file-fixture construction does not establish
registered-source HTTP custody, a durable admission permit or a DB-to-source
authorization binding.

## Why a separate recipe is needed

The unchanged generic `negotiated_hls_args` recipe places input `-ss` before
`-i`. On this actual AAC-primed finite HLS, a requested 13 ms origin produces
first visible source time 1000 ms, rather than 40 ms. At 3.417 seconds it yields
no decoded video. Adding input `-seek_timestamp 1` did not fix the exploratory
trial. Exact source bytes, generic argv, installed FFmpeg build and independent
frames are retained. Generic production routes are unchanged.

The test-only correction decodes sequentially with `-copyts`, then applies
absolute video/audio trim against the scanner-proved presented zero origin:

```
trim=start=S:end=E,setpts=PTS-S/TB,<existing scale/pad>,fps=fps=30:start_time=0:round=near
atrim=start=S:end=E,asetpts=PTS-S/TB
```

`E` is the actual proved source end. Audio trim removes source decoder tail
padding before re-encoding. No arithmetic adjustment based on packet priming is
added or subtracted. Sequential decode must still read/decode the earlier source
before trimming; it is not a cheap random seek. Slow work is rejected within its
fixed phase budget, with no precision reduction or automatic budget increase.

The earlier correction with only implicit `-r 30` passed the old neighbor oracle,
but stronger endpoint/coverage checks reveal an actual 3.417-second failure: 316
frames cover source indices 86–348 and finish 49.667 ms early. The explicit fps
trial includes source index 349 and satisfies one-output-period endpoint bounds.
Earlier reports marked passed belong to that earlier oracle stage, not the final
verdict; the exact failure is retained separately.

## Separate clocks and fixed oracle

Source AAC raw first packet PTS/DTS is −1024 at timebase 1/48000. Its edit and
explicit skip metadata, complete sample table and actual decoded frames prove
presented sample zero. Source tail padding, child encoder priming and child tail
padding are separate observations. FFprobe can omit the first AAC packet
duration and report a full 1024 samples for the final short raw sample. Raw end
uses actual BMFF sample tables; these diagnostic fields are never invented or
substituted for the table. Complete child packet PTS/DTS and decoded sample PTS
are compared and remain continuous.

The six seeks are 0, 13, 1000, 1013, 3417 and 8013 ms. They include fractional,
non-keyframe, exact segment-boundary and near-boundary requests. Every child
decoded video frame is checked through the first, middle and final output
segments, including both sides of each four-second boundary.

The first child frame must be the first actual source frame at/after the seek.
Each later output frame may use only its immediate source timestamp neighbors.
The HLS wrapper additionally requires nondecreasing source indices, steps of
zero or one at this higher output rate, at most `ceil(30/25)=2` consecutive
duplicates, and coverage of every selected source frame through the proved end.
It therefore cannot accept neighboring choices that go backwards or skip a
source frame. Actual output duration must differ from the selected source
interval by no more than one measured 30 fps period plus 0.01 ms probe rounding;
the older generic VFR 80 ms end allowance does not apply.

The original producer's interior PCM checks sample regular half-second windows
and both sides of every output segment boundary. They do not compare every PCM
sample and did not reach presented sample zero or the last valid raw samples.
A separate source-bound retained-artifact analysis now compares the first 4096
valid presented samples at offset zero and the last 4096 ending exactly at the
actual raw end, for all six cases. No decoder or media generator is rerun. Future
fixture runs use the same endpoint verifier alongside the sampled interior
checks. This supplies endpoint correlation windows, not every-sample identity.
The search measures phase within ±2048 samples; permitted
phase stays fixed at ±48 samples (1 ms), with correlation ≥0.9. The search range
does not become an allowed error. Raw audio length must equal the trimmed source
interval within one sample. Decoded AAC tail padding is bounded to 1024 samples.
The decoded source and child arrays are restricted to their actual valid raw
intervals for endpoint comparison. The −1024/skip-1024 priming packet is absent
from decoded PCM; sample zero is compared without subtracting priming again.
Source and child decoder tail padding remain explicitly incomparable and are
excluded. Endpoint phase residual is zero samples in all twelve windows, with
minimum correlation 0.968769 under the original fixed thresholds. Same-length
head/tail substitutions of 1024 decoded samples are rejected by content checks;
these are synthetic AAC-sized PCM blocks, not encoded AAC packet mutations.
Decoded-length and valid-tail truncations are separately rejected by length
checks. Twelve content and twelve truncation negatives are retained.

The per-case A/V correspondence bound is derived from the scanner-qualified
source period plus the fixed audio phase bound: `1000 / source_fps + 1 ms`, or
41 ms for this measured 25→30 conversion. The exact frame oracle governs legal
resampling; this numeric envelope does not permit arbitrary shifted frames.
Separate endpoint checks use the measured output period. Negatives include real
generic failures, wrong claimed origin, actual source-frame substitution, a
whole-output frame shift, a 1024-sample PCM shift, bracket-valid reversal/skip
that the older neighbor oracle accepts, and an out-of-bound tail.

## Budgets, cancellation and ownership

Source copy/scan has the existing independent 35-second deadline and the unchanged
128 MiB total file-byte, 32 MiB media-resource, 64-segment and 300-second limits.
Each test child has a separately typed, shorten-only 20-second wall budget,
20 CPU seconds, a 20-second maximum media window, 1 GiB address space, 128 MiB
maximum decoder allocation and 64 KiB per diagnostic pipe. At most five fixed
four-second media resources plus init/manifest/temp are permitted; 4 MiB
`RLIMIT_FSIZE` per file and a checked eight-file/32 MiB aggregate apply. These
fixture output ceilings are not a production cache reservation proof.

The native report records capture elapsed time separately from child elapsed
time and both budgets. The child wall timer includes spawn and rejects a ready
completion after its deadline. Controlled cancellation and a shortened deadline
produce typed `Canceled`/`Deadline`; neither confers decoder-failure authority.
The numerical 20-second child test budget does not prove the separate browser
presentation phase, and a total startup timeout cannot authorize fallback.

Before every outer subprocess spawn, including generator, FFprobe, PNG and PCM
commands, the Node runner persists owner intent and its receipt channel. It
retains the actual `ChildProcess`, attaches pipe/error/close handlers before
yielding and records real close/stdio results. Each helper receipt is bound to
that exact pre-spawn owner ID. Positive native scope shutdown is required before
source custody removal; the outer close and native process-scope result are
separate evidence. Missing/mismatched receipts or unresolved closure remain
Unknown and stop subsequent ordinary cases.

The first stack-overflow attempt copied/sealed source bytes but has no decoder
or scope-disposal receipt. Actor launch/disposal remains Unknown; neither its
outer exit nor later positive runs supplies the missing proof. The heap-buffered,
boxed helper fixes that test allocation issue. A later attempted exit-7 negative
actually failed to spawn `/usr/bin/node` with ENOENT, close code −2 and no PID;
its pre-spawn owner record and Unknown native receipt are retained, and that
suite stopped. No old attempt is cleaned up, adopted or mapped across namespaces.

## Run and retained evidence

Use the existing installed Linux toolchain. Build only the media-core test
binary offline; then copy that exact executable to task-owned evidence storage
and release the shared Cargo target before the Node matrix. The runner never
builds Cargo or installs anything.

```
cargo test --offline -p media-core static_hls -- --test-threads=1
node tests/static-hls-child-timeline-native.mjs --output NEW-DIRECTORY --helper COPIED-MEDIA-CORE-TEST-BINARY
node --test tests/negotiated-timeline-verifier.mjs tests/static-hls-timeline-contract.test.mjs
node tests/static-hls-audio-endpoints-retained.mjs --binding FROZEN-PRODUCER-BINDING --output NEW-DIRECTORY
```

The output retains procedural provenance, actual source bytes, all independently
decoded source/child PNGs and observations, source/child PCM, complete probe JSON,
sample-table/phase/whole-frame checks, exact argv, tool and helper hashes, one
pre-spawn owner/close receipt per command, native bound receipts and `report.json`.
`accepted=false`, `release_ready=false` and `production_fallback_enabled=false`
remain explicit even for the passing fixture. There is no browser, PostgreSQL,
Server/Worker, Agent/NAS, production grant, source account or deployment evidence.
The retained PCM reanalysis keeps the original producer report and binding
unchanged. Its separate report records original producer commit/input hashes,
current analysis source and Node executable hashes, valid/padding intervals,
endpoint results and reproducible in-memory negative mutation recipes/digests.
