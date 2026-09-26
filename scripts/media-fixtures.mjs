import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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
  schema_version: 1,
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
  if (fixture.audio)
    args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000");
  args.push("-t", "3", "-map", "0:v:0");
  if (fixture.audio) args.push("-map", "1:a:0");
  args.push(
    ...fixture.video,
    ...(fixture.audio ?? ["-an"]),
    "-threads",
    "2",
    `/fixtures/${file}`,
  );
  run([...base, "ffmpeg", ...args]);
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
  // Decode every sample, including the deliberately unsupported PQ-tagged one.
  run([
    ...base,
    "ffmpeg",
    "-v",
    "error",
    "-i",
    `/fixtures/${file}`,
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
  });
  console.log(`Generated, probed, decoded: ${file}`);
}
await writeFile(
  resolve(root, "manifest.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(`Manifest: ${resolve(root, "manifest.json")}`);
