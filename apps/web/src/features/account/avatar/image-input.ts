export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 40_000_000,
  MAX_SIDE = 16384;
type ImageInfo = {
  width: number;
  height: number;
  type: "image/png" | "image/jpeg" | "image/webp";
};
function dimensions(info: ImageInfo) {
  if (
    info.width < 1 ||
    info.height < 1 ||
    info.width > MAX_SIDE ||
    info.height > MAX_SIDE
  )
    throw Error("图片尺寸超限，任一边不能超过16384像素");
  if (info.width * info.height > MAX_PIXELS)
    throw Error("图片超过4000万像素，请先缩小原图");
  return info;
}
export function inspectImage(bytes: Uint8Array): ImageInfo {
  if (bytes.length > MAX_SOURCE_BYTES) throw Error("原图不能超过10MiB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  const invalid = () => new Error("图片结构不完整或格式无效");
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
  ) {
    if (text(12, 4) !== "IHDR" || view.getUint32(8) !== 13) throw invalid();
    const info = dimensions({
      width: view.getUint32(16),
      height: view.getUint32(20),
      type: "image/png",
    });
    let p = 8,
      ended = false;
    while (p < bytes.length) {
      if (p + 12 > bytes.length) throw invalid();
      const length = view.getUint32(p),
        type = text(p + 4, 4);
      if (p + 12 + length > bytes.length) throw invalid();
      if (["acTL", "fcTL", "fdAT"].includes(type))
        throw Error("不支持动态PNG，请使用静态图片");
      p += 12 + length;
      if (type === "IEND") {
        ended = true;
        break;
      }
    }
    if (!ended || p !== bytes.length) throw invalid();
    return info;
  }
  if (bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
    if (view.getUint32(4, true) + 8 !== bytes.length) throw invalid();
    let p = 12,
      width = 0,
      height = 0;
    while (p < bytes.length) {
      if (p + 8 > bytes.length) throw invalid();
      const type = text(p, 4),
        length = view.getUint32(p + 4, true),
        data = p + 8;
      if (data + length > bytes.length) throw invalid();
      if (
        type === "ANIM" ||
        type === "ANMF" ||
        (type === "VP8X" && bytes[data] & 2)
      )
        throw Error("不支持动态WebP，请使用静态图片");
      if (type === "VP8X" && length >= 10) {
        width =
          1 + bytes[data + 4] + bytes[data + 5] * 256 + bytes[data + 6] * 65536;
        height =
          1 + bytes[data + 7] + bytes[data + 8] * 256 + bytes[data + 9] * 65536;
      } else if (
        !width &&
        type === "VP8 " &&
        length >= 10 &&
        bytes[data + 3] === 0x9d &&
        bytes[data + 4] === 1 &&
        bytes[data + 5] === 0x2a
      ) {
        width = view.getUint16(data + 6, true) & 0x3fff;
        height = view.getUint16(data + 8, true) & 0x3fff;
      } else if (
        !width &&
        type === "VP8L" &&
        length >= 5 &&
        bytes[data] === 0x2f
      ) {
        width = 1 + ((bytes[data + 1] | (bytes[data + 2] << 8)) & 0x3fff);
        height =
          1 +
          (((bytes[data + 2] >> 6) |
            (bytes[data + 3] << 2) |
            (bytes[data + 4] << 10)) &
            0x3fff);
      }
      p = data + length + (length % 2);
    }
    if (p !== bytes.length || !width || !height) throw invalid();
    return dimensions({ width, height, type: "image/webp" });
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let p = 2,
      width = 0,
      height = 0;
    while (p + 4 <= bytes.length) {
      if (bytes[p++] !== 255) throw invalid();
      while (bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (marker === 0xda) break;
      if (marker === 0xd9) break;
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      const length = view.getUint16(p);
      if (length < 2 || p + length > bytes.length) throw invalid();
      if (marker === 0xe2 && text(p + 2, 4) === "MPF\0")
        throw Error("不支持多帧JPEG，请使用静态图片");
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (length < 8) throw invalid();
        height = view.getUint16(p + 3);
        width = view.getUint16(p + 5);
      }
      p += length;
    }
    if (!width || !height) throw invalid();
    return dimensions({ width, height, type: "image/jpeg" });
  }
  throw Error("请选择静态JPG、PNG或WebP图片，不支持GIF、SVG和动态图");
}
export async function decodeAvatar(file: File): Promise<ImageBitmap> {
  if (file.size > MAX_SOURCE_BYTES) throw Error("原图不能超过10MiB");
  inspectImage(new Uint8Array(await file.arrayBuffer()));
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw Error("无法解码图片，请选择完整的静态JPG、PNG或WebP");
  }
  try {
    dimensions({
      width: bitmap.width,
      height: bitmap.height,
      type: "image/png",
    });
  } catch (error) {
    bitmap.close();
    throw error;
  }
  return bitmap;
}
