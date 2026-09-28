import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Each encoded rectangle represents a display-space square. Expected sizes
// are hand calculated for a centered 16:9 crop at 640x360, with 3px codec tolerance.
export const geometryCases = [
  {
    name: "anamorphic-wide",
    size: "720x576",
    sar: "64/45",
    dar: "16:9",
    box: [310, 216, 100, 142],
    expected: 89,
  },
  {
    name: "anamorphic-classic",
    size: "720x576",
    sar: "16/15",
    dar: "4:3",
    box: [310, 234, 100, 106],
    expected: 89,
  },
  {
    name: "square-pixels",
    size: "640x360",
    sar: "1",
    dar: "16:9",
    box: [270, 130, 100, 100],
    expected: 100,
  },
  {
    name: "portrait",
    size: "360x640",
    sar: "1",
    dar: "9:16",
    box: [130, 270, 100, 100],
    expected: 178,
  },
];
export function makeGeometry(root, cases = geometryCases) {
  for (const c of cases) {
    const [x, y, w, h] = c.box;
    const file = resolve(root, c.name + ".mp4");
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=black:s=${c.size}:r=25:d=1,drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=white:t=fill,setsar=${c.sar}`,
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        file,
      ],
      { timeout: 15000, windowsHide: true },
    );
    const metadata = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=display_aspect_ratio",
          "-of",
          "json",
          file,
        ],
        { encoding: "utf8", timeout: 10000, windowsHide: true },
      ),
    );
    assert.equal(metadata.streams[0].display_aspect_ratio, c.dar);
  }
}
export async function measureCover(client, root, cover) {
  const response = await client.raw(cover.url.replace("/api/v1", ""));
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  assert.ok(bytes.length <= 262144);
  const output = resolve(root, cover.revision + ".webp");
  await writeFile(output, bytes);
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      output,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { timeout: 10000, maxBuffer: 2000000, windowsHide: true },
  );
  assert.equal(raw.length, 640 * 360 * 3);
  let left = 640,
    right = -1,
    top = 360,
    bottom = -1;
  for (let y = 0; y < 360; y++)
    for (let x = 0; x < 640; x++) {
      const i = (y * 640 + x) * 3;
      if (raw[i] > 200 && raw[i + 1] > 200 && raw[i + 2] > 200) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  return { width: right - left + 1, height: bottom - top + 1 };
}
export function assertGeometry(c, actual) {
  assert.ok(
    Math.abs(actual.width - c.expected) <= 3 &&
      Math.abs(actual.height - c.expected) <= 3,
    `${c.name}: expected display square ${c.expected}px; got ${JSON.stringify(actual)}`,
  );
}
