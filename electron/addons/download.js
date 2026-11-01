'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const https = require('node:https');
const { REDIRECT_HOSTS } = require('./manifest');

const MAX_REDIRECTS = 3;
const IDLE_TIMEOUT_MS = 30000;

class DownloadError extends Error {
  constructor(message, code = 'download_failed') {
    super(message);
    this.code = code;
  }
}

/** Decides whether a redirect may be followed. Returns the absolute URL or null. */
function checkRedirect(
  fromUrl,
  location,
  count,
  allowedHosts = REDIRECT_HOSTS
) {
  if (
    count >= MAX_REDIRECTS ||
    typeof location !== 'string' ||
    location.length > 4096
  )
    return null;
  let to;
  try {
    to = new URL(location, fromUrl);
  } catch {
    return null;
  }
  if (to.protocol !== 'https:' || to.username || to.password || to.port)
    return null;
  if (!allowedHosts.includes(to.hostname.toLowerCase())) return null;
  return to.toString();
}

/** Default transport: GET over https only. Resolves the IncomingMessage. */
function httpsGet(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers, agent: false, signal, timeout: IDLE_TIMEOUT_MS },
      resolve
    );
    req.on('timeout', () =>
      req.destroy(new DownloadError('The connection timed out'))
    );
    req.on('error', reject);
  });
}

/**
 * Downloads `url` into `destFile`, hashing while streaming. `get` is injectable for tests.
 * Returns { sha256, bytes }. The caller compares the hash BEFORE extracting anything.
 */
async function downloadFile({
  url,
  destFile,
  expectedHost,
  maxBytes,
  onProgress,
  signal,
  get = httpsGet,
}) {
  let current = new URL(url);
  if (current.protocol !== 'https:')
    throw new DownloadError('Downloads must use https');
  if (current.hostname.toLowerCase() !== String(expectedHost).toLowerCase())
    throw new DownloadError('Unexpected download host');
  let res;
  for (let hop = 0; ; hop++) {
    if (signal && signal.aborted)
      throw new DownloadError('Cancelled', 'cancelled');
    try {
      res = await get(
        current.toString(),
        { 'User-Agent': 'Inkleaf', Accept: 'application/octet-stream, */*' },
        signal
      );
    } catch (e) {
      if (e instanceof DownloadError) throw e;
      if (signal && signal.aborted)
        throw new DownloadError('Cancelled', 'cancelled');
      throw new DownloadError(
        'Could not connect. Check your internet connection and try again.',
        'network'
      );
    }
    const status = res.statusCode;
    if ([301, 302, 303, 307, 308].includes(status)) {
      res.resume();
      const next = checkRedirect(current.toString(), res.headers.location, hop);
      if (!next)
        throw new DownloadError(
          'The download was redirected to an untrusted location',
          'redirect'
        );
      current = new URL(next);
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new DownloadError(
        status === 404
          ? 'The add-on file was not found on the server'
          : `The server answered with an error (HTTP ${status})`,
        'http_error'
      );
    }
    break;
  }
  const declared = Number(res.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    throw new DownloadError(
      'The download is larger than expected',
      'too_large'
    );
  }
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(destFile, { flags: 'wx', mode: 0o600 });
  let bytes = 0;
  const total = Number.isFinite(declared) ? declared : 0;
  try {
    await new Promise((resolve, reject) => {
      const fail = (e) => {
        res.destroy();
        out.destroy();
        reject(e);
      };
      const onAbort = () => fail(new DownloadError('Cancelled', 'cancelled'));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes)
          return fail(
            new DownloadError(
              'The download is larger than expected',
              'too_large'
            )
          );
        hash.update(chunk);
        if (!out.write(chunk)) {
          res.pause();
          out.once('drain', () => res.resume());
        }
        if (onProgress) onProgress(bytes, total);
      });
      res.on('error', () =>
        fail(new DownloadError('The connection was interrupted', 'network'))
      );
      res.on('aborted', () =>
        fail(new DownloadError('The connection was interrupted', 'network'))
      );
      out.on('error', (e) => fail(e));
      res.on('end', () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        out.end(resolve);
      });
    });
  } catch (e) {
    await fsp.rm(destFile, { force: true }).catch(() => {});
    throw e;
  }
  if (Number.isFinite(declared) && declared > 0 && bytes !== declared) {
    await fsp.rm(destFile, { force: true }).catch(() => {});
    throw new DownloadError('The download was incomplete', 'network');
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** Streaming SHA-256 of a file on disk. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Constant-time compare of two hex digests. */
function hashesEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length)
    return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

module.exports = {
  downloadFile,
  hashFile,
  hashesEqual,
  checkRedirect,
  DownloadError,
  MAX_REDIRECTS,
};
