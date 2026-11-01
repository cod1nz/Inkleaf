'use strict';

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "frame-src 'self' blob:",
  "media-src 'self' blob:",
  "form-action 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

// Only for responses under /addons/: the LibreOffice (Emscripten) worker uses new Function. A worker takes its CSP
// from its own script response, so app pages keep the strict CSP. Add-on files are SHA-256 verified before extraction.
const ADDON_CSP = CSP.replace(
  "script-src 'self' 'wasm-unsafe-eval'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'"
);

function securityHeaders({ addon = false } = {}) {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    // <link rel=dns-prefetch> is not covered by CSP and resolves outside webRequest (DNS exfiltration channel).
    'X-DNS-Prefetch-Control': 'off',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': addon ? ADDON_CSP : CSP,
  };
}

module.exports = { CSP, ADDON_CSP, securityHeaders };
