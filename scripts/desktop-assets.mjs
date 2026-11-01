#!/usr/bin/env node
/**
 * Inkleaf desktop asset preparation (PLAN.md D2/D8).
 *
 * Populates app/public/{wasm,tesseract,fonts}/ so the desktop build is fully
 * offline at runtime. Build-time network access is allowed here (once); every
 * downloaded or locally supplied artifact is checked against a pinned SHA-256
 * in scripts/desktop-assets.lock.json and cached in app/.cache-assets/.
 *
 * Layout produced (matches the __DESKTOP__ paths in the renderer):
 *   public/wasm/pymupdf/   <- @bentopdf/pymupdf-wasm tarball (package root)
 *   public/wasm/gs/        <- @bentopdf/gs-wasm tarball (package/assets/*)
 *   public/wasm/cpdf/      <- coherentpdf tarball (package/dist/*)
 *   public/tesseract/worker.min.js   <- tesseract.js dist/worker.min.js
 *   public/tesseract/core/           <- tesseract.js-core package
 *   public/tesseract/lang/eng.traineddata.gz
 *   public/fonts/ocr/<file>          <- Noto fonts (upstream URLs read from
 *                                       src/js/config/font-mappings.ts)
 *   public/fonts/editor/<pkg>/fonts/ <- @embedpdf/fonts-* tarballs
 *
 * Usage:
 *   node scripts/desktop-assets.mjs [--ocr-fonts=all|latin] [--force] [--offline]
 *     --ocr-fonts=latin (default) fetch only "Noto Sans" (English OCR layer);
 *                       "all" fetches every family in font-mappings.ts.
 *     --force           re-extract even if the stamp says up to date.
 *     --offline         never touch the network; fail if something is not cached.
 *   Run with --update-lock to re-record hashes after an intentional version bump.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, '.cache-assets');
const publicDir = path.join(root, 'public');
const lockPath = path.join(root, 'scripts', 'desktop-assets.lock.json');
const stampPath = path.join(cacheDir, 'stamp.json');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const OFFLINE = args.has('--offline');
const UPDATE_LOCK = args.has('--update-lock');
const OCR_FONTS =
  [...args].find((a) => a.startsWith('--ocr-fonts='))?.split('=')[1] ?? 'latin';

const TESSDATA_VERSION = '4.0.0_best_int';
const CPDF_VERSION = '2.5.5';
const EMBEDPDF_FONT_VERSION = '1.0.0';
const EMBEDPDF_FONT_PACKS = [
  'fonts-jp',
  'fonts-kr',
  'fonts-sc',
  'fonts-tc',
  'fonts-arabic',
  'fonts-hebrew',
  'fonts-latin',
];

const log = (m) => console.log(`[desktop-assets] ${m}`);
const fail = (m) => {
  console.error(`[desktop-assets] ERROR: ${m}`);
  process.exit(1);
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (p, fallback) =>
  fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;

const lock = readJson(lockPath, { version: 1, artifacts: {} });
let lockDirty = false;

fs.mkdirSync(cacheDir, { recursive: true });

function packageLockVersion(name) {
  const pl = readJson(path.join(root, 'package-lock.json'), { packages: {} });
  const v = pl.packages?.[`node_modules/${name}`]?.version;
  if (!v) fail(`cannot find ${name} version in package-lock.json`);
  return v;
}

function pinnedVersionFromSource(key) {
  const src = fs.readFileSync(
    path.join(root, 'src/js/const/cdn-version.ts'),
    'utf8'
  );
  const m = new RegExp(`${key}:\\s*'([^']+)'`).exec(src);
  if (!m) fail(`cannot read ${key} version from src/js/const/cdn-version.ts`);
  return m[1];
}

/** Verify (or first-time record) the hash of an artifact. */
function checkHash(key, buf, source) {
  const digest = sha256(buf);
  const entry = lock.artifacts[key];
  if (!entry || UPDATE_LOCK) {
    lock.artifacts[key] = { sha256: digest, size: buf.length, source };
    lockDirty = true;
    log(`recorded ${key} sha256=${digest.slice(0, 12)}...`);
  } else if (entry.sha256 !== digest) {
    fail(
      `SHA-256 mismatch for ${key}\n  expected ${entry.sha256}\n  actual   ${digest}\n` +
        '  (re-run with --update-lock only after reviewing the change)'
    );
  }
}

async function download(url) {
  if (OFFLINE) fail(`--offline set but ${url} is not cached`);
  log(`download ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Get an artifact: local candidates first, then cache, then network.
 * Always hash-verified; downloads are cached under .cache-assets/.
 */
async function getArtifact(key, fileName, url, localCandidates = []) {
  const cached = path.join(cacheDir, fileName);
  for (const candidate of [...localCandidates, cached]) {
    if (candidate && fs.existsSync(candidate)) {
      const buf = fs.readFileSync(candidate);
      checkHash(key, buf, url);
      return buf;
    }
  }
  const buf = await download(url);
  checkHash(key, buf, url);
  fs.writeFileSync(cached, buf);
  return buf;
}

/** Minimal, traversal-safe tar.gz reader (ustar, GNU long names, pax skipped). */
function untgz(buf) {
  const tar = zlib.gunzipSync(buf);
  const files = new Map();
  let off = 0;
  let longName = null;
  const str = (s, e) => tar.toString('utf8', s, e).replace(/\0.*$/s, '');
  while (off + 512 <= tar.length) {
    if (tar.every((b, i) => i < off || i >= off + 512 || b === 0)) break;
    let name = str(off, off + 100);
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8);
    const type = String.fromCharCode(tar[off + 156] || 48);
    const prefix = str(off + 345, off + 500);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = off + 512;
    if (type === 'L') {
      longName = str(dataStart, dataStart + size);
    } else if (type === '0' || type === '\0') {
      const n = longName ?? name;
      longName = null;
      files.set(n, tar.subarray(dataStart, dataStart + size));
    } else {
      longName = null; // directories, pax headers (x/g), links: ignored
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function safeJoin(base, rel) {
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    fail(`archive path escapes target directory: ${rel}`);
  }
  return target;
}

function writeFiles(destDir, entries) {
  const base = path.resolve(destDir);
  for (const [rel, data] of entries) {
    const out = safeJoin(base, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
}

/** Select files below `prefix` (npm tarballs use "package/") and re-root them. */
function selectUnder(files, prefix) {
  const out = [];
  for (const [name, data] of files) {
    if (name.startsWith(prefix)) out.push([name.slice(prefix.length), data]);
  }
  return out;
}

const resetDir = (d) => {
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
};

function npmTarballUrl(name, version) {
  const base = name.split('/').pop();
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

function parseOcrFontManifest() {
  const src = fs.readFileSync(
    path.join(root, 'src/js/config/font-mappings.ts'),
    'utf8'
  );
  const section = src.split('export const fontFamilyToUrl')[1] ?? '';
  const re = /'(Noto [^']+)':\s*'(https:\/\/[^']+)'/g;
  const out = [];
  let m;
  while ((m = re.exec(section)) !== null) {
    out.push({ family: m[1], url: m[2], file: m[2].split('/').pop() });
  }
  if (out.length < 27) fail(`expected 27 OCR font URLs, found ${out.length}`);
  return OCR_FONTS === 'all'
    ? out
    : out.filter((f) => f.family === 'Noto Sans');
}

async function main() {
  const pymupdfVer = pinnedVersionFromSource('pymupdf');
  const gsVer = pinnedVersionFromSource('ghostscript');
  const tessVer = packageLockVersion('tesseract.js');
  const tessCoreVer = packageLockVersion('tesseract.js-core');
  const ocrFonts = parseOcrFontManifest();

  const stampKey = JSON.stringify({
    pymupdfVer,
    gsVer,
    tessVer,
    tessCoreVer,
    CPDF_VERSION,
    TESSDATA_VERSION,
    EMBEDPDF_FONT_VERSION,
    ocr: ocrFonts.map((f) => f.file),
  });
  const prevStamp = readJson(stampPath, {});
  const outputsPresent = [
    'wasm/pymupdf',
    'wasm/gs',
    'wasm/cpdf',
    'tesseract/worker.min.js',
    'tesseract/core',
    'tesseract/lang/eng.traineddata.gz',
    'fonts/ocr',
    'fonts/editor',
  ].every((p) => fs.existsSync(path.join(publicDir, p)));
  if (!FORCE && !UPDATE_LOCK && outputsPresent && prevStamp.key === stampKey) {
    log('up to date (use --force to rebuild)');
    return;
  }

  const bundleDir = path.join(root, 'bentopdf-airgap-bundle');
  const vendorDir = path.join(root, 'vendor');

  // --- PyMuPDF (package root -> wasm/pymupdf, dist/ + assets/ at root) ------
  {
    const name = `bentopdf-pymupdf-wasm-${pymupdfVer}.tgz`;
    const buf = await getArtifact(
      `pymupdf-wasm@${pymupdfVer}`,
      name,
      npmTarballUrl('@bentopdf/pymupdf-wasm', pymupdfVer),
      [path.join(bundleDir, name), path.join(vendorDir, name)]
    );
    const dest = path.join(publicDir, 'wasm/pymupdf');
    resetDir(dest);
    writeFiles(
      dest,
      selectUnder(untgz(buf), 'package/').filter(
        ([n]) =>
          /^(dist|assets)\//.test(n) || n === 'LICENSE' || n === 'package.json'
      )
    );
  }

  // --- Ghostscript (package/assets/* -> wasm/gs) ------------------------------
  {
    const name = `bentopdf-gs-wasm-${gsVer}.tgz`;
    const buf = await getArtifact(
      `gs-wasm@${gsVer}`,
      name,
      npmTarballUrl('@bentopdf/gs-wasm', gsVer),
      [path.join(bundleDir, name), path.join(vendorDir, name)]
    );
    const files = untgz(buf);
    const assets = selectUnder(files, 'package/assets/');
    const dest = path.join(publicDir, 'wasm/gs');
    resetDir(dest);
    writeFiles(dest, assets.length ? assets : selectUnder(files, 'package/'));
  }

  // --- CoherentPDF (package/dist/* -> wasm/cpdf) ------------------------------
  {
    const name = `coherentpdf-${CPDF_VERSION}.tgz`;
    const buf = await getArtifact(
      `coherentpdf@${CPDF_VERSION}`,
      name,
      npmTarballUrl('coherentpdf', CPDF_VERSION),
      [path.join(bundleDir, name), path.join(vendorDir, name)]
    );
    const files = untgz(buf);
    const dist = selectUnder(files, 'package/dist/');
    const dest = path.join(publicDir, 'wasm/cpdf');
    resetDir(dest);
    writeFiles(dest, dist.length ? dist : selectUnder(files, 'package/'));
  }

  // --- Tesseract worker + core ---------------------------------------------------
  {
    const name = `tesseract.js-${tessVer}.tgz`;
    const buf = await getArtifact(
      `tesseract.js@${tessVer}`,
      name,
      npmTarballUrl('tesseract.js', tessVer),
      [path.join(bundleDir, name)]
    );
    const worker = untgz(buf).get('package/dist/worker.min.js');
    if (!worker) fail('worker.min.js not found in tesseract.js tarball');
    fs.mkdirSync(path.join(publicDir, 'tesseract'), { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'tesseract/worker.min.js'), worker);
  }
  {
    const name = `tesseract.js-core-${tessCoreVer}.tgz`;
    const buf = await getArtifact(
      `tesseract.js-core@${tessCoreVer}`,
      name,
      npmTarballUrl('tesseract.js-core', tessCoreVer),
      [path.join(bundleDir, name)]
    );
    const dest = path.join(publicDir, 'tesseract/core');
    resetDir(dest);
    // The worker only ever loads the self-contained *.wasm.js variants.
    writeFiles(
      dest,
      selectUnder(untgz(buf), 'package/').filter(
        ([n]) => n.endsWith('.wasm.js') || n === 'LICENSE'
      )
    );
  }

  // --- English traineddata (gz, as expected with gzip: true) -------------------
  {
    const buf = await getArtifact(
      `tessdata-eng@${TESSDATA_VERSION}`,
      `eng-${TESSDATA_VERSION}.traineddata.gz`,
      `https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/${TESSDATA_VERSION}/eng.traineddata.gz`
    );
    const dest = path.join(publicDir, 'tesseract/lang');
    resetDir(dest);
    fs.writeFileSync(path.join(dest, 'eng.traineddata.gz'), buf);
  }

  // --- OCR text-layer fonts (Noto) ----------------------------------------------
  {
    const dest = path.join(publicDir, 'fonts/ocr');
    resetDir(dest);
    for (const f of ocrFonts) {
      const buf = await getArtifact(
        `ocr-font:${f.file}`,
        `ocr-font-${f.file}`,
        f.url
      );
      fs.writeFileSync(path.join(dest, f.file), buf);
    }
  }

  // --- Editor fallback fonts (@embedpdf/fonts-*) ---------------------------------
  {
    const dest = path.join(publicDir, 'fonts/editor');
    resetDir(dest);
    for (const pack of EMBEDPDF_FONT_PACKS) {
      const buf = await getArtifact(
        `@embedpdf/${pack}@${EMBEDPDF_FONT_VERSION}`,
        `embedpdf-${pack}-${EMBEDPDF_FONT_VERSION}.tgz`,
        npmTarballUrl(`@embedpdf/${pack}`, EMBEDPDF_FONT_VERSION)
      );
      const fonts = selectUnder(untgz(buf), 'package/fonts/');
      if (!fonts.length) fail(`no fonts/ directory in @embedpdf/${pack}`);
      writeFiles(
        path.join(dest, pack, 'fonts'),
        fonts.filter(([n]) => /-Regular\.(otf|ttf)$/i.test(n))
      );
    }
  }

  // --- Neutralise unreachable upstream CDN fallbacks (defence in depth) -------
  // tesseract.js and pyodide embed jsDelivr defaults that are never used
  // because every path is overridden; rewrite them so nothing remote remains.
  for (const rel of [
    'tesseract/worker.min.js',
    'wasm/pymupdf/assets/pyodide.js',
  ]) {
    const file = path.join(publicDir, rel);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replaceAll(
      'https://cdn.jsdelivr.net',
      'https://blocked.invalid'
    );
    if (after !== before) fs.writeFileSync(file, after);
  }

  if (lockDirty) {
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    log(`wrote ${path.relative(root, lockPath)}`);
  }
  fs.writeFileSync(stampPath, JSON.stringify({ key: stampKey }));
  log('done');
}

main().catch((e) => fail(e?.stack || String(e)));
