'use strict';
// Real-Electron check that the desktop pdf.js hardening (desktop-io onViewerLoaded) takes effect in the bundled viewers.
// Run from app/: INKLEAF_DIST=<dist dir> npx electron electron/__tests__/probe-pdfjs.js
// The top page gets the same listener desktop-io installs (copied below, so this works against an older dist too),
// then each viewer is loaded in an iframe with a PDF whose OpenAction is JavaScript and which has a URI link.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-pdfjs-'));
app.setPath('userData', path.join(tmp, 'userData'));
if (!process.env.INKLEAF_DIST)
  process.env.INKLEAF_DIST = path.resolve(__dirname, '../../dist');
const { registerScheme, registerHandler } = require('../protocol');
registerScheme();

function jsPdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [5 0 R] >>',
    '<< /S /JavaScript /JS (console.println\\("inkleaf-probe"\\);) >>',
    '<< /Type /Annot /Subtype /Link /Rect [0 0 200 200] /Border [0 0 0] /A << /S /URI /URI (https://probe-link.example.com/) >> >>',
  ];
  let out = '%PDF-1.7\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offs.forEach((o) => (out += String(o).padStart(10, '0') + ' 00000 n \n'));
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1').toString('base64');
}

const HOOK = `(() => {
  const OPTS = { disablePreferences: true, enableScripting: false, isEvalSupported: false, externalLinkTarget: 2, pdfBugEnabled: false };
  document.addEventListener('webviewerloaded', (ev) => {
    const o = ev.detail && ev.detail.source && ev.detail.source.PDFViewerApplicationOptions;
    if (o) for (const [k, v] of Object.entries(OPTS)) { try { o.set(k, v); } catch {} }
  }, true);
  return 1;
})()`;

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    registerHandler(session.defaultSession);
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const opened = [];
    win.webContents.setWindowOpenHandler(({ url }) => {
      opened.push(url);
      return { action: 'deny' };
    });
    await win.loadURL('app://bentopdf/');
    const js = (c) => win.webContents.executeJavaScript(c);
    const b64 = jsPdf();
    for (const [label, viewer, hooked] of [
      ['pdfjs-viewer (default, no hook)', '/pdfjs-viewer/viewer.html', false],
      ['pdfjs-viewer + desktop hook', '/pdfjs-viewer/viewer.html', true],
      [
        'pdfjs-annotation-viewer + desktop hook',
        '/pdfjs-annotation-viewer/web/viewer.html',
        true,
      ],
    ]) {
      await win.loadURL('app://bentopdf/');
      if (hooked) await js(HOOK);
      const r = await js(`new Promise(async (res) => {
        const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([u8], { type: 'application/pdf' }));
        const f = document.createElement('iframe'); f.style.width = '800px'; f.style.height = '600px';
        f.src = ${JSON.stringify(viewer)} + '?file=' + encodeURIComponent(url);
        document.body.appendChild(f);
        for (let i = 0; i < 100; i++) {
          await new Promise(r => setTimeout(r, 100));
          const w = f.contentWindow; const a = w && w.PDFViewerApplication;
          const link = w && w.document.querySelector('.linkAnnotation a');
          if (a && a.pdfDocument && (link || i > 40)) {
            return res({ scripting: w.PDFViewerApplicationOptions.get('enableScripting'), viewerScripting: a.pdfViewer.enableScripting,
              eval: w.PDFViewerApplicationOptions.get('isEvalSupported'), target: link ? link.target : null, href: link ? link.href : null, sandbox: !!(a.pdfScriptingManager && a.pdfScriptingManager.ready) });
          }
        }
        const w = f.contentWindow; const o = w && w.PDFViewerApplicationOptions; res({ timeout: true, hasApp: !!(w && w.PDFViewerApplication), doc: !!(w && w.PDFViewerApplication && w.PDFViewerApplication.pdfDocument), scripting: o && o.get('enableScripting'), links: w && w.document.querySelectorAll('.linkAnnotation').length, url: w && String(w.location.href).slice(0, 80) });
      })`);
      check(`${label}: loaded`, !r.timeout, r);
      if (r.timeout) continue;
      if (hooked) {
        check(
          `${label}: enableScripting false`,
          r.scripting === false && r.viewerScripting === false,
          r
        );
        check(
          `${label}: scripting sandbox not started`,
          r.sandbox === false,
          r
        );
        check(`${label}: isEvalSupported false`, r.eval === false, r);
        if (r.target === null) {
          check(
            `${label}: (link layer not rendered by this viewer build; link checks skipped)`,
            true
          );
          continue;
        }
        check(
          `${label}: URI link opens as _blank (-> window.open handler -> confirm)`,
          r.target === '_blank',
          r
        );
        await js(
          `document.querySelector('iframe').contentWindow.document.querySelector('.linkAnnotation a').click(); 1`
        );
        await sleep(500);
        check(
          `${label}: clicking the link reaches setWindowOpenHandler`,
          opened.includes('https://probe-link.example.com/'),
          opened
        );
        opened.length = 0;
      } else {
        check(
          `${label}: baseline has scripting ON (shows why the hook is needed)`,
          r.scripting === true,
          r
        );
      }
    }
  } catch (e) {
    console.log('ERROR', (e && e.stack) || e);
  }
  for (const r of results)
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  ' + JSON.stringify(r.extra)}`
    );
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} FAILED` : `\nALL ${results.length} PASSED`);
  app.exit(failed ? 1 : 0);
});
