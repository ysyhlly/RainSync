// Actual owned FFmpeg decode prerequisite plus adversarial pure-analyzer tests.
// No Server, Worker, database, browser, graph authority or fallback is enabled.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  cp,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  STATIC_HLS_LIMITS,
  staticMediaPlaylist,
  inspectStaticHlsStructure,
  inspectStaticHlsTimeline,
  requireSameStaticHlsClosure,
  staticHlsByteIdentity,
} from "../scripts/static-hls-timeline.mjs";
import {
  runBoundedOwned,
  scanOwnedStaticHls,
} from "../scripts/static-hls-timeline-owned.mjs";
import { createVisibleTimecodeDecoder } from "../scripts/acceptance-timecode.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const repo = resolve(import.meta.dirname, "..");
let root, source, positive, report;
const command = async (name, args, options) => {
  const result = await runBoundedOwned(name, args, options);
  report.commands.push(result.execution);
  return result.stdout;
};
async function encode(name, extra = [], { audio = true, fps = 25 } = {}) {
  const directory = resolve(root, name);
  await mkdir(directory);
  const args = [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-threads",
    "1",
    "-i",
    resolve(root, "source/fixture.mp4"),
    ...(audio
      ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4"]
      : []),
    "-map",
    "0:v:0",
    ...(audio ? ["-map", "1:a:0"] : ["-an"]),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-threads",
    "1",
    "-bf",
    "0",
    "-g",
    String(fps),
    "-sc_threshold",
    "0",
    ...(audio ? ["-c:a", "aac", "-ar", "48000", "-ac", "1"] : []),
    ...extra,
    "-avoid_negative_ts",
    "disabled",
    "-f",
    "hls",
    "-hls_time",
    "1",
    "-hls_segment_type",
    "fmp4",
    "-hls_playlist_type",
    "vod",
    resolve(directory, "index.m3u8"),
  ];
  await command("ffmpeg", args);
  return directory;
}
async function scan(directory) {
  const result = await scanOwnedStaticHls(directory);
  await writeFile(
    resolve(directory, "decode-evidence.json"),
    JSON.stringify(result.probe),
  );
  report.cases.push({
    directory,
    proof: result.proof,
    actual_bytes: result.actual_bytes,
    elapsed_ms: result.elapsed_ms,
    execution: result.execution,
  });
  return result;
}
const evidenceInput = (value = positive) => ({
  ...value.input,
  probe: structuredClone(value.probe),
});
function rejected(input, reason) {
  assert.throws(
    () => inspectStaticHlsTimeline(input),
    reason ?? /unsupported_static_hls_timeline:/,
  );
}
async function mutateDirectory(name, mutate) {
  const directory = resolve(root, name);
  await cp(resolve(root, "zero"), directory, { recursive: true });
  await mutate(directory);
  return directory;
}
function findType(bytes, tag) {
  const offset = bytes.indexOf(Buffer.from(tag));
  assert.ok(offset >= 4, tag);
  return offset + 4;
}

before(async () => {
  await mkdir(resolve(repo, ".runtime"), { recursive: true });
  root = await mkdtemp(resolve(repo, ".runtime/static-hls-contract-"));
  report = {
    version: 1,
    result: "running",
    scope: "owned-local-static-hls-timeline-prerequisite-only",
    accepted: false,
    release_ready: false,
    production_fallback_enabled: false,
    limits: STATIC_HLS_LIMITS,
    commands: [],
    cases: [],
    negative_cases: [],
    sources: await Promise.all(
      [
        "scripts/static-hls-timeline.mjs",
        "scripts/static-hls-timeline-owned.mjs",
        "tests/static-hls-timeline-contract.test.mjs",
        "scripts/acceptance-timecode.mjs",
        "scripts/generate-timecode-fixture.py",
      ].map(async (path) => ({
        path,
        sha256: hash(await readFile(resolve(repo, path))),
      })),
    ),
  };
  report.ffmpeg = (await command("ffmpeg", ["-version"])).toString();
  report.ffprobe = (await command("ffprobe", ["-version"])).toString();
  await command(
    "python3",
    [
      resolve(repo, "scripts/generate-timecode-fixture.py"),
      "--output",
      resolve(root, "source"),
      "--frames",
      "100",
      "--fps",
      "25",
    ],
    { limited: false },
  );
  source = JSON.parse(await readFile(resolve(root, "source/manifest.json")));
  positive = await scan(await encode("zero"));
});
after(async () => {
  if (!root || !report) return;
  report.result = "completed-see-node-test-exit-status";
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`Static HLS prerequisite artifacts: ${root}`);
});

test("complete actual source scan proves every raw sample and decoded timestamp", () => {
  assert.equal(positive.proof.duration_ms, 4000);
  assert.equal(positive.proof.segments.length, 4);
  assert.deepEqual(
    positive.proof.tracks.map(
      ({ kind, raw_first_pts, decoded_first_pts, priming_samples }) => ({
        kind,
        raw_first_pts,
        decoded_first_pts,
        priming_samples,
      }),
    ),
    [
      {
        kind: "video",
        raw_first_pts: 0,
        decoded_first_pts: 0,
        priming_samples: 0,
      },
      {
        kind: "audio",
        raw_first_pts: -1024,
        decoded_first_pts: 0,
        priming_samples: 1024,
      },
    ],
  );
  assert.equal(positive.proof.tracks[0].decoded_frames, 100);
  assert.ok(
    positive.proof.tracks[1].tail_padding_samples >= 0 &&
      positive.proof.tracks[1].tail_padding_samples < 1024,
  );
  assert.ok(positive.execution.process_group_reaped);
});

test("first and later HLS-decoded pixels carry the matching original source time", async () => {
  const decode = createVisibleTimecodeDecoder(source.decoder_config);
  for (const ms of [0, 1000, 2400, 3960]) {
    const png = await command("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-protocol_whitelist",
      "file",
      "-i",
      resolve(root, "zero/index.m3u8"),
      "-vf",
      `select=gte(t\\,${ms / 1000})`,
      "-frames:v",
      "1",
      "-fps_mode",
      "passthrough",
      "-pix_fmt",
      "rgb24",
      "-threads",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "pipe:1",
    ]);
    const path = resolve(root, `presented-${ms}.png`);
    await writeFile(path, png);
    const observation = await decode(png);
    assert.equal(observation.original_position_ms, ms);
    report.cases.push({
      kind: "source_pixel_clock",
      source_pts_ms: ms,
      observation,
      png_path: path,
      png_sha256: hash(png),
    });
  }
});

test("media sequence seven does not manufacture an offset", () => {
  const input = evidenceInput();
  input.manifest = input.manifest.replace(
    "MEDIA-SEQUENCE:0",
    "MEDIA-SEQUENCE:7",
  );
  const proof = inspectStaticHlsTimeline(input);
  assert.equal(proof.media_sequence, 7);
  assert.equal(proof.source_origin_ms, 0);
});

test("actual video-only and 30 fps sources are independently scanned", async () => {
  const silent = await scan(await encode("silent", [], { audio: false }));
  assert.equal(silent.proof.tracks.length, 1);
  const thirty = await scan(
    await encode("thirty", ["-r", "30", "-fps_mode", "cfr"], { fps: 30 }),
  );
  assert.equal(thirty.proof.tracks[0].decoded_frames, 120);
});

async function actualNegative(directory, kind) {
  const args = [...positive.execution.args];
  args[args.length - 1] = resolve(directory, "index.m3u8");
  const bytes = await command("ffprobe", args);
  await writeFile(resolve(directory, "negative-decode-evidence.json"), bytes);
  const probe = JSON.parse(bytes);
  let reason;
  try {
    await scanOwnedStaticHls(directory);
    assert.fail("negative source unexpectedly accepted");
  } catch (error) {
    assert.match(error.message, /unsupported_static_hls_timeline:/);
    reason = error.message;
  }
  const frames = probe.packets_and_frames.filter(
    (record) => record.type === "frame",
  );
  const streams = probe.streams.map((stream) => {
    const selected = frames.filter(
      (frame) => frame.stream_index === stream.index,
    );
    return {
      kind: stream.codec_type,
      first_decoded_pts: selected[0]?.pts,
      last_decoded_pts: selected.at(-1)?.pts,
      decoded_frame_count: selected.length,
      time_base: stream.time_base,
      missing_duration_count: selected.filter(
        (frame) => !Number.isFinite(frame.duration ?? frame.pkt_duration),
      ).length,
      discontinuities: selected.slice(1).flatMap((frame, index) => {
        const previous = selected[index],
          duration = previous.duration ?? previous.pkt_duration;
        return !Number.isFinite(duration) ||
          frame.pts === previous.pts + duration
          ? []
          : [{ before: previous.pts, duration, after: frame.pts }];
      }),
    };
  });
  const manifest = await readFile(resolve(directory, "index.m3u8"), "utf8"),
    playlist = staticMediaPlaylist(manifest);
  const paths = [
    "index.m3u8",
    playlist.map,
    ...playlist.segments.map(({ uri }) => uri),
  ];
  const actual_files = await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(resolve(directory, path));
      return { path, bytes: bytes.length, sha256: hash(bytes) };
    }),
  );
  report.negative_cases.push({
    kind,
    directory,
    rejected: true,
    reason,
    streams,
    actual_files,
    decoder_sha256: hash(bytes),
  });
}

test("actual plus-four-second source is rejected despite ENDLIST", async () => {
  const directory = await encode("offset", [
    "-vf",
    "setpts=PTS+4/TB",
    "-af",
    "asetpts=PTS+4/TB",
    "-copyts",
    "-fps_mode",
    "passthrough",
  ]);
  await actualNegative(directory, "actual_offset");
});

test("actual undeclared one-second jump is rejected across the complete source", async () => {
  const directory = await encode("gap", [
    "-vf",
    "setpts=PTS+if(gte(T\\,2)\\,1/TB\\,0)",
    "-af",
    "asetpts=PTS+if(gte(T\\,2)\\,1/TB\\,0)",
    "-copyts",
    "-fps_mode",
    "passthrough",
  ]);
  await actualNegative(directory, "actual_undeclared_gap");
});

test("actual delayed audio is not normalized into a zero-origin promise", async () => {
  const directory = await encode("audio-delay", [
    "-af",
    "asetpts=PTS+0.4/TB",
    "-copyts",
    "-fps_mode",
    "passthrough",
  ]);
  await actualNegative(directory, "actual_audio_delay");
});

test("unknown edits, priming, missing frames and manufactured zero evidence are rejected", () => {
  let input = evidenceInput();
  input.probe.packets_and_frames.find(
    (record) => record.type === "packet" && record.stream_index === 1,
  ).side_data_list[0].skip_samples = 512;
  rejected(input, /aac_priming_mismatch/);
  input = evidenceInput();
  input.probe.packets_and_frames.find(
    (record) => record.type === "packet" && record.stream_index === 1,
  ).side_data_list[0].discard_padding = 1;
  rejected(input, /aac_priming_mismatch/);
  input = evidenceInput();
  input.probe.packets_and_frames.splice(
    input.probe.packets_and_frames.findIndex(
      (record) => record.type === "frame",
    ),
    1,
  );
  rejected(input, /decoded_sample_count/);
  input = evidenceInput();
  input.probe.packets_and_frames.filter(
    (record) => record.type === "frame" && record.stream_index === 0,
  )[50].pts = 0;
  rejected(input, /decoded_presentation_clock/);
  input = evidenceInput();
  input.init = Buffer.from(input.init);
  input.init.writeInt32BE(1, findType(input.init, "elst") + 12);
  rejected(input, /unknown_edit_offset/);
});

test("a later segment cannot add or lose a track", async () => {
  const changed = await mutateDirectory("unknown-track", async (directory) => {
    const path = resolve(directory, "index3.m4s"),
      bytes = await readFile(path);
    bytes.writeUInt32BE(999, findType(bytes, "tfhd") + 4);
    await writeFile(path, bytes);
  });
  await assert.rejects(scanOwnedStaticHls(changed), /fragment_unknown_track/);
  const input = evidenceInput();
  input.segments = [...input.segments];
  input.segments[3] = await readFile(resolve(root, "silent/index3.m4s"));
  rejected(input, /segment_track_set_changed/);
});

test("raw audio media end must match video before decoder padding is allowed", async () => {
  const children = (bytes, start = 0, end = bytes.length) => {
    const result = [];
    for (let offset = start; offset < end;) {
      const length = bytes.readUInt32BE(offset);
      assert.ok(length >= 8 && offset + length <= end);
      result.push({
        type: bytes.toString("ascii", offset + 4, offset + 8),
        start: offset + 8,
        end: offset + length,
      });
      offset += length;
    }
    return result;
  };
  for (const finalDuration of [1, 1023]) {
    const input = evidenceInput();
    input.segments = input.segments.map((bytes) => Buffer.from(bytes));
    const bytes = input.segments.at(-1);
    const moof = children(bytes).find(({ type }) => type === "moof");
    const audioId = positive.proof.tracks.find(
      ({ kind }) => kind === "audio",
    ).track_id;
    const traf = children(bytes, moof.start, moof.end)
      .filter(({ type }) => type === "traf")
      .find(({ start, end }) => {
        const tfhd = children(bytes, start, end).find(
          ({ type }) => type === "tfhd",
        );
        return bytes.readUInt32BE(tfhd.start + 4) === audioId;
      });
    const trun = children(bytes, traf.start, traf.end).find(
      ({ type }) => type === "trun",
    );
    const flags = bytes.readUInt32BE(trun.start);
    assert.ok(flags & 0x100, "fixture has explicit audio sample durations");
    const count = bytes.readUInt32BE(trun.start + 4);
    const stride = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0);
    const finalDurationOffset =
      trun.start + 12 + (flags & 4 ? 4 : 0) + (count - 1) * stride;
    bytes.writeUInt32BE(finalDuration, finalDurationOffset);
    // Packet/frame timestamps and decoded 1024-sample duration are unchanged.
    // Only the actual final media duration changed, so it cannot be padding.
    rejected(input, /audio_video_end_alignment/);
    const directory = await mutateDirectory(
      `audio-tail-${finalDuration}`,
      (directory) => writeFile(resolve(directory, "index3.m4s"), bytes),
    );
    await actualNegative(directory, `actual_audio_tail_${finalDuration}`);
    assert.match(
      report.negative_cases.at(-1).reason,
      /audio_video_end_alignment/,
    );
  }
});

test("every actual byte is hashed, including init and a previously unplayed final segment", () => {
  const expected = positive.proof;
  requireSameStaticHlsClosure(expected, structuredClone(expected));
  const input = evidenceInput();
  input.segments = input.segments.map((bytes) => Buffer.from(bytes));
  // Byte flip inside encoded payload leaves sample clocks valid. A closure
  // hash must still reject it independently of timestamp eligibility.
  input.segments[3][findType(input.segments[3], "mdat") + 20] ^= 1;
  const changed = staticHlsByteIdentity(input);
  assert.equal(changed.segments[3].bytes, expected.segments[3].bytes);
  assert.notEqual(changed.segments[3].sha256, expected.segments[3].sha256);
  assert.throws(
    () => requireSameStaticHlsClosure(expected, changed),
    /source_changed/,
  );
  const initBytes = Buffer.from(positive.input.init);
  initBytes[8] ^= 1;
  const initChanged = staticHlsByteIdentity({
    ...positive.input,
    init: initBytes,
  });
  assert.equal(initChanged.init.bytes, expected.init.bytes);
  assert.notEqual(initChanged.init.sha256, expected.init.sha256);
  assert.throws(
    () => requireSameStaticHlsClosure(expected, initChanged),
    /source_changed/,
  );
  const queryChanged = staticHlsByteIdentity({
    ...positive.input,
    manifest: positive.input.manifest.replace(
      "index3.m4s",
      "index3.m4s?signature=changed",
    ),
  });
  assert.throws(
    () => requireSameStaticHlsClosure(expected, queryChanged),
    /source_changed/,
  );
});

test("static syntax, unsupported tags, resource and diagnostic bounds fail closed", () => {
  for (const tag of [
    "#EXT-X-KEY:METHOD=NONE",
    "#EXT-X-BYTERANGE:4@0",
    "#EXT-X-DISCONTINUITY",
    "#EXT-X-START:TIME-OFFSET=1",
    "#EXT-X-UNKNOWN:1",
  ]) {
    assert.throws(
      () =>
        staticMediaPlaylist(
          positive.input.manifest.replace(
            "#EXT-X-ENDLIST",
            `${tag}\n#EXT-X-ENDLIST`,
          ),
        ),
      /unsupported_manifest_tag/,
    );
  }
  for (const text of [
    positive.input.manifest.replace("PLAYLIST-TYPE:VOD", "PLAYLIST-TYPE:EVENT"),
    positive.input.manifest.replace("#EXT-X-ENDLIST\n", ""),
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant.m3u8\n",
    "x".repeat(STATIC_HLS_LIMITS.manifestBytes + 1),
  ])
    assert.throws(
      () => staticMediaPlaylist(text),
      /unsupported_static_hls_timeline:/,
    );
  const input = evidenceInput();
  input.probe.packets_and_frames = Array(STATIC_HLS_LIMITS.records + 1).fill(
    {},
  );
  rejected(input, /decoder_record_bound/);
  assert.throws(
    () =>
      inspectStaticHlsStructure({
        ...positive.input,
        segments: positive.input.segments.slice(1),
      }),
    /incomplete_closure/,
  );
});

test("decoder deadline and stdout overflow kill and reap the owned process group", async () => {
  await assert.rejects(
    runBoundedOwned(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeout: 50,
      limited: false,
    }),
    /decoder_deadline/,
  );
  await assert.rejects(
    runBoundedOwned(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(1048576));setInterval(()=>{},1000)",
      ],
      { outputBytes: 1024, limited: false },
    ),
    /decoder_output_bound/,
  );
});

test("never-started decoder preserves spawn failure without signaling a missing PID", async () => {
  await assert.rejects(
    runBoundedOwned(resolve(root, "does-not-exist"), [], { limited: false }),
    /decoder_spawn_ENOENT:never_started/,
  );
});

test("a nonregular owned resource is refused without blocking on FIFO open", async () => {
  const directory = await mutateDirectory("fifo", async (directory) => {
    const path = resolve(directory, "init.mp4");
    await unlink(path);
    await command("mkfifo", [path]);
  });
  await assert.rejects(scanOwnedStaticHls(directory), /local_file_bound/);
});

test("empty or malformed closure inventories cannot compare as valid authority", () => {
  for (const value of [
    { version: 1, segments: [] },
    { ...positive.proof, manifest_sha256: "" },
    { ...positive.proof, init: { bytes: -1, sha256: "a".repeat(64) } },
  ]) {
    assert.throws(
      () => requireSameStaticHlsClosure(value, value),
      /closure_proof_shape/,
    );
  }
});
