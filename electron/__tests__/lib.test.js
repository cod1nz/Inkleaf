'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseUrlPath,
  resolveInside,
  isRealInside,
  realRoots,
} = require('../lib/safepath');
const { candidatesFor, LOCALES } = require('../lib/routing');
const { mimeFor } = require('../lib/mime');
const { securityHeaders, CSP } = require('../lib/headers');
const { isTrustedUrl, isHttpUrl } = require('../lib/trust');
const {
  toLongPath,
  pdfArgs,
  safeFileName,
  saveFilters,
  openFilters,
  pathKind,
  uncHost,
} = require('../lib/files');
const { normalize, addEntry, removeEntry } = require('../lib/recent');
const { atomicWrite } = require('../lib/atomic');

test('parseUrlPath accepts normal paths', () => {
  assert.deepEqual(parseUrlPath('/').segments, []);
  assert.deepEqual(parseUrlPath('/a/b.js').segments, ['a', 'b.js']);
  assert.deepEqual(parseUrlPath('/my%20file.pdf').segments, ['my file.pdf']);
  assert.equal(parseUrlPath('/merge/').trailingSlash, true);
});

test('parseUrlPath rejects traversal and tricks', () => {
  for (const p of [
    '/..',
    '/a/../b',
    '/%2e%2e/x',
    '/a/%2E%2E/b',
    '/a%2fb',
    '/a%5cb',
    '/a\\b',
    '/a%00b',
    '/%252e%252e/x',
    '/C:/x',
    '/a/%',
    '/foo./x',
    '/...',
  ]) {
    assert.equal(parseUrlPath(p), null, p);
  }
  assert.equal(parseUrlPath('relative'), null);
});

test('resolveInside stays in root', () => {
  const root = path.resolve('some', 'root');
  assert.equal(
    resolveInside(root, ['a', 'b.txt']),
    path.join(root, 'a', 'b.txt')
  );
  assert.equal(resolveInside(root, ['..', 'x']), null);
  assert.equal(resolveInside(root, ['a', '..', '..', 'x']), null);
  assert.equal(resolveInside(root, []), null);
  // sibling with common prefix must not pass
  assert.equal(resolveInside(root, ['..', 'root-evil', 'x']), null);
});

test('isRealInside blocks symlink escape', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'dist');
  const outside = path.join(tmp, 'secret');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'ok.txt'), 'x');
  fs.writeFileSync(path.join(outside, 's.txt'), 'x');
  const roots = await realRoots(root);
  assert.equal(await isRealInside(path.join(root, 'ok.txt'), roots), true);
  assert.equal(await isRealInside(path.join(root, 'missing'), roots), false);
  try {
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  } catch {
    return t.skip('cannot create symlink');
  }
  assert.equal(
    await isRealInside(path.join(root, 'link', 's.txt'), roots),
    false
  );
});

test('routing: root, pages, assets', () => {
  assert.deepEqual(candidatesFor([]), ['desktop.html', 'index.html']);
  assert.deepEqual(candidatesFor(['merge-pdf']), [
    'merge-pdf.html',
    'merge-pdf/index.html',
  ]);
  assert.deepEqual(candidatesFor(['assets', 'a.js']), ['assets/a.js']);
  assert.deepEqual(candidatesFor(['x.wasm']), ['x.wasm']);
});

test('routing: locale prefixes fall back to unprefixed path', () => {
  assert.equal(LOCALES.length, 24);
  assert.deepEqual(candidatesFor(['de']), [
    'de.html',
    'de/index.html',
    'desktop.html',
    'index.html',
  ]);
  assert.deepEqual(candidatesFor(['zh-TW', 'merge-pdf']), [
    'zh-TW/merge-pdf.html',
    'zh-TW/merge-pdf/index.html',
    'merge-pdf.html',
    'merge-pdf/index.html',
  ]);
  assert.deepEqual(candidatesFor(['fr', 'assets', 'a.css']), [
    'fr/assets/a.css',
    'assets/a.css',
  ]);
  // unknown locale is not stripped
  assert.deepEqual(candidatesFor(['xx', 'merge-pdf']), [
    'xx/merge-pdf.html',
    'xx/merge-pdf/index.html',
  ]);
});

test('mime lookup', () => {
  assert.equal(mimeFor('a/b.wasm'), 'application/wasm');
  assert.match(mimeFor('x.MJS'), /^text\/javascript/);
  assert.match(mimeFor('x.json'), /^application\/json/);
  assert.equal(mimeFor('f.woff2'), 'font/woff2');
  assert.equal(mimeFor('f.ttf'), 'font/ttf');
  assert.equal(mimeFor('f.unknown'), 'application/octet-stream');
});

test('security headers', () => {
  const h = securityHeaders();
  assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(h['Cross-Origin-Embedder-Policy'], 'require-corp');
  assert.equal(h['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.match(
    CSP,
    /^default-src 'self'; script-src 'self' 'wasm-unsafe-eval'/
  );
  assert.doesNotMatch(CSP, /(?<!wasm-)unsafe-eval|https?:/);
});

test('trusted urls', () => {
  assert.equal(isTrustedUrl('app://bentopdf/merge-pdf'), true);
  assert.equal(isTrustedUrl('app://evil/'), false);
  assert.equal(isTrustedUrl('app://bentopdf.evil/'), false);
  assert.equal(isTrustedUrl('https://example.com/'), false);
  assert.equal(
    isTrustedUrl('http://localhost:5173/x', 'http://localhost:5173'),
    true
  );
  assert.equal(isTrustedUrl('http://localhost:5173/x'), false);
  assert.equal(isTrustedUrl(undefined), false);
  assert.equal(isHttpUrl('https://a.b'), true);
  assert.equal(isHttpUrl('file:///etc/passwd'), false);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
});

test('files helpers', () => {
  assert.equal(toLongPath('C:\\short', 'win32'), 'C:\\short');
  const long = 'C:\\' + 'a'.repeat(250);
  assert.equal(toLongPath(long, 'win32'), '\\\\?\\' + long);
  assert.equal(
    toLongPath('\\\\srv\\share\\' + 'a'.repeat(250), 'win32').startsWith(
      '\\\\?\\UNC\\srv'
    ),
    true
  );
  assert.equal(toLongPath(long, 'linux'), long);
  assert.deepEqual(
    pdfArgs(['electron.exe', '.', '--dev', 'C:\\x\\A.PDF', 'b.txt', '-x.pdf']),
    ['C:\\x\\A.PDF']
  );
  assert.equal(
    safeFileName('../../evil/..\\x:y.pdf'),
    '_.._evil_.._x_y.pdf'.replace(/^\.+/, '')
  );
  assert.equal(safeFileName(42), 'document.pdf');
  assert.equal(safeFileName('   '), 'document.pdf');
  assert.equal(saveFilters('application/pdf')[0].extensions[0], 'pdf');
  assert.equal(saveFilters('x/y')[0].extensions[0], '*');
  assert.equal(openFilters('pdf').length, 1);
  assert.ok(openFilters('any')[0].extensions.includes('docx'));
});

test('atomicWrite writes and leaves no temp files', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-w-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const target = path.join(tmp, 'out.pdf');
  fs.writeFileSync(target, 'old');
  await atomicWrite(target, Buffer.from('new data'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'new data');
  assert.deepEqual(fs.readdirSync(tmp), ['out.pdf']);
  await assert.rejects(
    atomicWrite(path.join(tmp, 'nodir', 'x.pdf'), Buffer.from('x'))
  );
});

test('parseUrlPath rejects 8.3 short names and device names', () => {
  for (const p of [
    '/PROGRA~1',
    '/a/INDEX~1.HTM',
    '/CON',
    '/nul.txt',
    '/a/COM1',
    '/lpt2.js',
  ])
    assert.equal(parseUrlPath(p), null, p);
  assert.deepEqual(parseUrlPath('/console.js').segments, ['console.js']);
});

test('csp allows self framing only', () => {
  assert.match(CSP, /frame-ancestors 'self'/);
  assert.equal('X-Frame-Options' in securityHeaders(), false);
});

test('pdfArgs resolves against cwd', () => {
  assert.deepEqual(pdfArgs(['app.exe', 'my file.pdf'], path.resolve('/w')), [
    path.resolve('/w', 'my file.pdf'),
  ]);
});

test('recent: add dedupes, stamps lastOpened, caps; remove drops; normalize fills legacy entries', () => {
  let l = addEntry([], path.join('d', 'a.pdf'), 100, 2);
  l = addEntry(l, path.join('d', 'b.pdf'), 200, 2);
  l = addEntry(l, path.join('d', 'a.pdf'), 300, 2);
  assert.deepEqual(
    l.map((r) => [r.name, r.lastOpened]),
    [
      ['a.pdf', 300],
      ['b.pdf', 200],
    ]
  );
  l = addEntry(l, path.join('d', 'c.pdf'), 400, 2);
  assert.equal(l.length, 2);
  assert.deepEqual(
    removeEntry(l, path.join('d', 'c.pdf')).map((r) => r.name),
    ['a.pdf']
  );
  const legacy = normalize(
    [{ path: path.join('x', 'old.pdf') }, { nope: 1 }, null],
    10
  );
  assert.deepEqual(legacy, [
    { path: path.join('x', 'old.pdf'), name: 'old.pdf', lastOpened: 0 },
  ]);
});

test('pathKind: UNC / device paths are not local on Windows', () => {
  const r = String.raw;
  assert.equal(pathKind(r`C:\Users\a\x.pdf`, 'win32'), 'local');
  assert.equal(pathKind(r`\\?\C:\very\long\x.pdf`, 'win32'), 'local');
  assert.equal(pathKind(r`\\attacker\share\x.pdf`, 'win32'), 'network');
  assert.equal(pathKind('//attacker/share/x.pdf', 'win32'), 'network');
  assert.equal(pathKind(r`\\?\UNC\attacker\share\x.pdf`, 'win32'), 'network');
  assert.equal(pathKind(r`\\?\unc\attacker\share\x.pdf`, 'win32'), 'network');
  assert.equal(pathKind(r`\\.\pipe\evil.pdf`, 'win32'), 'device');
  assert.equal(pathKind(r`\\?\GLOBALROOT\Device\x.pdf`, 'win32'), 'device');
  assert.equal(pathKind(5, 'win32'), 'device');
  assert.equal(pathKind('//server/x.pdf', 'darwin'), 'local');
  assert.equal(uncHost(r`\\srv\share\x.pdf`), 'srv');
  assert.equal(uncHost(r`\\?\UNC\srv\share\x.pdf`), 'srv');
  assert.equal(uncHost('//srv/share/x.pdf'), 'srv');
});

test('safeFileName strips bidi / zero-width disguises; risky outputs are detected', () => {
  assert.equal(safeFileName('invoice\u202Efdp.exe'), 'invoicefdp.exe');
  assert.equal(safeFileName('a\u200Bb\u2066c\uFEFF.pdf'), 'abc.pdf');
  assert.equal(safeFileName('x\u0085y.pdf'), 'xy.pdf');
  const { isRiskyOutput } = require('../lib/files');
  for (const n of [
    'a.exe',
    'a.EXE',
    'a.js',
    'a.hta',
    'a.lnk',
    'a.html',
    'a.docm',
    'a.exe.',
    'a.exe ',
  ])
    assert.equal(isRiskyOutput(n), true, n);
  for (const n of ['a.pdf', 'a.png', 'a.zip', 'a.txt', 'a.json', 'exe.pdf'])
    assert.equal(isRiskyOutput(n), false, n);
});

test('privacy headers: no DNS prefetch, no referrer', () => {
  const h = securityHeaders();
  assert.equal(h['X-DNS-Prefetch-Control'], 'off');
  assert.equal(h['Referrer-Policy'], 'no-referrer');
});
