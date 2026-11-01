'use strict';
// Shared Electron E2E harness. Each suite is run as: npx electron e2e/suites/<name>.cjs
// It boots the REAL electron/main.js against app/dist (read-only) with a throwaway userData dir.
const path = require('path');
const fs = require('fs');
const os = require('os');
const APP = path.resolve(__dirname, '..', '..');
const E2E = path.join(APP, 'e2e');
const FIX = path.join(E2E, '.fixtures');
const { app, BrowserWindow, nativeTheme } = require('electron');

const suite =
  process.env.E2E_SUITE || path.basename(process.argv[1] || 'suite', '.cjs');
const OUT = path.join(E2E, 'out', suite);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(E2E, 'shots'), { recursive: true });
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-e2e-ud-'));
app.setPath('userData', UD);
process.env.INKLEAF_TEST = '1';
process.env.INKLEAF_TEST_SAVE_DIR = OUT;
process.env.INKLEAF_DIST = process.env.INKLEAF_DIST || path.join(APP, 'dist');
const sf = process.env.E2E_SCALE;
if (sf) app.commandLine.appendSwitch('force-device-scale-factor', sf);

const results = [];
const mainErrors = [];
const consoleErrors = [];
process.on('uncaughtException', (e) => {
  mainErrors.push('uncaughtException: ' + ((e && e.stack) || e));
});
process.on('unhandledRejection', (e) => {
  mainErrors.push('unhandledRejection: ' + ((e && e.stack) || e));
});

function record(id, status, evidence) {
  const ev = typeof evidence === 'string' ? evidence : JSON.stringify(evidence);
  results.push({ suite, id, status, evidence: (ev || '').slice(0, 600) });
  console.log(
    `${status.padEnd(10)} ${id}${status === 'PASS' ? '' : '  :: ' + (ev || '').slice(0, 300)}`
  );
}
const check = (id, ok, evidence, failStatus = 'FAIL') =>
  record(
    id,
    ok ? 'PASS' : failStatus,
    ok ? (typeof evidence === 'string' ? evidence : '') : evidence
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const win = () => BrowserWindow.getAllWindows()[0];
const js = (c) => win().webContents.executeJavaScript(c, true);
const url = () => win().webContents.getURL();

async function waitFor(fn, ms = 20000, step = 150) {
  const t = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    if (Date.now() - t > ms) return false;
    await sleep(step);
  }
}

let started = false;
function boot(argvFiles = [], size) {
  if (started) throw new Error('boot once');
  started = true;
  for (const f of argvFiles) process.argv.push(f);
  require(path.join(APP, 'electron', 'main.js'));
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (_e2, level, message, line, sourceId) => {
      const lv =
        typeof level === 'number'
          ? level
          : { error: 3, warning: 2 }[level] || 1;
      if (lv >= 3) consoleErrors.push(String(message).slice(0, 300));
    });
    wc.on('render-process-gone', (_e2, d) =>
      mainErrors.push('render-process-gone: ' + JSON.stringify(d))
    );
    wc.on('unresponsive', () => mainErrors.push('renderer unresponsive'));
  });
  return app.whenReady().then(async () => {
    await waitFor(
      () => win() && win().webContents.getURL().startsWith('app://'),
      20000
    );
    if (size) win().setContentSize(size[0], size[1]);
  });
}

async function goto(rel, ms = 20000) {
  win().webContents.loadURL('app://bentopdf/' + rel);
  await waitFor(() => url().includes(rel.split('?')[0]), ms);
  await waitFor(
    () => js('document.readyState').then((s) => s === 'complete'),
    ms
  );
  await sleep(300);
}

/** Obtain desk grants for local files via the (stubbed) open dialog. Returns [{id,name,size}] */
async function grant(paths) {
  await goto('desktop.html');
  process.env.INKLEAF_TEST_OPEN = paths.join('|');
  const r = await js(`window.desk.openFiles('any')`);
  delete process.env.INKLEAF_TEST_OPEN;
  return r;
}

/** Open a tool page with the given files handed off exactly like the shell does. */
async function openTool(tool, paths) {
  const gs = await grant(paths);
  const q = gs
    .map(
      (g) =>
        `desk-file=${encodeURIComponent(g.id)}&desk-name=${encodeURIComponent(g.name)}`
    )
    .join('&');
  await goto(`${tool}.html${q ? '?' + q : ''}`);
  return gs;
}

const shot = async (name) => {
  const img = await win().webContents.capturePage();
  const f = path.join(E2E, 'shots', `${name}.png`);
  fs.writeFileSync(f, img.toPNG());
  return f;
};
let CUR = OUT;
let runN = 0;
function newOut() {
  CUR = path.join(OUT, 'r' + ++runN);
  fs.mkdirSync(CUR, { recursive: true });
  process.env.INKLEAF_TEST_SAVE_DIR = CUR;
  return CUR;
}
const curDir = () => CUR;
const listOut = () =>
  fs
    .readdirSync(CUR)
    .filter((f) => !f.includes('.inkleaf') && !f.endsWith('.tmp'));
async function waitOutput(count = 1, ms = 60000, before = 0) {
  return waitFor(
    () => (listOut().length >= before + count ? listOut() : null),
    ms,
    200
  );
}

/** PowerShell working-set sampler over all electron processes of this app (peak MB). */
function startMemSampler() {
  let peak = 0,
    stop = false;
  const tick = async () => {
    while (!stop) {
      try {
        const m = app.getAppMetrics();
        const sum =
          m.reduce(
            (a, p) => a + ((p.memory && (p.memory.workingSetSize || 0)) || 0),
            0
          ) / 1024;
        if (sum > peak) peak = sum;
      } catch {
        /* ignore */
      }
      await sleep(250);
    }
  };
  tick();
  return {
    stop: () => {
      stop = true;
      return Math.round(peak);
    },
  };
}
/** Event-loop responsiveness probe in the renderer: max gap between 50ms timers during fn. */
async function withResponsiveness(fn) {
  await js(
    `window.__gaps = { max: 0, last: performance.now() }; clearInterval(window.__gi); window.__gi = setInterval(() => { const n = performance.now(); window.__gaps.max = Math.max(window.__gaps.max, n - window.__gaps.last); window.__gaps.last = n; }, 50); 0`
  );
  const r = await fn();
  const max = await js(
    `clearInterval(window.__gi); Math.round(window.__gaps.max)`
  );
  return { r, maxGapMs: max };
}

async function finish(extra = {}) {
  record(
    'zz-main-process-errors',
    mainErrors.length ? 'FAIL' : 'PASS',
    mainErrors.join(' | ')
  );
  const f = path.join(E2E, 'out', `results-${suite}.json`);
  fs.writeFileSync(
    f,
    JSON.stringify(
      {
        suite,
        results,
        consoleErrors: [...new Set(consoleErrors)].slice(0, 40),
        ...extra,
      },
      null,
      2
    )
  );
  const fails = results.filter((r) => r.status === 'FAIL').length;
  console.log(`DONE ${suite}: ${results.length} results, ${fails} fail`);
  try {
    fs.rmSync(UD, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  setTimeout(() => app.exit(0), 200);
}
const guard = (fn) => async () => {
  try {
    await fn();
  } catch (e) {
    record('zz-suite-crash', 'FAIL', String((e && e.stack) || e));
  }
  await finish();
};
const overall = (ms) =>
  setTimeout(() => {
    record('zz-suite-timeout', 'FAIL', 'suite exceeded ' + ms + 'ms');
    finish().then(() => process.exit(0));
  }, ms);

module.exports = {
  APP,
  E2E,
  FIX,
  OUT,
  UD,
  app,
  BrowserWindow,
  nativeTheme,
  record,
  check,
  sleep,
  win,
  js,
  url,
  waitFor,
  boot,
  goto,
  grant,
  openTool,
  shot,
  listOut,
  newOut,
  curDir,
  waitOutput,
  startMemSampler,
  withResponsiveness,
  finish,
  guard,
  overall,
  mainErrors,
  consoleErrors,
  results,
};
