// Writes src/public/icon/{16,32,48,128}.png: a solid rounded square in Keep
// yellow. Hand-rolled PNG so the repo needs no image dependency.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const COLOR = [251, 188, 4]; // #fbbc04
const INK = [32, 33, 36]; // #202124, the bar of the "note"

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcTable = (chunk.table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crcBuf]);
}

function png(size) {
  const radius = size * 0.22;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0]; // filter: none
    for (let x = 0; x < size; x++) {
      // rounded-corner test
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const outside = Math.hypot(dx, dy) > radius;
      // two ink lines suggesting written text
      const line =
        !outside &&
        x > size * 0.24 &&
        x < size * 0.76 &&
        ((y > size * 0.36 && y < size * 0.45) || (y > size * 0.55 && y < size * 0.64));
      const [r, g, b] = line ? INK : COLOR;
      row.push(r, g, b, outside ? 0 : 255);
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('src/public/icon', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(`src/public/icon/${size}.png`, png(size));
  console.log(`src/public/icon/${size}.png`);
}
