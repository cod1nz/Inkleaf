'use strict';
// Deterministic fixture generator -> app/e2e/.fixtures (git-ignored). Usage: node e2e/make-fixtures.cjs [--no-large]
const fs = require('fs');
const path = require('path');
const APP = path.resolve(__dirname, '..');
const { PDFDocument, StandardFonts, rgb } = require(
  APP + '/node_modules/pdf-lib'
);
const { createCanvas } = require(APP + '/node_modules/@napi-rs/canvas');
const { writePdf, noiseFill } = require('./lib/minipdf.cjs');
const F = path.join(__dirname, '.fixtures');
const noLarge = process.argv.includes('--no-large');
fs.mkdirSync(F, { recursive: true });
const p = (...a) => path.join(F, ...a);
const SCAN_LINES = [
  [
    'Invoice number 2024 quarterly revenue',
    'Inkleaf document processing report',
  ],
  ['Total amount payable within thirty days', 'Thank you for your business'],
];

async function normal() {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const pg = d.addPage([612, 792]);
    pg.drawText(`Normal fixture page ${i} of 3`, {
      x: 56,
      y: 700,
      size: 24,
      font: f,
    });
    for (let l = 0; l < 25; l++)
      pg.drawText(`Line ${l} lorem ipsum dolor sit amet consectetur ${i}`, {
        x: 56,
        y: 660 - l * 20,
        size: 11,
        font: f,
        color: rgb(0.1, 0.1, 0.1),
      });
  }
  d.setTitle('Normal fixture');
  fs.writeFileSync(p('normal-3p.pdf'), await d.save());
  for (const [name, pages] of [
    ['second-2p.pdf', 2],
    ['third-1p.pdf', 1],
  ]) {
    const e = await PDFDocument.create();
    const ef = await e.embedFont(StandardFonts.TimesRoman);
    for (let i = 1; i <= pages; i++)
      e.addPage([595, 842]).drawText(`${name} page ${i}`, {
        x: 60,
        y: 700,
        size: 28,
        font: ef,
      });
    fs.writeFileSync(p(name), await e.save());
  }
}
function scannedPages() {
  return SCAN_LINES.map((lines, pi) => {
    const W = 2550,
      H = 3300;
    const c = createCanvas(W, H),
      g = c.getContext('2d');
    g.fillStyle = '#fbfbf8';
    g.fillRect(0, 0, W, H);
    g.save();
    g.translate(W / 2, H / 2);
    g.rotate(0.004 * (pi ? -1 : 1));
    g.translate(-W / 2, -H / 2);
    g.fillStyle = '#111';
    g.font = 'bold 90px Arial, sans-serif';
    lines.forEach((t, i) => g.fillText(t, 260, 420 + i * 200));
    g.font = '64px Arial, sans-serif';
    for (let i = 0; i < 8; i++)
      g.fillText(
        'Quarterly figures are listed below for review ' + (i + 1),
        260,
        1000 + i * 130
      );
    g.restore();
    let s = 12345 + pi;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const id = g.getImageData(0, 0, W, H);
    const dd = id.data;
    for (let i = 0; i < dd.length; i += 4) {
      const n = (rnd() - 0.5) * 36;
      dd[i] += n;
      dd[i + 1] += n;
      dd[i + 2] += n;
    }
    g.putImageData(id, 0, 0);
    return c.toBuffer('image/jpeg', 70);
  });
}
async function scanned() {
  const d = await PDFDocument.create();
  for (const jb of scannedPages()) {
    const im = await d.embedJpg(jb);
    const pg = d.addPage([612, 792]);
    pg.drawImage(im, { x: 0, y: 0, width: 612, height: 792 });
  }
  fs.writeFileSync(p('scanned-eng.pdf'), await d.save());
  fs.writeFileSync(
    p('scanned-ground-truth.json'),
    JSON.stringify(SCAN_LINES.flat())
  );
}
function images() {
  const c = createCanvas(800, 600),
    g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 800, 600);
  gr.addColorStop(0, '#2a6');
  gr.addColorStop(1, '#c42');
  g.fillStyle = gr;
  g.fillRect(0, 0, 800, 600);
  g.fillStyle = '#fff';
  g.font = '80px Arial';
  g.fillText('Inkleaf image', 100, 320);
  fs.writeFileSync(p('image.png'), c.toBuffer('image/png'));
  fs.writeFileSync(p('image.jpg'), c.toBuffer('image/jpeg', 85));
  fs.writeFileSync(p('image.webp'), c.toBuffer('image/webp', 80));
}
function encrypted() {
  const pages = [1, 2].map((i) => ({
    text: [`Encrypted fixture page ${i}`, 'secret content ALPHA'],
  }));
  writePdf(p('enc-user-pw.pdf'), pages, {
    userPw: 'open123',
    ownerPw: 'owner456',
  });
  writePdf(p('enc-owner-only.pdf'), pages, {
    userPw: '',
    ownerPw: 'owner456',
    P: -3904,
  });
}
function broken() {
  const good = fs.readFileSync(p('normal-3p.pdf'));
  fs.writeFileSync(
    p('broken-truncated.pdf'),
    good.subarray(0, Math.floor(good.length * 0.5))
  );
  fs.writeFileSync(
    p('broken-garbage-header.pdf'),
    Buffer.concat([Buffer.from('GARBAGE!!\n'), good.subarray(8)])
  );
  const s = good.toString('latin1');
  const i = s.lastIndexOf('startxref');
  fs.writeFileSync(
    p('broken-no-xref.pdf'),
    Buffer.from(s.slice(0, i), 'latin1')
  );
  fs.writeFileSync(p('broken-zero-bytes.pdf'), Buffer.alloc(0));
  fs.writeFileSync(
    p('broken-not-a-pdf.pdf'),
    'Hello, this is just a plain text file renamed to .pdf\n'.repeat(20)
  );
  fs.writeFileSync(
    p('broken-huge-pagecount.pdf'),
    Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 2000000000 /Kids [3 0 R] >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\ntrailer\n<< /Root 1 0 R /Size 4 >>\n%%EOF\n'
    )
  );
  fs.mkdirSync(p('dir-named.pdf'), { recursive: true });
}
function names() {
  const good = fs.readFileSync(p('second-2p.pdf'));
  const dir = p('names');
  fs.mkdirSync(dir, { recursive: true });
  const list = [
    'договор №5.pdf',
    '合同文件.pdf',
    'عقد.pdf',
    '📄 scan.pdf',
    'name with   spaces.pdf',
    "o'brien's file.pdf",
    'a & b.pdf',
    'file%20name.pdf',
    'dots.trailing.pdf',
    'x'.repeat(196) + '.pdf',
    '#hash;semi,comma.pdf',
    'ünïcödé-ñ.PDF',
  ];
  for (const n of list) fs.writeFileSync(path.join(dir, n), good);
  try {
    fs.writeFileSync('\\\\?\\' + path.join(dir, 'trailing..pdf.'), good);
  } catch {
    /* optional */
  }
}
function longpath() {
  const good = fs.readFileSync(p('normal-3p.pdf'));
  let d = p('longpath');
  while (d.length < 330)
    d = path.join(
      d,
      'a-very-long-directory-name-to-exceed-the-windows-max-path-limit'
    );
  fs.mkdirSync('\\\\?\\' + d, { recursive: true });
  const f = path.join(d, 'deep-file.pdf');
  fs.writeFileSync('\\\\?\\' + f, good);
  fs.writeFileSync(p('longpath-path.txt'), f);
}
function large() {
  if (noLarge) return;
  const pages = Array.from({ length: 36 }, (_, i) => ({
    text: [`large page ${i + 1}`],
    images: [{ w: 1400, h: 1400, fill: noiseFill(1000 + i) }],
  }));
  writePdf(p('large-noise-216mb.pdf'), pages);
  const many = Array.from({ length: 1000 }, (_, i) => ({
    text: [`Page ${i + 1} of 1000`, 'small text only'],
    w: 300,
    h: 400,
    size: 12,
  }));
  writePdf(p('pages-1000.pdf'), many);
}
(async () => {
  await normal();
  await scanned();
  images();
  encrypted();
  broken();
  names();
  longpath();
  large();
  for (const f of fs.readdirSync(F)) {
    try {
      const s = fs.statSync(p(f));
      console.log(f, s.isFile() ? (s.size / 1e6).toFixed(2) + ' MB' : 'dir');
    } catch {
      /* skip */
    }
  }
})();
