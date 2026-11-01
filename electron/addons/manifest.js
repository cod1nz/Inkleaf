'use strict';
const fs = require('node:fs');

/**
 * Pinned add-on pack descriptors (PLAN D9). Replace REPLACE_ME, sha256 and sizeBytes when the pack is published.
 * The app refuses to download while sha256 is the all-zero placeholder.
 */
const VERSION = '1.0.0';
const MANIFEST = Object.freeze({
  libreoffice: Object.freeze({
    name: 'libreoffice',
    title: 'Office converter',
    version: VERSION,
    url: `https://github.com/st1ne/Inkleaf/releases/download/addons-v1/libreoffice-wasm-${VERSION}.zip`,
    sha256: '0'.repeat(64),
    sizeBytes: 75 * 1024 * 1024,
    requiredFiles: Object.freeze(['soffice.js']),
  }),
});

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/** Redirect targets allowed during download (https only). */
const REDIRECT_HOSTS = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

function validateEntry(m) {
  if (!m || typeof m !== 'object') throw new Error('Invalid add-on manifest');
  if (
    !NAME_RE.test(m.name) ||
    !VERSION_RE.test(m.version) ||
    m.version.includes('..')
  )
    throw new Error('Invalid add-on manifest');
  if (!SHA_RE.test(m.sha256)) throw new Error('Invalid add-on manifest hash');
  if (
    !Number.isSafeInteger(m.sizeBytes) ||
    m.sizeBytes <= 0 ||
    m.sizeBytes > 2 * 1024 * 1024 * 1024
  )
    throw new Error('Invalid add-on manifest size');
  const u = new URL(m.url);
  if (u.protocol !== 'https:' || u.username || u.password || u.port)
    throw new Error('Add-on URL must be plain https');
  if (
    !Array.isArray(m.requiredFiles) ||
    !m.requiredFiles.length ||
    m.requiredFiles.some(
      (f) => typeof f !== 'string' || f.includes('..') || f.startsWith('/')
    )
  ) {
    throw new Error('Invalid add-on manifest files');
  }
  return m;
}

const isPlaceholder = (m) => /^0{64}$/.test(m.sha256);

/**
 * Returns the descriptor for an add-on name. A test override (JSON file at INKLEAF_TEST_ADDON_MANIFEST) is honoured
 * only when unpackaged with INKLEAF_TEST=1; `app` is injected so this module stays testable without Electron.
 */
function getManifest(
  name,
  { isPackaged = true, env = process.env, readFile = fs.readFileSync } = {}
) {
  const base = Object.prototype.hasOwnProperty.call(MANIFEST, name)
    ? MANIFEST[name]
    : null;
  if (!base) return null;
  if (
    !isPackaged &&
    env.INKLEAF_TEST === '1' &&
    env.INKLEAF_TEST_ADDON_MANIFEST
  ) {
    const override = JSON.parse(
      readFile(env.INKLEAF_TEST_ADDON_MANIFEST, 'utf8')
    );
    return validateEntry({ ...base, ...override, name: base.name });
  }
  return validateEntry({ ...base });
}

module.exports = {
  MANIFEST,
  REDIRECT_HOSTS,
  getManifest,
  validateEntry,
  isPlaceholder,
};
