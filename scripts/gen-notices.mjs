#!/usr/bin/env node
/**
 * Generates public/third-party-notices.html (shipped in the desktop dist, linked from About).
 * Sources: package-lock.json (non-dev packages) + node_modules/<pkg>/package.json for license and
 * repository, plus hand-written entries for the bundled wasm/native components that are not npm deps.
 * Run by `npm run build:desktop`. No network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(
  fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')
);
const assetLock = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts/desktop-assets.lock.json'), 'utf8')
);

// Keep in sync with src/desktop/app-info.ts
const SOURCE_URL = 'https://github.com/st1ne/Inkleaf';
const UPSTREAM_URL = 'https://github.com/alam00000/bentopdf';

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]
  );

function cleanRepo(r) {
  let u = typeof r === 'string' ? r : r?.url;
  if (!u) return '';
  u = u
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/\.git$/, '');
  if (/^github:/.test(u)) u = 'https://github.com/' + u.slice(7);
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) u = 'https://github.com/' + u;
  return /^https?:\/\//.test(u) ? u : '';
}

function licenseOf(j) {
  const l = j.license ?? j.licenses;
  if (!l) return 'See package';
  if (typeof l === 'string') return l;
  if (Array.isArray(l))
    return l.map((x) => (typeof x === 'string' ? x : x.type)).join(' OR ');
  return l.type || 'See package';
}

const rows = new Map();
for (const [key, v] of Object.entries(lock.packages)) {
  if (!key || v.dev) continue;
  const name = key.slice(
    key.lastIndexOf('node_modules/') + 'node_modules/'.length
  );
  let j;
  try {
    j = JSON.parse(
      fs.readFileSync(path.join(root, key, 'package.json'), 'utf8')
    );
  } catch {
    continue; // optional / not installed on this platform
  }
  const version = j.version || v.version || '';
  const id = `${name}@${version}`;
  if (!rows.has(id))
    rows.set(id, {
      name,
      version,
      license: licenseOf(j),
      repo: cleanRepo(j.repository) || cleanRepo(j.homepage),
    });
}
const npmRows = [...rows.values()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
);

const ver = (k) =>
  (Object.keys(assetLock.artifacts).find((a) => a.startsWith(k + '@')) || '')
    .split('@')
    .pop();

const bundled = [
  {
    name: 'PyMuPDF (as WebAssembly, @bentopdf/pymupdf-wasm)',
    version: ver('pymupdf-wasm') + ' (PyMuPDF 1.26.3)',
    license: 'AGPL-3.0',
    repo: 'https://github.com/pymupdf/PyMuPDF',
    note: 'Copyright Artifex Software, Inc. Also available under a commercial license from Artifex.',
  },
  {
    name: 'MuPDF (inside PyMuPDF)',
    version: '',
    license: 'AGPL-3.0',
    repo: 'https://github.com/ArtifexSoftware/mupdf',
    note: 'Copyright Artifex Software, Inc.',
  },
  {
    name: 'Ghostscript (as WebAssembly, @bentopdf/gs-wasm)',
    version: ver('gs-wasm'),
    license: 'AGPL-3.0',
    repo: 'https://ghostscript.com/',
    note: 'Copyright Artifex Software, Inc. Source: https://git.ghostscript.com/',
  },
  {
    name: 'Pyodide (Python runtime for PyMuPDF)',
    version: '',
    license: 'MPL-2.0',
    repo: 'https://github.com/pyodide/pyodide',
    note: 'CPython is under the PSF License.',
  },
  {
    name: 'NumPy, lxml, fonttools, python-docx (Pyodide wheels)',
    version: '',
    license: 'BSD-3-Clause (NumPy, lxml), MIT (fonttools, python-docx)',
    repo: 'https://github.com/numpy/numpy',
    note: '',
  },
  {
    name: 'OpenCV for Python (Pyodide wheel)',
    version: '4.11.0.86',
    license: 'Apache-2.0 (OpenCV), MIT (packaging)',
    repo: 'https://github.com/opencv/opencv-python',
    note: '',
  },
  {
    name: 'pdf2docx (Pyodide wheel)',
    version: '0.5.8',
    license: 'GPL-3.0',
    repo: 'https://github.com/dothinking/pdf2docx',
    note: 'Used only for PDF to Word conversion.',
  },
  {
    name: 'CoherentPDF (cpdf), JavaScript build',
    version: ver('coherentpdf'),
    license: 'See upstream (commercial / non-commercial dual license)',
    repo: 'https://github.com/coherentgraphics/cpdf-binaries',
    note: 'Copyright Coherent Graphics Ltd. Verify the license terms for your distribution before release.',
  },
  {
    name: 'LibreOffice (optional add-on, downloaded only on explicit user request)',
    version: '',
    license: 'MPL-2.0 (with component licenses, see upstream)',
    repo: 'https://www.libreoffice.org/about-us/source-code/',
    note: 'Not part of the installer. The WebAssembly build is by @matbee/libreoffice-converter.',
  },
  {
    name: 'Tesseract OCR (WebAssembly core, tesseract.js-core)',
    version: ver('tesseract.js-core'),
    license: 'Apache-2.0',
    repo: 'https://github.com/tesseract-ocr/tesseract',
    note: '',
  },
  {
    name: 'Tesseract English trained data (tessdata_best, integer model)',
    version: '4.0.0',
    license: 'Apache-2.0',
    repo: 'https://github.com/tesseract-ocr/tessdata_best',
    note: '',
  },
  {
    name: 'PDFium (via bentopdf-pdfium)',
    version: '',
    license: 'BSD-3-Clause / Apache-2.0 (PDFium); wrapper AGPL-3.0',
    repo: 'https://pdfium.googlesource.com/pdfium/',
    note: '',
  },
  {
    name: 'PDF.js',
    version: '',
    license: 'Apache-2.0',
    repo: 'https://github.com/mozilla/pdf.js',
    note: 'Viewer assets under pdfjs-viewer/ and pdfjs-annotation-viewer/.',
  },
  {
    name: 'Noto fonts (editor and OCR fallback fonts)',
    version: '',
    license: 'OFL-1.1',
    repo: 'https://github.com/notofonts',
    note: 'Noto Sans, Noto Sans CJK (JP, KR, SC, TC), Noto Naskh Arabic, Noto Sans Hebrew.',
  },
];

const link = (u) =>
  `<a href="${esc(u)}" rel="noopener noreferrer" target="_blank">${esc(u.replace(/^https?:\/\//, ''))}</a>`;
const rowHtml = (r) =>
  `<tr><td>${esc(r.name)}</td><td>${esc(r.version)}</td><td>${esc(r.license)}</td><td>${r.repo ? link(r.repo) : ''}${
    r.note ? `<br><small>${esc(r.note)}</small>` : ''
  }</td></tr>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Third-party notices - Inkleaf</title>
<style>
  :root { color-scheme: light dark; --fg:#1b1d21; --bg:#fff; --mut:#5d6370; --line:#d9dce2; --acc:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8eaee; --bg:#16171a; --mut:#9aa1ae; --line:#34373f; --acc:#7aa2ff; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:960px; margin:0 auto; padding:32px 24px 64px; }
  h1 { font-size:20px; } h2 { font-size:16px; margin-top:32px; }
  a { color:var(--acc); } small, .mut { color:var(--mut); }
  table { border-collapse:collapse; width:100%; margin-top:8px; }
  th, td { text-align:left; vertical-align:top; padding:6px 8px; border-bottom:1px solid var(--line); word-break:break-word; }
  th { font-weight:600; }
</style>
</head>
<body>
<main>
<p><a href="/desktop.html">Back to Inkleaf</a></p>
<h1>Third-party notices</h1>
<p>Inkleaf is free software licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only). It is based on
${link(UPSTREAM_URL)} (BentoPDF by alam00000, AGPL-3.0-only); thank you to its authors and contributors.</p>
<h2>Source code offer</h2>
<p>As required by the AGPL-3.0, the complete corresponding source code of this program, including the build scripts, is available to every user at
${link(SOURCE_URL)}.
If you received this program without access to that address, contact the distributor, who must provide the source on request.</p>
<p class="mut">Inkleaf makes no network connections while processing files. All components below run locally.</p>
<h2>Bundled components (WebAssembly and native)</h2>
<table><thead><tr><th>Component</th><th>Version</th><th>License</th><th>Source</th></tr></thead><tbody>
${bundled.map(rowHtml).join('\n')}
</tbody></table>
<h2>JavaScript packages (${npmRows.length})</h2>
<p class="mut">Generated from package-lock.json (production dependencies installed at build time). Full license texts ship in each package. Electron and Chromium licenses are in the application's LICENSE files.</p>
<table><thead><tr><th>Package</th><th>Version</th><th>License</th><th>Repository</th></tr></thead><tbody>
${npmRows.map(rowHtml).join('\n')}
</tbody></table>
</main>
</body>
</html>
`;

fs.writeFileSync(path.join(root, 'public/third-party-notices.html'), html);
console.log(
  `third-party-notices.html: ${npmRows.length} npm packages, ${bundled.length} bundled components`
);
