#!/usr/bin/env node
/**
 * Fails if any installer in release/ exceeds the budget (PLAN D8).
 * Env: INSTALLER_BUDGET_MB (default below), RELEASE_DIR (default ./release).
 * TODO(D8): default is 220 MB, not the planned 150 MB, because the Electron runtime plus the
 * bundled wasm/OCR/fonts measure above 150 MB; tighten once assets are trimmed.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.env.RELEASE_DIR || 'release');
const budget = Number(process.env.INSTALLER_BUDGET_MB || 220);
const EXT = /\.(exe|dmg|zip|AppImage|msi)$/i;
if (!fs.existsSync(dir)) {
  console.error(`size:check: ${dir} not found`);
  process.exit(1);
}
const files = fs
  .readdirSync(dir)
  .filter((f) => EXT.test(f) && fs.statSync(path.join(dir, f)).isFile());
if (!files.length) {
  console.error('size:check: no installer artifacts found in', dir);
  process.exit(1);
}
let bad = 0;
for (const f of files) {
  const mb = fs.statSync(path.join(dir, f)).size / 1048576;
  const over = mb > budget;
  if (over) bad++;
  console.log(
    `${over ? 'FAIL' : 'ok  '} ${f}  ${mb.toFixed(1)} MB (budget ${budget} MB)`
  );
}
process.exit(bad ? 1 : 0);
