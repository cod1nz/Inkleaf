'use strict';
const { dialog, BrowserWindow } = require('electron');
const { getTsa } = require('./tsa-allowlist');
const tsa = require('./tsa');

/** Registers network-capable IPC (the renderer itself has no network). deps come from ipc.js. */
function register({ handle, DeskError, testHook }) {
  handle('desk:net:timestamp', async (event, opts) => {
    if (!opts || typeof opts !== 'object')
      throw new DeskError('bad_args', 'Invalid options');
    const { tsaId, digestHex, hashAlgo, request } = opts;
    const entry = getTsa(tsaId);
    if (!entry) throw new DeskError('bad_args', 'Unknown timestamp authority');
    let bytes;
    if (request instanceof ArrayBuffer) bytes = Buffer.from(request);
    else if (ArrayBuffer.isView(request))
      bytes = Buffer.from(
        request.buffer,
        request.byteOffset,
        request.byteLength
      );
    else throw new DeskError('bad_args', 'Expected ArrayBuffer');
    if (bytes.length > tsa.MAX_REQUEST_BYTES)
      throw new DeskError('too_large', 'Timestamp request too large');
    let parsed;
    try {
      parsed = tsa.parseTimeStampReq(bytes);
    } catch (e) {
      throw new DeskError('bad_args', e.message);
    }
    if (
      (digestHex !== undefined && digestHex !== parsed.digestHex) ||
      (hashAlgo !== undefined && hashAlgo !== parsed.hashAlgo)
    ) {
      throw new DeskError(
        'bad_args',
        'Timestamp request does not match its digest'
      );
    }
    try {
      tsa.rateLimit();
    } catch (e) {
      throw new DeskError(e.code, e.message);
    }
    const host = new URL(entry.url).hostname;
    if (!(testHook() && process.env.INKLEAF_TEST_CONFIRM === 'yes')) {
      const win = BrowserWindow.fromWebContents(event.sender);
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Contact server', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Timestamp this document',
        message: `Contact ${host} to timestamp this document?`,
        detail: `Only a hash of your document is sent, not the file.\n\nHash (${parsed.hashAlgo}): ${parsed.digestHex.slice(0, 16)}...`,
      });
      if (r.response !== 0)
        throw new DeskError('cancelled', 'Timestamping was cancelled');
    }
    try {
      const out = await tsa.requestTimestamp({ tsaId, request: bytes });
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    } catch (e) {
      throw new DeskError(
        e.code || 'network',
        e.code ? e.message : 'Could not reach the timestamp server'
      );
    }
  });
}

module.exports = { register };
