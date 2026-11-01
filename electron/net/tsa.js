'use strict';
const http = require('node:http');
const https = require('node:https');
const { getTsa } = require('./tsa-allowlist');

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;
const MIN_INTERVAL_MS = 2000;

const HASH_OIDS = {
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
  '1.3.14.3.2.26': 'sha1',
};
const HASH_LEN = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };

class TsaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Minimal DER TLV reader. Returns { tag, start, end } or throws. */
function readTlv(buf, pos, limit) {
  if (pos + 2 > limit)
    throw new TsaError('bad_args', 'Malformed timestamp request');
  const tag = buf[pos];
  let len = buf[pos + 1];
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || p + n > limit)
      throw new TsaError('bad_args', 'Malformed timestamp request');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i];
    p += n;
  }
  if (p + len > limit)
    throw new TsaError('bad_args', 'Malformed timestamp request');
  return { tag, start: p, end: p + len };
}

function oidToString(buf, start, end) {
  if (end <= start) return '';
  const parts = [Math.floor(buf[start] / 40), buf[start] % 40];
  let v = 0;
  for (let i = start + 1; i < end; i++) {
    v = v * 128 + (buf[i] & 0x7f);
    if (!(buf[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

/**
 * Parses a DER TimeStampReq and returns { hashAlgo, digestHex }. Accepts only a well-formed request:
 * SEQUENCE { INTEGER version, SEQUENCE messageImprint { SEQUENCE algId, OCTET STRING hash }, ... } with no trailing bytes.
 */
function parseTimeStampReq(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length < 16 || buf.length > MAX_REQUEST_BYTES)
    throw new TsaError('bad_args', 'Invalid timestamp request size');
  const outer = readTlv(buf, 0, buf.length);
  if (outer.tag !== 0x30 || outer.end !== buf.length)
    throw new TsaError('bad_args', 'Malformed timestamp request');
  const ver = readTlv(buf, outer.start, outer.end);
  if (ver.tag !== 0x02)
    throw new TsaError('bad_args', 'Malformed timestamp request');
  const mi = readTlv(buf, ver.end, outer.end);
  if (mi.tag !== 0x30)
    throw new TsaError('bad_args', 'Malformed timestamp request');
  const alg = readTlv(buf, mi.start, mi.end);
  if (alg.tag !== 0x30)
    throw new TsaError('bad_args', 'Malformed timestamp request');
  const oid = readTlv(buf, alg.start, alg.end);
  if (oid.tag !== 0x06)
    throw new TsaError('bad_args', 'Malformed timestamp request');
  const hashAlgo = HASH_OIDS[oidToString(buf, oid.start, oid.end)];
  if (!hashAlgo) throw new TsaError('bad_args', 'Unsupported hash algorithm');
  const dig = readTlv(buf, alg.end, mi.end);
  if (
    dig.tag !== 0x04 ||
    dig.end !== mi.end ||
    dig.end - dig.start !== HASH_LEN[hashAlgo]
  ) {
    throw new TsaError('bad_args', 'Malformed timestamp request');
  }
  return {
    hashAlgo,
    digestHex: buf.subarray(dig.start, dig.end).toString('hex'),
  };
}

/** Same host only (http to https upgrade allowed, never a downgrade). Returns the next URL or null to refuse. */
function checkRedirect(fromUrl, location, count) {
  if (count >= MAX_REDIRECTS || typeof location !== 'string') return null;
  let to;
  try {
    to = new URL(location, fromUrl);
  } catch {
    return null;
  }
  const from = new URL(fromUrl);
  if (to.hostname !== from.hostname) return null;
  if (to.protocol !== 'https:' && to.protocol !== 'http:') return null;
  if (from.protocol === 'https:' && to.protocol === 'http:') return null;
  if (to.username || to.password) return null;
  return to.toString();
}

/** Default transport: one request, no cookies, no automatic redirects. Resolves { status, headers, body }. */
function nodeRequest(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method: 'POST', headers, agent: false, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let n = 0;
        res.on('data', (c) => {
          n += c.length;
          if (n > MAX_RESPONSE_BYTES) {
            req.destroy(
              new TsaError(
                'too_large',
                'The timestamp server sent an unexpectedly large reply'
              )
            );
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
        res.on('error', reject);
      }
    );
    req.on('timeout', () =>
      req.destroy(
        new TsaError('timeout', 'The timestamp server did not answer in time')
      )
    );
    req.on('error', reject);
    req.end(body);
  });
}

let lastCall = 0;
function rateLimit(now = Date.now()) {
  if (now - lastCall < MIN_INTERVAL_MS)
    throw new TsaError(
      'rate_limited',
      'Please wait a moment before requesting another timestamp'
    );
  lastCall = now;
}
function _resetRateLimit() {
  lastCall = 0;
}

/** Performs the RFC 3161 POST. `transport` is injectable for tests. */
async function requestTimestamp({
  tsaId,
  request,
  transport = nodeRequest,
  timeoutMs = TIMEOUT_MS,
}) {
  const tsa = getTsa(tsaId);
  if (!tsa) throw new TsaError('bad_args', 'Unknown timestamp authority');
  const body = Buffer.from(request);
  parseTimeStampReq(body);
  let url = tsa.url;
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await transport(
        url,
        body,
        {
          'Content-Type': 'application/timestamp-query',
          Accept: 'application/timestamp-reply',
          'Content-Length': String(body.length),
          'User-Agent': 'Inkleaf',
        },
        timeoutMs
      );
    } catch (e) {
      if (e instanceof TsaError) throw e;
      throw new TsaError('network', 'Could not reach the timestamp server');
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const next = checkRedirect(url, res.headers && res.headers.location, hop);
      if (!next)
        throw new TsaError(
          'redirect',
          'The timestamp server redirected somewhere unexpected'
        );
      url = next;
      continue;
    }
    if (res.status !== 200)
      throw new TsaError(
        'http_error',
        `The timestamp server refused the request (HTTP ${res.status})`
      );
    const out = Buffer.from(res.body);
    if (out.length > MAX_RESPONSE_BYTES)
      throw new TsaError(
        'too_large',
        'The timestamp server sent an unexpectedly large reply'
      );
    if (out.length < 8 || out[0] !== 0x30)
      throw new TsaError(
        'bad_reply',
        'The timestamp server sent an invalid reply'
      );
    return out;
  }
}

module.exports = {
  TsaError,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  TIMEOUT_MS,
  MAX_REDIRECTS,
  MIN_INTERVAL_MS,
  parseTimeStampReq,
  checkRedirect,
  requestTimestamp,
  rateLimit,
  _resetRateLimit,
};
