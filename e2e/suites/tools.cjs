'use strict';
// Tool scenarios on real fixtures: merge, split, compress, rotate, OCR, protect/unlock, convert.
const path = require('path');
const fs = require('fs');
const H = require('../lib/harness.cjs');
const V = require('../lib/validate.cjs');
const fx = (n) => path.join(H.FIX, n);
H.overall(14 * 60 * 1000);

const setVal = (id, v) =>
  H.js(
    `(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e) return false; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); return true })()`
  );
const click = (id) =>
  H.js(
    `(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e) return false; e.click(); return true })()`
  );
const alertState = () =>
  H.js(
    `(() => { const m = document.getElementById('alert-modal'); if (!m) return null; const vis = !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none'; return vis ? { title: document.getElementById('alert-title').innerText, msg: document.getElementById('alert-message').innerText } : null })()`
  );
const toasts = () =>
  H.js(`(document.getElementById('inkleaf-io-toasts')||{}).innerText || ''`);

/** click process, wait for new output files or an alert. Returns {files, alert, ms} */
async function run(
  tool,
  inputs,
  setup,
  { wait = 90000, expectFiles = 1, clickId = 'process-btn' } = {}
) {
  H.newOut();
  H.newOut();
  await H.openTool(tool, inputs.map(fx));
  await H.sleep(1500);
  const ok = await H.waitFor(
    () =>
      H.js(
        `!!document.getElementById('${clickId}') && !document.getElementById('${clickId}').disabled`
      ),
    20000
  );
  if (setup) await setup();
  const before = H.listOut().length;
  const t0 = Date.now();
  await click(clickId);
  let alert = null;
  const files = await H.waitFor(
    async () => {
      const l = H.listOut();
      if (l.length >= before + expectFiles) return l.slice(before);
      alert = await alertState();
      if (
        alert &&
        /error|fail|invalid|password|encrypt/i.test(alert.title + alert.msg)
      )
        return [];
      return null;
    },
    wait,
    250
  );
  return {
    files: files || [],
    alert: alert || (await alertState()),
    ms: Date.now() - t0,
    toasts: await toasts(),
    ready: !!ok,
    newest: H.listOut().slice(before),
  };
}
const out = (f) => path.join(H.curDir(), f);
const step = async (id, fn) => {
  try {
    await fn();
  } catch (e) {
    H.record(id, 'FAIL', 'exception: ' + (e && e.message));
  }
};

H.boot().then(
  H.guard(async () => {
    // ---- merge (3 files incl. unicode names)
    await step('merge-3-unicode', async () => {
      const names = [
        'names/договор №5.pdf',
        'names/合同文件.pdf',
        'names/عقد.pdf',
      ];
      const r = await run('merge-pdf', names, null);
      const f = r.files[0];
      if (!f)
        return H.record('merge-3-unicode', 'FAIL', {
          alert: r.alert,
          toasts: r.toasts,
        });
      const info = await V.pdfInfo(out(f));
      H.check(
        'merge-3-unicode',
        info.pages === 6,
        { pages: info.pages, name: f },
        'FAIL'
      );
      H.record(
        'merge-3-unicode:output-name',
        /\.pdf$/i.test(f) ? 'PASS' : 'FAIL',
        f
      );
    });
    await step('merge-normal-order', async () => {
      const r = await run(
        'merge-pdf',
        ['normal-3p.pdf', 'second-2p.pdf', 'third-1p.pdf'],
        null
      );
      const f = r.files[0];
      const info = f && (await V.pdfInfo(out(f)));
      H.check(
        'merge-3-simple',
        info && info.pages === 6 && /Normal fixture/.test(info.text),
        info || r
      );
    });

    // ---- split
    await step('split', async () => {
      const r = await run(
        'split-pdf',
        ['normal-3p.pdf'],
        async () => {
          await setVal('split-mode', 'range');
          await setVal('page-range', '1-2');
        },
        { expectFiles: 1 }
      );
      const f = r.files[0];
      if (!f)
        return H.record('split-range', 'FAIL', {
          alert: r.alert,
          toasts: r.toasts,
        });
      const kind = V.magic(out(f));
      let pages;
      if (kind === 'pdf') pages = (await V.pdfInfo(out(f))).pages;
      else if (kind === 'zip') pages = await V.zipEntries(out(f));
      H.check(
        'split-range 1-2',
        kind === 'pdf'
          ? pages === 2
          : Array.isArray(pages) && pages.length >= 1,
        { kind, pages, f }
      );
    });

    // ---- compress
    await step('compress', async () => {
      const r = await run(
        'compress-pdf',
        ['scanned-eng.pdf'],
        async () => {
          await setVal('compression-level', 'balanced');
        },
        { wait: 150000 }
      );
      const f = r.files[0];
      if (!f)
        return H.record('compress-scanned', 'FAIL', {
          alert: r.alert,
          toasts: r.toasts,
          ms: r.ms,
        });
      const info = await V.pdfInfo(out(f));
      const inSize = fs.statSync(fx('scanned-eng.pdf')).size;
      const outSize = fs.statSync(out(f)).size;
      H.check('compress-valid-output', info.pages === 2, info);
      H.check(
        'compress-smaller',
        outSize < inSize,
        { inSize, outSize, ms: r.ms },
        'FAIL'
      );
    });

    // ---- rotate
    await step('rotate', async () => {
      const r = await run('rotate-pdf', ['normal-3p.pdf'], async () => {
        await click('rotate-all-right');
      });
      const f = r.files[0];
      if (!f)
        return H.record('rotate-all-right', 'FAIL', {
          alert: r.alert,
          toasts: r.toasts,
        });
      const info = await V.pdfInfo(out(f));
      H.check(
        'rotate-all-right',
        info.pages === 3 && info.rot.every((x) => x === 90),
        info
      );
    });

    // ---- OCR
    await step('ocr', async () => {
      await H.openTool('ocr-pdf', [fx('scanned-eng.pdf')]);
      await H.sleep(2000);
      const langs = await H.js(
        `[...document.querySelectorAll('input[type=checkbox]')].map(c=>c.id+':'+c.value+':'+c.checked).slice(0,8)`
      );
      // select eng if present and not checked
      await H.js(
        `(() => { const c = [...document.querySelectorAll('input[type=checkbox]')].find(x => (x.value||x.id||'').toLowerCase().includes('eng')); if (c && !c.checked) c.click(); return !!c })()`
      );
      const enabled = await H.waitFor(
        () => H.js(`!document.getElementById('process-btn').disabled`),
        15000
      );
      if (!enabled)
        return H.record('ocr-eng', 'FAIL', {
          reason: 'process-btn disabled',
          langs,
        });
      const t0 = Date.now();
      await click('process-btn');
      const text = await H.waitFor(
        async () => {
          const t = await H.js(
            `document.getElementById('ocr-text-output').value || ''`
          );
          return t.length > 40 ? t : null;
        },
        240000,
        1000
      );
      const ms = Date.now() - t0;
      if (!text)
        return H.record('ocr-eng', 'FAIL', {
          alert: await alertState(),
          ms,
          toasts: await toasts(),
        });
      const truth = JSON.parse(
        fs.readFileSync(fx('scanned-ground-truth.json'), 'utf8')
      )
        .join(' ')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 4);
      const got = text.toLowerCase();
      const hit = truth.filter((w) => got.includes(w));
      H.check('ocr-eng-text', hit.length / truth.length >= 0.8, {
        hit: hit.length,
        total: truth.length,
        ms,
        sample: text.slice(0, 120),
      });
      const before = H.listOut().length;
      await click('download-searchable-pdf');
      const got2 = await H.waitFor(
        () => (H.listOut().length > before ? H.listOut().slice(before) : null),
        60000,
        300
      );
      if (got2) {
        const info = await V.pdfInfo(out(got2[0]));
        H.check(
          'ocr-searchable-pdf-has-text-layer',
          info.pages === 2 && /invoice/i.test(info.text),
          info
        );
      } else
        H.record('ocr-searchable-pdf-has-text-layer', 'FAIL', {
          alert: await alertState(),
        });
    });

    // ---- protect -> unlock roundtrip
    let protectedFile = null;
    await step('protect', async () => {
      const r = await run('protect-pdf', ['normal-3p.pdf'], async () => {
        await setVal('user-password-input', 'pw-Round1');
        await setVal('owner-password-input', 'own-Round1');
      });
      const f = r.files[0];
      if (!f)
        return H.record('protect-user-password', 'FAIL', {
          alert: r.alert,
          toasts: r.toasts,
        });
      protectedFile = out(f);
      const enc = await V.isEncrypted(protectedFile);
      H.check('protect-output-requires-password', enc === true, { enc, f });
      let ok = false;
      try {
        ok = (await V.pdfInfo(protectedFile, 'pw-Round1')).pages === 3;
      } catch {
        /* */
      }
      H.check('protect-opens-with-password', ok, f);
    });
    await step('unlock-roundtrip', async () => {
      if (!protectedFile)
        return H.record(
          'unlock-roundtrip',
          'FAIL',
          'no protected file from previous step'
        );
      const copy = fx('_protected-roundtrip.pdf');
      fs.copyFileSync(protectedFile, copy);
      const r = await run(
        'unlock-pdf',
        ['_protected-roundtrip.pdf'],
        async () => {
          await setVal('password-input', 'pw-Round1');
        }
      );
      const f = r.files[0];
      if (!f)
        return H.record('unlock-roundtrip', 'FAIL', {
          alert: r.alert,
          toasts: r.toasts,
        });
      const enc = await V.isEncrypted(out(f));
      const info = await V.pdfInfo(out(f));
      H.check('unlock-roundtrip', enc === false && info.pages === 3, {
        enc,
        pages: info.pages,
      });
      fs.rmSync(copy, { force: true });
    });
    await step('unlock-fixture-right', async () => {
      const r = await run('unlock-pdf', ['enc-user-pw.pdf'], async () => {
        await setVal('password-input', 'open123');
      });
      const f = r.files[0];
      if (!f)
        return H.record('unlock-fixture-right-password', 'FAIL', {
          alert: r.alert,
          toasts: r.toasts,
        });
      H.check(
        'unlock-fixture-right-password',
        (await V.isEncrypted(out(f))) === false &&
          (await V.pdfInfo(out(f))).pages === 2,
        f
      );
    });
    await step('unlock-wrong', async () => {
      const before = H.listOut().length;
      const r = await run(
        'unlock-pdf',
        ['enc-user-pw.pdf'],
        async () => {
          await setVal('password-input', 'WRONG');
        },
        { wait: 25000 }
      );
      const a = r.alert;
      const wrote = H.listOut().length > before;
      const alive = await H.js('1+1')
        .then((v) => v === 2)
        .catch(() => false);
      H.check(
        'unlock-wrong-password-friendly-error',
        !!a && !wrote && alive && !/TypeError|undefined|\bat \w+\(/.test(a.msg),
        { alert: a, wrote, toasts: r.toasts }
      );
    });
    await step('remove-restrictions', async () => {
      const r = await run('remove-restrictions', ['enc-owner-only.pdf'], null, {
        wait: 60000,
      });
      const f = r.files[0];
      if (!f)
        return H.record('remove-restrictions-owner-only', 'FAIL', {
          alert: r.alert,
          toasts: r.toasts,
        });
      H.check(
        'remove-restrictions-owner-only',
        (await V.pdfInfo(out(f))).pages === 2,
        f
      );
    });

    // ---- convert
    await step('pdf-to-jpg', async () => {
      const r = await run('pdf-to-jpg', ['normal-3p.pdf'], null, {
        wait: 60000,
      });
      const f = r.files[0];
      if (!f)
        return H.record('pdf-to-jpg', 'FAIL', {
          alert: r.alert,
          toasts: r.toasts,
        });
      const k = V.magic(out(f));
      const entries = k === 'zip' ? await V.zipEntries(out(f)) : [f];
      H.check(
        'pdf-to-jpg',
        k === 'jpg' ||
          (entries &&
            entries.length === 3 &&
            entries.every((e) => /\.jpe?g$/i.test(e))),
        { k, entries }
      );
    });
    await step('jpg-to-pdf', async () => {
      const r = await run('jpg-to-pdf', ['image.jpg'], null, { wait: 60000 });
      const f = r.files[0];
      if (!f)
        return H.record('jpg-to-pdf', 'FAIL', {
          alert: r.alert,
          toasts: r.toasts,
        });
      H.check(
        'jpg-to-pdf',
        V.magic(out(f)) === 'pdf' && (await V.pdfInfo(out(f))).pages === 1,
        f
      );
    });
    for (const [tool, img] of [
      ['image-to-pdf', 'image.png'],
      ['image-to-pdf', 'image.webp'],
    ]) {
      await step(`${tool}-${img}`, async () => {
        const r = await run(tool, [img], null, { wait: 60000 });
        const f = r.files[0];
        if (!f)
          return H.record(`${tool}-${img}`, 'FAIL', {
            alert: r.alert,
            toasts: r.toasts,
          });
        H.check(
          `${tool}-${img}`,
          V.magic(out(f)) === 'pdf' && (await V.pdfInfo(out(f))).pages === 1,
          f
        );
      });
    }
    H.record(
      'heic-to-pdf',
      'KNOWN-LIMIT',
      'no HEIC encoder available offline in node_modules; fixture not generated'
    );
  })
);
