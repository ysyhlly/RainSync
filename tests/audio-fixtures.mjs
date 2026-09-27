import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const root = resolve(".runtime/fixtures");
const manifest = JSON.parse(
  await readFile(resolve(root, "manifest.json"), "utf8"),
);
const fixture = manifest.cases.find((c) => c.id === "h264-multi-audio");
assert.ok(fixture);
assert.equal(
  createHash("sha256")
    .update(await readFile(resolve(root, fixture.file)))
    .digest("hex"),
  fixture.sha256,
);
const exporter = resolve(
  "target/debug/examples/hls_fixture_args" +
    (process.platform === "win32" ? ".exe" : ""),
);
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
  manifest.image_id,
];
const options = {
  windowsHide: true,
  timeout: 90000,
  maxBuffer: 8 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
};
const run = (args) => execFileSync("docker", [...base, ...args], options);
const runId = `audio-${randomUUID()}`;
const report = {
  image_id: manifest.image_id,
  input_sha256: fixture.sha256,
  cases: [],
};
const audio = fixture.metadata.streams.filter((s) => s.codec_type === "audio");
assert.equal(audio.length, 2);
function power(samples, frequency) {
  let real = 0,
    imaginary = 0;
  for (let i = 0; i < samples.length; i++) {
    const angle = (2 * Math.PI * frequency * i) / 8000;
    real += samples[i] * Math.cos(angle);
    imaginary += samples[i] * Math.sin(angle);
  }
  return real ** 2 + imaginary ** 2;
}
for (const mode of ["remux", "transcode"]) {
  for (let track = 0; track < audio.length; track++) {
    const index = audio[track].index;
    const directory = `${runId}/${mode}-${index}`;
    await mkdir(resolve(root, directory), { recursive: true });
    const playlist = `/fixtures/${directory}/index.m3u8`;
    const args = JSON.parse(
      execFileSync(
        exporter,
        [
          `/fixtures/${fixture.file}`,
          playlist,
          mode,
          JSON.stringify(fixture.metadata),
          String(index),
        ],
        { ...options, encoding: "utf8" },
      ),
    );
    run(["ffmpeg", "-v", "error", "-xerror", ...args]);
    const meta = JSON.parse(
      run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", playlist]),
    );
    assert.equal(
      meta.streams.filter((s) => s.codec_type === "audio").length,
      1,
    );
    const pcm = run([
      "ffmpeg",
      "-v",
      "error",
      "-xerror",
      "-i",
      playlist,
      "-ss",
      "0.5",
      "-t",
      "1",
      "-map",
      "0:a:0",
      "-ar",
      "8000",
      "-ac",
      "1",
      "-f",
      "f32le",
      "pipe:1",
    ]);
    const samples = Array.from({ length: pcm.length / 4 }, (_, i) =>
      pcm.readFloatLE(i * 4),
    );
    assert.ok(samples.length >= 7900 && samples.every(Number.isFinite));
    const expected = track === 0 ? 440 : 880;
    const other = track === 0 ? 880 : 440;
    const rms = Math.sqrt(
      samples.reduce((n, x) => n + x * x, 0) / samples.length,
    );
    const dominance =
      power(samples, expected) /
      Math.max(power(samples, other), Number.EPSILON);
    assert.ok(
      rms > 0.01 && dominance > 100,
      `${mode}/${index}: wrong or silent track`,
    );
    report.cases.push({
      mode,
      index,
      expected_hz: expected,
      rms,
      power_ratio: dominance,
      args,
    });
    console.log(
      `PASS: ${mode} absolute stream ${index} decodes to ${expected} Hz`,
    );
  }
}
const invalidArgs = JSON.parse(
  execFileSync(
    exporter,
    [
      `/fixtures/${fixture.file}`,
      `/fixtures/${runId}/invalid.m3u8`,
      "remux",
      JSON.stringify(fixture.metadata),
      "99",
    ],
    { ...options, encoding: "utf8" },
  ),
);
const invalid = spawnSync(
  "docker",
  [...base, "ffmpeg", "-v", "error", ...invalidArgs],
  { ...options, encoding: "utf8" },
);
assert.equal(invalid.error, undefined);
assert.notEqual(invalid.status, 0);
assert.match(invalid.stderr, /matches no streams/);
report.invalid_track_rejected = true;
await writeFile(
  resolve(root, runId, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(`Evidence: ${resolve(root, runId, "report.json")}`);
