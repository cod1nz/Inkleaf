'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  app,
  ipcMain,
  dialog,
  shell,
  BrowserWindow,
  nativeTheme,
} = require('electron');
const { isTrustedUrl } = require('./lib/trust');
const {
  MAX_READ_BYTES,
  toLongPath,
  pathKind,
  uncHost,
  openFilters,
  saveFilters,
  safeFileName,
  isRiskyOutput,
} = require('./lib/files');
const { atomicWrite } = require('./lib/atomic');
const { readJson, writeJson } = require('./lib/jsonstore');
const { userDataPath } = require('./paths');
const { normalize, addEntry, removeEntry } = require('./lib/recent');

const MAX_GRANTS = 2000;
const MAX_RECENT = 10;

// Test hook: only when running unpackaged with INKLEAF_TEST=1. Replaces native dialogs with env-provided paths.
const testHook = () => !app.isPackaged && process.env.INKLEAF_TEST === '1';

class DeskError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const grants = new Map(); // id -> { path, name, mode: 'in' | 'out' }
const inputIds = new Map(); // path -> id (reuse ids for the same input)
let devUrl = null;
let pendingOpenWith = [];
let rendererReady = false;
let onRecentChanged = () => {};

const recentFile = () => userDataPath('recent.json');
const mainWindow = () => BrowserWindow.getAllWindows()[0] || null;

function grant(p, mode) {
  if (mode === 'in' && inputIds.has(p) && grants.has(inputIds.get(p)))
    return inputIds.get(p);
  if (grants.size >= MAX_GRANTS) {
    const oldest = grants.keys().next().value;
    const g = grants.get(oldest);
    if (g.mode === 'in') inputIds.delete(g.path);
    grants.delete(oldest);
  }
  const id = crypto.randomUUID();
  grants.set(id, { path: p, name: path.basename(p), mode });
  if (mode === 'in') inputIds.set(p, id);
  return id;
}

function getGrant(id, mode) {
  if (typeof id !== 'string' || id.length > 64)
    throw new DeskError('bad_args', 'Invalid file id');
  const g = grants.get(id);
  if (!g || g.mode !== mode)
    throw new DeskError('not_granted', 'File access not granted');
  return g;
}

function publicError(e) {
  if (e instanceof DeskError) return { code: e.code, message: e.message };
  switch (e && e.code) {
    case 'ENOENT':
      return { code: 'not_found', message: 'File not found' };
    case 'EACCES':
    case 'EPERM':
      return { code: 'denied', message: 'Permission denied' };
    case 'EBUSY':
      return { code: 'busy', message: 'File is in use' };
    case 'ENOSPC':
      return { code: 'no_space', message: 'Not enough disk space' };
    default:
      return { code: 'internal', message: 'Operation failed' };
  }
}

function senderOk(event) {
  const f = event.senderFrame;
  return (
    !!f &&
    f.parent === null &&
    f === event.sender.mainFrame &&
    isTrustedUrl(f.url, devUrl)
  );
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!senderOk(event))
      return { ok: false, error: { code: 'forbidden', message: 'Forbidden' } };
    try {
      return { ok: true, value: await fn(event, ...args) };
    } catch (e) {
      return { ok: false, error: publicError(e) };
    }
  });
}

async function statRegular(p) {
  const st = await fsp.stat(toLongPath(p));
  if (!st.isFile()) throw new DeskError('not_file', 'Not a regular file');
  return st;
}

async function describe(p) {
  const st = await statRegular(p);
  return { id: grant(p, 'in'), name: path.basename(p), size: st.size };
}

/** Reads a granted input through one handle, so the size check and the read see the same file. */
async function readGranted(p) {
  const fh = await fsp.open(toLongPath(p), 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new DeskError('not_file', 'Not a regular file');
    if (st.size > MAX_READ_BYTES)
      throw new DeskError('too_large', 'File exceeds 2 GB limit');
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    while (off < st.size) {
      const { bytesRead } = await fh.read(buf, off, st.size - off, off);
      if (bytesRead === 0) break; // truncated meanwhile: return what is there
      off += bytesRead;
    }
    return off === st.size ? buf : buf.subarray(0, off);
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Network (UNC) paths that did not come from a native dialog or a menu click (argv, open-file, second instance)
 * need consent: touching \\server\share makes Windows connect over SMB and send the user's NTLM credentials.
 */
async function confirmNetworkOpen(paths) {
  if (testHook()) return process.env.INKLEAF_TEST_CONFIRM === 'yes';
  const w = mainWindow();
  const { response } = await dialog.showMessageBox(
    w && !w.isDestroyed() ? w : undefined,
    {
      type: 'warning',
      buttons: ['Open', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message:
        paths.length > 1
          ? `Open ${paths.length} files from a network location?`
          : 'Open a file from a network location?',
      detail: `${paths[0].slice(0, 300)}\n\nThis connects to "${uncHost(paths[0]).slice(0, 100)}" and may send your Windows sign-in to that computer. Only continue if you trust it.`,
    }
  );
  return response === 0;
}

// ---- recent files ----
const recentList = () => normalize(readJson(recentFile(), []), MAX_RECENT);

function addRecent(p) {
  const list = addEntry(recentList(), p, Date.now(), MAX_RECENT);
  writeJson(recentFile(), list);
  try {
    app.addRecentDocument(p);
  } catch {
    /* unsupported platform */
  }
  onRecentChanged(list);
}

function removeRecent(p) {
  const list = removeEntry(recentList(), p);
  writeJson(recentFile(), list);
  onRecentChanged(list);
}

function clearRecent() {
  writeJson(recentFile(), []);
  try {
    app.clearRecentDocuments();
  } catch {
    /* ignore */
  }
  onRecentChanged([]);
}

// ---- open with ----
function setRendererReady(v) {
  rendererReady = !!v;
}

function sendToRenderer(channel, payload) {
  const w = mainWindow();
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

/** Validates paths from argv / open-file / recent menu and delivers them to the renderer. */
async function openPaths(paths, { userChosen = false } = {}) {
  const files = [];
  let candidates = [];
  for (const p of Array.isArray(paths) ? paths.slice(0, 200) : []) {
    if (typeof p !== 'string' || p.length > 32000 || !/\.pdf$/i.test(p))
      continue;
    const abs = path.resolve(p);
    const kind = pathKind(abs);
    if (kind === 'device') continue; // \\.\pipe\..., \\?\GLOBALROOT\...: never
    candidates.push({ abs, network: kind === 'network' });
  }
  const remote = candidates.filter((c) => c.network).map((c) => c.abs);
  if (
    remote.length &&
    !userChosen &&
    !(await confirmNetworkOpen(remote).catch(() => false))
  ) {
    candidates = candidates.filter((c) => !c.network);
  }
  for (const { abs } of candidates) {
    try {
      files.push(await describe(abs));
      addRecent(abs);
    } catch {
      /* skip missing / non-regular */
    }
  }
  if (!files.length) return;
  if (rendererReady && mainWindow()) {
    sendToRenderer('open-with', files);
  } else {
    pendingOpenWith.push(...files);
  }
  const w = mainWindow();
  if (w) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
}

function openRecentIndex(i) {
  const r = recentList()[i];
  return r ? openPaths([r.path], { userChosen: true }) : undefined;
}

function register(opts = {}) {
  devUrl = opts.devUrl || null;
  onRecentChanged = opts.onRecentChanged || onRecentChanged;

  handle('desk:ready', (event) => {
    rendererReady = true;
    if (pendingOpenWith.length) {
      event.sender.send('open-with', pendingOpenWith);
      pendingOpenWith = [];
    }
  });

  handle('desk:openFiles', async (event, kind) => {
    if (kind !== undefined && kind !== 'pdf' && kind !== 'any')
      throw new DeskError('bad_args', 'Invalid kind');
    const win = BrowserWindow.fromWebContents(event.sender);
    const res =
      testHook() && process.env.INKLEAF_TEST_OPEN
        ? {
            canceled: false,
            filePaths: process.env.INKLEAF_TEST_OPEN.split('|'),
          }
        : await dialog.showOpenDialog(win, {
            properties: ['openFile', 'multiSelections'],
            filters: openFilters(kind || 'pdf'),
          });
    if (res.canceled) return [];
    const out = [];
    for (const p of res.filePaths.slice(0, 200)) {
      try {
        out.push(await describe(p));
        if (/\.pdf$/i.test(p)) addRecent(p);
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  });

  handle('desk:readFile', async (_e, id) => {
    const g = getGrant(id, 'in');
    const buf = await readGranted(g.path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });

  handle('desk:saveAs', async (event, opts2) => {
    if (!opts2 || typeof opts2 !== 'object')
      throw new DeskError('bad_args', 'Invalid options');
    const { suggestedName, mime } = opts2;
    if (typeof suggestedName !== 'string' || suggestedName.length > 512)
      throw new DeskError('bad_args', 'Invalid name');
    if (mime !== undefined && (typeof mime !== 'string' || mime.length > 100))
      throw new DeskError('bad_args', 'Invalid mime');
    const win = BrowserWindow.fromWebContents(event.sender);
    const res =
      testHook() && process.env.INKLEAF_TEST_SAVE_DIR
        ? {
            canceled: false,
            filePath: path.join(
              process.env.INKLEAF_TEST_SAVE_DIR,
              safeFileName(suggestedName)
            ),
          }
        : await dialog.showSaveDialog(win, {
            defaultPath: safeFileName(suggestedName),
            filters: saveFilters(mime),
          });
    if (res.canceled || !res.filePath) return null;
    return { id: grant(res.filePath, 'out') };
  });

  handle('desk:write', async (_e, id, data) => {
    const g = getGrant(id, 'out');
    let buf;
    if (data instanceof ArrayBuffer) buf = Buffer.from(data);
    else if (ArrayBuffer.isView(data))
      buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else throw new DeskError('bad_args', 'Expected ArrayBuffer');
    if (buf.byteLength > MAX_READ_BYTES)
      throw new DeskError('too_large', 'Data exceeds 2 GB limit');
    await atomicWrite(g.path, buf);
    // Bytes from an untrusted PDF (e.g. an extracted attachment) saved under an executable / active-content name:
    // tag them like a browser download so SmartScreen / Office Protected View still apply.
    if (process.platform === 'win32' && isRiskyOutput(g.path)) {
      await fsp
        .writeFile(
          toLongPath(`${g.path}:Zone.Identifier`),
          '[ZoneTransfer]\r\nZoneId=3\r\n'
        )
        .catch(() => {});
    }
    return { ok: true };
  });

  handle('desk:reveal', (_e, id) => {
    if (typeof id !== 'string' || id.length > 64)
      throw new DeskError('bad_args', 'Invalid file id');
    const g = grants.get(id);
    if (!g) throw new DeskError('not_granted', 'File access not granted');
    shell.showItemInFolder(g.path);
  });

  handle('desk:recent:list', async () => {
    const out = [];
    for (const r of recentList()) {
      try {
        // Listing must not touch network shares (SMB connect + NTLM on every home render); size is unknown then.
        const entry =
          pathKind(r.path) === 'local'
            ? await describe(r.path)
            : { id: grant(r.path, 'in'), name: path.basename(r.path), size: 0 };
        out.push({ ...entry, lastOpened: r.lastOpened });
      } catch {
        /* gone */
      }
    }
    return out;
  });
  handle('desk:recent:clear', () => clearRecent());
  handle('desk:recent:remove', (_e, id) => {
    removeRecent(getGrant(id, 'in').path);
  });
  handle('desk:recent:add', (_e, id) => {
    addRecent(getGrant(id, 'in').path);
  });

  handle('desk:theme:get', () =>
    nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  );
  nativeTheme.on('updated', () =>
    sendToRenderer('theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  );

  // Network-capable features live in the main process only (renderer has no network): TSA bridge + add-ons.
  const deps = { handle, DeskError, testHook, sendToRenderer };
  require('./net').register(deps);
  require('./addons').register(deps);
}

module.exports = {
  register,
  openPaths,
  openRecentIndex,
  recentList,
  clearRecent,
  sendToRenderer,
  setRendererReady,
};
