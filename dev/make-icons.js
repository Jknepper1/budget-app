// Draws the app icon with no dependencies: three budget meters on a green square.
// Everything sits inside the center of the square so Android's icon mask can't clip it.
// Run: node dev/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BACKGROUND = [14, 102, 85];
const FILL = [255, 255, 255];
const TRACK = [62, 133, 118];

// Each bar is [center height, how full it is], as fractions of the icon.
const BARS = [[0.34, 0.86], [0.5, 0.52], [0.66, 0.7]];
const LEFT = 0.24;
const RIGHT = 0.76;
const HALF_HEIGHT = 0.052;

/** How far a point is inside a rounded bar: positive when inside, in pixels. */
function coverage(x, y, x0, x1, cy, radius) {
  const dx = Math.max(x0 + radius - x, x - (x1 - radius), 0);
  const dy = Math.abs(y - cy);
  return Math.min(1, Math.max(0, radius - Math.hypot(dx, dy) + 0.5));
}

function drawIcon(size) {
  const pixels = Buffer.alloc((size * 3 + 1) * size);
  const radius = HALF_HEIGHT * size;
  for (let py = 0; py < size; py++) {
    const rowStart = py * (size * 3 + 1);
    pixels[rowStart] = 0;
    for (let px = 0; px < size; px++) {
      const x = px + 0.5;
      const y = py + 0.5;
      let color = BACKGROUND;
      for (const [centerY, fullness] of BARS) {
        const cy = centerY * size;
        const start = LEFT * size;
        const end = RIGHT * size;
        const track = coverage(x, y, start, end, cy, radius);
        const fill = coverage(x, y, start, start + (end - start) * fullness, cy, radius);
        color = color.map((c, i) => c + (TRACK[i] - c) * track);
        color = color.map((c, i) => c + (FILL[i] - c) * fill);
      }
      const at = rowStart + 1 + px * 3;
      pixels[at] = Math.round(color[0]);
      pixels[at + 1] = Math.round(color[1]);
      pixels[at + 2] = Math.round(color[2]);
    }
  }
  return encodePng(size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 8 bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'docs', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-192.png'), drawIcon(192));
fs.writeFileSync(path.join(out, 'icon-512.png'), drawIcon(512));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), drawIcon(180));
console.log(`Icons written to ${out}`);
