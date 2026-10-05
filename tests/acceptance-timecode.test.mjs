// Local FFmpeg encode/decode and pixel-reader checks. No browser or RainSync.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import {
  crc32,
  createVisibleTimecodeDecoder,
  readTimecodePng,
} from "../scripts/acceptance-timecode.mjs";
import { createBrowserMeasurementDriver } from "../scripts/acceptance-browser.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Test-side PNG encoding lets us corrupt actual codec-decoded pixels, then
// recompute the container CRC independently of the visible-marker CRC.
const chunk = (type, data) => {
  const tag = Buffer.from(type),
    out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  tag.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([tag, data])), out.length - 4);
  return out;
};
function pngOf({ width, height, channels, pixels }, filter = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const stride = width * channels,
    raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const diagonal =
        y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = [0, left, up, Math.floor((left + up) / 2)][filter];
      if (filter === 4) {
        const p = left + up - diagonal,
          a = Math.abs(p - left),
          b = Math.abs(p - up),
          c = Math.abs(p - diagonal);
        predictor = a <= b && a <= c ? left : b <= c ? up : diagonal;
      }
      raw[y * (stride + 1) + x + 1] =
        (pixels[y * stride + x] - predictor) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const copyImage = (image) => ({ ...image, pixels: Buffer.from(image.pixels) });
function paint(image, x, y, width, height, value) {
  for (let yy = y; yy < y + height; yy++)
    for (let xx = x; xx < x + width; xx++)
      for (let c = 0; c < 3; c++)
        image.pixels[(yy * image.width + xx) * image.channels + c] = value;
}
function scaledImage(image, scale, dx = 0, dy = 0, channels = 3) {
  const width = image.width * scale + dx * 2,
    height = image.height * scale + dy * 2;
  const result = {
    width,
    height,
    channels,
    pixels: Buffer.alloc(width * height * channels, 255),
  };
  for (let y = 0; y < image.height * scale; y++)
    for (let x = 0; x < image.width * scale; x++) {
      const from =
        (Math.floor(y / scale) * image.width + Math.floor(x / scale)) *
        image.channels;
      const to = ((y + dy) * width + x + dx) * channels;
      image.pixels.copy(result.pixels, to, from, from + 3);
    }
  return result;
}

test(
  "owned RST1 H.264 pipeline independently decodes pixels and fails closed",
  { timeout: 60000 },
  async (t) => {
    await mkdir(join(repo, ".runtime"), { recursive: true });
    const root = process.env.RAINSYNC_TIMECODE_EVIDENCE
      ? resolve(process.env.RAINSYNC_TIMECODE_EVIDENCE)
      : await mkdtemp(join(repo, ".runtime", "timecode-test-"));
    if (process.env.RAINSYNC_TIMECODE_EVIDENCE)
      await mkdir(root, { mode: 0o700 });
    const report = {
      scope: "owned-fixture-codec-validation",
      accepted: false,
      release_ready: false,
      browser_executed: false,
      sources_sha256: Object.fromEntries(
        await Promise.all(
          [
            "scripts/acceptance-timecode.mjs",
            "scripts/generate-timecode-fixture.py",
            "scripts/acceptance-browser.mjs",
            "tests/acceptance-timecode.test.mjs",
          ].map(async (path) => [path, sha(await readFile(join(repo, path)))]),
        ),
      ),
      artifacts: [],
      decoded: [],
      rejections: [],
    };
    const save = async (name, png) => {
      await writeFile(join(root, name), png, { mode: 0o600, flag: "wx" });
      const artifact = { path: name, sha256: sha(png), bytes: png.length };
      report.artifacts.push(artifact);
      return artifact;
    };
    t.after(async () => {
      await writeFile(
        join(root, "test-report.json"),
        JSON.stringify(report, null, 2) + "\n",
        { mode: 0o600 },
      );
      console.log(`Raw timecode evidence: ${root}`);
    });
    let manifest, originalPng;
    await t.test(
      "actual H.264 encoded frames: all decoded images, nonzero origin and hour rollover",
      async () => {
        for (const fps of [25, 30]) {
          const output = join(root, `fps-${fps}`);
          execFileSync(
            "python3",
            [
              join(repo, "scripts/generate-timecode-fixture.py"),
              `--output=${output}`,
              "--frames=12",
              `--fps=${fps}`,
              "--origin-ms=3599950",
            ],
            { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
          );
          const m = JSON.parse(await readFile(join(output, "manifest.json")));
          const decode = createVisibleTimecodeDecoder(m.decoder_config);
          assert.equal(m.accepted, false);
          assert.equal(m.decoded_frames.length, 12);
          assert.equal(
            sha(await readFile(join(output, m.media.path))),
            m.media.sha256,
          );
          for (const frame of m.decoded_frames) {
            const png = await readFile(join(output, frame.path)),
              decoded = decode(png);
            assert.equal(
              decoded.original_position_ms,
              3599950 + Math.round((frame.frame_index * 1000) / fps),
            );
            assert.equal(decoded.frame_index, frame.frame_index);
            assert.equal(
              decoded.human_readable,
              m.source_frames[frame.frame_index].human_readable,
            );
            assert.equal(decoded.frame_sha256, frame.sha256);
            assert.equal(
              decoded.timestamp_rounding_bound_ms,
              fps === 25 ? 0 : 0.5,
            );
            report.decoded.push({
              ...decoded,
              path: `fps-${fps}/${frame.path}`,
              codec_pts_ms: frame.encoded_pts_ms,
            });
          }
          manifest = m;
          originalPng = await readFile(join(output, m.decoded_frames[2].path));
          // Encoded/decompressed frame bytes genuinely differ from the source PNG.
          assert.notEqual(sha(originalPng), m.source_frames[2].sha256);
        }
      },
    );
    assert.ok(
      manifest && originalPng,
      "FFmpeg fixture required; failures must not silently skip",
    );
    const image = readTimecodePng(originalPng),
      config = manifest.decoder_config;
    const decode = createVisibleTimecodeDecoder(config);
    await t.test(
      "RGB/RGBA filters and explicit 2x ROI padding retain the same visible frame",
      async () => {
        for (let filter = 0; filter <= 4; filter++) {
          const padded = scaledImage(image, 2, 16, 8, 4),
            png = pngOf(padded, filter);
          const decoder = createVisibleTimecodeDecoder({
            ...config,
            screenshotWidth: padded.width,
            screenshotHeight: padded.height,
            scale: 2,
            roi: { x: 16, y: 8, width: 1280, height: 720 },
          });
          assert.equal(decoder(png).original_position_ms, 3600017);
          await save(`positive-rgba-scale2-filter${filter}.png`, png);
        }
      },
    );
    const reject = async (name, png, pattern, decoder = decode) => {
      await save(`${name}.png`, png);
      assert.throws(() => decoder(png), pattern);
      report.rejections.push({ name, expected: String(pattern) });
    };
    await t.test(
      "visible checksum, layout, numeric content, alpha and contrast reject corruption",
      async () => {
        let bad = copyImage(image);
        // Flip one frame-index payload bit while preserving a well-formed PNG.
        const n = 12 * 8 + 7,
          x = 32 + (2 + (n % 32)) * 8,
          y = 32 + (2 + Math.floor(n / 32)) * 8;
        const old =
          bad.pixels[
            (y + 3) * bad.width * bad.channels + (x + 3) * bad.channels
          ];
        paint(bad, x, y, 8, 8, old < 128 ? 255 : 0);
        await reject(
          "negative-marker-checksum",
          pngOf(bad),
          /timecode checksum/,
        );
        bad = copyImage(image);
        paint(bad, 40, 40, 8, 8, 255);
        await reject("negative-layout", pngOf(bad), /layout\/ROI/);
        bad = copyImage(image);
        paint(bad, 32, 32, 288, 96, 128);
        await reject("negative-contrast", pngOf(bad), /contrast/);
        bad = copyImage(image);
        paint(bad, 32, 160, 20, 28, 255);
        await reject("negative-numeric-glyph", pngOf(bad), /numeric timecode/);
        bad = scaledImage(image, 1, 0, 0, 4);
        bad.pixels[((32 + 3) * bad.width + 32 + 3) * 4 + 3] = 0;
        await reject("negative-alpha", pngOf(bad), /transparent/);
        // Change a complete numeric glyph to another VALID glyph (0 -> 1), leaving
        // marker/CRC intact; semantic comparison must detect the disagreement.
        bad = copyImage(image);
        paint(bad, 32, 160, 20, 28, 255);
        const one = [
          "00100",
          "01100",
          "00100",
          "00100",
          "00100",
          "00100",
          "01110",
        ];
        one.forEach((row, yy) =>
          [...row].forEach((bit, xx) => {
            if (bit === "1") paint(bad, 32 + xx * 4, 160 + yy * 4, 4, 4, 0);
          }),
        );
        await reject(
          "negative-numeric-marker-mismatch",
          pngOf(bad),
          /numeric\/marker/,
        );
      },
    );
    await t.test(
      "wrong ROI, unknown scale, source identity and bounds reject",
      async () => {
        const padded = scaledImage(image, 1, 8, 8),
          png = pngOf(padded);
        const wrongRoi = createVisibleTimecodeDecoder({
          ...config,
          screenshotWidth: padded.width,
          screenshotHeight: padded.height,
          roi: { x: 16, y: 8, width: 640, height: 360 },
        });
        await reject(
          "negative-wrong-roi",
          png,
          /layout\/ROI|checksum|version/,
          wrongRoi,
        );
        await reject(
          "negative-unknown-scale",
          pngOf(scaledImage(image, 2)),
          /unknown screenshot/,
        );
        await reject(
          "negative-wrong-source",
          originalPng,
          /sample identity/,
          createVisibleTimecodeDecoder({
            ...config,
            sampleId: "0000000000000000",
          }),
        );
        await reject(
          "negative-frame-bounds",
          originalPng,
          /position\/frame bounds/,
          createVisibleTimecodeDecoder({ ...config, frameCount: 2 }),
        );
        assert.throws(
          () => createVisibleTimecodeDecoder({ ...config, scale: 1.5 }),
          /supported scale/,
        );
        assert.throws(
          () =>
            createVisibleTimecodeDecoder({
              ...config,
              roi: { ...config.roi, x: 1 },
            }),
          /outside screenshot/,
        );
        assert.throws(
          () =>
            createVisibleTimecodeDecoder({
              ...config,
              mediaOriginMs: 359999999,
            }),
          /numeric timecode bounds/,
        );
      },
    );
    await t.test(
      "malformed PNG checksums, truncation, inflated bounds and unsupported layout reject",
      async () => {
        const transparency = Buffer.alloc(6); // RGB black would be transparent.
        const withTransparency = Buffer.concat([
          originalPng.subarray(0, 33),
          chunk("tRNS", transparency),
          originalPng.subarray(33),
        ]);
        await reject(
          "negative-rgb-transparency",
          withTransparency,
          /transparency chunk/,
        );
        const corrupt = Buffer.from(originalPng);
        corrupt[corrupt.length - 1] ^= 1;
        await reject("negative-png-crc", corrupt, /PNG checksum/);
        await reject(
          "negative-png-truncated",
          originalPng.subarray(0, -8),
          /truncated|bounds/,
        );
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(640);
        ihdr.writeUInt32BE(360, 4);
        ihdr[8] = 8;
        ihdr[9] = 2;
        const raw = Buffer.alloc((640 * 3 + 1) * 360 + 1);
        const oversize = Buffer.concat([
          originalPng.subarray(0, 8),
          chunk("IHDR", ihdr),
          chunk("IDAT", deflateSync(raw)),
          chunk("IEND", Buffer.alloc(0)),
        ]);
        await reject("negative-inflate-bound", oversize, /larger than/);
        ihdr[12] = 1;
        const interlaced = Buffer.concat([
          originalPng.subarray(0, 8),
          chunk("IHDR", ihdr),
          chunk("IDAT", deflateSync(Buffer.alloc(1))),
          chunk("IEND", Buffer.alloc(0)),
        ]);
        await reject(
          "negative-interlaced",
          interlaced,
          /unsupported PNG layout/,
        );
        assert.equal(
          crc32(Buffer.from("123456789")),
          0xcbf43926,
          "external CRC32 check vector",
        );
      },
    );
    const fakeClients = () =>
      ["left", "right"].map((client_id) => ({
        client_id,
        room: "fixture-only",
        source_url: "fixture-memory",
        media_origin_ms: 3599950,
        page: {
          async evaluate(_fn, input) {
            if (input) return undefined;
            return {
              client_id,
              original_position_ms: 3600017,
              monotonic_ms: 1,
              unavailable: false,
            };
          },
          locator() {
            return {
              async screenshot() {
                return originalPng;
              },
            };
          },
        },
      }));
    await t.test(
      "driver saves failed exact screenshots before attempting decode",
      async () => {
        const saved = [];
        let finishSinks;
        const sinksFinished = new Promise((resolve) => {
          finishSinks = resolve;
        });
        const driver = await createBrowserMeasurementDriver({
          clients: fakeClients(),
          decodeTimecode() {
            throw Error("fixture corruption");
          },
          async saveFrame(png, meta) {
            const artifact = await save(
              `driver-failure-${meta.client_id}.png`,
              png,
            );
            saved.push(artifact);
            if (saved.length === 2) finishSinks();
            return artifact;
          },
        });
        await assert.rejects(driver.timecodeChecks(), (error) => {
          assert.equal(error.cause.message, "fixture corruption");
          assert.equal(error.frame_artifact.sha256, sha(originalPng));
          return /raw frame saved/.test(error.message);
        });
        // Promise.all rejects on the first client; allow both sinks to finish before
        // inspecting the artifacts. This fake-page contract test is not a browser.
        await sinksFinished;
        assert.equal(saved.length, 2);
        await driver.dispose();
      },
    );
    await t.test(
      "observer admits one soak stream but rejects an empty client set",
      async () => {
        await assert.rejects(
          createBrowserMeasurementDriver({
            clients: [],
            decodeTimecode: decode,
            saveFrame: async () => {
              throw Error("unreachable");
            },
          }),
        );
        const driver = await createBrowserMeasurementDriver({
          clients: fakeClients().slice(0, 1),
          decodeTimecode: decode,
          async saveFrame(png) {
            return save("driver-single-stream.png", png);
          },
        });
        assert.equal((await driver.timecodeChecks()).length, 1);
        await driver.dispose();
      },
    );
    await t.test(
      "driver composes decoder metadata without reducing the existing tolerance",
      async () => {
        const driver = await createBrowserMeasurementDriver({
          clients: fakeClients(),
          decodeTimecode: decode,
          async saveFrame(png, meta) {
            return save(`driver-success-${meta.client_id}.png`, png);
          },
        });
        const checks = await driver.timecodeChecks();
        for (const check of checks) {
          assert.equal(check.method, "visible-frame-timecode");
          assert.equal(check.visible_original_position_ms, 3600017);
          assert.equal(check.decoder_evidence.frame_index, 2);
          assert.equal(check.decoder_evidence.timestamp_rounding_bound_ms, 0.5);
          assert.equal(check.tolerance_ms, 100);
        }
        await driver.dispose();
      },
    );
  },
);
