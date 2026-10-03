// Bounded decoder for our owned RST1 fixture only. Not general OCR.
// The only observation input is PNG pixels; configuration pins geometry/source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const MAX_PNG_BYTES = 16 * 1024 * 1024;
const WIDTH = 640,
  HEIGHT = 360;
const GLYPHS = {
  0: "01110100011001110101110011000101110",
  1: "00100011000010000100001000010001110",
  2: "01110100010000100010001000100011111",
  3: "11110000010000101110000010000111110",
  4: "00010001100101010010111110001000010",
  5: "11111100001000011110000010000111110",
  6: "01110100001000011110100011000101110",
  7: "11111000010001000100010000100001000",
  8: "01110100011000101110100011000101110",
  9: "01110100011000101111000010000101110",
  ":": "00000001000010000000001000010000000",
  ".": "00000000000000000000000000010000100",
};

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// A small, bounded PNG reader avoids a native runtime dependency in the driver.
// Playwright RGB/RGBA PNG, 8-bit, non-interlaced only. CRCs, filters and lengths
// are checked; APNG, palette, grayscale, 16-bit and unknown critical chunks fail.
export function readTimecodePng(png) {
  assert.ok(
    Buffer.isBuffer(png) && png.length <= MAX_PNG_BYTES,
    "invalid PNG input bound",
  );
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), "invalid PNG signature");
  let offset = 8,
    width,
    height,
    channels,
    ended = false,
    dataEnded = false;
  const compressed = [];
  while (offset < png.length) {
    assert.ok(offset + 12 <= png.length, "truncated PNG chunk");
    const length = png.readUInt32BE(offset),
      type = png.toString("ascii", offset + 4, offset + 8);
    assert.ok(
      length <= MAX_PNG_BYTES && offset + 12 + length <= png.length,
      "PNG chunk bounds",
    );
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(
      crc32(png.subarray(offset + 4, offset + 8 + length)),
      png.readUInt32BE(offset + 8 + length),
      "PNG checksum mismatch",
    );
    if (type === "IHDR") {
      assert.ok(
        offset === 8 && length === 13 && width === undefined,
        "invalid PNG header",
      );
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.ok(
        width > 0 && height > 0 && width <= 4096 && height <= 2304,
        "PNG dimensions exceed bound",
      );
      assert.ok(
        data[8] === 8 &&
          [2, 6].includes(data[9]) &&
          data[10] === 0 &&
          data[11] === 0 &&
          data[12] === 0,
        "unsupported PNG layout",
      );
      channels = data[9] === 2 ? 3 : 4;
    } else {
      assert.ok(width !== undefined, "PNG header missing");
      if (type === "IDAT") {
        assert.ok(!dataEnded, "noncontiguous PNG data");
        compressed.push(data);
      } else if (type === "IEND") {
        assert.ok(
          length === 0 && compressed.length > 0 && offset + 12 === png.length,
          "invalid PNG end",
        );
        ended = true;
        break;
      } else {
        assert.notEqual(type, "tRNS", "PNG transparency chunk unsupported");
        assert.ok(
          !["acTL", "fcTL", "fdAT"].includes(type),
          "animated PNG unsupported",
        );
        assert.ok(
          /^[a-z][A-Za-z]{3}$/.test(type),
          "unknown critical PNG chunk",
        );
        if (compressed.length) dataEnded = true;
      }
    }
    offset += length + 12;
  }
  assert.ok(ended, "PNG end missing");
  const stride = width * channels,
    expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(compressed), {
    maxOutputLength: expected,
  });
  assert.equal(raw.length, expected, "PNG inflated size mismatch");
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4, "unsupported PNG filter");
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const diagonal =
        y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = up;
      if (filter === 3) predictor = Math.floor((left + up) / 2);
      if (filter === 4) {
        const p = left + up - diagonal,
          a = Math.abs(p - left),
          b = Math.abs(p - up),
          c = Math.abs(p - diagonal);
        predictor = a <= b && a <= c ? left : b <= c ? up : diagonal;
      }
      pixels[y * stride + x] =
        (raw[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

const integer = (value, name, min, max) =>
  assert.ok(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `invalid ${name}`,
  );
const displayTime = (ms) => {
  const pad = (v, n = 2) => String(v).padStart(n, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
};

export function createVisibleTimecodeDecoder({
  sampleId,
  mediaOriginMs,
  fps,
  frameCount,
  screenshotWidth,
  screenshotHeight,
  roi,
  scale,
}) {
  assert.match(sampleId, /^[a-f0-9]{16}$/, "pin the generated sample id");
  integer(mediaOriginMs, "media origin", 0, 359999999);
  integer(fps, "fps", 1, 60);
  integer(frameCount, "frame count", 1, 1800);
  integer(scale, "explicit supported scale", 1, 2);
  integer(screenshotWidth, "screenshot width", 1, 4096);
  integer(screenshotHeight, "screenshot height", 1, 2304);
  assert.ok(
    roi && roi.width === WIDTH * scale && roi.height === HEIGHT * scale,
    "ROI/scale must preserve exact fixture dimensions",
  );
  integer(roi.x, "ROI x", 0, screenshotWidth);
  integer(roi.y, "ROI y", 0, screenshotHeight);
  assert.ok(
    roi.x + roi.width <= screenshotWidth &&
      roi.y + roi.height <= screenshotHeight,
    "ROI outside screenshot bounds",
  );
  assert.ok(
    mediaOriginMs + Math.round(((frameCount - 1) * 1000) / fps) <= 359999999,
    "fixture exceeds numeric timecode bounds",
  );
  // Copy primitives: later mutations of the caller's ROI cannot repin geometry.
  const originX = roi.x,
    originY = roi.y;
  return function decodeTimecode(png) {
    const image = readTimecodePng(png);
    assert.equal(
      image.width,
      screenshotWidth,
      "unknown screenshot width/scale",
    );
    assert.equal(
      image.height,
      screenshotHeight,
      "unknown screenshot height/scale",
    );
    // Read the central half of each cell. Every pixel must agree and be opaque;
    // this tolerates codec edges but rejects blur, low contrast and mixed cells.
    const cell = (x, y, size) => {
      const startX = originX + x * scale + Math.floor((size * scale) / 4);
      const startY = originY + y * scale + Math.floor((size * scale) / 4);
      const side = Math.max(1, Math.floor((size * scale) / 2));
      let result;
      for (let yy = startY; yy < startY + side; yy++)
        for (let xx = startX; xx < startX + side; xx++) {
          const pos = (yy * image.width + xx) * image.channels;
          assert.ok(
            image.channels !== 4 || image.pixels[pos + 3] === 255,
            "transparent timecode pixel",
          );
          const luminance =
            (image.pixels[pos] * 299 +
              image.pixels[pos + 1] * 587 +
              image.pixels[pos + 2] * 114) /
            1000;
          assert.ok(
            luminance <= 65 || luminance >= 190,
            "timecode contrast/ambiguity rejection",
          );
          const bit = luminance <= 65 ? 1 : 0;
          assert.ok(
            result === undefined || result === bit,
            "mixed timecode cell",
          );
          result = bit;
        }
      return result;
    };
    const payload = Buffer.alloc(32);
    for (let row = 0; row < 12; row++)
      for (let col = 0; col < 36; col++) {
        const bit = cell(32 + col * 8, 32 + row * 8, 8);
        if (row >= 2 && row <= 9 && col >= 2 && col <= 33) {
          const n = (row - 2) * 32 + col - 2;
          payload[n >> 3] |= bit << (7 - (n % 8));
        } else {
          let expected = 0;
          if (row === 1 && col >= 1 && col <= 34) expected = col % 2;
          else if (row === 10 && col >= 1 && col <= 34)
            expected = 1 - (col % 2);
          else if (row >= 2 && row <= 9 && col === 34) expected = 1;
          assert.equal(bit, expected, "timecode layout/ROI rejection");
        }
      }
    assert.equal(
      payload.toString("ascii", 0, 4),
      "RST1",
      "unsupported marker version",
    );
    assert.equal(
      crc32(payload.subarray(0, 28)),
      payload.readUInt32BE(28),
      "timecode checksum mismatch",
    );
    assert.equal(
      payload.subarray(4, 12).toString("hex"),
      sampleId,
      "wrong fixture sample identity",
    );
    assert.equal(payload.readUInt16BE(24), fps, "fixture fps mismatch");
    assert.equal(payload.readUInt16BE(26), 0, "unsupported marker flags");
    const frame_index = payload.readUInt32BE(12),
      encoded = payload.readBigUInt64BE(16);
    assert.ok(
      frame_index < frameCount && encoded <= 359999999n,
      "timecode position/frame bounds",
    );
    const original_position_ms = Number(encoded);
    assert.equal(
      original_position_ms,
      mediaOriginMs + Math.round((frame_index * 1000) / fps),
      "fixture frame/position mismatch",
    );
    let human_readable = "";
    for (let i = 0; i < 12; i++) {
      let glyph = "";
      for (let row = 0; row < 7; row++)
        for (let col = 0; col < 6; col++) {
          const bit = cell(32 + i * 24 + col * 4, 160 + row * 4, 4);
          if (col < 5) glyph += bit;
          else assert.equal(bit, 0, "numeric timecode spacing corrupted");
        }
      const match = Object.entries(GLYPHS).find(
        ([, pattern]) => pattern === glyph,
      );
      assert.ok(match, "unknown numeric timecode glyph");
      human_readable += match[0];
    }
    assert.equal(
      human_readable,
      displayTime(original_position_ms),
      "numeric/marker timecode mismatch",
    );
    return {
      original_position_ms,
      method: "rainsync-rst1-pixels-v1",
      sample_id: sampleId,
      frame_index,
      human_readable,
      frame_duration_ms: 1000 / fps,
      timestamp_rounding_bound_ms: 1000 % fps === 0 ? 0 : 0.5,
      // This is NOT a bound on screenshot capture latency or dual-client error.
      frame_sha256: createHash("sha256").update(png).digest("hex"),
    };
  };
}
