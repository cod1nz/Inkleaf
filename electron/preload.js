'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const versionArg = process.argv.find((a) => a.startsWith('--inkleaf-version='));
const version = versionArg
  ? versionArg.slice('--inkleaf-version='.length)
  : '0.0.0';

/** Unwraps {ok,value}|{ok:false,error} from main into a resolved value or a plain Error with .code. */
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && res.ok) return res.value;
  const msg = (res && res.error && res.error.message) || 'Operation failed';
  const code = (res && res.error && res.error.code) || 'internal';
  const err = new Error(`[${code}] ${msg}`);
  // contextBridge drops custom error props and name; only message survives, so the code is the '[code] ' prefix.
  err.code = code;
  throw err;
}

function subscribe(channel, cb) {
  if (typeof cb !== 'function') throw new TypeError('callback required');
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const toArrayBuffer = (u8) =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

contextBridge.exposeInMainWorld('desk', {
  platform: process.platform,
  version,
  openFiles: (kind) => call('desk:openFiles', kind),
  readFile: async (id) => toArrayBuffer(await call('desk:readFile', id)),
  saveAs: (opts) =>
    call('desk:saveAs', {
      suggestedName: opts && opts.suggestedName,
      mime: opts && opts.mime,
    }),
  write: (id, data) => call('desk:write', id, data),
  revealInFolder: (id) => call('desk:reveal', id),
  recent: {
    list: () => call('desk:recent:list'),
    clear: () => call('desk:recent:clear'),
    add: (id) => call('desk:recent:add', id),
    remove: (id) => call('desk:recent:remove', id),
  },
  onOpenWith: (cb) => {
    const off = subscribe('open-with', cb);
    call('desk:ready').catch(() => {});
    return off;
  },
  onMenu: (cb) => subscribe('menu', cb),
  net: {
    // The renderer sends the DER request plus an allowlisted TSA id, never a URL.
    timestamp: async ({ tsaId, request, digestHex, hashAlgo }) =>
      toArrayBuffer(
        await call('desk:net:timestamp', {
          tsaId,
          request,
          digestHex,
          hashAlgo,
        })
      ),
  },
  addons: {
    status: (name) => call('desk:addons:status', name),
    install: (name) => call('desk:addons:install', name),
    installFromFile: (name) => call('desk:addons:installFromFile', name),
    cancel: (name) => call('desk:addons:cancel', name),
    remove: (name) => call('desk:addons:remove', name),
    onProgress: (cb) => subscribe('addons:progress', cb),
  },
  theme: {
    get: () => call('desk:theme:get'),
    onChange: (cb) => subscribe('theme', cb),
  },
});
