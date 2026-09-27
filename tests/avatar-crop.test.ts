import { expect, it } from "vitest";
import {
  createCrop,
  cropRect,
  panCrop,
  zoomCrop,
} from "../apps/web/src/features/account/avatar/crop-model";
import { inspectImage } from "../apps/web/src/features/account/avatar/image-input";
it("crops landscape and portrait source pixels without stretching", () => {
  const wide = createCrop(1600, 900);
  expect(cropRect(wide)).toEqual({ x: 350, y: 0, size: 900 });
  expect(cropRect(zoomCrop(wide, 2))).toEqual({ x: 575, y: 225, size: 450 });
  expect(cropRect(createCrop(900, 1600))).toEqual({ x: 0, y: 350, size: 900 });
  expect(cropRect(createCrop(120, 120))).toEqual({ x: 0, y: 0, size: 120 });
});
it("clamps all edges, preserves square coverage and uses viewport-independent source coordinates", () => {
  const original = zoomCrop(createCrop(1600, 900), 2);
  expect(panCrop(original, 20, 10, 200)).toEqual(
    panCrop(original, 40, 20, 400),
  );
  for (const dx of [-10000, 10000])
    for (const dy of [-10000, 10000]) {
      const r = cropRect(panCrop(original, dx, dy, 256));
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.size).toBeLessThanOrEqual(1600);
      expect(r.y + r.size).toBeLessThanOrEqual(900);
    }
  expect(zoomCrop(original, 0).zoom).toBe(1);
  expect(zoomCrop(original, 99).zoom).toBe(8);
  expect(zoomCrop(original, Number.NaN)).toEqual(original);
  expect(() => createCrop(0, 900)).toThrow();
});
it("keeps the zoom anchor on the same original pixel until an edge is reached", () => {
  const start = zoomCrop(createCrop(1600, 1600), 2),
    old = cropRect(start);
  const next = cropRect(zoomCrop(start, 4, 0.75, 0.25));
  expect(next.x + 0.75 * next.size).toBeCloseTo(old.x + 0.75 * old.size);
  expect(next.y + 0.25 * next.size).toBeCloseTo(old.y + 0.25 * old.size);
});
const chunk = (type: string, payload: number[]) => {
  const b = new Uint8Array(12 + payload.length);
  new DataView(b.buffer).setUint32(0, payload.length);
  b.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  );
  b.set(payload, 8);
  return b;
};
function png(width: number, height: number, animated = false) {
  const h = new Uint8Array(13);
  const v = new DataView(h.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  h[8] = 8;
  h[9] = 6;
  return Uint8Array.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk("IHDR", [...h]),
    ...(animated ? chunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0]) : []),
    ...chunk("IEND", []),
  ]);
}
it("reads source dimensions before decoding and rejects large, animated, corrupt or unsupported input", () => {
  expect(inspectImage(png(1600, 900))).toEqual({
    width: 1600,
    height: 900,
    type: "image/png",
  });
  expect(() => inspectImage(png(1600, 900, true))).toThrow("动态");
  expect(() => inspectImage(png(8000, 8000))).toThrow("像素");
  expect(() => inspectImage(png(20000, 1))).toThrow("尺寸");
  expect(() => inspectImage(png(1600, 900).slice(0, -1))).toThrow();
  expect(() => inspectImage(new TextEncoder().encode("<svg/>"))).toThrow(
    "静态",
  );
  expect(() => inspectImage(new TextEncoder().encode("GIF89a"))).toThrow(
    "静态",
  );
});
it("recognizes JPEG and lossless WebP geometry and rejects animated WebP", () => {
  const jpg = Uint8Array.from([
    255, 216, 255, 192, 0, 11, 8, 3, 132, 6, 64, 1, 1, 17, 0, 255, 218, 0, 2,
    255, 217,
  ]);
  expect(inspectImage(jpg)).toEqual({
    width: 1600,
    height: 900,
    type: "image/jpeg",
  });
  function webp(animated: boolean) {
    const b = new Uint8Array(30);
    b.set([..."RIFF"].map((c) => c.charCodeAt(0)));
    new DataView(b.buffer).setUint32(4, 22, true);
    b.set(
      [..."WEBPVP8X"].map((c) => c.charCodeAt(0)),
      8,
    );
    new DataView(b.buffer).setUint32(16, 10, true);
    b[20] = animated ? 2 : 0;
    b[24] = 255;
    b[25] = 1;
    b[27] = 255;
    b[28] = 1;
    return b;
  }
  expect(inspectImage(webp(false))).toEqual({
    width: 512,
    height: 512,
    type: "image/webp",
  });
  expect(() => inspectImage(webp(true))).toThrow("动态");
});
