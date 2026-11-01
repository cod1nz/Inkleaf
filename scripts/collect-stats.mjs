#!/usr/bin/env node
// Collects Inkleaf desktop project statistics and prints them as JSON on stdout.
// Read-only: nothing is written. Usage (from app/):
//   node scripts/collect-stats.mjs > docs-desktop/stats.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (...p) => path.join(APP, ...p);
const exists = (p) => fs.existsSync(p);

// ---- 1. Tools (same structure as src/js/config/tools.ts: categories -> tools, id = href basename) ----
function readTools() {
  const src = fs.readFileSync(rel('src/js/config/tools.ts'), 'utf8');
  const lines = src.split(/\r?\n/);
  const categories = [];
  let current = null;
  for (const line of lines) {
    const cat = line.match(/^ {4}name: '(.+)',$/);
    if (cat) {
      current = { name: cat[1], tools: [] };
      categories.push(current);
      continue;
    }
    const href = line.match(
      /^ {8}href: import\.meta\.env\.BASE_URL \+ '([^']+)',$/
    );
    if (href && current) {
      current.tools.push({ href: href[1] });
    }
  }
  // Same id rule as getToolIdFromHref in tools.ts.
  const idOf = (href) => href.match(/\/([^/]+)\.html$/)?.[1] ?? href;
  const perCategory = categories.map((c) => ({
    name: c.name,
    entries: c.tools.length,
    ids: c.tools.map((t) => idOf(t.href)),
  }));
  const unique = new Set(perCategory.flatMap((c) => c.ids));
  return {
    categories_count: perCategory.length,
    unique_tool_pages: unique.size,
    entries_across_categories: perCategory.reduce((a, c) => a + c.entries, 0),
    per_category: Object.fromEntries(
      perCategory.map((c) => [c.name, c.entries])
    ),
    per_category_unique: Object.fromEntries(
      perCategory.map((c) => [c.name, new Set(c.ids).size])
    ),
  };
}

// ---- 2. Dist ----
function walk(dir, acc = { bytes: 0, files: 0 }) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.isFile()) {
      acc.bytes += fs.statSync(p).size;
      acc.files += 1;
    }
  }
  return acc;
}

function readDist() {
  const dist = rel('dist');
  if (!exists(dist)) return null;
  const pages = fs
    .readdirSync(dist)
    .filter((f) => f.endsWith('.html'))
    .sort();
  const total = walk(dist);
  const localeDir = path.join(dist, 'locales');
  const localeFolders = exists(localeDir)
    ? fs
        .readdirSync(localeDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  // Translated HTML pages would live in a top-level folder named after a locale (none expected).
  const routingSrc = fs.readFileSync(rel('electron/lib/routing.js'), 'utf8');
  const routeLocales = (routingSrc.match(/LOCALES = \[([^\]]+)\]/)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/'/g, ''))
    .filter(Boolean);
  const translatedPages = {};
  for (const loc of routeLocales) {
    const d = path.join(dist, loc);
    if (exists(d) && fs.statSync(d).isDirectory()) {
      const html = fs
        .readdirSync(d, { recursive: true })
        .filter((f) => String(f).endsWith('.html')).length;
      if (html > 0) translatedPages[loc] = html;
    }
  }
  return {
    html_pages_top_level: pages.length,
    total_files: total.files,
    size_bytes: total.bytes,
    size_mb: Number((total.bytes / 1e6).toFixed(1)),
    locale_json_folders: localeFolders,
    locale_json_folder_count: localeFolders.length,
    translated_html_pages_by_locale: translatedPages,
    ui_languages: Object.keys(translatedPages).length
      ? ['en', ...Object.keys(translatedPages)]
      : ['en'],
  };
}

// ---- 3. Tests (read only from e2e/results.json; unit test counts are not stored in a file) ----
function readTests() {
  const p = rel('e2e/results.json');
  if (!exists(p))
    return { e2e: null, unit: null, note: 'e2e/results.json not found' };
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const s = j.summary ?? {};
  return {
    e2e: {
      total: s.total ?? j.results?.length ?? null,
      pass: s.PASS ?? null,
      fail: s.FAIL ?? null,
      known_limit: s['KNOWN-LIMIT'] ?? null,
    },
    unit: null,
    note: 'unit test counts are not recorded in a file; run `npx vitest run` / `node --test` to obtain them',
  };
}

// ---- 4. Installers ----
function readInstallers() {
  const dir = rel('release');
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(exe|dmg)$/i.test(f))
    .sort()
    .map((f) => {
      const bytes = fs.statSync(path.join(dir, f)).size;
      return {
        file: f,
        size_bytes: bytes,
        size_mb: Number((bytes / 1e6).toFixed(1)),
      };
    });
}

// ---- 5. Third-party notices (rows = <tr> with <td> cells, header rows excluded) ----
function readNotices() {
  const p = rel('public/third-party-notices.html');
  if (!exists(p)) return null;
  const html = fs.readFileSync(p, 'utf8');
  const sections = html
    .split(/<h2>/)
    .slice(1)
    .map((chunk) => {
      const title = chunk.match(/^([^<]+)<\/h2>/)?.[1]?.trim() ?? '';
      const rows = (chunk.match(/<tr>\s*<td>/g) || []).length;
      return { title, rows };
    });
  const totalRows = sections.reduce((a, s) => a + s.rows, 0);
  const jsHeading = sections.find((s) => /JavaScript packages/i.test(s.title));
  return {
    total_rows: totalRows,
    sections,
    javascript_packages_listed: jsHeading ? jsHeading.rows : null,
    javascript_packages_heading_count:
      Number(jsHeading?.title.match(/\((\d+)\)/)?.[1] ?? NaN) || null,
  };
}

const tools = readTools();
const stats = {
  generated_by: 'scripts/collect-stats.mjs',
  tools,
  dist: readDist(),
  tests: readTests(),
  installers: readInstallers(),
  third_party_notices: readNotices(),
};
process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
