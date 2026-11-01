'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.resolve(__dirname, '..', '..');
const { PDFDocument } = require(APP + '/node_modules/pdf-lib');
let pdfjsP;
const pdfjs = () =>
  (pdfjsP ||= import(
    'file:///' +
      (APP + '/node_modules/pdfjs-dist/legacy/build/pdf.mjs').replace(
        /\\/g,
        '/'
      )
  ));

async function pdfInfo(file, password) {
  const data = new Uint8Array(fs.readFileSync(file));
  const lib = await pdfjs();
  const d = await lib.getDocument({ data, password, verbosity: 0 }).promise;
  let text = '';
  for (let i = 1; i <= Math.min(d.numPages, 3); i++)
    text +=
      ' ' +
      (await (await d.getPage(i)).getTextContent()).items
        .map((x) => x.str)
        .join(' ');
  const rot = [];
  for (let i = 1; i <= Math.min(d.numPages, 3); i++)
    rot.push((await d.getPage(i)).rotate);
  const out = { pages: d.numPages, text, rot, size: data.length };
  await d.destroy();
  return out;
}
async function isEncrypted(file) {
  try {
    await pdfInfo(file, undefined);
    return false;
  } catch (e) {
    return e && e.name === 'PasswordException';
  }
}
async function libPages(file) {
  const d = await PDFDocument.load(fs.readFileSync(file), {
    ignoreEncryption: true,
  });
  return d.getPageCount();
}
function magic(file) {
  const b = fs.readFileSync(file).subarray(0, 8);
  if (b.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  return 'other';
}
async function zipEntries(file) {
  try {
    const JSZip = require(APP + '/node_modules/jszip');
    const z = await JSZip.loadAsync(fs.readFileSync(file));
    return Object.keys(z.files);
  } catch {
    return null;
  }
}
module.exports = { pdfInfo, isEncrypted, libPages, magic, zipEntries };
