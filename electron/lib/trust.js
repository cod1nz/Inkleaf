'use strict';

const APP_ORIGIN_PREFIX = 'app://bentopdf/';

/** True for URLs the renderer may live on. devUrl is e.g. http://localhost:5173 */
function isTrustedUrl(url, devUrl) {
  if (typeof url !== 'string') return false;
  if (url.startsWith(APP_ORIGIN_PREFIX)) return true;
  if (devUrl) {
    try {
      return new URL(url).origin === new URL(devUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { isTrustedUrl, isHttpUrl, APP_ORIGIN_PREFIX };
