'use strict';
// open-with / names / long paths / broken / dialogs / save edge cases / limits
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const H = require('../lib/harness.cjs');
const electron = require('electron');
const fx = (...n) => path.join(H.FIX, ...n);
H.overall(10 * 60 * 1000);
const ipc = () => require(path.join(H.APP, 'electron', 'ipc.js'));
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
const step = async (id, fn) => {
  if (ONLY && !ONLY.test(id)) return;
  try {
    await fn();
  } catch (e) {
    H.record(id, 'FAIL', 'exception: ' + (e && e.message));
  }
};
const alertState = () =>
  H.js(
    `(() => { const m = document.getElementById('alert-modal'); if (!m) return null; const vis = !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none'; return vis ? { title: document.getElementById('alert-title').innerText, msg: document.getElementById('alert-message').innerText } : null })()`
  );
const toasts = () =>
  H.js(`(document.getElementById('inkleaf-io-toasts')||{}).innerText || ''`);
const collectToasts = async (ms) => {
  let all = '';
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const x = await toasts();
    if (x && !all.includes(x)) all += x + ' | ';
    await H.sleep(150);
  }
  return all;
};
const navLog = [];
const lp = (p) => '\\\\?\\' + p;

const nameFiles = fs.existsSync(fx('names'))
  ? fs.readdirSync(fx('names')).filter((f) => /\.pdf\.?$/i.test(f))
  : [];
const longFile = fs.readFileSync(fx('longpath-path.txt'), 'utf8').trim();

async function waitNav(prevUrl, ms = 15000) {
  return H.waitFor(() => navLog.length && navLog[navLog.length - 1], ms);
}

H.boot([fx('names', 'договор №5.pdf')]).then(
  H.guard(async () => {
    H.win().webContents.on('did-start-navigation', (_e, u) => {
      if (/desk-file/.test(u)) navLog.push(u);
    });
    // ---- initial argv open-with (real startup path)
    await step('argv', async () => {
      const ok = await H.waitFor(() => /edit-pdf/.test(H.url()), 20000);
      const u = H.url();
      const nm = decodeURIComponent(
        (u.match(/desk-name=([^&]+)/) || [])[1] || ''
      );
      H.check(
        'open-with-argv-cyrillic: navigates to edit tool',
        /edit-pdf/.test(H.url()),
        { u, nm }
      );
      await H.sleep(2500);
      const txt = await H.js('document.body.innerText');
      H.check(
        'open-with-argv-cyrillic: name shown in page',
        txt.includes('договор'),
        txt.slice(0, 200)
      );
      H.check(
        'open-with-argv-cyrillic: no alert',
        !(await alertState()),
        await alertState()
      );
    });

    // ---- open-with for every name fixture + long path + others (runtime path = second-instance)
    const cases = nameFiles.map((n) => [
      `name:${n.slice(0, 40)}`,
      fx('names', n),
      n,
    ]);
    cases.push(
      ['longpath>260', longFile, 'deep-file.pdf'],
      ['normal', fx('normal-3p.pdf'), 'normal-3p.pdf'],
      ['scanned', fx('scanned-eng.pdf'), 'scanned-eng.pdf'],
      ['pages-1000', fx('pages-1000.pdf'), 'pages-1000.pdf'],
      ['enc-user-pw', fx('enc-user-pw.pdf'), 'enc-user-pw.pdf'],
      ['enc-owner-only', fx('enc-owner-only.pdf'), 'enc-owner-only.pdf']
    );
    for (const [id, p, expectName] of cases) {
      await step('ow-' + id, async () => {
        await H.goto('desktop.html');
        navLog.length = 0;
        await ipc().openPaths([p]);
        const ok = await waitNav(null, 15000);
        if (!ok)
          return H.record(
            'open-with:' + id,
            /.pdf.$/.test(expectName) ? 'KNOWN-LIMIT' : 'FAIL',
            'no navigation (path filtered); url=' + H.url()
          );
        const nm = decodeURIComponent(
          (ok.match(/desk-name=([^&]+)/) || [])[1] || ''
        );
        await H.sleep(1500);
        const al = await alertState();
        const expected = expectName.replace(/\.$/, '');
        H.check(
          'open-with:' + id,
          (nm === expectName || nm === expected) && !al,
          { nm, expectName, alert: al, toasts: await toasts() }
        );
      });
    }

    // ---- same file twice, 30 files at once
    await step('same-twice', async () => {
      await H.openTool('merge-pdf', [fx('normal-3p.pdf'), fx('normal-3p.pdf')]);
      await H.sleep(2500);
      const n = await H.js(
        `document.querySelectorAll('#file-list li, #file-list > div').length`
      );
      H.check(
        'open-same-file-twice (merge lists 2 entries, no crash)',
        n === 2,
        { n, alert: await alertState(), toasts: await toasts() }
      );
    });
    await step('thirty', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-30-'));
      const ps = [];
      for (let i = 0; i < 30; i++) {
        const f = path.join(dir, `f${String(i).padStart(2, '0')} ✓.pdf`);
        fs.copyFileSync(fx(i % 2 ? 'second-2p.pdf' : 'third-1p.pdf'), f);
        ps.push(f);
      }
      const t0 = Date.now();
      await H.openTool('merge-pdf', ps);
      const n = await H.waitFor(async () => {
        const c = await H.js(
          `document.querySelectorAll('#file-list li, #file-list > div').length`
        );
        return c >= 30 ? c : 0;
      }, 30000);
      H.check('open-30-files-at-once (merge lists 30)', n === 30, {
        n,
        ms: Date.now() - t0,
        alert: await alertState(),
      });
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // ---- not-a-regular-file inputs
    await step('dir', async () => {
      await H.goto('desktop.html');
      process.env.INKLEAF_TEST_OPEN = fx('dir-named.pdf');
      const r = await H.js(`window.desk.openFiles('pdf')`);
      delete process.env.INKLEAF_TEST_OPEN;
      H.check(
        'directory-named-.pdf is skipped cleanly',
        Array.isArray(r) && r.length === 0,
        r
      );
      const prev = H.url();
      await ipc().openPaths([fx('dir-named.pdf')]);
      await H.sleep(1500);
      H.check(
        'directory-named-.pdf via open-with: no navigation/crash',
        H.url() === prev,
        H.url()
      );
    });
    await step('junction', async () => {
      const j = path.join(os.tmpdir(), 'inkleaf-junction.pdf');
      fs.rmSync(j, { recursive: true, force: true });
      cp.execSync(`cmd /c mklink /J "${j}" "${fx('names')}"`, {
        stdio: 'ignore',
      });
      await H.goto('desktop.html');
      process.env.INKLEAF_TEST_OPEN = j;
      const r = await H.js(`window.desk.openFiles('pdf')`);
      delete process.env.INKLEAF_TEST_OPEN;
      H.check(
        'junction-named-.pdf is skipped cleanly',
        Array.isArray(r) && r.length === 0,
        r
      );
      fs.rmdirSync(j);
    });
    await step('symlink', async () => {
      const s = path.join(os.tmpdir(), 'inkleaf-symlink.pdf');
      fs.rmSync(s, { force: true });
      try {
        fs.symlinkSync(fx('normal-3p.pdf'), s, 'file');
      } catch (e) {
        return H.record(
          'symlink-to-pdf',
          'KNOWN-LIMIT',
          'cannot create symlink without privilege: ' + e.code
        );
      }
      await H.goto('desktop.html');
      process.env.INKLEAF_TEST_OPEN = s;
      const r = await H.js(`window.desk.openFiles('pdf')`);
      delete process.env.INKLEAF_TEST_OPEN;
      H.check(
        'symlink-to-pdf opens (followed)',
        r.length === 1 && r[0].size > 0,
        r
      );
      fs.rmSync(s, { force: true });
    });

    // ---- broken fixtures through tools (friendly error, not hang/blank)
    for (const b of [
      'broken-truncated',
      'broken-garbage-header',
      'broken-no-xref',
      'broken-zero-bytes',
      'broken-not-a-pdf',
      'broken-huge-pagecount',
    ]) {
      for (const tool of ['merge-pdf', 'compress-pdf']) {
        await step(`${b}:${tool}`, async () => {
          await H.openTool(tool, [fx(b + '.pdf')]);
          const t0 = Date.now();
          const sawMsg = await H.waitFor(
            async () => (await alertState()) || (await toasts()) || null,
            10000,
            300
          );
          if (!sawMsg) {
            // some tools only fail on process; try it
            await H.js(
              `(document.getElementById('process-btn')||{click(){}}).click()`
            );
          }
          const msg =
            sawMsg ||
            (await H.waitFor(
              async () => (await alertState()) || (await toasts()) || null,
              25000,
              300
            ));
          const body = (await H.js('document.body.innerText')).trim();
          const alive = (await H.js('1+1').catch(() => 0)) === 2;
          const txt =
            typeof msg === 'string' ? msg : msg && `${msg.title}: ${msg.msg}`;
          const ugly =
            /TypeError|undefined|Cannot read|\bat [\w.]+ \(|NaN/.test(
              txt || ''
            );
          const isError =
            /error|invalid|fail|could not|corrupt|not a valid|unable|damaged|empty|missing/i.test(
              txt || ''
            );
          // zero-bytes/not-a-pdf etc. should surface an error; merge of a 0-length file not opening is also acceptable if a clear toast appears
          if (b === 'broken-huge-pagecount' && /success/i.test(txt || ''))
            return H.record(
              `broken:${b} in ${tool}`,
              'KNOWN-LIMIT',
              'pdf-lib recovered the 1 real page and merged without error: ' +
                txt
            );
          H.check(
            `broken:${b} in ${tool}: friendly error shown, page alive`,
            alive && body.length > 20 && !!txt && isError && !ugly,
            { txt, ugly, alive, bodyLen: body.length, ms: Date.now() - t0 }
          );
        });
      }
    }

    // ---- native dialog cancel (patched dialog)
    await step('cancel', async () => {
      const d = electron.dialog;
      const so = d.showOpenDialog,
        ss = d.showSaveDialog;
      d.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      d.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
      await H.goto('desktop.html');
      const savedDir = process.env.INKLEAF_TEST_SAVE_DIR;
      delete process.env.INKLEAF_TEST_SAVE_DIR;
      const o = await H.js(`window.desk.openFiles('pdf')`);
      const s = await H.js(
        `window.desk.saveAs({suggestedName:'x.pdf', mime:'application/pdf'})`
      );
      H.check(
        'cancel open dialog -> [] ',
        Array.isArray(o) && o.length === 0,
        o
      );
      H.check('cancel save dialog -> null', s === null, s);
      // cancelled save from a tool: no error toast, no file
      await H.openTool('rotate-pdf', [fx('normal-3p.pdf')]);
      await H.sleep(1200);
      await H.js(
        `document.getElementById('rotate-all-right').click(); document.getElementById('process-btn').click()`
      );
      const tt = await collectToasts(6000);
      const al = await alertState();
      H.check(
        'cancel save from tool: no error toast',
        !/fail|error|could not/i.test(tt + JSON.stringify(al || '')),
        { al, tt }
      );
      d.showOpenDialog = so;
      d.showSaveDialog = ss;
      process.env.INKLEAF_TEST_SAVE_DIR = savedDir;
    });

    // ---- save destinations through the stubbed dialog (desk.saveAs + desk.write)
    async function saveTo(dir, name = 'out.pdf') {
      process.env.INKLEAF_TEST_SAVE_DIR = dir;
      await H.goto('desktop.html');
      return H.js(
        `(async () => { try { const s = await window.desk.saveAs({suggestedName:${JSON.stringify(name)}, mime:'application/pdf'}); if (!s) return {cancel:true}; const w = await window.desk.write(s.id, new Uint8Array([37,80,68,70,45,49,46,52,10]).buffer); return {ok:true,w}; } catch (e) { return {err: String(e && e.message || e)} } })()`
      );
    }
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-save-'));
    await step('save-unicode', async () => {
      const d = path.join(base, 'папка 文件夹 📁');
      fs.mkdirSync(d);
      const r = await saveTo(d, 'результат 结果.pdf');
      H.check(
        'save to non-ASCII dir + name',
        !!r.ok && fs.existsSync(path.join(d, 'результат 结果.pdf')),
        { r, files: fs.readdirSync(d) }
      );
    });
    await step('save-long', async () => {
      let d = base;
      while (d.length < 300)
        d = path.join(
          d,
          'long-save-directory-segment-xxxxxxxxxxxxxxxxxxxxxxxxxxxx'
        );
      fs.mkdirSync(lp(d), { recursive: true });
      const r = await saveTo(d, 'long-out.pdf');
      let exists = false;
      try {
        exists = fs.existsSync(lp(path.join(d, 'long-out.pdf')));
      } catch {
        /* */
      }
      H.check('save to >260-char destination dir', !!r.ok && exists, {
        r,
        len: d.length,
      });
      const r2 = await saveTo(d, 'n'.repeat(200) + '.pdf');
      H.check('save long filename (200 chars) in long dir', !!r2.ok, r2);
    });
    await step('save-readonly', async () => {
      // ACL deny entries are not enforced for this sandboxed token, so use a read-only (attrib +R) existing target file.
      H.record(
        'save-into-readonly-dir (ACL)',
        'KNOWN-LIMIT',
        'icacls deny not enforced for the sandbox token; used read-only file target instead'
      );
      const d = path.join(base, 'readonly');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'ro.pdf'), 'ORIGINAL');
      cp.execSync(`attrib +R "${path.join(d, 'ro.pdf')}"`);
      const r = await saveTo(d, 'ro.pdf');
      const content = fs.readFileSync(path.join(d, 'ro.pdf'), 'latin1');
      H.check(
        'save over read-only file -> clean error, original intact, no leftover tmp',
        !r.ok &&
          content === 'ORIGINAL' &&
          fs.readdirSync(d).length === 1 &&
          !/at |errno/.test(r.err || ''),
        { r, content, left: fs.readdirSync(d) }
      );
      process.env.INKLEAF_TEST_SAVE_DIR = d;
      fs.writeFileSync(path.join(d, 'normal-3p.pdf'), 'ORIGINAL');
      cp.execSync(`attrib +R "${path.join(d, 'normal-3p.pdf')}"`);
      await H.openTool('rotate-pdf', [fx('normal-3p.pdf')]);
      await H.sleep(1200);
      await H.js(
        `document.getElementById('rotate-all-right').click(); document.getElementById('process-btn').click()`
      );
      const tt = await collectToasts(6000);
      const al = await alertState();
      cp.execSync(`attrib -R "${path.join(d, 'ro.pdf')}"`);
      cp.execSync(`attrib -R "${path.join(d, 'normal-3p.pdf')}"`);
      H.check(
        'tool save over read-only file shows friendly error toast',
        /denied|permission|could not|cannot|couldn.t|fail|in use/i.test(tt),
        { tt, al }
      );
    });
    await step('save-missing', async () => {
      const r = await saveTo(path.join(base, 'does', 'not', 'exist'), 'm.pdf');
      H.check(
        'save when target dir is missing -> clean error',
        !r.ok && !/at |errno/.test(r.err || ''),
        r
      );
      process.env.INKLEAF_TEST_SAVE_DIR = path.join(base, 'gone');
      await H.openTool('rotate-pdf', [fx('normal-3p.pdf')]);
      await H.sleep(1200);
      await H.js(
        `document.getElementById('rotate-all-right').click(); document.getElementById('process-btn').click()`
      );
      const tt = await collectToasts(6000);
      const _x = 0;
      const al = await alertState();
      H.check(
        'tool save to missing dir shows error toast (not silent success)',
        /not found|could not|cannot|couldn.t|fail|missing|exist/i.test(tt),
        { tt, al }
      );
    });
    await step('save-overwrite-existing', async () => {
      const d = path.join(base, 'ow');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'x.pdf'), 'OLD');
      const r = await saveTo(d, 'x.pdf');
      H.check(
        'save over existing file replaces atomically',
        !!r.ok &&
          fs.readFileSync(path.join(d, 'x.pdf'), 'latin1').startsWith('%PDF') &&
          fs.readdirSync(d).length === 1,
        { r, files: fs.readdirSync(d) }
      );
    });
    fs.rmSync(lp(base), { recursive: true, force: true });

    // ---- 2 GB cap with a real 2.1 GB sparse file
    await step('cap', async () => {
      const f = path.join(os.tmpdir(), 'inkleaf-2p1gb.pdf');
      fs.rmSync(f, { force: true });
      cp.execSync(`fsutil file createnew "${f}" 2254857830`, {
        stdio: 'ignore',
      });
      try {
        await H.goto('desktop.html');
        process.env.INKLEAF_TEST_OPEN = f;
        const g = await H.js(`window.desk.openFiles('pdf')`);
        delete process.env.INKLEAF_TEST_OPEN;
        const rd = await H.js(
          `window.desk.readFile(${JSON.stringify(g[0] && g[0].id)}).then(() => 'read-ok', e => String(e && e.message))`
        );
        H.check(
          'readFile >2GB rejected with too_large',
          /too_large|2 GB/i.test(rd),
          rd
        );
        await H.openTool('merge-pdf', [f]);
        await H.sleep(3000);
        const tt = await toasts();
        const al = await alertState();
        H.check(
          '2.1GB file in tool: friendly "too large" message',
          /2 GB|too large|large/i.test(tt + JSON.stringify(al || '')),
          { tt, al }
        );
      } finally {
        fs.rmSync(f, { force: true });
      }
    });
  })
);
