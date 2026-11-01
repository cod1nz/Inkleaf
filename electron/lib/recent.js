'use strict';
const path = require('node:path');

/** Pure helpers for the recent-files list: [{ path, name, lastOpened (ms epoch) }], newest first. */
function normalize(list, max) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && typeof r.path === 'string' && r.path)
    .map((r) => ({
      path: r.path,
      name:
        typeof r.name === 'string' && r.name ? r.name : path.basename(r.path),
      lastOpened: Number.isFinite(r.lastOpened) ? r.lastOpened : 0,
    }))
    .slice(0, max);
}

function addEntry(list, p, now, max) {
  return normalize(
    [
      { path: p, name: path.basename(p), lastOpened: now },
      ...list.filter((r) => r.path !== p),
    ],
    max
  );
}

function removeEntry(list, p) {
  return list.filter((r) => r.path !== p);
}

module.exports = { normalize, addEntry, removeEntry };
