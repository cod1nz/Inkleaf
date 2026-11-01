'use strict';
const path = require('node:path');

const MAX_READ_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_NAME = 255;

/** Windows long-path prefix for paths > 240 chars. No-op elsewhere. */
function toLongPath(p, platform = process.platform, force = false) {
  if (
    platform !== 'win32' ||
    (!force && p.length <= 240) ||
    p.startsWith('\\\\?\\')
  )
    return p;
  if (p.startsWith('\\\\')) return '\\\\?\\UNC\\' + p.slice(2);
  return '\\\\?\\' + path.win32.resolve(p);
}

/**
 * Path kinds on Windows: 'local' (drive path or \\?\X:\), 'network' (\\server\share, //server/share, \\?\UNC\...),
 * 'device' (\\.\pipe\..., \\?\GLOBALROOT, other device namespaces). Touching a network path makes Windows open an
 * SMB session and send NTLM credentials; device paths can reach named pipes. Elsewhere everything is 'local'.
 */
function pathKind(p, platform = process.platform) {
  if (typeof p !== 'string') return 'device';
  if (platform !== 'win32') return 'local';
  const s = p.replace(/\//g, '\\');
  if (!s.startsWith('\\\\')) return 'local';
  if (/^\\\\\?\\[A-Za-z]:\\/.test(s)) return 'local';
  if (/^\\\\\?\\UNC\\/i.test(s)) return 'network';
  if (/^\\\\[.?]\\/.test(s)) return 'device';
  return 'network';
}

/** Server name of a UNC path (\\server\share\x, //server/share/x, \\?\UNC\server\share\x). */
function uncHost(p) {
  return String(p)
    .replace(/\//g, '\\')
    .replace(/^\\\\(\?\\UNC\\)?/i, '')
    .split('\\')[0];
}

/** Candidate args that look like a PDF path (existence is checked by the caller). */
function pdfArgs(argv, cwd) {
  return argv
    .slice(1)
    .filter(
      (a) => typeof a === 'string' && !a.startsWith('-') && /\.pdf$/i.test(a)
    )
    .map((a) => (cwd ? path.resolve(cwd, a) : a));
}

function openFilters(kind) {
  if (kind === 'any') {
    return [
      {
        name: 'Documents and images',
        extensions: [
          'pdf',
          'png',
          'jpg',
          'jpeg',
          'webp',
          'gif',
          'bmp',
          'tif',
          'tiff',
          'docx',
          'doc',
          'xlsx',
          'xls',
          'pptx',
          'ppt',
          'odt',
          'ods',
          'odp',
          'rtf',
          'txt',
          'epub',
        ],
      },
      { name: 'All files', extensions: ['*'] },
    ];
  }
  return [{ name: 'PDF', extensions: ['pdf'] }];
}

const SAVE_EXT = {
  'application/pdf': ['pdf', 'PDF'],
  'image/png': ['png', 'PNG'],
  'image/jpeg': ['jpg', 'JPEG'],
  'image/webp': ['webp', 'WebP'],
  'image/tiff': ['tiff', 'TIFF'],
  'application/zip': ['zip', 'ZIP archive'],
  'text/plain': ['txt', 'Text'],
  'application/json': ['json', 'JSON'],
};

function saveFilters(mime) {
  const e = SAVE_EXT[mime];
  return e
    ? [{ name: e[1], extensions: [e[0]] }]
    : [{ name: 'All files', extensions: ['*'] }];
}

/**
 * Strip separators and control chars so a suggested name cannot carry a path, and bidi overrides / zero-width
 * chars so it cannot disguise its extension in the save dialog ("invoice\u202Efdp.exe" shows as "invoiceexe.pdf").
 */
function safeFileName(name, fallback = 'document.pdf') {
  if (typeof name !== 'string') return fallback;
  const n = name
    // eslint-disable-next-line no-control-regex
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
      ''
    )
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, MAX_NAME)
    .trim();
  return n || fallback;
}

/** Extensions Windows will execute or open with active content; such outputs get a Mark of the Web. */
const RISKY_EXT =
  /\.(exe|com|scr|pif|cpl|msi|msix|msp|appx|appxbundle|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|reg|jar|dll|sys|chm|iso|img|vhd|vhdx|html?|xhtml|mht(ml)?|svg|docm|dotm|xlsm|xltm|xlam|pptm|potm|ppam|one|application|appref-ms|settingcontent-ms|library-ms|search-ms)$/i;
const isRiskyOutput = (p) => RISKY_EXT.test(String(p).replace(/[. ]+$/, ''));

module.exports = {
  MAX_READ_BYTES,
  toLongPath,
  pathKind,
  uncHost,
  pdfArgs,
  openFilters,
  saveFilters,
  safeFileName,
  isRiskyOutput,
};
