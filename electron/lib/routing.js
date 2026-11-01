'use strict';

const LOCALES = [
  'en',
  'ar',
  'be',
  'ru',
  'fr',
  'de',
  'es',
  'zh',
  'zh-TW',
  'vi',
  'tr',
  'id',
  'it',
  'pt',
  'pl',
  'nl',
  'da',
  'sv',
  'ko',
  'ja',
  'uk',
  'sk',
  'ca',
  'fa',
];
const LOCALE_SET = new Set(LOCALES);

function variantCandidates(segments) {
  if (segments.length === 0) return ['desktop.html', 'index.html'];
  const p = segments.join('/');
  const last = segments[segments.length - 1];
  if (/\.[A-Za-z0-9]+$/.test(last)) return [p];
  return [`${p}.html`, `${p}/index.html`];
}

/**
 * Ordered relative file candidates (posix style) for a request path.
 * A locale prefix is tried as-is first, then with the prefix removed.
 */
function candidatesFor(segments) {
  const list = variantCandidates(segments);
  if (segments.length > 0 && LOCALE_SET.has(segments[0])) {
    for (const c of variantCandidates(segments.slice(1)))
      if (!list.includes(c)) list.push(c);
  }
  return list;
}

module.exports = { LOCALES, candidatesFor };
