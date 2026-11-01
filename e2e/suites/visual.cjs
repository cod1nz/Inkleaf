'use strict';
// DPI / viewport / dark-mode screenshots. Run with E2E_SCALE=1.5 etc.
const path = require('path');
const fs = require('fs');
const H = require('../lib/harness.cjs');
const fx = (...n) => path.join(H.FIX, ...n);
H.overall(5 * 60 * 1000);
const scale = process.env.E2E_SCALE || '1';
const tag = (s) => `s${scale}-${s}`;
const longName = fs.readdirSync(fx('names')).find((n) => n.startsWith('xxxx'));
const overflowProbe = `(() => {
  const de = document.documentElement;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > innerWidth + 1 || r.left < -1) { if (cs.position !== 'fixed' || r.width < innerWidth * 2) bad.push('offscreen:' + el.tagName + '.' + String(el.className).slice(0, 40) + ':' + Math.round(r.left) + '..' + Math.round(r.right)); }
    if (el.children.length === 0 && el.textContent.trim().length > 3 && el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && cs.overflowX === 'visible' && el.clientWidth > 0) bad.push('text-overflow:' + el.tagName + '.' + String(el.className).slice(0, 40) + ':' + el.textContent.trim().slice(0, 30));
  }
  return { hscroll: de.scrollWidth > de.clientWidth + 1, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, bad: bad.slice(0, 8) };
})()`;

H.boot().then(
  H.guard(async () => {
    // populate Recent with a very long filename + unicode
    await H.goto('desktop.html');
    const ipc = require(path.join(H.APP, 'electron', 'ipc.js'));
    for (const p of [
      fx('names', longName),
      fx('names', 'договор №5.pdf'),
      fx('names', '合同文件.pdf'),
      fx('normal-3p.pdf'),
    ]) {
      process.env.INKLEAF_TEST_OPEN = p;
      await H.js(
        `window.desk.openFiles('pdf').then(f => window.desk.recent.add(f[0].id))`
      );
    }
    delete process.env.INKLEAF_TEST_OPEN;
    for (const [w, h] of [
      [1366, 768],
      [800, 600],
    ]) {
      H.win().setContentSize(w, h);
      await H.sleep(500);
      for (const theme of ['light', 'dark']) {
        H.nativeTheme.themeSource = theme;
        await H.sleep(500);
        await H.goto('desktop.html');
        await H.sleep(700);
        const key = `${w}x${h}-${theme}`;
        await H.shot(tag(`home-${key}`));
        const pr = await H.js(overflowProbe);
        const dark = await H.js(
          `getComputedStyle(document.body).backgroundColor`
        );
        H.record(
          `visual:${tag('home')}:${key}:no-overflow`,
          pr.hscroll || pr.bad.length ? 'FAIL' : 'PASS',
          { ...pr, bodyBg: dark }
        );
        // theme actually follows system
        const isDarkDom = await H.js(
          `document.documentElement.dataset.theme || document.documentElement.className`
        );
        H.record(
          `visual:${tag('theme-follows-system')}:${theme}`,
          /dark/i.test(String(isDarkDom)) === (theme === 'dark') ||
            (theme === 'light' && !/dark/i.test(String(isDarkDom)))
            ? 'PASS'
            : 'FAIL',
          { dom: isDarkDom, bodyBg: dark }
        );
        // merge page with long + unicode names
        await H.openTool('merge-pdf', [
          fx('names', longName),
          fx('names', 'договор №5.pdf'),
          fx('names', '合同文件.pdf'),
        ]);
        await H.sleep(1200);
        await H.shot(tag(`merge-${key}`));
        const pm = await H.js(overflowProbe);
        H.record(
          `visual:${tag('merge')}:${key}:no-overflow`,
          pm.hscroll || pm.bad.length ? 'FAIL' : 'PASS',
          pm
        );
        // palette
        await H.goto('desktop.html');
        H.win().webContents.focus();
        for (const type of ['keyDown', 'keyUp'])
          H.win().webContents.sendInputEvent({
            type,
            keyCode: 'K',
            modifiers: ['control'],
          });
        await H.sleep(700);
        const opened = await H.js(
          `!!document.querySelector('[role=dialog], [class*=palette]')`
        );
        try {
          await H.shot(tag(`palette-${key}`));
        } catch (e) {
          H.record('visual:capturePage-failed:' + key, 'FAIL', e.message);
        }
        const pp = await H.js(overflowProbe);
        H.record(
          `visual:${tag('palette')}:${key}`,
          opened && !pp.hscroll ? 'PASS' : 'FAIL',
          { opened, ...pp }
        );
        for (const type of ['keyDown', 'keyUp'])
          H.win().webContents.sendInputEvent({ type, keyCode: 'Escape' });
        // titlebar long names (document.title)
        if (w === 1366 && theme === 'light')
          H.record(`visual:${tag('window-title')}`, 'PASS', H.win().getTitle());
      }
    }
  })
);
