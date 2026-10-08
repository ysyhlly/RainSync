// Opt-in bounded file-only HLS evidence. Requires an already-built media-core
// test helper; no Cargo, HTTP, database, browser, credentials or remote source.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createVisibleTimecodeDecoder } from "../scripts/acceptance-timecode.mjs";
import { CHILD_TOLERANCES, verifyHlsSourcePixels, verifyChildPixels,
  verifyChildAudioClock, measureAudioPhase, verifyAudioPhase, verifyAudioEndpointIdentity } from "../scripts/static-hls-child-verifier.mjs";
import { inspectStaticHlsStructure } from "../scripts/static-hls-timeline.mjs";
import { verifyOutputTimeline } from "../scripts/negotiated-timeline-verifier.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
assert.equal(argv.length, 4, "--output NEW-DIRECTORY --helper BUILT-MEDIA-CORE-TEST-BINARY");
assert.equal(argv[0], "--output"); assert.equal(argv[2], "--helper");
const root = path.resolve(argv[1]), helper = path.resolve(argv[3]);
assert.ok((await fs.stat(helper)).isFile());
process.umask(0o077); await fs.mkdir(root);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const write = (name, value) => fs.writeFile(path.join(root, name), JSON.stringify(value, null, 2) + "\n");
const report = { version: 1, scope: "synthetic-file-only-sealed-static-HLS-child",
  accepted: false, release_ready: false, production_fallback_enabled: false,
  status: "running", tolerances: CHILD_TOLERANCES, commands: [], cases: [], negative_controls: [],
  boundary: "Complete actual sealed HLS source and child decoder/RST1/PCM evidence only; no public parent, child authority, DB admission, source gateway or browser presentation proof" };
await write("report.json", report);
async function run(binary, args, { env = {}, timeout = 35000, maxBytes = 16 * 1024 * 1024,
  allowFailure = false, limited = true } = {}) {
  const executable = limited ? "/usr/bin/prlimit" : binary;
  const actualArgs = limited ? ["--as=1073741824", "--cpu=35", "--", binary, ...args] : args;
  const id = report.commands.length, ownerId = randomUUID();
  if (env.RAINSYNC_HLS_FIXTURE_OUTPUT) env.RAINSYNC_HLS_FIXTURE_OWNER_ID = ownerId;
  const record = { owner_id: ownerId, responsibility: "own this exact ChildProcess through close and collect its independent native Scope receipt when applicable",
    state: "registered-before-spawn", receipt_path: `owner-${id}.json`,
    binary, args, executable, actualArgs, env,
    argv_sha256: hash(JSON.stringify([executable, ...actualArgs])),
    pid: null, close: null, native_scope: env.RAINSYNC_HLS_FIXTURE_OUTPUT ? "unknown-until-bound-receipt" : "not-applicable" };
  report.commands.push(record);
  await write(record.receipt_path, record);
  await write("report.json", report);
  const start = performance.now();
  const child = spawn(executable, actualArgs, { cwd: repo, detached: true,
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1", ...env } });
  record.pid = child.pid ?? null;
  record.state = "spawn-returned-awaiting-close";
  let failure = null, outBytes = 0, errBytes = 0; const stdout = [], stderr = [];
  const stop = (why) => { failure ??= why; try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") failure = "kill_failed"; } };
  child.stdout.on("data", (b) => { outBytes += b.length;
    if (outBytes > maxBytes) stop("stdout_bound"); else stdout.push(b); });
  child.stderr.on("data", (b) => { errBytes += b.length;
    if (errBytes > 65536) stop("stderr_bound"); else stderr.push(b); });
  const timer = setTimeout(() => stop("wall_deadline"), timeout);
  const completion = new Promise((resolve) => {
    child.on("error", (error) => { failure ??= error.message; });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  // Attach close/error and pipe handlers synchronously before yielding: a
  // helper that exits immediately still leaves a real observable close record.
  await write(record.receipt_path, record);
  const result = await completion;
  clearTimeout(timer);
  let reaped = false; try { process.kill(-child.pid, 0); }
  catch (error) { reaped = error.code === "ESRCH"; }
  const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
  await fs.writeFile(path.join(root, `command-${id}.stdout`), out);
  await fs.writeFile(path.join(root, `command-${id}.stderr`), err);
  Object.assign(record, {
    ...result, elapsed_ms: performance.now() - start, failure,
    state: "actual-close-observed", close: result,
    stdout_sha256: hash(out), stderr_sha256: hash(err), outBytes, errBytes,
    process_group_reaped: reaped });
  if (env.RAINSYNC_HLS_FIXTURE_OUTPUT) {
    try {
      const receipt = await fs.readFile(path.join(env.RAINSYNC_HLS_FIXTURE_OUTPUT, "native-report.json"));
      const value = JSON.parse(receipt);
      assert.equal(value.outer_owner_id, ownerId, "native receipt must bind this pre-spawn owner");
      record.native_scope = value.process_scope_reaped === true ? "positively-drained" : "unknown";
      record.native_receipt_sha256 = hash(receipt);
      record.source_custody_removed_after_reap = value.source_custody_removed_after_reap;
    } catch (error) { record.native_scope = "unknown"; record.native_receipt_error = error.message; }
  }
  await write(record.receipt_path, record);
  await write("report.json", report);
  assert.ok(reaped, "owned process group must be absent after close");
  if (!allowFailure) { assert.equal(failure, null); assert.equal(result.code, 0, err.toString());
    assert.equal(errBytes, 0, err.toString()); }
  return out;
}
const ffmpeg = (args, options) => run("/usr/bin/ffmpeg", ["-v", "error", "-nostdin",
  "-threads", "1", "-filter_threads", "1", "-max_alloc", "134217728", ...args], options);
const probe = async (input) => JSON.parse(await run("/usr/bin/ffprobe", ["-v", "error", "-threads", "1",
  "-protocol_whitelist", "file", "-format_whitelist", "hls,mov", "-show_packets", "-show_frames",
  "-show_streams", "-show_format", "-show_data", "-show_entries",
  "stream:format:frame=stream_index,media_type,pts,best_effort_timestamp,duration,nb_samples:packet=stream_index,pts,dts,duration:packet_side_data=side_data_type,skip_samples,discard_padding",
  "-of", "json", input]));
async function pixels(input, directory, config) {
  await fs.mkdir(directory);
  await ffmpeg(["-protocol_whitelist", "file", "-format_whitelist", "hls,mov", "-i", input,
    "-map", "0:v:0", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-threads", "1",
    "-start_number", "0", path.join(directory, "%06d.png")]);
  const decoder = createVisibleTimecodeDecoder(config), observations = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const bytes = await fs.readFile(path.join(directory, name));
    observations.push({ ...(await decoder(bytes)), png: path.relative(root, path.join(directory, name)),
      png_sha256: hash(bytes) });
  }
  await fs.writeFile(path.join(directory, "observations.json"), JSON.stringify(observations));
  return observations;
}
async function pcm(input, directory) {
  const bytes = await ffmpeg(["-protocol_whitelist", "file", "-format_whitelist", "hls,mov", "-i", input,
    "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
  await fs.writeFile(path.join(directory, "decoded-audio.f32"), bytes);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
async function childStructure(directory) {
  const manifest = await fs.readFile(path.join(directory, "index.m3u8"), "utf8");
  const names = manifest.split("\n").filter((line) => line && !line.startsWith("#"));
  // Project only EVENT to VOD for the existing finite structural parser. This
  // is a sample-table inspection of completed output, never source admission.
  const structure = inspectStaticHlsStructure({
    manifest: manifest.replace("PLAYLIST-TYPE:EVENT", "PLAYLIST-TYPE:VOD"),
    init: await fs.readFile(path.join(directory, "init.mp4")),
    segments: await Promise.all(names.map((name) => fs.readFile(path.join(directory, name)))),
  });
  return structure;
}
async function native(source, name, start, recipe = "sequential", controls = {}) {
  const output = path.join(root, name);
  await run(helper, ["--ignored", "--exact", "static_hls::child_timeline_fixture::sealed_hls_child_fixture",
    "--nocapture", "--test-threads=1"], { limited: false, timeout: 60000,
    env: { RAINSYNC_HLS_FIXTURE_SOURCE: source, RAINSYNC_HLS_FIXTURE_OUTPUT: output,
      RAINSYNC_HLS_FIXTURE_START: String(start), RAINSYNC_HLS_FIXTURE_RECIPE: recipe, ...controls } });
  const facts = JSON.parse(await fs.readFile(path.join(output, "native-report.json")));
  assert.equal(facts.outer_owner_id, report.commands.at(-1).owner_id);
  assert.equal(report.commands.at(-1).native_scope, "positively-drained");
  return { output, native: facts };
}
try {
  report.git_head = (await run("/usr/bin/git", ["rev-parse", "HEAD"], { limited: false })).toString().trim();
  report.helper_sha256 = hash(await fs.readFile(helper));
  report.sources_sha256 = Object.fromEntries(await Promise.all([
    "crates/media-core/src/static_hls/child_timeline_fixture.rs", "crates/media-core/src/static_hls/mod.rs",
    "crates/media-core/src/static_hls/scanner.rs", "crates/media-core/src/static_hls/timeline.rs",
    "crates/media-core/src/static_hls/owned_directory.rs", "crates/media-core/src/capabilities.rs",
    "scripts/static-hls-child-verifier.mjs", "scripts/acceptance-timecode.mjs",
    "scripts/generate-timecode-fixture.py", "tests/static-hls-child-timeline-native.mjs",
  ].map(async (name) => [name, hash(await fs.readFile(path.join(repo, name)))])));
  report.tools = { node: process.version,
    ffmpeg: (await run("/usr/bin/ffmpeg", ["-version"])).toString(),
    ffprobe: (await run("/usr/bin/ffprobe", ["-version"])).toString(),
    ffmpeg_sha256: hash(await fs.readFile("/usr/bin/ffmpeg")),
    ffprobe_sha256: hash(await fs.readFile("/usr/bin/ffprobe")) };
  const fixture = path.join(root, "pixels");
  await run("/usr/bin/python3", ["scripts/generate-timecode-fixture.py", "--output", fixture,
    "--frames", "350", "--fps", "25"], { limited: false });
  const manifest = JSON.parse(await fs.readFile(path.join(fixture, "manifest.json")));
  const source = path.join(root, "source-hls"); await fs.mkdir(source);
  // Original, deterministic aperiodic PCM, with no third-party recording.
  const signal = Buffer.alloc(14 * 48000 * 4); let state = 90210, y = 0;
  for (let i = 0; i < 14 * 48000; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    y = .88 * y + .12 * (state / 0xffffffff * 2 - 1); signal.writeFloatLE(y * .7, i * 4); }
  await fs.writeFile(path.join(source, "original-audio.f32"), signal);
  await ffmpeg(["-framerate", "25", "-i", path.join(fixture, "source", "%06d.png"),
    "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", path.join(source, "original-audio.f32"),
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-threads", "1",
    "-crf", "18", "-pix_fmt", "yuv420p", "-bf", "0", "-g", "25", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "1", "-avoid_negative_ts", "disabled",
    "-f", "hls", "-hls_time", "1", "-hls_segment_type", "fmp4", "-hls_playlist_type", "vod",
    path.join(source, "index.m3u8")]);
  report.source_bytes = await Promise.all((await fs.readdir(source)).sort().map(async (name) => {
    const bytes = await fs.readFile(path.join(source, name));
    return { name, bytes: bytes.length, sha256: hash(bytes) };
  }));
  const sourcePcm = await pcm(path.join(source, "index.m3u8"), source);
  const sourcePixels = await pixels(path.join(source, "index.m3u8"), path.join(root, "source-decoded-HLS"), manifest.decoder_config);
  let sourceFrames, clockContract;
  const outputConfig = { ...manifest.decoder_config, screenshotWidth: 1280, screenshotHeight: 720,
    roi: { x: 0, y: 0, width: 1280, height: 720 }, scale: 2 };
  for (const start of [0, .013, 1, 1.013, 3.417, 8.013]) {
    const { output, native: facts } = await native(source, `sequential-${start}`, start);
    assert.equal(facts.outcome, "Completed"); assert.equal(facts.selected_audio, 1);
    assert.equal(facts.source_proof.tracks[1].raw_first_pts, -1024);
    assert.equal(facts.source_proof.tracks[1].decoded_first_pts, 0);
    const sourceProbe = JSON.parse(await fs.readFile(path.join(output, "source-probe.json")));
    sourceFrames ??= verifyHlsSourcePixels(facts.source_proof, sourceProbe, sourcePixels);
    clockContract ??= { sourceFps: facts.source_facts.video.framerate,
      sourceDurationMs: facts.source_proof.duration_ms };
    assert.equal(facts.source_facts.video.framerate, clockContract.sourceFps);
    assert.equal(facts.source_proof.duration_ms, clockContract.sourceDurationMs);
    assert.equal(facts.source_proof.manifest_sha256,
      report.source_bytes.find((row) => row.name === "index.m3u8").sha256);
    assert.equal(facts.source_proof.init.sha256,
      report.source_bytes.find((row) => row.name === "init.mp4").sha256);
    for (let i = 0; i < facts.source_proof.segments.length; i++)
      assert.equal(facts.source_proof.segments[i].sha256,
        report.source_bytes.find((row) => row.name === `index${i}.m4s`).sha256);
    const input = path.join(output, "child", "index.m3u8"), childProbe = await probe(input);
    await fs.writeFile(path.join(output, "child-probe.json"), JSON.stringify(childProbe));
    const childPixels = await pixels(input, path.join(output, "decoded-video"), outputConfig);
    const checks = verifyChildPixels({ startMs: start * 1000, sourceFrames, ...clockContract, probe: childProbe, observations: childPixels });
    const structure = await childStructure(path.join(output, "child"));
    const outputVideo = childProbe.streams.find((row) => row.codec_type === "video");
    assert.equal(outputVideo.codec_name, "h264");
    assert.equal(outputVideo.codec_tag_string, "avc1");
    assert.equal(outputVideo.pix_fmt, "yuv420p");
    assert.equal(outputVideo.has_b_frames, 0);
    assert.equal(outputVideo.avg_frame_rate, "30/1");
    assert.equal(outputVideo.width, 1280); assert.equal(outputVideo.height, 720);
    const videoTrack = structure.tracks.find((row) => row.kind === "video");
    const rawVideo = structure.allSamples.get(videoTrack.id);
    const videoPackets = childProbe.packets_and_frames.filter((row) => row.type === "packet" && row.stream_index === outputVideo.index);
    assert.equal(rawVideo.length, videoPackets.length); assert.equal(rawVideo.length, checks.length);
    for (let i = 0; i < rawVideo.length; i++) {
      assert.equal(videoPackets[i].pts, rawVideo[i].pts); assert.equal(videoPackets[i].dts, rawVideo[i].pts);
      assert.equal(videoPackets[i].duration, rawVideo[i].duration);
    }
    const clock = verifyChildAudioClock(childProbe, 14 - start, structure);
    const childPcm = await pcm(input, output);
    assert.equal(childPcm.length, clock.decoded_end_samples);
    const sourceAudio = facts.source_proof.tracks.find((row) => row.kind === "audio");
    const sourceClock = { raw_end_samples: Math.round(sourceAudio.raw_end_seconds * 48000),
      decoded_end_samples: Math.round(sourceAudio.end_seconds * 48000) };
    const endpoints = verifyAudioEndpointIdentity({ source: sourcePcm, child: childPcm,
      expectedStart: Math.round(start * 48000), sourceClock, childClock: clock });
    const windows = new Set([2048, ...Array.from({ length: Math.floor((childPcm.length - 6144) / 24000) }, (_, i) => 2048 + i * 24000),
      ...[4, 8, 12].flatMap((t) => [t * 48000 - 2048, t * 48000 + 2048]), childPcm.length - 6144]);
    const phases = verifyAudioPhase([...windows].filter((n) => n >= 0 && n + 4096 < childPcm.length)
      .sort((a, b) => a - b).map((n) => measureAudioPhase(sourcePcm, childPcm, Math.round(start * 48000), n)));
    const avResidual = Math.max(...checks.map((row) => Math.abs(row.residual_ms)))
      + Math.max(...[...phases, ...endpoints.endpoints].map((row) => Math.abs(row.residual_ms)));
    const sourceFps = facts.source_facts.video.framerate;
    assert.equal(sourceFps, 25);
    const avTolerance = 1000 / sourceFps + CHILD_TOLERANCES.audioPhaseSamples / 48;
    assert.ok(avResidual <= avTolerance);
    report.cases.push({ start_seconds: start, native: facts, frame_count: checks.length,
      whole_video_checks: checks, audio_clock: clock, audio_phase_checks: phases,
      audio_endpoint_checks: endpoints, audio_interior_coverage: "sampled phase windows, not every PCM sample", av_residual_ms: avResidual,
      av_tolerance_ms: avTolerance, source_fps: sourceFps, output_fps: 30,
      output_actual_video_facts: outputVideo,
      resampling_rule: "First source frame at/after seek; each later CFR30 frame may use only the immediate CFR25 source neighbors, including legitimate duplicated/dropped source frames",
      child_manifest_sha256: hash(await fs.readFile(input)),
      child_structure_projection: "Completed EVENT output projected to VOD solely to parse actual BMFF sample tables" });
    if (start === .013) {
      assert.throws(() => verifyChildPixels({ startMs: 1013, sourceFrames, ...clockContract, probe: childProbe, observations: childPixels }), /wrong source frame/);
      const shifted = structuredClone(childPixels); shifted[0] = sourcePixels[2];
      assert.throws(() => verifyChildPixels({ startMs: 13, sourceFrames, ...clockContract, probe: childProbe, observations: shifted }), /wrong source frame/);
      const shiftedOutput = [...childPixels.slice(1), childPixels.at(-1)];
      assert.throws(() => verifyChildPixels({ startMs: 13, sourceFrames, ...clockContract, probe: childProbe, observations: shiftedOutput }), /wrong source frame/);
      const legacy = (observations, probe = childProbe) => {
        const video = probe.streams.find((row) => row.codec_type === "video");
        const [n, d] = video.time_base.split("/").map(Number);
        return verifyOutputTimeline({ startMs: 13, sourceFrames, timeBase: video.time_base,
          outputFrames: probe.packets_and_frames.filter((row) => row.type === "frame" && row.media_type === "video")
            .map((row) => row.pts * n / d * 1000),
          samples: observations.map((row, i) => ({ ...row, output_frame_index: i })) });
      };
      for (const [kind, first, second, rejection] of [
        ["bracket-valid-reversal", 2, 1, /moves backwards/],
        ["bracket-valid-skip", 2, 4, /skips a source frame/],
      ]) {
        const negative = structuredClone(childPixels);
        const i = kind === "bracket-valid-reversal" ? 1 : 3;
        negative[i] = sourcePixels[first]; negative[i + 1] = sourcePixels[second];
        legacy(negative);
        assert.throws(() => verifyChildPixels({ startMs: 13, sourceFrames, ...clockContract,
          probe: childProbe, observations: negative }), rejection);
        report.negative_controls.push({ kind, output_indices: [i, i + 1], source_indices: [first, second],
          generic_neighbor_verifier_accepts: true, HLS_wrapper_rejects: true });
      }
      const tailProbe = structuredClone(childProbe), tailPixels = [...childPixels];
      const videoFrames = tailProbe.packets_and_frames.filter((row) => row.type === "frame" && row.media_type === "video");
      const last = videoFrames.at(-1), tick = last.duration;
      const extraCount = Math.floor((14000 - 13 + 1000 / 30 - videoFrames.length * 1000 / 30) / (1000 / 30)) + 1;
      for (let extra = 1; extra <= extraCount; extra++) {
        tailProbe.packets_and_frames.push({ ...last, pts: last.pts + extra * tick,
          best_effort_timestamp: last.pts + extra * tick }); tailPixels.push(childPixels.at(-1));
      }
      legacy(tailPixels, tailProbe);
      assert.throws(() => verifyChildPixels({ startMs: 13, sourceFrames, ...clockContract,
        probe: tailProbe, observations: tailPixels }), /end-duration/);
      report.negative_controls.push({ kind: "tail-beyond-one-output-period", extra_output_frames: extraCount,
        generic_neighbor_verifier_accepts: true, HLS_wrapper_rejects: true });
      const shiftedPcm = childPcm.subarray(1024);
      const negative = measureAudioPhase(sourcePcm, shiftedPcm, 624, 2048);
      assert.throws(() => verifyAudioPhase(Array(8).fill(negative)), /wrong audio source origin/);
      report.negative_controls.push({ kind: "wrong-origin-claim", requested_ms: 1013, actual_ms: 13 },
        { kind: "actual-next-source-frame-substitution", independent_frame: sourcePixels[2] },
        { kind: "whole-output-one-frame-shift", shift_output_frames: 1 },
        { kind: "decoded-PCM-shift-1024", measurement: negative });
    }
    await write("report.json", report);
  }
  for (const start of [.013, 3.417]) {
    const { output, native: facts } = await native(source, `generic-${start}`, start, "generic");
    const input = path.join(output, "child", "index.m3u8"), childProbe = await probe(input);
    await fs.writeFile(path.join(output, "child-probe.json"), JSON.stringify(childProbe));
    const frames = childProbe.packets_and_frames.filter((row) => row.type === "frame" && row.media_type === "video");
    let observations = [];
    if (frames.length) {
      observations = await pixels(input, path.join(output, "decoded-video"), outputConfig);
      assert.throws(() => verifyChildPixels({ startMs: start * 1000, sourceFrames, ...clockContract, probe: childProbe, observations }), /wrong source frame/);
    } else assert.equal(start, 3.417);
    report.negative_controls.push({ kind: "actual-generic-input-seek-failure", requested_origin_ms: start * 1000,
      native: facts, decoded_video_frames: frames.length, first_independent_frame: observations[0] ?? null });
  }
  for (const [name, controls, expected] of [
    ["canceled", { RAINSYNC_HLS_FIXTURE_CANCEL_MS: "25" }, "Canceled"],
    ["deadline", { RAINSYNC_HLS_FIXTURE_WALL_MS: "1" }, "Deadline"],
  ]) {
    const { native: facts } = await native(source, name, .013, "sequential", controls);
    assert.equal(facts.outcome, expected); assert.equal(facts.process_scope_reaped, true);
    assert.equal(facts.source_custody_removed_after_reap, true);
    assert.equal(facts.timeout_is_decoder_failure_authority, false);
    report.negative_controls.push({ kind: name, native: facts });
  }
  report.status = "passed";
} catch (error) { report.status = "failed"; report.failure = error.stack; throw error;
} finally { await write("report.json", report); console.log(`Static HLS child evidence: ${root}`); }
