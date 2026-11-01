'use strict';
const path = require('node:path');
const {
  app,
  BrowserWindow,
  nativeTheme,
  session,
  screen,
} = require('electron');
const { registerScheme, registerHandler } = require('./protocol');
const ipc = require('./ipc');
const { installMenu, confirmExternal } = require('./menu');
const { isTrustedUrl, isHttpUrl } = require('./lib/trust');
const { pdfArgs } = require('./lib/files');
const { readJson, writeJson } = require('./lib/jsonstore');
const { userDataPath } = require('./paths');

function devUrl() {
  if (app.isPackaged) return null; // never honour dev switches in a packaged build
  const u =
    process.env.INKLEAF_DEV_URL ||
    (process.argv.includes('--dev') ? 'http://localhost:5173' : null);
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(p.hostname)
      ? p.origin
      : null;
  } catch {
    return null;
  }
}
const DEV_URL = devUrl();
const START_URL = DEV_URL
  ? `${DEV_URL.replace(/\/$/, '')}/desktop.html`
  : 'app://bentopdf/';

// Heavy PDF work (cpdf/pdf-lib on 200+ MB inputs) needs far more than V8's default renderer heap cap
// (~4 GB on 64-bit, less under pointer pressure/workers). Allow up to 50% of physical RAM, capped at 8 GB,
// floor 2 GB. Must be set before app 'ready'. Applies to renderers and their workers.
{
  const totalMB = Math.floor(require('node:os').totalmem() / 1048576);
  const heapMB = Math.max(2048, Math.min(8192, Math.floor(totalMB / 2)));
  app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${heapMB}`);
}

// Privacy / exfiltration hardening (must precede 'ready'). Chromium's resolver never answers: <link rel=dns-prefetch>,
// preconnect and WebRTC STUN/TURN lookups bypass webRequest and CSP, and a DNS query alone can leak data.
// The TSA bridge and add-on download run in the main process on Node http(s), which has its own resolver.
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP * ~NOTFOUND, EXCLUDE localhost'
);
app.commandLine.appendSwitch(
  'force-webrtc-ip-handling-policy',
  'disable_non_proxied_udp'
);
// No Chromium background networking (Electron compiles most of it out; belt and braces).
app.commandLine.appendSwitch('disable-background-networking');

registerScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
const stateFile = () => userDataPath('window-state.json');
const bgColor = () => (nativeTheme.shouldUseDarkColors ? '#16171a' : '#ffffff');

function loadBounds() {
  const s = readJson(stateFile(), null);
  const ok =
    s &&
    [s.x, s.y, s.width, s.height].every(Number.isFinite) &&
    s.width >= 400 &&
    s.height >= 300;
  if (!ok) return { width: 1200, height: 800 };
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      s.x < a.x + a.width - 40 &&
      s.x + s.width > a.x + 40 &&
      s.y >= a.y - 10 &&
      s.y < a.y + a.height - 40
    );
  });
  return visible
    ? {
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        maximized: !!s.maximized,
      }
    : { width: s.width, height: s.height };
}

function trackBounds(w) {
  let timer;
  const save = () => {
    if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
    writeJson(stateFile(), {
      ...w.getNormalBounds(),
      maximized: w.isMaximized(),
    });
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  w.on('resize', later);
  w.on('move', later);
  w.on('maximize', later);
  w.on('unmaximize', later);
  w.on('close', save);
}

function createWindow() {
  const { maximized, ...bounds } = loadBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'Inkleaf',
    backgroundColor: bgColor(),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      webviewTag: false,
      allowRunningInsecureContent: false,
      spellcheck: false, // Hunspell dictionaries would be downloaded from Google on Linux
      navigateOnDragDrop: false,
      safeDialogs: true,
      additionalArguments: [`--inkleaf-version=${app.getVersion()}`],
    },
  });
  win.once('ready-to-show', () => {
    if (maximized) win.maximize();
    win.show();
  });
  const onTheme = () =>
    win && !win.isDestroyed() && win.setBackgroundColor(bgColor());
  nativeTheme.on('updated', onTheme);
  trackBounds(win);
  ipc.setRendererReady(false);
  win.webContents.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) ipc.setRendererReady(false);
  });
  win.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame && win && !win.isDestroyed()) win.show(); // never leave an invisible window
  });
  win.on('closed', () => {
    nativeTheme.removeListener('updated', onTheme);
    win = null;
  });
  win.loadURL(START_URL);
}

function hardenContents(contents) {
  // WebRTC (STUN/TURN, host candidates) bypasses webRequest and CSP connect-src: no UDP unless proxied, and the
  // session proxy below is a dead end, so ICE gathering cannot reach the network.
  try {
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  } catch {
    /* not a renderer */
  }
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) confirmExternal(win, url).catch(() => {});
    return { action: 'deny' };
  });
  const block = (event, url) => {
    if (!isTrustedUrl(url, DEV_URL)) {
      event.preventDefault();
      if (isHttpUrl(url)) confirmExternal(win, url).catch(() => {});
    }
  };
  contents.on('will-navigate', block);
  contents.on('will-frame-navigate', (event) => {
    if (
      !isTrustedUrl(event.url, DEV_URL) &&
      !/^(about:blank|blob:)/.test(event.url)
    )
      event.preventDefault();
  });
  contents.on('will-redirect', block);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

async function hardenSession(ses) {
  ses.setSpellCheckerEnabled(false);
  // Defence in depth for traffic webRequest never sees (DNS prefetch, preconnect, WebRTC TCP): send everything
  // through a proxy that does not exist. Main-process network (TSA, add-on download) uses Node http(s), not this
  // session. Loopback stays direct for the dev server.
  await ses.setProxy({
    mode: 'fixed_servers',
    proxyRules: 'socks5://127.0.0.1:9',
    proxyBypassRules: DEV_URL ? '<local>' : '',
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // Defence in depth on top of CSP: nothing leaves the machine from the renderer.
  ses.webRequest.onBeforeRequest((details, cb) => {
    let ok = false;
    try {
      const u = new URL(details.url);
      ok =
        ['app:', 'blob:', 'data:', 'devtools:', 'chrome-extension:'].includes(
          u.protocol
        ) ||
        (!!DEV_URL &&
          (u.origin === DEV_URL || u.origin === DEV_URL.replace('http', 'ws')));
    } catch {
      /* unparsable -> cancel */
    }
    cb({ cancel: !ok });
  });
}

function rebuildMenu(recent = ipc.recentList()) {
  installMenu({
    isDev: !!DEV_URL,
    recent,
    send: (id) => ipc.sendToRenderer('menu', id),
    openRecent: (i) => ipc.openRecentIndex(i),
    clearRecent: () => ipc.clearRecent(),
    getWindow: () => win,
  });
}

app.on('web-contents-created', (_e, contents) => hardenContents(contents));

app.on('second-instance', (_e, argv, cwd) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  ipc.openPaths(pdfArgs(argv, cwd));
});

const pendingMacFiles = [];
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) ipc.openPaths([filePath]);
  else pendingMacFiles.push(filePath);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.whenReady().then(async () => {
  await hardenSession(session.defaultSession);
  registerHandler(session.defaultSession);
  ipc.register({
    devUrl: DEV_URL,
    onRecentChanged: (list) => rebuildMenu(list),
  });
  rebuildMenu();
  createWindow();
  ipc.openPaths([...pdfArgs(process.argv), ...pendingMacFiles]);
});
