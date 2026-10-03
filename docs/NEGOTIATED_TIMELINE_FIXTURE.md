# Negotiated exact-decode fixture (§11.2)

This is an owned native FFmpeg verification slice, not release acceptance or a
new runtime timeline-admission policy. No production recipe, playback schema,
plan grant, database migration, browser, service, Agent or NAS behavior changes.

## What the fixture proves

`tests/negotiated-timeline-native.mjs` calls the actual
`capabilities::negotiated_hls_args` through the
`negotiated_timeline_args` Rust example. The example also calls production
candidate selection; nonzero `remux` and `audio_transcode` requests must remain
ineligible. The old Docker `tests/seek-fixtures.mjs` continues to test the legacy
builder and is not relabeled as negotiated-recipe evidence.

Eight positive cases cover long-GOP H.264 CFR25 and VFR25→12.5, requested starts
1.25s and 5.267s, and either no audio or explicitly selected absolute stream 2.
The two audio tracks carry separately authored 440Hz and 880Hz signals; output
must contain only one audio track and its measured signal must be 880Hz.
Source targets are verified to be non-keyframes. Four-second fMP4 segments,
actual segment first PTS/keyframes, complete output PTS/timebase, first frame,
1.5s frame, last frame and both sides of every segment boundary are measured.

The owned source has independently rendered RST1 frame identity and numeric
content time. The input is decoded from the beginning, without seeking, and
all decoded PNGs are read by the existing bounded pixel decoder. Their actual
source PTS must agree with that independent clock for the positive contract.
Output PNGs are decoded at 1280×720 with the decoder's explicit 2× geometry;
no image matching or metadata-derived replacement for the visible clock is
used. The only execution overrides bound input/filter/encoder threads to 1.

### Fixed quantization rule

- First output PTS must be zero; every subsequent output PTS must be `n/30`
  within one observed muxer timebase tick, plus 0.01ms probe text rounding
- The first displayed frame must be the first independently decoded source
  frame at or after the requested start
- Later output frames may be only the two immediately adjacent source frames
  bracketing `requested_start + actual_output_PTS`
- The independently observed input intervals are 40ms for CFR and 40/80ms for
  VFR. No wider frame search, adjustable PSNR threshold, or widening-until-pass
  rule is used

This explicitly measures frame quantization. It does not claim the visible
content clock equals the requested fractional timestamp exactly.

## Negative controls and unresolved source coordinates

The executable positive verifier rejects a real zero-PTS output beginning at
source frame 0 when it is falsely described as a 1.25s seek. It also rejects a
later repeated-source frame despite a valid output clock. Fast unit negatives
cover output clock drift, nonzero first PTS, a preroll first source frame,
missing/duplicate boundary observations, source offsets, and timestamp jumps.
These are verifier-contract tests, not production source rejection.

Eight additional encodes observe four boundary sources at both requested
starts: global input timestamp offset, video versus audio offset, audio versus
video offset, and a 1s source PTS jump. They retain two separate axes:

1. Numeric content time/frame identity burned before the timestamp transform
2. Actual decoded source PTS, with an explicit `sourcePTS − formatStart`
   comparison and decode-from-start adjacent reference frame IDs

These axes cannot be substituted for each other. For example, global +2s on the
observed FFmpeg build produces format/audio start 1.978s but video start 2s due to
AAC priming. At a 1.25s request, burned content time 1.24s is decoded source
PTS 3.24s, or 1.262s after the format start. Similarly, video delayed 400ms has
burned 880ms at actual source PTS 1280ms. Neither observation alone proves a
runtime mapping defect. A gap may represent an intentional held frame; a
burned frame-number clock lagging after the gap is not independent proof of
incorrect original-media time.

The positive fixture therefore does not admit these boundary sources. It
records them as outside its continuous zero-origin proof, not as universally
invalid media. The runtime/direct/browser definition of original-media zero,
container edits, encoder priming, gap semantics, and any narrowly justified
normalization/rejection policy remain open. General input HLS, discontinuities,
upstream seek contracts and real browser presentation still require separate
evidence. No new runtime rejection or piecewise mapping is implemented here.

## Run

Prerequisites: installed Python/Pillow, Node, FFmpeg/ffprobe with libx264/AAC,
and the repository's already-installed Rust toolchain. No installation or
network access is performed. The output directory must be new; artifacts are
private and retained rather than deleted.

```sh
cargo build -p media-core --example negotiated_timeline_args --locked --offline
node tests/negotiated-timeline-verifier.mjs
node tests/negotiated-timeline-native.mjs \
  --output .runtime/negotiated-timeline-NEW \
  --exporter target/debug/examples/negotiated_timeline_args
```

Use the actual target directory if `CARGO_TARGET_DIR` is set. When sharing a
Cargo target across worktrees, prevent stale local-crate artifacts before
building, and copy/hash the finished helper before another worktree rebuilds
that target. A helper-only build is not a service-binary freeze.

`report.json` retains the source and production-recipe hashes, helper hash,
FFmpeg versions, complete PTS observations, selected audio measurement, raw
sample identity, accepted adjacent reference timestamps, and boundary cases.
`commands.json` records every argv and its hash with status; numbered stdout
and stderr files retain original tool output. `artifacts.json` hashes every
input, output, source/sample PNG, segment, init segment, probe and report file.
`accepted` and `release_ready` remain false regardless of fixture success.

## Recorded local run (2026-10-02)

On installed FFmpeg/ffprobe 7.1.5-0+deb13u1, the final native run passed 8 positive
cases with 84 independently decoded output samples and 8 boundary observations.
All positive output timelines used timebase 1/15360. First source frames were
1280ms and 5280ms for the two requests. Maximum observed absolute content-clock
residual was 30ms for CFR and 47ms for VFR, within the fixed immediate-neighbor
rule; those measurements do not redefine the rule. Selected audio measured
880Hz in all 4 audio-positive cases. Both executable negative controls rejected.

- `node tests/negotiated-timeline-verifier.mjs`: passed
- Existing `tests/acceptance-timecode.test.mjs`: 9 passed
- `cargo test -p media-core --lib --locked --offline`: 105 passed, 1 pre-existing
  ignored; this is not a workspace/all-target run
- Rust formatting, targeted Prettier and whitespace checks: passed

The retained `.runtime/negotiated-timeline-final/report.json` SHA256 is
`4c0f7b1895ffe07dcf22d14e9ca5a83f2d2afd8444f8341b557587b366177658`.
Its artifact index contains 4475 files; all hashes, source hashes and the copied
helper binary binding were rechecked after completion. The initial exploration
and first complete run remain separate from this final source-bound run.
