'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { toLongPath } = require('./files');

/** Writes to a temp file in the same directory, fsyncs, then renames over target. */
async function atomicWrite(target, data) {
  const dir = path.dirname(target);
  const tmpRaw = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  // temp name is longer than target: decide the long-path prefix on the longer one so both agree
  const long = toLongPath(tmpRaw) !== tmpRaw;
  const tmp = long ? toLongPath(tmpRaw) : tmpRaw;
  const dest = long ? toLongPath(target, process.platform, true) : target;
  let fh;
  try {
    fh = await fsp.open(tmp, 'wx', 0o644);
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null;
    await fsp.rename(tmp, dest);
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

module.exports = { atomicWrite };
