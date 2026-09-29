import { deflateSync } from "node:zlib";
export function chunk(type, data) {
  const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte;
    for (let i=0;i<8;i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const sum = Buffer.alloc(4); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, sum]);
}
// Independent, synthetic RGBA fixtures; no user photographs or network assets.
export function png(width = 512, height = 512, { noisy = false, alpha = 96, marker = "", animated = false } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8]=8; header[9]=6;
  const pixels = Buffer.alloc((width*4+1)*height);
  let seed = 0x12345678;
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const start = y*(width*4+1)+1+x*4;
    for (let c=0;c<3;c++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      pixels[start+c] = noisy ? seed & 255 : [220,80,30][c];
    }
    pixels[start+3]=alpha;
  }
  const extra = [];
  if (marker) extra.push(chunk("tEXt",Buffer.from(`Comment\0${marker}`)));
  if (animated) { const control=Buffer.alloc(8); control.writeUInt32BE(2); extra.push(chunk("acTL",control)); }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),...extra,chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]);
}
