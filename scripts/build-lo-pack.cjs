'use strict';
// Deterministic add-on pack builder: node scripts/build-lo-pack.cjs [version]
// Files at zip root, fixed timestamps, sorted names. .gz/.wasm are stored, text is deflated.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const src = path.join(__dirname, '..', 'public', 'libreoffice-wasm');
const version = process.argv[2] || '1.0.0';
const out = path.join(
  __dirname,
  '..',
  'addon-build',
  `libreoffice-wasm-${version}.zip`
);
const FILES = [
  'browser.worker.global.js',
  'soffice.data.gz',
  'soffice.js',
  'soffice.wasm.gz',
  'soffice.worker.js',
];
const DOS_TIME = 0,
  DOS_DATE = (30 << 9) | (1 << 5) | 1; // 2010-01-01 00:00
fs.mkdirSync(path.dirname(out), { recursive: true });
const loc = [],
  cen = [];
let off = 0;
for (const n of FILES) {
  const data = fs.readFileSync(path.join(src, n));
  const crc = zlib.crc32(data);
  const deflate = n.endsWith('.js');
  const body = deflate ? zlib.deflateRawSync(data, { level: 9 }) : data;
  const method = deflate ? 8 : 0;
  const name = Buffer.from(n);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0x0800, 6);
  lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(DOS_TIME, 10);
  lh.writeUInt16LE(DOS_DATE, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(method, 10);
  ch.writeUInt16LE(DOS_TIME, 12);
  ch.writeUInt16LE(DOS_DATE, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(body.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt32LE(off, 42);
  loc.push(lh, name, body);
  cen.push(ch, name);
  off += 30 + name.length + body.length;
}
const cd = Buffer.concat(cen);
const e = Buffer.alloc(22);
e.writeUInt32LE(0x06054b50, 0);
e.writeUInt16LE(FILES.length, 8);
e.writeUInt16LE(FILES.length, 10);
e.writeUInt32LE(cd.length, 12);
e.writeUInt32LE(off, 16);
fs.writeFileSync(out, Buffer.concat([...loc, cd, e]));
const buf = fs.readFileSync(out);
console.log(
  JSON.stringify({
    out,
    sizeBytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  })
);
