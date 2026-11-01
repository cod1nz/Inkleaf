'use strict';
/**
 * Add-on manager (PLAN D9). Electron-free: everything environment specific is injected, so it is unit-testable.
 * States: not-installed | downloading | verifying | installed | error (extraction is reported as 'verifying').
 * Layout: <root>/<name>/manifest.json and <root>/<name>/<version>/... (served read-only at /addons/<name>/<version>/).
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  downloadFile,
  hashFile,
  hashesEqual,
  DownloadError,
} = require('./download');
const { extractZip, ZipError } = require('./zip');
const { isPlaceholder } = require('./manifest');

class AddonError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const SIZE_SLACK = 1024 * 1024;

function friendly(e) {
  if (e instanceof AddonError) return e;
  if (e instanceof DownloadError)
    return new AddonError(
      e.code === 'cancelled' ? 'cancelled' : e.code,
      e.message
    );
  if (e instanceof ZipError) {
    return e.code === 'cancelled'
      ? new AddonError('cancelled', 'Cancelled')
      : new AddonError(
          'bad_archive',
          'The add-on file is damaged or not a valid add-on pack'
        );
  }
  if (e && e.code === 'ENOSPC')
    return new AddonError(
      'no_space',
      'Not enough disk space to install the add-on'
    );
  if (e && (e.code === 'EACCES' || e.code === 'EPERM'))
    return new AddonError(
      'denied',
      'Permission denied while installing the add-on'
    );
  return new AddonError('internal', 'The add-on could not be installed');
}

/**
 * @param {object} cfg
 * @param {string} cfg.root addons root dir (userData/addons)
 * @param {object} cfg.manifest validated manifest entry
 * @param {(ev: object) => void} [cfg.emit] progress sink
 * @param {Function} [cfg.download] injectable downloadFile
 * @param {object} [cfg.zipLimits]
 */
function createManager({
  root,
  manifest,
  emit = () => {},
  download = downloadFile,
  zipLimits,
}) {
  const dir = path.join(root, manifest.name);
  const versionDir = path.join(dir, manifest.version);
  const manifestFile = path.join(dir, 'manifest.json');
  let state = 'not-installed';
  let progress = null;
  let error = null;
  let controller = null;
  let busy = false;
  let lastEmit = 0;

  const host = () => new URL(manifest.url).hostname;

  function publish(force = true) {
    const now = Date.now();
    if (!force && now - lastEmit < 100) return;
    lastEmit = now;
    emit({ name: manifest.name, state, progress, error });
  }
  function setState(s, extra = {}) {
    state = s;
    progress = extra.progress === undefined ? null : extra.progress;
    error = extra.error === undefined ? null : extra.error;
    publish();
  }

  async function readInstalled() {
    try {
      const m = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
      if (
        !m ||
        m.name !== manifest.name ||
        m.version !== manifest.version ||
        !hashesEqual(String(m.sha256), manifest.sha256)
      )
        return false;
      for (const f of manifest.requiredFiles) {
        const st = await fsp.stat(path.join(versionDir, ...f.split('/')));
        if (!st.isFile()) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async function status() {
    if (
      state === 'not-installed' ||
      state === 'installed' ||
      state === 'error'
    ) {
      const ok = await readInstalled();
      if (ok && state !== 'installed') state = 'installed';
      if (!ok && state === 'installed') state = 'not-installed';
    }
    return {
      name: manifest.name,
      title: manifest.title,
      state,
      version: manifest.version,
      sizeBytes: manifest.sizeBytes,
      host: host(),
      available: !isPlaceholder(manifest),
      basePath:
        state === 'installed'
          ? `/addons/${manifest.name}/${manifest.version}/`
          : null,
      progress,
      error,
    };
  }

  /** hash check, extract into a temp dir, atomic rename into place, then record the manifest. */
  async function finalize(zipPath, tmp, signal) {
    setState('verifying');
    const actual = await hashFile(zipPath);
    if (!hashesEqual(actual, manifest.sha256)) {
      throw new AddonError(
        'hash_mismatch',
        'The add-on file does not match the expected checksum, so it was not installed'
      );
    }
    if (signal.aborted) throw new AddonError('cancelled', 'Cancelled');
    const extractDir = path.join(tmp, 'extract');
    await fsp.mkdir(extractDir);
    await extractZip(zipPath, extractDir, { limits: zipLimits, signal });
    for (const f of manifest.requiredFiles) {
      let st;
      try {
        st = await fsp.stat(path.join(extractDir, ...f.split('/')));
      } catch {
        st = null;
      }
      if (!st || !st.isFile())
        throw new AddonError(
          'bad_archive',
          'The add-on file is not a valid add-on pack'
        );
    }
    await fsp.mkdir(dir, { recursive: true });
    const old = path.join(tmp, 'old');
    let hadOld = false;
    try {
      await fsp.rename(versionDir, old);
      hadOld = true;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    try {
      await fsp.rename(extractDir, versionDir);
    } catch (e) {
      if (hadOld) await fsp.rename(old, versionDir).catch(() => {});
      throw e;
    }
    const record = JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      sha256: manifest.sha256,
      sizeBytes: manifest.sizeBytes,
      installedAt: Date.now(),
    });
    const tmpRecord = path.join(tmp, 'manifest.json');
    await fsp.writeFile(tmpRecord, record);
    await fsp.rename(tmpRecord, manifestFile);
    // Drop other versions left over from earlier app releases.
    for (const ent of await fsp
      .readdir(dir, { withFileTypes: true })
      .catch(() => [])) {
      if (
        ent.isDirectory() &&
        ent.name !== manifest.version &&
        !ent.name.startsWith('.tmp-')
      ) {
        await fsp
          .rm(path.join(dir, ent.name), { recursive: true, force: true })
          .catch(() => {});
      }
    }
  }

  async function run(work) {
    if (busy)
      throw new AddonError('busy', 'The add-on is already being installed');
    busy = true;
    controller = new AbortController();
    let tmp = null;
    try {
      await fsp.mkdir(dir, { recursive: true });
      for (const ent of await fsp
        .readdir(dir, { withFileTypes: true })
        .catch(() => [])) {
        if (ent.name.startsWith('.tmp-'))
          await fsp
            .rm(path.join(dir, ent.name), { recursive: true, force: true })
            .catch(() => {});
      }
      tmp = path.join(dir, `.tmp-${crypto.randomBytes(6).toString('hex')}`);
      await fsp.mkdir(tmp);
      await work(tmp, controller.signal);
      setState('installed');
      return await status();
    } catch (e) {
      const fe = friendly(e);
      if (fe.code === 'cancelled')
        setState((await readInstalled()) ? 'installed' : 'not-installed');
      else setState('error', { error: { code: fe.code, message: fe.message } });
      throw fe;
    } finally {
      busy = false;
      controller = null;
      if (tmp)
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  function unavailable() {
    if (isPlaceholder(manifest)) {
      throw new AddonError(
        'unavailable',
        'This add-on has not been published yet, so it cannot be installed in this build'
      );
    }
  }

  return {
    status,
    host,
    isBusy: () => busy,
    /** Downloads from the pinned URL. `confirm` is awaited before any network use. */
    async install(confirm) {
      unavailable();
      if (busy)
        throw new AddonError('busy', 'The add-on is already being installed');
      if (
        !(await confirm({
          sizeBytes: manifest.sizeBytes,
          host: host(),
          title: manifest.title,
        }))
      ) {
        throw new AddonError('cancelled', 'Cancelled');
      }
      return run(async (tmp, signal) => {
        setState('downloading', {
          progress: { received: 0, total: manifest.sizeBytes, percent: 0 },
        });
        const zipPath = path.join(tmp, 'pack.zip');
        await download({
          url: manifest.url,
          destFile: zipPath,
          expectedHost: host(),
          maxBytes: manifest.sizeBytes + SIZE_SLACK,
          signal,
          onProgress: (received, total) => {
            const t = total || manifest.sizeBytes;
            progress = {
              received,
              total: t,
              percent: Math.min(100, Math.floor((received / t) * 100)),
            };
            publish(false);
          },
        });
        await finalize(zipPath, tmp, signal);
      });
    },
    /** Offline sideload from a user-chosen file; same hash + extraction path. Never touches the network. */
    async installFromFile(file) {
      unavailable();
      return run(async (tmp, signal) => {
        const st = await fsp.stat(file);
        if (!st.isFile())
          throw new AddonError(
            'bad_archive',
            'Please choose the add-on .zip file'
          );
        if (st.size > manifest.sizeBytes + SIZE_SLACK)
          throw new AddonError(
            'hash_mismatch',
            'This file is not the expected add-on pack'
          );
        // Work on a private copy so the file cannot change between hashing and extraction.
        const zipPath = path.join(tmp, 'pack.zip');
        await fsp.copyFile(file, zipPath);
        await finalize(zipPath, tmp, signal);
      });
    },
    cancel() {
      if (controller) controller.abort();
      return { cancelled: !!controller };
    },
    async remove() {
      if (busy) throw new AddonError('busy', 'The add-on is being installed');
      await fsp.rm(dir, { recursive: true, force: true });
      setState('not-installed');
      return status();
    },
  };
}

module.exports = { createManager, AddonError };
