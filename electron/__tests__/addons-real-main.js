'use strict';
// Run: INKLEAF_DIST=dist-net npx electron electron/__tests__/addons-real-main.js
// Real Electron run of the add-on sideload path with a fabricated pack and a manifest override.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { app, BrowserWindow, session } = require('electron');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-addon-real-'));
app.setPath('userData', path.join(tmp, 'ud'));
process.env.INKLEAF_TEST = '1';
process.env.INKLEAF_TEST_CONFIRM = 'yes';

// fabricate a tiny stored-method zip
function zip(files) {
  const crcT = (b) => (zlib.crc32 ? zlib.crc32(b) : 0);
  const loc = [];
  const cen = [];
  let off = 0;
  for (const [n, d] of files) {
    const name = Buffer.from(n);
    const data = Buffer.from(d);
    const crc = crcT(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    const l = Buffer.concat([lh, name, data]);
    loc.push(l);
    cen.push(Buffer.concat([ch, name]));
    off += l.length;
  }
  const cd = Buffer.concat(cen);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(files.length, 8);
  e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(off, 16);
  return Buffer.concat([...loc, cd, e]);
}
const pack = zip([
  ['soffice.js', 'console.log("lo")'],
  ['soffice.wasm', '\0asm\x01\0\0\0'],
]);
const packFile = path.join(tmp, 'pack.zip');
fs.writeFileSync(packFile, pack);
const mf = path.join(tmp, 'manifest.json');
fs.writeFileSync(
  mf,
  JSON.stringify({
    version: '0.0.1',
    sha256: crypto.createHash('sha256').update(pack).digest('hex'),
    sizeBytes: pack.length,
  })
);
process.env.INKLEAF_TEST_ADDON_MANIFEST = mf;
process.env.INKLEAF_TEST_OPEN = packFile;
if (!process.env.INKLEAF_DIST) process.env.INKLEAF_DIST = 'dist-net';

const { registerScheme, registerHandler } = require('../protocol');
const ipc = require('../ipc');
registerScheme();
const results = [];
const check = (n, ok, x) => results.push({ n, ok: !!ok, x });
const done = (code) => {
  for (const r of results)
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.x !== undefined ? '  ' + JSON.stringify(r.x) : ''}`
    );
  const f = results.filter((r) => !r.ok).length;
  console.log(f ? `${f} FAILED` : `ALL ${results.length} PASSED`);
  const ud = path.join(tmp, 'ud', 'addons', 'libreoffice');
  console.log('files:', fs.existsSync(ud) ? fs.readdirSync(ud) : 'none');
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  app.exit(code ?? (f ? 1 : 0));
};
setTimeout(() => done(2), 60000).unref();
app.whenReady().then(async () => {
  try {
    registerHandler(session.defaultSession);
    ipc.register({ devUrl: null });
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    await win.loadURL('app://bentopdf/');
    const js = (c) => win.webContents.executeJavaScript(c);
    check(
      'status before = not-installed',
      (await js(`desk.addons.status('libreoffice')`)).state === 'not-installed'
    );
    check(
      'unknown add-on rejected',
      (
        await js(`desk.addons.status('../x').then(()=>'ok',e=>e.message)`)
      ).startsWith('[bad_args]')
    );
    const st = await js(`desk.addons.installFromFile('libreoffice')`);
    check(
      'installFromFile -> installed',
      st.state === 'installed' && st.basePath === '/addons/libreoffice/0.0.1/',
      st
    );
    const r = await js(
      `fetch('/addons/libreoffice/0.0.1/soffice.wasm').then(async r=>({s:r.status,ct:r.headers.get('content-type'),coep:r.headers.get('cross-origin-embedder-policy'),corp:r.headers.get('cross-origin-resource-policy'),n:(await r.arrayBuffer()).byteLength}))`
    );
    check(
      'wasm served with application/wasm + COEP/CORP',
      r.s === 200 &&
        r.ct === 'application/wasm' &&
        r.coep === 'require-corp' &&
        r.corp === 'same-origin' &&
        r.n === 8,
      r
    );
    check(
      'compileStreaming on add-on wasm',
      (await js(
        `WebAssembly.compileStreaming(fetch('/addons/libreoffice/0.0.1/soffice.wasm')).then(()=>true,e=>String(e))`
      )) === true
    );
    check(
      'js served',
      (
        await js(
          `fetch('/addons/libreoffice/0.0.1/soffice.js').then(r=>r.text())`
        )
      ).includes('lo')
    );
    for (const u of [
      '/addons/libreoffice/0.0.1/../../../window-state.json',
      '/addons/libreoffice/%2e%2e/%2e%2e/recent.json',
      '/addons/libreoffice/..%2f..%2fx',
      '/addons/libreoffice/0.0.1/..%5c..%5cx',
      '/addons/../x',
    ]) {
      const s = await js(
        `fetch(${JSON.stringify(u)}).then(r=>r.status,()=> 'err')`
      );
      check(`traversal blocked ${u}`, s !== 200, s);
    }
    check(
      'status after = installed',
      (await js(`desk.addons.status('libreoffice')`)).state === 'installed'
    );
    const ud = path.join(tmp, 'ud', 'addons', 'libreoffice');
    check(
      'files under userData',
      fs.existsSync(path.join(ud, '0.0.1', 'soffice.js')) &&
        fs.existsSync(path.join(ud, 'manifest.json'))
    );
    const rm = await js(`desk.addons.remove('libreoffice')`);
    check(
      'remove -> not-installed',
      rm.state === 'not-installed' && !fs.existsSync(ud)
    );
    const ts = await js(
      `desk.net.timestamp({tsaId:'https://evil.com', request:new ArrayBuffer(40)}).then(()=>'ok',e=>e.message)`
    );
    check('timestamp with URL as id rejected', ts.startsWith('[bad_args]'), ts);
    const ts2 = await js(
      `desk.net.timestamp({tsaId:'freetsa', request:new Uint8Array(40).buffer}).then(()=>'ok',e=>e.message)`
    );
    check(
      'timestamp malformed request rejected before any network',
      ts2.startsWith('[bad_args]'),
      ts2
    );
    done();
  } catch (e) {
    console.log('ERROR', (e && e.stack) || e);
    done(3);
  }
});
