// Explicit opt-in owned native FFmpeg evidence. No browser, Docker, network,
// Server, Agent, credentials or public schema. Requires an already-built helper.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createVisibleTimecodeDecoder } from "../scripts/acceptance-timecode.mjs";
import {
  verifySourceClock,
  verifyOutputTimeline,
} from "../scripts/negotiated-timeline-verifier.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
assert.equal(
  argv.length,
  4,
  "usage: node tests/negotiated-timeline-native.mjs --output NEW-DIRECTORY --exporter BUILT-HELPER",
);
assert.equal(argv[0], "--output");
assert.equal(argv[2], "--exporter");
const root = path.resolve(argv[1]),
  exporter = path.resolve(argv[3]);
assert.ok(
  fs.statSync(exporter).isFile(),
  "build negotiated_timeline_args first",
);
process.umask(0o077);
fs.mkdirSync(root, { recursive: false });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const write = (name, value) =>
  fs.writeFileSync(
    path.join(root, name),
    JSON.stringify(value, null, 2) + "\n",
  );
const commands = [];
function run(binary, args, { allowFailure = false } = {}) {
  const result = spawnSync(binary, args, {
    cwd: repo,
    encoding: null,
    timeout: 180000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const id = String(commands.length + 1).padStart(4, "0");
  const raw = {
    binary,
    args,
    argv_sha256: sha(JSON.stringify([binary, ...args])),
    exit_code: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
  };
  fs.writeFileSync(
    path.join(root, `${id}.stdout`),
    result.stdout ?? Buffer.alloc(0),
  );
  fs.writeFileSync(
    path.join(root, `${id}.stderr`),
    result.stderr ?? Buffer.alloc(0),
  );
  commands.push(raw);
  write("commands.json", commands);
  if (!allowFailure)
    assert.equal(
      result.status,
      0,
      `${binary} failed; see ${id}.stderr: ${result.error ?? ""}`,
    );
  return { bytes: result.stdout, status: result.status };
}
const json = (binary, args) => JSON.parse(run(binary, args).bytes);
const ffmpeg = (args) =>
  run("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-threads",
    "1",
    "-filter_threads",
    "1",
    ...args,
  ]);
const probe = (input) =>
  json("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-show_data",
    "-of",
    "json",
    input,
  ]);
const frameProbe = (input) =>
  json("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_streams",
    "-show_frames",
    "-show_entries",
    "frame=best_effort_timestamp,best_effort_timestamp_time,pkt_duration_time,key_frame:stream=time_base,start_time,r_frame_rate,avg_frame_rate",
    "-of",
    "json",
    input,
  ]);
const report = {
  schema_version: 1,
  scope: "owned-native-negotiated-exact-decode",
  accepted: false,
  release_ready: false,
  status: "running",
  cases: [],
  boundary_observations: [],
  negative_controls: [],
  evidence_boundary:
    "Finite owned zero-origin CFR/VFR source verification only. Not browser presentation, general HLS/upstream admission, or a runtime source-clock contract.",
};
write("report.json", report);
try {
  report.tools = {
    ffmpeg: run("ffmpeg", ["-version"]).bytes.toString(),
    ffprobe: run("ffprobe", ["-version"]).bytes.toString(),
    node: process.version,
  };
  report.git_head = run("git", ["rev-parse", "HEAD"]).bytes.toString().trim();
  report.exporter_sha256 = sha(fs.readFileSync(exporter));
  report.source_files_sha256 = Object.fromEntries(
    [
      "crates/media-core/examples/negotiated_timeline_args.rs",
      "crates/media-core/src/capabilities.rs",
      "scripts/generate-timecode-fixture.py",
      "scripts/acceptance-timecode.mjs",
      "scripts/negotiated-timeline-verifier.mjs",
      "tests/negotiated-timeline-native.mjs",
    ].map((p) => [p, sha(fs.readFileSync(path.join(repo, p)))]),
  );
  const fixture = path.join(root, "pixels");
  run("python3", [
    "scripts/generate-timecode-fixture.py",
    "--output",
    fixture,
    "--frames",
    "350",
    "--fps",
    "25",
  ]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(fixture, "manifest.json")),
  );
  const decodeSource = createVisibleTimecodeDecoder(manifest.decoder_config);
  const decodeOutput = createVisibleTimecodeDecoder({
    ...manifest.decoder_config,
    screenshotWidth: 1280,
    screenshotHeight: 720,
    roi: { x: 0, y: 0, width: 1280, height: 720 },
    scale: 2,
  });
  const sources = [];
  for (const kind of [
    "cfr-no-audio",
    "vfr-no-audio",
    "cfr-selected-audio",
    "vfr-selected-audio",
    "global-offset",
    "video-offset",
    "audio-offset",
    "timestamp-jump",
  ]) {
    const directory = path.join(root, kind);
    fs.mkdirSync(directory);
    const input = path.join(directory, "source.mp4"),
      hasAudio = !kind.endsWith("no-audio"),
      vfr = kind.startsWith("vfr");
    const filter = vfr
      ? "select='if(lt(t,3),1,not(mod(n,2)))'"
      : kind === "video-offset"
        ? "setpts=PTS+0.4/TB"
        : kind === "timestamp-jump"
          ? "setpts='PTS+if(gte(T,5),1/TB,0)'"
          : null;
    ffmpeg([
      "-n",
      "-framerate",
      "25",
      "-i",
      path.join(fixture, "source", "%06d.png"),
      ...(hasAudio
        ? [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=14",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=14",
          ]
        : []),
      "-map",
      "0:v",
      ...(hasAudio ? ["-map", "1:a", "-map", "2:a"] : ["-an"]),
      ...(filter
        ? ["-vf", filter, "-fps_mode", vfr ? "vfr" : "passthrough"]
        : []),
      ...(kind === "audio-offset" ? ["-af", "asetpts=PTS+0.4/TB"] : []),
      "-c:v",
      "libx264",
      "-g",
      "250",
      "-keyint_min",
      "250",
      "-sc_threshold",
      "0",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      ...(hasAudio ? ["-c:a", "aac"] : []),
      ...(kind === "global-offset" ? ["-output_ts_offset", "2"] : []),
      input,
    ]);
    const metadata = probe(input),
      framesProbe = frameProbe(input);
    fs.writeFileSync(
      path.join(directory, "source-metadata.json"),
      JSON.stringify(metadata, null, 2),
    );
    fs.writeFileSync(
      path.join(directory, "source-frames.json"),
      JSON.stringify(framesProbe, null, 2),
    );
    const reference = path.join(directory, "decoded-source");
    fs.mkdirSync(reference);
    ffmpeg([
      "-n",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-fps_mode",
      "passthrough",
      "-pix_fmt",
      "rgb24",
      "-threads",
      "1",
      "-start_number",
      "0",
      path.join(reference, "%06d.png"),
    ]);
    const frames = framesProbe.frames.map((f, n) => ({
      ...decodeSource(
        fs.readFileSync(
          path.join(reference, `${String(n).padStart(6, "0")}.png`),
        ),
      ),
      source_pts_ms: Number(f.best_effort_timestamp_time) * 1000,
      key_frame: f.key_frame,
    }));
    const video = metadata.streams.find((s) => s.codec_type === "video"),
      audio = hasAudio ? metadata.streams.find((s) => s.index === 2) : null;
    const sourceClock = {
      frames,
      formatStartMs: Number(metadata.format.start_time) * 1000,
      videoStartMs: Number(video.start_time) * 1000,
      selectedAudioStartMs: audio ? Number(audio.start_time) * 1000 : null,
    };
    let clockError = null;
    try {
      verifySourceClock(sourceClock);
    } catch (e) {
      clockError = e.message;
    }
    const diagnostic = [
      "global-offset",
      "video-offset",
      "audio-offset",
      "timestamp-jump",
    ].includes(kind);
    if (diagnostic)
      assert.ok(
        clockError,
        "boundary fixture must be outside the verified continuous zero-origin scope",
      );
    else assert.equal(clockError, null);
    assert.ok(
      frames.some((f, n) => n > 1 && !f.key_frame),
      "owned source must contain non-keyframes",
    );
    const gaps = frames
      .slice(1)
      .map((f, n) => f.source_pts_ms - frames[n].source_pts_ms);
    if (vfr)
      assert.ok(
        Math.max(...gaps) > Math.min(...gaps) * 1.5,
        "fixture must actually be VFR",
      );
    const source = {
      kind,
      input,
      metadata,
      frames,
      sourceClock,
      diagnostic,
      clockError,
      audioIndex: hasAudio ? "2" : "none",
      source_sha256: sha(fs.readFileSync(input)),
      source_frame_intervals_ms: [...new Set(gaps.map((g) => Math.round(g)))],
      key_frame_positions_ms: frames
        .filter((f) => f.key_frame)
        .map((f) => f.source_pts_ms),
    };
    fs.writeFileSync(
      path.join(directory, "source-visible-observations.json"),
      JSON.stringify({ ...sourceClock, clock_error: clockError }, null, 2),
    );
    sources.push(source);
  }
  async function encode(source, start, label = String(start)) {
    const dir = path.join(root, source.kind, label);
    fs.mkdirSync(dir);
    const playlist = path.join(dir, "index.m3u8");
    const recipe = json(exporter, [
      source.input,
      playlist,
      "transcode",
      JSON.stringify(source.metadata),
      source.audioIndex,
      String(start),
    ]);
    assert.equal(recipe.args[recipe.args.indexOf("-c:v") + 1], "libx264");
    const bounded = [...recipe.args];
    bounded.splice(bounded.length - 1, 0, "-threads", "1");
    ffmpeg(bounded);
    const outputMetadata = probe(playlist),
      outputProbe = frameProbe(playlist),
      outputFrames = outputProbe.frames.map(
        (f) => Number(f.best_effort_timestamp_time) * 1000,
      );
    const video = outputMetadata.streams.find((s) => s.codec_type === "video");
    assert.equal(video.width, 1280);
    assert.equal(video.height, 720);
    assert.equal(video.r_frame_rate, "30/1");
    const audio = outputMetadata.streams.filter(
      (s) => s.codec_type === "audio",
    );
    assert.equal(audio.length, source.audioIndex === "none" ? 0 : 1);
    let selectedAudioFrequencyHz = null;
    if (audio.length) {
      const pcm = ffmpeg([
        "-i",
        playlist,
        "-map",
        "0:a:0",
        "-ss",
        "1",
        "-t",
        "1",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "s16le",
        "pipe:1",
      ]).bytes;
      let crossings = 0;
      for (let i = 2; i < pcm.length; i += 2)
        if (pcm.readInt16LE(i - 2) <= 0 && pcm.readInt16LE(i) > 0) crossings++;
      selectedAudioFrequencyHz = crossings / (pcm.length / 2 / 48000);
      assert.ok(
        Math.abs(selectedAudioFrequencyHz - 880) <= 3,
        "selected absolute audio stream 2 must carry 880Hz, not first 440Hz",
      );
      fs.writeFileSync(path.join(dir, "selected-audio-1s.s16le"), pcm);
    }
    const playlistText = fs.readFileSync(playlist, "utf8");
    const uris = playlistText
      .split("\n")
      .filter((l) => l && !l.startsWith("#"));
    assert.ok(uris.length >= 2, "must cover HLS segment boundary");
    const init = playlistText.match(/#EXT-X-MAP:URI="([^"\n]+)"/)[1];
    const boundaries = [];
    for (const uri of uris) {
      assert.match(uri, /^[\w.-]+$/);
      assert.match(init, /^[\w.-]+$/);
      const combined = path.join(dir, `${uri}.mp4`);
      fs.writeFileSync(
        combined,
        Buffer.concat([
          fs.readFileSync(path.join(dir, init)),
          fs.readFileSync(path.join(dir, uri)),
        ]),
      );
      const segmentProbe = frameProbe(combined);
      const firstPtsMs =
        Number(segmentProbe.frames[0].best_effort_timestamp_time) * 1000;
      const n = outputFrames.findIndex((t) => Math.abs(t - firstPtsMs) < 0.01);
      assert.ok(n >= 0, "segment first frame must occur in continuous output");
      boundaries.push({
        uri,
        first_pts_ms: firstPtsMs,
        first_frame_index: n,
        first_frame_key: segmentProbe.frames[0].key_frame,
      });
      assert.equal(segmentProbe.frames[0].key_frame, 1);
      fs.writeFileSync(
        path.join(dir, `${uri}.probe.json`),
        JSON.stringify(segmentProbe, null, 2),
      );
    }
    const indices = [
      ...new Set([
        0,
        45,
        outputFrames.length - 1,
        ...boundaries
          .slice(1)
          .flatMap((b) => [
            b.first_frame_index - 1,
            b.first_frame_index,
            b.first_frame_index + 1,
          ]),
      ]),
    ]
      .filter((n) => n >= 0 && n < outputFrames.length)
      .sort((a, b) => a - b);
    const samples = [];
    for (const n of indices) {
      const png = ffmpeg([
        "-i",
        playlist,
        "-map",
        "0:v:0",
        "-vf",
        `select=eq(n\\,${n})`,
        "-frames:v",
        "1",
        "-fps_mode",
        "passthrough",
        "-threads",
        "1",
        "-c:v",
        "png",
        "-f",
        "image2pipe",
        "pipe:1",
      ]).bytes;
      fs.writeFileSync(path.join(dir, `frame-${n}.png`), png);
      const decoded = decodeOutput(png),
        sourceFrame = source.frames.find(
          (f) => f.frame_index === decoded.frame_index,
        );
      assert.ok(
        sourceFrame,
        "visible output frame identity must exist in source",
      );
      const target = start * 1000 + outputFrames[n];
      const relative = (f) =>
        f.source_pts_ms - source.sourceClock.formatStartMs;
      const before = source.frames.findLast(
          (f) => relative(f) <= target + 0.01,
        ),
        after = source.frames.find((f) => relative(f) >= target - 0.01);
      samples.push({
        ...decoded,
        output_frame_index: n,
        source_decoded_pts_ms: sourceFrame.source_pts_ms,
        source_pts_minus_format_start_ms: relative(sourceFrame),
        decode_from_start_neighbor_frame_ids: [
          ...new Set([before?.frame_index, after?.frame_index]),
        ].filter(Number.isInteger),
      });
    }
    if (!source.diagnostic && start > 0) {
      const firstReference = source.frames.find(
        (f) => f.original_position_ms >= start * 1000,
      );
      assert.equal(
        firstReference.key_frame,
        0,
        "seek must actually target a non-keyframe",
      );
    }
    const record = {
      kind: source.kind,
      start_seconds: start,
      source_sha256: source.source_sha256,
      source_frame_intervals_ms: source.source_frame_intervals_ms,
      key_frame_positions_ms: source.key_frame_positions_ms,
      source_clock_error: source.clockError,
      source_origin_facts: {
        format_start_ms: source.sourceClock.formatStartMs,
        video_start_ms: source.sourceClock.videoStartMs,
        selected_audio_start_ms: source.sourceClock.selectedAudioStartMs,
      },
      production_recipe: recipe,
      production_argv_sha256: sha(JSON.stringify(recipe.args)),
      execution_argv_sha256: sha(
        JSON.stringify(
          commands.findLast(
            (c) => c.binary === "ffmpeg" && c.args.at(-1) === playlist,
          )?.args,
        ),
      ),
      thread_bound: "input/filter/encoder threads=1, no media recipe overrides",
      output_metadata: outputMetadata,
      output_time_base: video.time_base,
      output_frames_ms: outputFrames,
      boundaries,
      selected_audio_frequency_hz: selectedAudioFrequencyHz,
      samples,
    };
    fs.writeFileSync(
      path.join(dir, "output-probe.json"),
      JSON.stringify(outputProbe, null, 2),
    );
    fs.writeFileSync(
      path.join(dir, "case.json"),
      JSON.stringify(record, null, 2),
    );
    return record;
  }
  for (const source of sources) {
    for (const start of [1.25, 5.267]) {
      // Candidate validation remains production-owned: no nonzero copy fallback.
      for (const mode of ["remux", "audio_transcode"]) {
        const denied = run(
          exporter,
          [
            source.input,
            path.join(root, "never-created.m3u8"),
            mode,
            JSON.stringify(source.metadata),
            source.audioIndex,
            String(start),
          ],
          { allowFailure: true },
        );
        assert.notEqual(
          denied.status,
          0,
          "nonzero generated copy route must remain ineligible",
        );
      }
      const record = await encode(source, start);
      if (source.diagnostic) {
        record.interpretation =
          "Outside this fixture acceptance scope. Marker content time and actual decoded source PTS are distinct axes here; this is not proof of a production mapping bug or runtime rejection. Direct/browser media-coordinate contract is unresolved.";
        report.boundary_observations.push(record);
      } else {
        record.mapping_checks = verifyOutputTimeline({
          startMs: start * 1000,
          sourceFrames: source.frames,
          samples: record.samples,
          outputFrames: record.output_frames_ms,
          timeBase: record.output_time_base,
        });
        report.cases.push(record);
      }
      write("report.json", report);
    }
  }
  // Real output starts at zero but contains source frame zero. It must not pass
  // as a seek to 1.25 merely because PTS and the claimed plan origin look valid.
  const source = sources[0],
    wrong = await encode(source, 0, "wrong-origin-control");
  const check = {
    startMs: 1250,
    sourceFrames: source.frames,
    samples: wrong.samples,
    outputFrames: wrong.output_frames_ms,
    timeBase: wrong.output_time_base,
  };
  assert.throws(() => verifyOutputTimeline(check), /wrong source frame/);
  report.negative_controls.push({
    kind: "real-zero-PTS-wrong-source",
    directory: `${source.kind}/wrong-origin-control`,
    rejected: true,
  });
  const good = report.cases[0],
    drift = good.samples.map((s, n) =>
      n === good.samples.length - 1
        ? { ...s, ...good.samples[1], output_frame_index: s.output_frame_index }
        : s,
    );
  assert.throws(
    () =>
      verifyOutputTimeline({
        startMs: good.start_seconds * 1000,
        sourceFrames: source.frames,
        samples: drift,
        outputFrames: good.output_frames_ms,
        timeBase: good.output_time_base,
      }),
    /wrong source frame/,
  );
  report.negative_controls.push({
    kind: "later-frame-repetition-with-valid-zero-PTS",
    samples: drift,
    rejected: true,
  });
  report.status = "passed";
  report.verified_positive_cases = report.cases.length;
  report.quantization =
    "First frame exactly the first decoded source frame at/after request; later frames only immediate decoded source neighbors of request+actual output PTS. CFR25 max40ms/VFR max80ms source intervals, CFR30 output checked within one muxer tick. No tolerance search/widening.";
} catch (error) {
  report.status = "failed";
  report.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  write("report.json", report);
  const artifacts = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.name !== "artifacts.json")
        artifacts.push({
          path: path.relative(root, name),
          sha256: sha(fs.readFileSync(name)),
          bytes: fs.statSync(name).size,
        });
    }
  }
  walk(root);
  write("artifacts.json", artifacts);
  console.log(
    `Evidence: ${root}/report.json (${report.status}); ${artifacts.length} hashed artifacts`,
  );
}
