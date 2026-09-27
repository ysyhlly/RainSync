import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(".runtime/fixtures", `subtitles-${randomUUID()}`);
await mkdir(root, { recursive: true });
const options = {
  windowsHide: true,
  timeout: 90000,
  encoding: "utf8",
  stdio: ["pipe", "pipe", "pipe"],
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
  options,
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
const normalizer = resolve(
  "target/debug/examples/shift_subtitles" +
    (process.platform === "win32" ? ".exe" : ""),
);
const report = { image_id: image, cases: [] };
for (const bom of [false, true]) {
  const name = `chinese-${bom ? "bom" : "utf8"}.srt`;
  const srt =
    (bom ? "\ufeff" : "") +
    "1\r\n00:00:00,000 --> 00:00:01,000\r\n已结束\r\n\r\n2\r\n00:00:01,000 --> 00:00:05,000\r\n中文长字幕\r\n跨越起点\r\n\r\n3\r\n00:00:05,000 --> 00:00:07,000\r\n下一句\r\n";
  await writeFile(resolve(root, name), srt);
  const converted = execFileSync(
    "docker",
    [
      ...base,
      "ffmpeg",
      "-v",
      "error",
      "-nostdin",
      "-i",
      `/fixtures/${name}`,
      "-map",
      "0:0",
      "-f",
      "webvtt",
      "pipe:1",
    ],
    options,
  );
  const result = execFileSync(normalizer, ["3000"], {
    ...options,
    input: converted,
  });
  assert.ok(!result.includes("已结束"));
  assert.ok(result.includes("00:00:00.000 --> 00:00:02.000"));
  assert.ok(result.includes("中文长字幕\n跨越起点"));
  assert.ok(result.includes("00:00:02.000 --> 00:00:04.000"));
  await writeFile(resolve(root, `${name}.vtt`), result);
  // Feed the normalized output back through a real WebVTT parser.
  const probed = JSON.parse(
    execFileSync(
      "docker",
      [
        ...base,
        "ffprobe",
        "-v",
        "error",
        "-show_packets",
        "-of",
        "json",
        `/fixtures/${name}.vtt`,
      ],
      options,
    ),
  );
  assert.equal(probed.packets.length, 2);
  assert.equal(Number(probed.packets[0].pts_time), 0);
  assert.equal(Number(probed.packets[0].duration_time), 2);
  report.cases.push({ name, origin_ms: 3000, packets: probed.packets });
  console.log(
    `PASS: ${name}: actual FFmpeg conversion, crossing cue and expired cue`,
  );
}
const rejected = spawnSync(normalizer, ["0"], {
  ...options,
  input: "WEBVTT\n\n-00:01.000 --> 00:02.000\ninvalid\n",
});
assert.equal(rejected.error, undefined);
assert.notEqual(rejected.status, 0);
await writeFile(
  resolve(root, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(`Evidence: ${resolve(root, "report.json")}`);
