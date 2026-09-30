/** Original square-crop model, expressed only in orientation-corrected source pixels. */
export interface Crop {
  width: number;
  height: number;
  cx: number;
  cy: number;
  zoom: number;
}
const clamp = (x: number, min: number, max: number) =>
  Math.min(max, Math.max(min, x));
function bounded(crop: Crop): Crop {
  const half = Math.min(crop.width, crop.height) / (2 * crop.zoom);
  return {
    ...crop,
    cx: clamp(crop.cx, half, crop.width - half),
    cy: clamp(crop.cy, half, crop.height - half),
  };
}
export function createCrop(width: number, height: number): Crop {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw Error("图片尺寸无效");
  return { width, height, cx: width / 2, cy: height / 2, zoom: 1 };
}
export function cropRect(crop: Crop) {
  const size = Math.min(crop.width, crop.height) / crop.zoom;
  return { x: crop.cx - size / 2, y: crop.cy - size / 2, size };
}
export function panCrop(
  crop: Crop,
  dx: number,
  dy: number,
  viewport: number,
): Crop {
  if (![dx, dy, viewport].every(Number.isFinite) || viewport <= 0) return crop;
  const scale = cropRect(crop).size / viewport;
  return bounded({
    ...crop,
    cx: crop.cx - dx * scale,
    cy: crop.cy - dy * scale,
  });
}
export function zoomCrop(
  crop: Crop,
  zoom: number,
  anchorX = 0.5,
  anchorY = 0.5,
): Crop {
  if (![zoom, anchorX, anchorY].every(Number.isFinite)) return crop;
  zoom = clamp(zoom, 1, 8);
  const oldSize = cropRect(crop).size,
    newSize = Math.min(crop.width, crop.height) / zoom;
  return bounded({
    ...crop,
    zoom,
    cx: crop.cx + (clamp(anchorX, 0, 1) - 0.5) * (oldSize - newSize),
    cy: crop.cy + (clamp(anchorY, 0, 1) - 0.5) * (oldSize - newSize),
  });
}
export function drawCrop(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  crop: Crop,
  size = 512,
) {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("浏览器无法创建图像画布");
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const r = cropRect(crop);
  ctx.drawImage(image, r.x, r.y, r.size, r.size, 0, 0, size, size);
}
export async function exportCrop(
  image: CanvasImageSource,
  crop: Crop,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  drawCrop(canvas, image, crop, 512);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(Error("无法导出头像，请换一张图片"))),
      "image/png",
    ),
  );
  if (blob.size > 2 * 1024 * 1024)
    throw Error("导出头像超过2MiB，请选择其他图片");
  return blob;
}
