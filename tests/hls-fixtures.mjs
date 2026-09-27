import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const root = resolve(".runtime/fixtures");
const manifest = JSON.parse(
  await readFile(resolve(root, "manifest.json"), "utf8"),
);
const exporter = resolve(
  "target/debug/examples/hls_fixture_args" +
    (process.platform === "win32" ? ".exe" : ""),
);
const run = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 90000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
const runId = `hls-${randomUUID()}`;
const evidence = {
  image_id: manifest.image_id,
  generated_at: new Date().toISOString(),
  cases: [],
};
const ratio = (text) => {
  const [a, b] = text.split(":").map(Number);
  return a / b;
};
function displayRatio(video) {
  const sar =
    video.sample_aspect_ratio && video.sample_aspect_ratio !== "N/A"
      ? ratio(video.sample_aspect_ratio)
      : 1;
  const dar = (video.width * sar) / video.height;
  const rotation =
    video.side_data_list?.find((s) => s.side_data_type === "Display Matrix")
      ?.rotation ?? 0;
  return Math.abs(rotation) % 180 === 90 ? 1 / dar : dar;
}
for (const fixture of manifest.cases.filter((f) => !f.expected_error)) {
  const bytes = await readFile(resolve(root, fixture.file));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    fixture.sha256,
  );
  // Exercise forced conversion even for directly playable input; remux only
  // when video is already supported, as enforced by the server's route chooser.
  const modes =
    fixture.expected_mode === "transcode"
      ? ["transcode"]
      : ["remux", "transcode"];
  for (const mode of modes) {
    const directory = `${runId}/${fixture.id}-${mode}`;
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
        ],
        { encoding: "utf8", windowsHide: true },
      ),
    );
    run([...base, "ffmpeg", "-v", "error", "-xerror", ...args]);
    const selectedMode =
      args[args.indexOf("-c:v") + 1] === "copy" ? "remux" : "transcode";
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
        playlist,
      ]),
    );
    const video = metadata.streams.find((s) => s.codec_type === "video");
    const original = fixture.metadata.streams.find(
      (s) => s.codec_type === "video",
    );
    assert.equal(video.codec_name, "h264");
    assert.ok(["yuv420p", "yuvj420p"].includes(video.pix_fmt));
    assert.ok(
      Math.abs(displayRatio(video) / displayRatio(original) - 1) < 0.01,
      `${fixture.id}/${mode}: display aspect ratio changed`,
    );
    const audio = metadata.streams.filter((s) => s.codec_type === "audio");
    assert.equal(audio.length, fixture.audio ? 1 : 0);
    for (const stream of audio) assert.equal(stream.codec_name, "aac");
    const duration = Number(metadata.format.duration);
    assert.ok(
      Math.abs(duration - Number(fixture.metadata.format.duration)) < 0.15,
      `${fixture.id}/${mode}: duration ${duration}`,
    );
    run([
      ...base,
      "ffmpeg",
      "-v",
      "error",
      "-xerror",
      "-i",
      playlist,
      "-map",
      "0:v",
      "-map",
      "0:a?",
      "-f",
      "null",
      "-",
    ]);
    const text = await readFile(resolve(root, directory, "index.m3u8"), "utf8");
    assert.ok(text.includes("#EXT-X-ENDLIST"));
    evidence.cases.push({
      id: fixture.id,
      mode,
      selected_mode: selectedMode,
      input_sha256: fixture.sha256,
      args,
      metadata,
    });
    console.log(
      `PASS: ${fixture.id}/${mode} -> ${selectedMode}: HLS decode, codecs, duration and display geometry`,
    );
  }
}
await writeFile(
  resolve(root, runId, "report.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(`Evidence: ${resolve(root, runId, "report.json")}`);
