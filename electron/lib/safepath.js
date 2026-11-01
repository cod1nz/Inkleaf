'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Turns a URL pathname into validated segments, or null if it is unsafe.
 * Rejects NUL, backslashes, encoded separators, "." / ".." segments,
 * drive-like segments and double-encoded tricks.
 */
function parseUrlPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  const segments = [];
  const raw = pathname.split('/');
  for (let i = 1; i < raw.length; i++) {
    const part = raw[i];
    if (part === '') continue;
    let seg;
    try {
      seg = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (seg === '.' || seg === '..') return null;
    if (/[\0\\/:*?"<>|]/.test(seg)) return null;
    if (/%(2e|2f|5c|00)/i.test(seg)) return null; // double-encoded
    if (/^\.+$/.test(seg) || /[. ]$/.test(seg)) return null; // windows trailing dot/space
    if (/~\d/.test(seg)) return null; // windows 8.3 short names
    if (
      /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(
        seg
      )
    )
      return null; // windows device names
    segments.push(seg);
  }
  return { segments, trailingSlash: pathname.endsWith('/') };
}

function isInside(root, target) {
  const win = process.platform === 'win32';
  const r = win ? root.toLowerCase() : root;
  const t = win ? target.toLowerCase() : target;
  if (t === r) return true;
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** Lexical resolve; returns null if the result escapes root. */
function resolveInside(root, relParts) {
  const rootAbs = path.resolve(root);
  const full = path.resolve(rootAbs, ...relParts);
  return full !== rootAbs && isInside(rootAbs, full) ? full : null;
}

/** Symlink-safe check: the real path of file must lie in one of the real roots. */
async function isRealInside(file, roots) {
  let real;
  try {
    real = await fs.realpath(file);
  } catch {
    return false;
  }
  return roots.some((r) => isInside(r, real));
}

async function realRoots(root) {
  const out = [];
  for (const r of [root, root.replace('app.asar', 'app.asar.unpacked')]) {
    try {
      out.push(await fs.realpath(r));
    } catch {
      /* missing root variant */
    }
  }
  return out;
}

module.exports = {
  parseUrlPath,
  isInside,
  resolveInside,
  isRealInside,
  realRoots,
};
