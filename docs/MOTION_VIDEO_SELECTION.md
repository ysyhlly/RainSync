# Motion-video selection and legacy recipe admission

The historical opt-in paired-recipe checkpoint below remains inactive in
production. New local and reliable-HTTP generated jobs now have a separate
strict equivalence refusal gate while retaining the old Worker recipe and job
shape. See [Legacy stream mapping admission](LEGACY_STREAM_MAPPING_ADMISSION.md)
for that narrow Server change, compatibility boundary and validation limits.

The earlier checkpoint added opt-in pure selectors, argument builders and source-bound
provenance checks. It does **not** change Server candidate admission, private
capability bindings, job creation, Worker dispatch or the existing public APIs.
The attached-picture defect remained a source finding before the separate
refusal gate. The cover-first cases below were tested with synthetic ffprobe catalogs;
no native cover-first fixture has established that runtime behavior yet.

## Source audit

- `capabilities::validate_source` takes the first video row, including cover art.
- `capabilities::analyze` derives codec/configuration/range facts from that row.
- `hls_needs_video_transform` examines every video, including cover art and
  alternate motion streams, for rotation and variable-rate indications.
- `negotiated_hls_args` and `hls_args` map `0:v:0`.
- Server `media::prepare` and fallback hints use those legacy helpers; its
  generated job spec contains audio selection and source version but no video
  selection. Server `playback_capabilities::selected_output` rechecks output
  configuration equivalence, which alone cannot detect a changed selected
  source under a fixed transcode candidate.
- Worker `jobs` reads an untyped JSON spec. Any string `negotiated_mode` enters
  the negotiated recipe. An unknown mode or new `video_index` is not rejected
  by the old reader. Its existing queue claim admits the legacy NULL logical
  queue; the separate static-HLS queue is outside this change.
- Static-HLS scanner/child-timeline fixtures and existing callers retain their
  legacy entry points. No static-HLS contract or schema is changed here.

## Selection and compatible interpretation

`motion_video::select` excludes only numeric `disposition.attached_pic=1`.
Missing disposition and unrecognized values retain the legacy interpretation
as ordinary video. They are not evidence that motion was observed.

When every eligible motion row has an index, selection uses the lowest
validated absolute ffprobe stream index. JSON row reordering does not change
that selection. Indices must be integer unsigned 32-bit values; the selected
index must occur once across all input streams. Mapping uses `0:<index>`, never
a vector position or video ordinal. Multiple motion streams remain eligible for
an explicitly mapped generated route; direct still requires exactly one total
source video and at most one source audio stream.

For an incomplete legacy catalog, selection preserves catalog order. An omitted
selected index permits `LegacyFirstVideo`/`0:v:0` only when the chosen row is the
first source video. A cover-first catalog lacking the selected motion index
returns `video_stream_index_required`. An explicit malformed index is rejected.

Supported compatibility cases:

| Catalog facts | Pure interpretation |
| --- | --- |
| Single video, index 0 and disposition 0 | Absolute 0; existing direct eligibility retained |
| Single video, omitted index/disposition | Legacy first video; existing interpretation retained |
| Multiple videos, omitted indices | First catalog video; generated mapping retained, direct withheld |
| Cover last, selected first video index omitted | Legacy first video; cover excluded only when explicitly marked |
| Cover first, motion index present | Actual absolute motion index; direct withheld |
| Cover first, motion index omitted | Refused; row position is not substituted |
| Cover disposition omitted | Cannot classify it as cover; historical video interpretation retained |
| Old queued job, video_index absent | Original 0:v:0 recipe; never reselect from new metadata |
| New explicit video_index=0 | Absolute 0, with no falsy-value fallback |
| Present null/string/negative/fractional/overflow video_index | Refused |

`validate_motion_source` retains global explicit protected-track checks, then
checks HDR/depth/range only on the selected video. `analyze_motion_source` and
`compatible_motion_mode` apply configuration, SAR, rotation and frame-rate
facts to that same row. Cover-only/audio-only catalogs yield no candidates and
four not-offered `video_configuration_unavailable` decisions using the existing
finite protocol reason. No new public enum or migration is introduced.

The private `VideoSelectionIdentity` includes mapping, ordering semantics and a
canonical SHA-256 of the full selected probe row. The digest includes codec
headers, range, SAR, rotation and frame-rate facts. `require_current_motion_candidate`
requires both that identity and the exact current candidate, so a fixed 720p
transcode does not mask a changed selected source. This must supplement the
existing source-version, audio-intent, timing, request and authorization guards;
it does not replace any of them.

## Smallest future paired-job contract

The explicit argument builders take `VideoMapping`; compatibility wrappers
retain their exact original mapping and settings. Pure `job_mapping` accepts a
validated `video_index`, while omission preserves old queued specs. This helper
is not called by Worker yet.

An old Worker ignores new fields, and its current mode parser supplies no
old-reader-refused version/enum boundary. Therefore a new field alone cannot
make mixed Server/Worker binaries safe. Non-default admission must remain off
until a supported co-delivered stop/drain switch proves old claimers exited
before new admission and verifies that actual `WORKER_URL` targets the paired
Worker. Static source inspection, a pair of binary hashes or an operator
assertion alone does not establish that switch. Rolling mixed-queue operation is
not supported by this proposed contract.

After that proof, wiring must carry the selected identity in private bindings,
recheck it during current source preparation and selected-output provenance,
write the validated absolute index to new generated specs, and consume it in
Worker. Legacy encrypted bindings and queued specs need their existing behavior
or an explicitly approved fresh-negotiation boundary; they must not be silently
reinterpreted. No general queue fence or new schema is proposed in this lane.

## Validation

On the task-local compact target, offline and locked, with incremental and
dev/test debug information disabled:

- `cargo test --offline --locked -p media-core --lib motion_video::tests`: 14 passed
- `cargo test --offline --locked -p media-core --lib capabilities::tests`: 12 passed
- `cargo test --offline --locked -p media-core --lib compatibility_tests`: 3 passed

These are pure tests, including cover first/last, noncontiguous/reordered
indices, multiple motion streams, omitted/malformed facts, no-video routes,
source changes under identical fixed output, selected rotation/VFR/SAR/depth,
global protected tracks, explicit index 0, and old queued-job arguments. They
start no services, sockets or FFmpeg. No runtime/upgrade qualification, publication,
deployment or historical fixture failure is claimed resolved by this checkpoint.

The first separately authorized, ignored local fixture passed at commit
`1fc5b54fce9a98666fa5f5bb5bf8b705db5f80b1`, before the opt-in default-audio
review correction described below. Its source-bound report remains immutable
and must not be rebound to the corrected source:

`cargo test --offline --locked -p media-core --test motion_video_output selected_motion_content_and_audio_survive_attached_cover -- --ignored --exact --nocapture`

It uses the existing `child_process::Scope/capture`, a 30-second/4-MiB bound,
and available disk >=10% of total plus 64 MiB before each child. Each exact argv
is journaled before capture; source/tool hashes are retained before the first
child. Both scope and test-process global shutdown returned positive original
child reaping receipts before the verdict. All eight registered commands exited
successfully. The fixture uses no services or network.

The actual MP4 muxer canonicalized cover art to the last video: audio index 0,
blue motion video index 1, second 880-Hz audio index 2, red attached JPEG index 3.
The selected generated recipe used absolute video `0:1` and audio `0:2`.
Decoded output RGB was `[1,0,255]`, and decoded audio measured 878.21 Hz, matching
the selected 880-Hz track rather than the unselected 440-Hz track. Output probe
confirmed H.264 1280x720 and AAC stereo 48 kHz. This establishes actual local
absolute mapping, content and audio selection with cover last. **Cover-first
remains pure metadata evidence.** It does not qualify production admission or
mixed binaries, nor resolve any historical runtime failure.


## Opt-in default audio review correction

`motion_video::select_audio` preserves explicit absolute audio intent. For an
omitted intent and a complete audio catalog, it chooses the lowest validated
absolute audio index, independent of JSON row order. Malformed indices or a
selected index duplicated across streams are rejected. An incomplete audio
catalog retains the legacy first-row compatible interpretation; a missing index
remains missing and is never replaced by a row position.

`negotiated_hls_args_for_motion_source` and `hls_args_for_motion_source` resolve
that same audio row to an actual absolute FFmpeg map whenever its index is
known. The source analyzer and provenance check use the shared selector. Thus a
reordered catalog with AAC index 42 before AC3 index 3 defaults to AC3 index 3,
withholds AAC stream-copy/remux facts, and maps `0:3`. Explicit audio 42 retains
its AAC facts and map `0:42`. The 14 pure motion tests include this regression,
current-candidate provenance, row reordering, missing/malformed audio indices,
and duplicate ambiguity. The legacy analyzer and recipe wrappers retain their
original branches, default `0:a:0?`, and existing explicit-audio behavior.

The three new selection types expose serialization for retained evidence;
unused deserialization and parse-only attributes were removed. A future stored
binding parser and admission semantics remain the coordinator's separate
integration decision.

The original native report validates only its original source and explicit
audio index 2. It supplies no actual default-audio evidence for this corrected
source. At the repaired `36f4215` checkpoint, a final source-bound native rerun had not
been performed. The separately authorized final run below supplies that evidence
without changing or rebinding the first report.

Focused `cargo clippy --offline --locked -p media-core --lib --test motion_video_output -- -D warnings` passed after the correction. The initial two fixture
style-lint failures are retained separately; the mechanical fixes do not
retroactively change the first native report's source binding.


## Final bounded native evidence

The same ignored test, extended to exactly 11 registered child commands, passed
at implementation commit `c568bd34aca8619e076b815aeb94d57e07109b2a`. It uses the
reviewed shared source-recipe helper for explicit audio and for an omitted audio
intent with the actual complete ffprobe catalog deliberately reversed. The
extra three commands are only default encode, output probe and 0.5-second PCM
decode. Every command retained the original 30-second/4-MiB bound and available
disk >=10% plus 64 MiB gate. Both owned scope and test-process global shutdown
returned positive original-child reaping receipts before the verdict.

The explicit path mapped video `0:1` and audio `0:2`, decoded blue RGB
`[1,0,255]`, and measured 878.21 Hz. The default path resolved the reversed
catalog to audio index 0, mapped `0:0`, and measured 440.24 Hz. Both output probes
confirmed H.264 1280x720 and AAC stereo 48 kHz. This provides actual default-audio
selection evidence on the corrected source, alongside the pure reordered
AAC-42/AC3-3 candidate/provenance regression. All 11 commands exited successfully.

The actual source mux still placed the red attached JPEG last. Cover-first is
still a pure metadata test, not a claimed native cover-first reproduction.
Source/tool/implementation hashes, pre-spawn exact argv, probes, encoded file
hashes and shutdown receipts are retained in the final report separately from
the immutable original `1fc5b54` report. That final documentation update changed
no executable source. Indexed Server/Worker admission remains unwired and mixed-binary
qualification remains a separate unresolved requirement.
