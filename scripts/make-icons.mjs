#!/usr/bin/env node
/**
 * Generates build/icon.svg, icon.png (1024), icon.ico (16..256) and icon.icns with pure Node
 * (own rasterizer + zlib PNG encoder, no native deps). Mirrors logoMark() in src/desktop/icons.ts:
 * accent (#2563eb) rounded tile with a white two-stroke leaf. Run: node scripts/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'build'
);
fs.mkdirSync(out, { recursive: true });

const ACCENT = [0x25, 0x63, 0xeb];
// Cubic beziers in the 24x24 logo space: [p0, c1, c2, p1]
const CURVES = [
  [
    [6.4, 17.6],
    [6.4, 11.4],
    [10, 7.2],
    [17.6, 6.4],
  ],
  [
    [17.6, 6.4],
    [17.4, 13.6],
    [13.4, 17.4],
    [8.2, 17.0],
  ],
  [
    [6.4, 17.6],
    [8.1, 14.4],
    [10.1, 12.2],
    [13, 10.6],
  ],
];
const HALF_W = 0.8;
const RADIUS = 6.5;

const segs = [];
for (const [p0, c1, c2, p1] of CURVES) {
  let prev = p0;
  for (let i = 1; i <= 48; i++) {
    const t = i / 48,
      u = 1 - t;
    const p = [0, 1].map(
      (k) =>
        u * u * u * p0[k] +
        3 * u * u * t * c1[k] +
        3 * u * t * t * c2[k] +
        t * t * t * p1[k]
    );
    segs.push([prev, p]);
    prev = p;
  }
}

function distSeg(px, py, [a, b]) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy))
  );
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function inTile(x, y) {
  const cx = Math.min(Math.max(x, RADIUS), 24 - RADIUS),
    cy = Math.min(Math.max(y, RADIUS), 24 - RADIUS);
  return Math.hypot(x - cx, y - cy) <= RADIUS;
}

/** Returns RGBA (non-premultiplied) Buffer of size*size, 3x3 supersampled. */
function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 3,
    k = 24 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tile = 0,
        leaf = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) * k,
            py = (y + (sy + 0.5) / SS) * k;
          if (!inTile(px, py)) continue;
          tile++;
          if (segs.some((s) => distSeg(px, py, s) <= HALF_W)) leaf++;
        }
      }
      const n = SS * SS,
        o = (y * size + x) * 4;
      if (!tile) continue;
      const f = leaf / tile;
      for (let c = 0; c < 3; c++)
        buf[o + c] = Math.round(ACCENT[c] * (1 - f) + 255 * f);
      buf[o + 3] = Math.round((tile / n) * 255);
    }
  }
  return buf;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Box-downscale by integer factor (premultiplied-correct). */
function downscale(src, size, f) {
  const n = size / f,
    dst = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let j = 0; j < f; j++)
        for (let i = 0; i < f; i++) {
          const o = ((y * f + j) * size + x * f + i) * 4,
            al = src[o + 3];
          r += src[o] * al;
          g += src[o + 1] * al;
          b += src[o + 2] * al;
          a += al;
        }
      const o = (y * n + x) * 4;
      if (a) {
        dst[o] = Math.round(r / a);
        dst[o + 1] = Math.round(g / a);
        dst[o + 2] = Math.round(b / a);
      }
      dst[o + 3] = Math.round(a / (f * f));
    }
  return dst;
}

// Render natively at small sizes (crisper) and 1024 for large.
const cache = new Map();
const rgbaFor = (s) =>
  cache.has(s) ? cache.get(s) : (cache.set(s, render(s)), cache.get(s));
const pngFor = (s) => png(rgbaFor(s), s);

fs.writeFileSync(path.join(out, 'icon.png'), pngFor(1024));

// ICO: BMP entries below 256, PNG for 256.
function bmpEntry(s) {
  const rgba = rgbaFor(s);
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(s, 4);
  hdr.writeInt32LE(s * 2, 8);
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(s * s * 4, 20);
  const px = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const i = ((s - 1 - y) * s + x) * 4,
        o = (y * s + x) * 4;
      px[o] = rgba[i + 2];
      px[o + 1] = rgba[i + 1];
      px[o + 2] = rgba[i];
      px[o + 3] = rgba[i + 3];
    }
  const maskRow = Math.ceil(s / 32) * 4;
  return Buffer.concat([hdr, px, Buffer.alloc(maskRow * s)]);
}
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoImgs = icoSizes.map((s) => (s === 256 ? pngFor(256) : bmpEntry(s)));
const dir = Buffer.alloc(6 + 16 * icoSizes.length);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(icoSizes.length, 4);
let off = dir.length;
icoSizes.forEach((s, i) => {
  const o = 6 + i * 16;
  dir[o] = s === 256 ? 0 : s;
  dir[o + 1] = s === 256 ? 0 : s;
  dir.writeUInt16LE(1, o + 4);
  dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(icoImgs[i].length, o + 8);
  dir.writeUInt32LE(off, o + 12);
  off += icoImgs[i].length;
});
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([dir, ...icoImgs]));

// ICNS: PNG payloads.
const icnsTypes = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
];
const big = rgbaFor(1024);
const icnsParts = icnsTypes.map(([t, s]) => {
  const data = s === 512 ? png(downscale(big, 1024, 2), 512) : pngFor(s);
  const h = Buffer.alloc(8);
  h.write(t, 0);
  h.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([h, data]);
});
const body = Buffer.concat(icnsParts);
const ih = Buffer.alloc(8);
ih.write('icns', 0);
ih.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(path.join(out, 'icon.icns'), Buffer.concat([ih, body]));

fs.writeFileSync(
  path.join(out, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 24 24"><rect width="24" height="24" rx="6.5" fill="#2563eb"/><path d="M6.4 17.6c0-6.2 3.6-10.4 11.2-11.2-.2 7.2-4.2 11-9.4 10.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.4 17.6c1.7-3.2 3.7-5.4 6.6-7" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>\n`
);
console.log('icons written to', out);
