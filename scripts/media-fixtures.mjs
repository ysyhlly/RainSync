import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(".runtime/fixtures");
await mkdir(root, { recursive: true });
const image = process.env.FIXTURE_IMAGE ?? "rainsync-server:dev";
const run = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 90000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
// Resolve the mutable tag once: all generated samples use exactly this image.
const imageId = run(["image", "inspect", "--format", "{{.Id}}", image]).trim();
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
  imageId,
];
const cases = JSON.parse(
  await readFile("tests/fixtures/media-cases.json", "utf8"),
);
const report = {
  schema_version: 2,
  generated_at: new Date().toISOString(),
  image_id: imageId,
  ffmpeg: run([...base, "ffmpeg", "-version"]).split(/\r?\n/)[0],
  cases: [],
};
for (const fixture of cases) {
  const file = `${fixture.id}.${fixture.extension}`;
  const args = [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24",
  ];
  const audioSources = fixture.audio
    ? (fixture.audio_sources ?? ["sine=frequency=440:sample_rate=48000"])
    : [];
  for (const source of audioSources) args.push("-f", "lavfi", "-i", source);
  args.push("-t", "3", "-map", "0:v:0");
  for (let i = 0; i < audioSources.length; i++)
    args.push("-map", `${i + 1}:a:0`);
  args.push(
    ...fixture.video,
    ...(fixture.audio ?? ["-an"]),
    ...(fixture.output_options ?? []),
    "-threads",
    "2",
    `/fixtures/${file}`,
  );
  run([...base, "ffmpeg", ...args]);
  // MP4 rotation is a display matrix attached when remuxing an existing track.
  if (fixture.rotation !== undefined) {
    const staged = `${fixture.id}.unrotated.mp4`;
    run([...base, "mv", `/fixtures/${file}`, `/fixtures/${staged}`]);
    run([
      ...base,
      "ffmpeg",
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-i",
      `/fixtures/${staged}`,
      "-map",
      "0",
      "-c",
      "copy",
      "-metadata:s:v:0",
      `rotate=${fixture.rotation}`,
      `/fixtures/${file}`,
    ]);
  }
  const metadata = JSON.parse(
    run([
      ...base,
      "ffprobe",
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      `/fixtures/${file}`,
    ]),
  );
  const video = metadata.streams.find((s) => s.codec_type === "video");
  const audio = metadata.streams.filter((s) => s.codec_type === "audio");
  assert.equal(audio.length, audioSources.length, `${fixture.id}: audio count`);
  const checks = { audio_streams: audio.length };
  if (fixture.audio_languages) {
    assert.deepEqual(
      audio.map((s) => s.tags?.language),
      fixture.audio_languages,
    );
    checks.audio_languages = fixture.audio_languages;
  }
  if (fixture.rotation !== undefined) {
    const rotation = video.side_data_list?.find(
      (s) => s.side_data_type === "Display Matrix",
    )?.rotation;
    assert.equal(rotation, fixture.rotation, `${fixture.id}: display rotation`);
    checks.rotation = rotation;
  }
  if (fixture.sample_aspect_ratio) {
    assert.equal(video.sample_aspect_ratio, fixture.sample_aspect_ratio);
    checks.sample_aspect_ratio = video.sample_aspect_ratio;
  }
  if (fixture.variable_frame_rate) {
    const frames = JSON.parse(
      run([
        ...base,
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
        `/fixtures/${file}`,
      ]),
    ).frames;
    const timestamps = frames.map((f) => Number(f.best_effort_timestamp_time));
    assert.ok(timestamps.length > 2 && timestamps.every(Number.isFinite));
    const intervals = timestamps.slice(1).map((t, i) => t - timestamps[i]);
    assert.ok(
      intervals.every((n) => n > 0),
      "frame timestamps must increase",
    );
    const distinct = [
      ...new Set(intervals.map((n) => Math.round(n * 1000))),
    ].sort((a, b) => a - b);
    assert.ok(distinct.at(-1) >= distinct[0] * 1.5, "VFR must survive muxing");
    checks.frame_intervals_ms = distinct;
  }
  // Decode every sample, including the deliberately unsupported PQ-tagged one.
  run([
    ...base,
    "ffmpeg",
    "-v",
    "error",
    "-xerror",
    "-i",
    `/fixtures/${file}`,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-f",
    "null",
    "-",
  ]);
  const bytes = await readFile(resolve(root, file));
  report.cases.push({
    ...fixture,
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    metadata,
    checks,
  });
  console.log(`Generated, probed, decoded: ${file}`);
}
await writeFile(
  resolve(root, "manifest.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(`Manifest: ${resolve(root, "manifest.json")}`);
