'use strict';
// Real-Electron e2e for the desktop file I/O bridge.
//   npx electron src/tests/desktop/io/electron-e2e.cjs      (run from app/; needs a display, window is hidden)
//   INKLEAF_DIST=<dir> overrides the web build dir (default: <app>/dist).
// The built dist already contains the desktop chrome that calls initDesktopIO().
// window.desk is a stub from electron-e2e-preload.cjs; the real preload/ipc are not involved.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

const appRoot = path.resolve(__dirname, '../../../..');
const dist = path.resolve(
  process.env.INKLEAF_DIST || path.join(appRoot, 'dist')
);
process.env.INKLEAF_DIST = dist;
if (!fs.existsSync(path.join(dist, 'merge-pdf.html'))) {
  console.error(
    'dist/merge-pdf.html missing: run `npm run build:desktop` first'
  );
  process.exit(2);
}

// tiny valid PDF with a correct xref table
function makePdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offs.forEach((o) => (out += String(o).padStart(10, '0') + ' 00000 n \n'));
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const pdf = makePdf();
const pdfB64 = pdf.toString('base64');
process.env.INKLEAF_E2E_PDF_B64 = pdfB64;

// The built dist includes desktop chrome -> bootstrapFlows() -> initDesktopIO(); change events are recorded by the preload.

const { registerScheme, registerHandler } = require(
  path.join(appRoot, 'electron/protocol')
);
registerScheme();

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra });
const done = (code) => {
  for (const r of results)
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.extra !== undefined ? '  ' + JSON.stringify(r.extra) : ''}`
    );
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} FAILED` : `\nALL ${results.length} PASSED`);
  app.exit(code ?? (failed ? 1 : 0));
};
setTimeout(() => {
  console.log('TIMEOUT');
  done(2);
}, 60000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID = '3f2b8c1e-7a4d-4e21-9b6a-0c5d8e9f1a2b';

app.whenReady().then(async () => {
  try {
    registerHandler(session.defaultSession);
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'electron-e2e-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    const run = (code) => win.webContents.executeJavaScript(code);
    if (process.env.E2E_DEBUG)
      win.webContents.on('console-message', (e) =>
        console.log('[page]', e.message ?? e)
      );
    win.webContents.once('dom-ready', () => {});
    await win.loadURL(
      `app://bentopdf/merge-pdf.html?desk-file=${UUID}&desk-name=a.pdf&keep=1`
    );

    // ---- hand-off
    let seen = [];
    for (let i = 0; i < 100; i++) {
      seen = await run('window.__getChangeSeen()');
      if (seen.length) break;
      await sleep(100);
    }
    check(
      'input got a change event with a.pdf (same size, application/pdf)',
      seen.length >= 1 &&
        seen[0].names.length === 1 &&
        seen[0].names[0] === `a.pdf|${pdf.length}|application/pdf`,
      seen
    );
    check(
      'delivered to #file-input',
      seen[0] && seen[0].id === 'file-input',
      seen
    );
    const live = await run(
      `(() => { const f = document.getElementById('file-input').files[0]; return f ? f.name + '|' + f.size : null })()`
    );
    check(
      'file-input.files holds the File',
      live === `a.pdf|${pdf.length}`,
      live
    );
    const search = await run('location.search');
    check(
      'hand-off params stripped from URL (others kept)',
      search === '?keep=1',
      search
    );
    let log = await run('window.__deskLog()');
    check(
      'desk.readFile called once with the validated uuid',
      log.filter((l) => l.fn === 'readFile').length === 1 && log[0].id === UUID,
      log
    );
    await sleep(800);
    if (process.env.E2E_DEBUG)
      console.log(
        'STATE',
        JSON.stringify(
          await run(
            "({rs:document.readyState,inputs:[...document.querySelectorAll('input[type=file]')].map(i=>i.id+':'+i.accept+':'+i.files.length)})"
          )
        )
      );
    if (process.env.E2E_DEBUG)
      console.log(
        'TOASTS',
        await run("document.getElementById('inkleaf-io-toasts')?.innerText")
      );
    check(
      'merge page UI lists a.pdf',
      /a\.pdf/.test(await run('document.body.innerText'))
    );

    // ---- detached download anchor (as editcore and several tools do)
    await run(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(pdfB64)}), c => c.charCodeAt(0));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      a.download = '../ev:il/CON.pdf';
      a.click();
      return true })()`);
    for (let i = 0; i < 50; i++) {
      log = await run('window.__deskLog()');
      if (log.some((l) => l.fn === 'write')) break;
      await sleep(100);
    }
    const sa = log.find((l) => l.fn === 'saveAs');
    const wr = log.find((l) => l.fn === 'write');
    check(
      'saveAs got sanitized name + mime',
      sa &&
        sa.suggestedName === '_evil_CON.pdf' &&
        sa.mime === 'application/pdf',
      sa
    );
    check('write used the saveAs grant id', wr && wr.id === 'out-grant-1', wr);
    check('written bytes equal source bytes', wr && wr.b64 === pdfB64);
    const nav = win.webContents.getURL();
    check(
      'page stayed put (no native navigation/download)',
      nav.startsWith('app://bentopdf/merge-pdf.html'),
      nav
    );

    // ---- same-origin iframe (pdf.js viewer pattern): attached anchor clicked inside the frame
    const iframeRes = await run(`new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.src = '/pdfjs-viewer/form-viewer.html';
      f.onload = () => {
        const d = f.contentDocument, w = f.contentWindow;
        const a = d.createElement('a');
        a.href = w.URL.createObjectURL(new w.Blob([new w.Uint8Array([37,80,68,70])], { type: 'application/pdf' }));
        a.download = 'from-frame.pdf';
        d.body.appendChild(a);
        a.click();
        resolve(typeof w.showSaveFilePicker);
      };
      document.body.appendChild(f);
    })`);
    for (let i = 0; i < 50; i++) {
      log = await run('window.__deskLog()');
      if (log.filter((l) => l.fn === 'write').length >= 2) break;
      await sleep(100);
    }
    const sa2 = log.filter((l) => l.fn === 'saveAs')[1];
    const wr2 = log.filter((l) => l.fn === 'write')[1];
    check(
      'iframe download routed to top-frame desk.saveAs',
      sa2 && sa2.suggestedName === 'from-frame.pdf',
      log
    );
    check(
      'iframe bytes written',
      wr2 && wr2.b64 === Buffer.from('%PDF').toString('base64'),
      wr2
    );
    check(
      'showSaveFilePicker removed in iframe',
      iframeRes === 'undefined',
      iframeRes
    );
    check(
      'showSaveFilePicker removed in top window',
      (await run('typeof window.showSaveFilePicker')) === 'undefined'
    );

    done();
  } catch (e) {
    console.log('ERROR', e && e.stack ? e.stack : e);
    done(1);
  }
});
