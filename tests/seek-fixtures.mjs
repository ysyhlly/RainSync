import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const variableFrameRate = process.argv.includes("--vfr");
assert.ok(
  process.argv.slice(2).every((arg) => arg === "--vfr"),
  "only --vfr is supported",
);
const root = resolve(
  ".runtime/fixtures",
  `seek-${variableFrameRate ? "vfr-" : ""}${randomUUID()}`,
);
await mkdir(root, { recursive: true });
const options = {
  windowsHide: true,
  timeout: 90000,
  maxBuffer: 16 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
};
const image = execFileSync(
  "docker",
  [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    process.env.FIXTURE_IMAGE ?? "rainsync-server:dev",
  ],
  { ...options, encoding: "utf8" },
).trim();
const base = [
  "run",
  "--rm",
  "--network",
  "none",
  "--cpus",
  "2",
  "--memory",
  "512m",
  "--mount",
  `type=bind,source=${root},target=/fixtures`,
  image,
];
const run = (args) => execFileSync("docker", [...base, ...args], options);
const exporter = resolve(
  "target/debug/examples/hls_fixture_args" +
    (process.platform === "win32" ? ".exe" : ""),
);
run([
  "ffmpeg",
  "-v",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=160x90:rate=24",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=48000",
  "-t",
  "12",
  "-c:v",
  "libx264",
  "-g",
  "240",
  "-keyint_min",
  "240",
  "-sc_threshold",
  "0",
  "-c:a",
  "aac",
  "-threads",
  "2",
  ...(variableFrameRate
    ? ["-vf", "select='if(lt(t,3),1,not(mod(n,2)))'", "-fps_mode", "vfr"]
    : []),
  "/fixtures/source.mp4",
]);
const sourceMetadata = JSON.parse(
  run([
    "ffprobe",
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    "/fixtures/source.mp4",
  ]),
);
const sourceFrames = JSON.parse(
  run([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_frames",
    "-show_entries",
    "frame=best_effort_timestamp_time",
    "-of",
    "json",
    "/fixtures/source.mp4",
  ]),
).frames;
const times = sourceFrames.map((frame) =>
  Number(frame.best_effort_timestamp_time),
);
assert.ok(times.length > 2 && times.every(Number.isFinite));
const gaps = times.slice(1).map((time, i) => time - times[i]);
assert.ok(gaps.every((gap) => gap > 0));
const frameIntervalsMs = [
  ...new Set(gaps.map((gap) => Math.round(gap * 1000))),
].sort((a, b) => a - b);
if (variableFrameRate)
  assert.ok(
    frameIntervalsMs.at(-1) >= frameIntervalsMs[0] * 1.5,
    "fixture must contain variable frame intervals",
  );
const report = {
  image_id: image,
  source_kind: variableFrameRate ? "vfr" : "cfr",
  source_frame_intervals_ms: frameIntervalsMs,
  source_metadata: sourceMetadata,
  source_sha256: createHash("sha256")
    .update(await readFile(resolve(root, "source.mp4")))
    .digest("hex"),
  cases: [],
};
const gray = (input, filter) =>
  run([
    "ffmpeg",
    "-v",
    "error",
    "-i",
    input,
    ...(filter ? ["-vf", filter] : []),
    "-frames:v",
    "1",
    "-fps_mode",
    "vfr",
    "-pix_fmt",
    "gray",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
function psnr(a, b) {
  assert.equal(a.length, 160 * 90);
  assert.equal(a.length, b.length);
  const mse =
    a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0) / a.length;
  return mse === 0 ? 100 : 10 * Math.log10(255 ** 2 / mse);
}
const oldKeyframe = gray("/fixtures/source.mp4");
for (const start of [0, 1.25, 5.25, 5.267, 8.125]) {
  // Independent reference: decode from the beginning and select by original
  // frame time, without using input seek or the production argument builder.
  const expected = gray("/fixtures/source.mp4", `select='gte(t,${start})'`);
  // CFR resampling can select either adjacent source frame at a fractional
  // source timestamp. Bound the reference to that interval, never a wider scan.
  const laterTarget = start + 1.5;
  const laterTimes = [
    ...new Set([
      times.findLast((time) => time <= laterTarget + 0.000001),
      times.find((time) => time >= laterTarget - 0.000001),
    ]),
  ];
  const laterReferences = laterTimes.map((time) => ({
    time,
    pixels: gray("/fixtures/source.mp4", `select='gte(t,${time - 0.000001})'`),
  }));
  for (const mode of ["remux", "transcode"]) {
    const directory = `${mode}-${start}`;
    await mkdir(resolve(root, directory), { recursive: true });
    const playlist = `/fixtures/${directory}/index.m3u8`;
    const args = JSON.parse(
      execFileSync(
        exporter,
        [
          "/fixtures/source.mp4",
          playlist,
          mode,
          JSON.stringify(sourceMetadata),
          "none",
          String(start),
        ],
        { ...options, encoding: "utf8" },
      ),
    );
    const selected =
      variableFrameRate || start > 0 || mode === "transcode"
        ? "transcode"
        : "remux";
    assert.equal(
      args[args.indexOf("-c:v") + 1],
      selected === "transcode" ? "libx264" : "copy",
    );
    run(["ffmpeg", "-v", "error", "-xerror", ...args]);
    const metadata = JSON.parse(
      run([
        "ffprobe",
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        playlist,
      ]),
    );
    const video = metadata.streams.find((s) => s.codec_type === "video");
    assert.ok(
      Math.abs(Number(video.start_time)) < 0.001,
      "first displayed frame must start at zero",
    );
    assert.ok(
      Math.abs(Number(metadata.format.duration) - (12 - start)) < 0.05,
      "preroll must not extend playlist duration",
    );
    const actual = gray(playlist);
    const matched = psnr(actual, expected);
    const obsolete = psnr(actual, oldKeyframe);
    assert.ok(
      matched > 30 && (start === 0 || matched > obsolete + 10),
      `wrong source frame: target=${matched}, old=${obsolete}`,
    );
    const laterActual = gray(playlist, "select='gte(t,1.5)'");
    const laterMatch = laterReferences
      .map(({ time, pixels }) => ({
        time,
        psnr: psnr(laterActual, pixels),
      }))
      .sort((a, b) => b.psnr - a.psnr)[0];
    const laterMatched = laterMatch.psnr;
    assert.ok(
      laterMatched > 30,
      `frame mapping drifted after startup: ${laterMatched}`,
    );
    run([
      "ffmpeg",
      "-v",
      "error",
      "-xerror",
      "-i",
      playlist,
      "-map",
      "0:v",
      "-map",
      "0:a",
      "-f",
      "null",
      "-",
    ]);
    report.cases.push({
      start_seconds: start,
      requested_mode: mode,
      selected_mode: selected,
      first_frame_psnr: matched,
      frame_after_1_5s_psnr: laterMatched,
      frame_after_1_5s_source_time: laterMatch.time,
      frame_after_1_5s_source_error_ms: (laterMatch.time - laterTarget) * 1000,
      frame_after_1_5s_reference_times: laterTimes,
      old_keyframe_psnr: obsolete,
      metadata,
      args,
    });
    console.log(
      `PASS: ${mode} seek ${start}s: zero first PTS, correct source frame, remaining duration`,
    );
  }
}
await writeFile(
  resolve(root, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(`Evidence: ${resolve(root, "report.json")}`);
