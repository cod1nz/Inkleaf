'use strict';
// Large-file timing / peak memory / UI responsiveness
const path = require('path');
const fs = require('fs');
const H = require('../lib/harness.cjs');
const V = require('../lib/validate.cjs');
const fx = (n) => path.join(H.FIX, n);
H.overall(20 * 60 * 1000);
const alertState = () =>
  H.js(
    `(() => { const m = document.getElementById('alert-modal'); if (!m) return null; const vis = !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none'; return vis ? { title: document.getElementById('alert-title').innerText, msg: document.getElementById('alert-message').innerText } : null })()`
  );
const toasts = () =>
  H.js(`(document.getElementById('inkleaf-io-toasts')||{}).innerText || ''`);
const metrics = {};

async function timed(id, tool, inputs, setup, wait = 360000) {
  try {
    H.newOut();
    const mem = H.startMemSampler();
    const t0 = Date.now();
    await H.openTool(tool, inputs.map(fx));
    const loadMs = Date.now() - t0;
    await H.waitFor(
      () =>
        H.js(
          `document.getElementById('process-btn') && !document.getElementById('process-btn').disabled`
        ),
      120000
    );
    if (tool === 'merge-pdf') {
      const lt = Date.now();
      const okL = await H.waitFor(
        () =>
          H.js(`document.querySelectorAll('#file-list li').length`).then(
            (n) => n >= inputs.length
          ),
        120000,
        300
      );
      metrics[id + ':fileListReadyMs'] = Date.now() - lt;
      if (!okL)
        H.record(
          id + ':files-listed',
          'FAIL',
          'merge list never reached ' + inputs.length
        );
    }
    if (setup) await setup();
    const t1 = Date.now();
    const { r, maxGapMs } = await H.withResponsiveness(async () => {
      await H.js(`document.getElementById('process-btn').click()`);
      return H.waitFor(
        async () => {
          const l = H.listOut();
          if (l.length) return { file: l[0] };
          const a = await alertState();
          if (a && /error|fail/i.test(a.title + a.msg)) return { alert: a };
          return null;
        },
        wait,
        500
      );
    });
    const peakMB = mem.stop();
    const ms = Date.now() - t1;
    metrics[id] = {
      loadMs,
      processMs: ms,
      peakWorkingSetMB: peakMB,
      maxUiGapMs: maxGapMs,
      inputMB: Math.round(
        inputs.reduce((a, n) => a + fs.statSync(fx(n)).size, 0) / 1e6
      ),
    };
    if (!r || r.alert)
      return H.record(id, 'FAIL', {
        r,
        alert: await alertState(),
        toasts: await toasts(),
        ...metrics[id],
      });
    const f = path.join(H.curDir(), r.file);
    const info = await V.pdfInfo(f);
    metrics[id].outputMB = Math.round(fs.statSync(f).size / 1e5) / 10;
    metrics[id].outPages = info.pages;
    H.record(id, 'PASS', metrics[id]);
    return info;
  } catch (e) {
    H.record(id, 'FAIL', 'exception ' + e.message);
  }
}

const ONLY = process.env.E2E_ONLY;
H.boot().then(
  H.guard(async () => {
    if (ONLY) {
      await timed(
        'large-merge-216MB+small',
        'merge-pdf',
        ['large-noise-216mb.pdf', 'normal-3p.pdf'],
        null
      );
      return;
    }
    const m1 = await timed(
      'large-merge-216MB+small',
      'merge-pdf',
      ['large-noise-216mb.pdf', 'normal-3p.pdf'],
      null
    );
    if (m1)
      H.check('large-merge output has 39 pages', m1.pages === 39, m1.pages);
    const jr = metrics['large-merge-216MB+small'];
    if (jr)
      H.check(
        'large-merge UI stays responsive (max renderer timer gap < 2000 ms)',
        jr.maxUiGapMs < 2000,
        jr,
        'FAIL'
      );
    await timed(
      'large-compress-216MB',
      'compress-pdf',
      ['large-noise-216mb.pdf'],
      async () => {
        await H.js(
          `(()=>{const e=document.getElementById('compression-level'); e.value='balanced'; e.dispatchEvent(new Event('change',{bubbles:true}))})()`
        );
      }
    );
    const m3 = await timed(
      'merge-1000-pages',
      'merge-pdf',
      ['pages-1000.pdf', 'normal-3p.pdf'],
      null,
      240000
    );
    if (m3)
      H.check('1000-page merge has 1003 pages', m3.pages === 1003, m3.pages);
    await timed(
      'split-1000-pages',
      'split-pdf',
      ['pages-1000.pdf'],
      async () => {
        await H.js(
          `(()=>{const m=document.getElementById('split-mode'); m.value='range'; m.dispatchEvent(new Event('change',{bubbles:true})); const e=document.getElementById('page-range'); e.value='1-500'; e.dispatchEvent(new Event('input',{bubbles:true}))})()`
        );
      },
      240000
    );
    // open the big file through open-with and check the shell holds up
    try {
      await H.goto('desktop.html');
      const mem = H.startMemSampler();
      const nav = [];
      H.win().webContents.on('did-start-navigation', (_e, u) => {
        if (/desk-file/.test(u)) nav.push(u);
      });
      const t0 = Date.now();
      await require(path.join(H.APP, 'electron', 'ipc.js')).openPaths([
        fx('large-noise-216mb.pdf'),
      ]);
      await H.waitFor(() => nav.length, 20000);
      await H.sleep(15000);
      const al = await alertState();
      const tt = await toasts();
      const alive = (await H.js('1+1').catch(() => 0)) === 2;
      metrics['open-with-216MB'] = {
        peakWorkingSetMB: mem.stop(),
        ms: Date.now() - t0,
      };
      H.check(
        'open-with 216MB PDF: editor loads without error/crash',
        alive && !al && !/fail|error|too large/i.test(tt),
        { al, tt, ...metrics['open-with-216MB'] }
      );
    } catch (e) {
      H.record('open-with-216MB', 'FAIL', e.message);
    }
  })
);
process.on('exit', () => {
  try {
    fs.writeFileSync(
      path.join(H.E2E, 'out', 'metrics-large.json'),
      JSON.stringify(metrics, null, 2)
    );
  } catch {
    /* */
  }
});
