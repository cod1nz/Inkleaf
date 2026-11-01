'use strict';
// Run: npx electron electron/__tests__/smoke-main.js   (needs a display; window is hidden)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-smoke-'));
const dist = path.join(tmp, 'dist');
fs.mkdirSync(dist);
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'TOPSECRET');
fs.writeFileSync(
  path.join(dist, 'index.html'),
  '<!doctype html><title>smoke</title><body>hi</body>'
);
fs.writeFileSync(
  path.join(dist, 'frame.html'),
  '<!doctype html><body>frame</body>'
);
fs.writeFileSync(
  path.join(dist, 'merge-pdf.html'),
  '<!doctype html><body>merge</body>'
);
fs.writeFileSync(
  path.join(dist, 'x.wasm'),
  Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
);
process.env.INKLEAF_DIST = dist;

const { registerScheme, registerHandler } = require('../protocol');
const ipc = require('../ipc');
registerScheme();

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra });
const done = (code) => {
  for (const r of results)
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra !== undefined ? '  ' + JSON.stringify(r.extra) : ''}`
    );
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} FAILED` : `\nALL ${results.length} PASSED`);
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code ?? (failed ? 1 : 0));
};
setTimeout(() => {
  console.log('TIMEOUT');
  done(2);
}, 50000).unref();

app.whenReady().then(async () => {
  try {
    registerHandler(session.defaultSession);
    ipc.register({ devUrl: null });
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        additionalArguments: ['--inkleaf-version=9.9.9'],
      },
    });
    await win.loadURL('app://bentopdf/');
    const js = (code) => win.webContents.executeJavaScript(code);

    check(
      'page loads (root -> index.html)',
      (await js('document.title')) === 'smoke'
    );
    check(
      'url is app://bentopdf/',
      win.webContents.getURL() === 'app://bentopdf/'
    );
    check(
      'crossOriginIsolated === true',
      (await js('crossOriginIsolated')) === true
    );
    check(
      'SharedArrayBuffer available',
      (await js('typeof SharedArrayBuffer')) === 'function'
    );

    const hdrs = await js(
      `fetch('/').then(r => Object.fromEntries([...r.headers]))`
    );
    check(
      'COOP same-origin',
      hdrs['cross-origin-opener-policy'] === 'same-origin'
    );
    check(
      'COEP require-corp',
      hdrs['cross-origin-embedder-policy'] === 'require-corp'
    );
    const csp = hdrs['content-security-policy'] || '';
    check(
      'CSP present, frame-ancestors self',
      /default-src 'self'/.test(csp) && /frame-ancestors 'self'/.test(csp),
      csp
    );
    check('no X-Frame-Options', !('x-frame-options' in hdrs));

    const wasm = await js(
      `fetch('/x.wasm').then(async r => ({ct: r.headers.get('content-type'), n: (await r.arrayBuffer()).byteLength, ok: r.ok}))`
    );
    check(
      '.wasm served as application/wasm',
      wasm.ct === 'application/wasm' && wasm.ok && wasm.n === 8,
      wasm
    );
    check(
      'WebAssembly.compileStreaming works',
      (await js(
        `WebAssembly.compileStreaming(fetch('/x.wasm')).then(() => true, e => String(e))`
      )) === true
    );
    check(
      'locale route /de/merge-pdf',
      (await js(`fetch('/de/merge-pdf').then(r => r.text())`)).includes('merge')
    );
    check(
      'HEAD works',
      (await js(`fetch('/x.wasm', {method: 'HEAD'}).then(r => r.status)`)) ===
        200
    );
    check(
      'POST rejected (405)',
      (await js(
        `fetch('/', {method: 'POST', body: 'x'}).then(r => r.status)`
      )) === 405
    );

    const bad = [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e%2fsecret.txt',
      '/a%5c..%5csecret.txt',
      '/..\\secret.txt',
      '/%252e%252e/secret.txt',
      '/C:/Windows/win.ini',
      '/c:/x',
      '/index.html::$DATA',
      '/index.html:stream',
      '/PROGRA~1',
      '/INDEX~1.HTM',
      '/CON',
      '/nul.txt',
      '//server/share/x',
      '/%5c%5cserver%5cshare',
      '/x%00.wasm',
      '/index.html.',
      '/index.html%20',
      '/addons/..%2f..%2fsecret.txt',
      '/addons/x/../../secret.txt',
    ];
    for (const u of bad) {
      const r = await js(
        `fetch(${JSON.stringify(u)}).then(async r => ({s: r.status, leak: (await r.text()).includes('TOPSECRET')}), e => ({s: 'err', leak: false}))`
      );
      check(`blocked ${u}`, r.s !== 200 && !r.leak, r);
    }

    check(
      'remote fetch blocked',
      (await js(
        `fetch('https://example.com/').then(() => 'LOADED', () => 'blocked')`
      )) === 'blocked'
    );
    check(
      'same-origin iframe allowed (frame-ancestors self)',
      (await js(
        `new Promise(res => { const f = document.createElement('iframe'); f.src = '/frame.html'; f.onload = () => { try { res(f.contentDocument.body.textContent === 'frame'); } catch (e) { res('xo:' + e.message); } }; setTimeout(() => res('timeout'), 4000); document.body.appendChild(f); })`
      )) === true
    );
    check(
      'inline script blocked by CSP',
      (await js(
        `new Promise(res => { window.__x = 0; const s = document.createElement('script'); s.textContent = 'window.__x = 1'; document.head.appendChild(s); setTimeout(() => res(window.__x === 0), 100); })`
      )) === true
    );
    check(
      'eval blocked',
      (await js(
        `(() => { try { return eval('1+1') === 2 ? 'EVAL OK' : 'weird'; } catch (e) { return 'blocked'; } })()`
      )) === 'blocked'
    );

    const keys = await js('Object.keys(window.desk).sort()');
    const expected = [
      'addons',
      'net',
      'onMenu',
      'onOpenWith',
      'openFiles',
      'platform',
      'readFile',
      'recent',
      'revealInFolder',
      'saveAs',
      'theme',
      'version',
      'write',
    ];
    check(
      'window.desk has exactly the expected keys',
      JSON.stringify(keys) === JSON.stringify(expected),
      keys
    );
    check(
      'desk.version from additionalArguments',
      (await js('desk.version')) === '9.9.9'
    );
    const leaks = await js(
      `['require', 'process', 'Buffer', 'ipcRenderer', 'electron', 'module', 'global'].filter(k => typeof window[k] !== 'undefined')`
    );
    check('no node/electron globals in page', leaks.length === 0, leaks);
    check(
      'recent keys',
      JSON.stringify(await js('Object.keys(desk.recent).sort()')) ===
        '["add","clear","list","remove"]'
    );
    {
      const v = await js(
        `desk.recent.remove('00000000-0000-0000-0000-000000000000').then(() => 'ok', e => e.message)`
      );
      check(
        'recent.remove unknown id -> not_granted',
        v.startsWith('[not_granted]'),
        v
      );
    }
    {
      const v = await js(
        `desk.recent.remove(5).then(() => 'ok', e => e.message)`
      );
      check('recent.remove bad arg -> bad_args', v.startsWith('[bad_args]'), v);
    }
    check(
      'theme keys',
      JSON.stringify(await js('Object.keys(desk.theme).sort()')) ===
        '["get","onChange"]'
    );
    check(
      'desk.theme.get() ok (sender validated)',
      ['dark', 'light'].includes(await js('desk.theme.get()'))
    );
    {
      const v = await js(
        `desk.readFile('00000000-0000-0000-0000-000000000000').then(() => 'ok', e => e.message)`
      );
      check(
        'readFile unknown id -> not_granted',
        v.startsWith('[not_granted]'),
        v
      );
    }
    {
      const v = await js(
        `desk.readFile('C:\\\\Windows\\\\win.ini').then(() => 'ok', e => e.message)`
      );
      check(
        'readFile with a path -> not_granted',
        v.startsWith('[not_granted]'),
        v
      );
    }
    {
      const v = await js(
        `desk.write('x', new ArrayBuffer(4)).then(() => 'ok', e => e.message)`
      );
      check('write unknown id rejected', v.startsWith('[not_granted]'), v);
    }
    {
      const v = await js(
        `desk.saveAs({suggestedName: 5}).then(() => 'ok', e => e.message)`
      );
      check('saveAs bad args rejected', v.startsWith('[bad_args]'), v);
    }

    if (process.platform === 'win32') {
      // argv / open-with: UNC (SMB + NTLM) and device paths are never touched without consent (test hook answers "no").
      const fsp = require('node:fs/promises');
      const seen = [];
      const orig = fsp.stat;
      fsp.stat = (p, ...a) => {
        seen.push(String(p));
        return orig(p, ...a);
      };
      process.env.INKLEAF_TEST = '1';
      delete process.env.INKLEAF_TEST_CONFIRM;
      try {
        await ipc.openPaths([
          '\\\\probe-unc.invalid\\share\\a.pdf',
          '//probe-unc.invalid/share/b.pdf',
          '\\\\?\\UNC\\probe-unc.invalid\\s\\c.pdf',
          '\\\\.\\pipe\\probe-pipe.pdf',
        ]);
      } finally {
        fsp.stat = orig;
        delete process.env.INKLEAF_TEST;
      }
      check(
        'argv UNC / device paths are not opened without consent',
        !seen.some((p) => /probe-/.test(p)),
        seen
      );

      // Saving active content (e.g. an extracted attachment) gets a Mark of the Web; bidi tricks are stripped.
      const outDir = path.join(tmp, 'out');
      fs.mkdirSync(outDir);
      process.env.INKLEAF_TEST = '1';
      process.env.INKLEAF_TEST_SAVE_DIR = outDir;
      try {
        const r = await js(
          `desk.saveAs({ suggestedName: 'evil\\u202Efdp.exe', mime: 'application/octet-stream' }).then(t => desk.write(t.id, new Uint8Array([77, 90]).buffer)).then(() => 'ok', e => e.message)`
        );
        const names = fs.readdirSync(outDir);
        check(
          'saveAs strips bidi override from the suggested name',
          r === 'ok' && names.includes('evilfdp.exe'),
          { r, names }
        );
        let motw = '';
        try {
          motw = fs.readFileSync(
            path.join(outDir, 'evilfdp.exe:Zone.Identifier'),
            'utf8'
          );
        } catch {
          /* none */
        }
        check(
          'risky output carries Zone.Identifier (ZoneId=3)',
          /ZoneId=3/.test(motw),
          motw
        );
        await js(
          `desk.saveAs({ suggestedName: 'plain.pdf', mime: 'application/pdf' }).then(t => desk.write(t.id, new Uint8Array([37]).buffer))`
        );
        check(
          'pdf output has no Zone.Identifier',
          !fs.existsSync(path.join(outDir, 'plain.pdf:Zone.Identifier'))
        );
      } finally {
        delete process.env.INKLEAF_TEST;
        delete process.env.INKLEAF_TEST_SAVE_DIR;
      }
    }

    done();
  } catch (e) {
    console.log('ERROR', (e && e.stack) || e);
    done(3);
  }
});
