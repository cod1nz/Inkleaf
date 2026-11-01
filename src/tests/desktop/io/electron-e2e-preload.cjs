'use strict';
// TEST-ONLY preload: stubs window.desk (the real preload is not touched) and records calls.
const { contextBridge } = require('electron');

const log = [];
const FIXTURE_B64 = process.env.INKLEAF_E2E_PDF_B64 || '';
const b64 = (ab) => {
  let bin = '';
  const u8 = new Uint8Array(ab);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
};
const fromB64 = (str) => {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
};

contextBridge.exposeInMainWorld('desk', {
  platform: process.platform,
  readFile: async (id) => {
    log.push({ fn: 'readFile', id });
    return fromB64(FIXTURE_B64);
  },
  saveAs: async (o) => {
    log.push({
      fn: 'saveAs',
      suggestedName: o && o.suggestedName,
      mime: o && o.mime,
    });
    return { id: 'out-grant-1' };
  },
  write: async (id, data) => {
    let enc;
    try {
      enc = b64(data);
    } catch (e) {
      enc = 'ERR ' + e.message + ' ' + Object.prototype.toString.call(data);
    }
    log.push({ fn: 'write', id, b64: enc });
    return { ok: true };
  },
  revealInFolder: async (id) => {
    log.push({ fn: 'reveal', id });
    return {};
  },
});
contextBridge.exposeInMainWorld('__deskLog', () =>
  JSON.parse(JSON.stringify(log))
);

// Records 'change' events on file inputs from the very start (capture phase on document), since the real
// chrome delivers the hand-off as soon as the page wires its listeners.
const changeSeen = [];
document.addEventListener(
  'change',
  (e) => {
    const t = e.target;
    if (t && t.files)
      changeSeen.push({
        id: t.id,
        names: Array.from(t.files).map(
          (f) => f.name + '|' + f.size + '|' + f.type
        ),
      });
  },
  true
);
contextBridge.exposeInMainWorld('__getChangeSeen', () =>
  JSON.parse(JSON.stringify(changeSeen))
);
