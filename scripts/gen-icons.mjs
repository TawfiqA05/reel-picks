// Generates PNG app icons with zero dependencies (node:zlib for DEFLATE).
// Draws the Reel Picks mark (amber disc, dark play triangle) on the navy
// tile for the app icons, and the iPhone launch screens.
import zlib from 'node:zlib';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('../public/icons/', import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression, filter, interlace = 0

  // filtered raw: each scanline prefixed with filter byte 0 (none)
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function sign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// Midnight marquee: an amber disc with a dark play mark on the night-navy tile.
const TILE = hex('#0f1526');
const DISC = hex('#f2a93b');
const MARK = hex('#1a1206');
const CREAM = hex('#f2eadb');

// The mark centred in a w x h canvas on `bg`, the disc `r` px across its
// radius. Each pixel is sampled 4 x 4 times, so the edges are smooth.
function draw(w, h, r, bg) {
  const rgba = Buffer.alloc(w * h * 4);
  const cx = w / 2; const cy = h / 2;
  // Play triangle, in units of the disc radius (from the SVG).
  const ax = cx - r * 0.228; const ay = cy - r * 0.456;
  const bx = ax; const by = cy + r * 0.456;
  const tx = cx + r * 0.5; const ty = cy;
  const x0 = Math.floor(cx - r - 2); const x1 = Math.ceil(cx + r + 2);
  const y0 = Math.floor(cy - r - 2); const y1 = Math.ceil(cy + r + 2);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = bg[0]; rgba[i * 4 + 1] = bg[1]; rgba[i * 4 + 2] = bg[2]; rgba[i * 4 + 3] = 255; }
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      let sr = 0; let sg = 0; let sb = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const px = x + (sx + 0.5) / 4; const py = y + (sy + 0.5) / 4;
        const inDisc = (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
        const d1 = sign(px, py, ax, ay, bx, by); const d2 = sign(px, py, bx, by, tx, ty); const d3 = sign(px, py, tx, ty, ax, ay);
        const inMark = !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
        const c = inDisc ? (inMark ? MARK : DISC) : bg;
        sr += c[0]; sg += c[1]; sb += c[2];
      }
      const i = (y * w + x) * 4;
      rgba[i] = Math.round(sr / 16); rgba[i + 1] = Math.round(sg / 16); rgba[i + 2] = Math.round(sb / 16);
    }
  }
  return rgba;
}

const icons = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  // Maskable: the mark stays inside the safe circle (80% of the tile).
  { name: 'maskable-512.png', size: 512, scale: 0.3 },
  { name: 'apple-touch-icon.png', size: 180 },
];
for (const t of icons) {
  const png = encodePng(t.size, t.size, draw(t.size, t.size, t.size * (t.scale || 0.36), TILE));
  fs.writeFileSync(outDir + t.name, png);
  console.log(`  ✓ ${t.name} (${png.length} bytes)`);
}

// iPhone launch screens for the installed app (apple-touch-startup-image in
// index.html): navy in dark mode, cream in light, the mark in the middle.
// One per screen size, in device pixels, portrait.
const LAUNCH = [
  [440, 956, 3], [402, 874, 3], [430, 932, 3], [393, 852, 3], [390, 844, 3], [428, 926, 3],
  [375, 812, 3], [414, 896, 3], [414, 896, 2], [375, 667, 2], [320, 568, 2],
];
fs.mkdirSync(`${outDir}launch/`, { recursive: true });
for (const [w, h, dpr] of LAUNCH) {
  for (const [theme, bg] of [['dark', TILE], ['light', CREAM]]) {
    const W = w * dpr; const H = h * dpr;
    const png = encodePng(W, H, draw(W, H, 40 * dpr, bg));
    fs.writeFileSync(`${outDir}launch/launch-${w}x${h}@${dpr}-${theme}.png`, png);
  }
}
console.log(`  ✓ ${LAUNCH.length * 2} launch screens in icons/launch/`);
console.log('Icons written to public/icons/');
