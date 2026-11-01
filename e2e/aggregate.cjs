'use strict';
// Merges out/results-*.json into results.json and RESULTS.md
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, 'out');
const all = [];
const consoleErrors = {};
for (const f of fs
  .readdirSync(out)
  .filter(
    (x) => /^results-.*\.json$/.test(x) && x !== 'results-explore.json'
  )) {
  const j = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
  all.push(...j.results);
  if (j.consoleErrors && j.consoleErrors.length)
    consoleErrors[j.suite] = j.consoleErrors;
}
let metrics = {};
try {
  metrics = JSON.parse(
    fs.readFileSync(path.join(out, 'metrics-large.json'), 'utf8')
  );
} catch {
  /* none */
}
const count = (s) => all.filter((r) => r.status === s).length;
const summary = {
  PASS: count('PASS'),
  FAIL: count('FAIL'),
  'KNOWN-LIMIT': count('KNOWN-LIMIT'),
  total: all.length,
};
fs.writeFileSync(
  path.join(__dirname, 'results.json'),
  JSON.stringify({ summary, results: all, metrics, consoleErrors }, null, 2)
);
const esc = (s) =>
  String(s || '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
let md = `# Inkleaf real-PDF E2E results\n\nPASS ${summary.PASS} / FAIL ${summary.FAIL} / KNOWN-LIMIT ${summary['KNOWN-LIMIT']} (total ${summary.total})\n\n| Suite | Scenario | Status | Evidence |\n|---|---|---|---|\n`;
for (const r of all)
  md += `| ${r.suite} | ${esc(r.id)} | ${r.status} | ${esc(r.evidence).slice(0, 220)} |\n`;
md += `\n## Large-file metrics\n\n\`\`\`json\n${JSON.stringify(metrics, null, 2)}\n\`\`\`\n`;
fs.writeFileSync(path.join(__dirname, 'RESULTS.md'), md);
console.log(summary);
