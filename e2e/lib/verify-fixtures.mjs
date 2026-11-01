import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '../..');
const pdfjs = await import(
  pathToFileURL(APP + '/node_modules/pdfjs-dist/legacy/build/pdf.mjs').href
);
const F = APP + '/e2e/.fixtures/';
for (const [f, pw] of [
  ['enc-user-pw.pdf', 'open123'],
  ['enc-user-pw.pdf', 'bad'],
  ['enc-owner-only.pdf', ''],
  ['pages-1000.pdf', ''],
  ['normal-3p.pdf', ''],
  ['large-noise-216mb.pdf', ''],
]) {
  try {
    const d = await pdfjs.getDocument({
      data: new Uint8Array(fs.readFileSync(F + f)),
      password: pw,
    }).promise;
    const t = await (await d.getPage(1)).getTextContent();
    console.log(
      f,
      JSON.stringify(pw),
      d.numPages,
      t.items
        .map((i) => i.str)
        .join(' ')
        .slice(0, 60)
    );
  } catch (e) {
    console.log(f, JSON.stringify(pw), 'ERR', e.name);
  }
}
