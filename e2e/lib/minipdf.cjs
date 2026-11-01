'use strict';
// Tiny deterministic PDF writer (streams to disk) with optional RC4-128 (V2/R3) encryption.
const fs = require('fs');
const crypto = require('crypto');
const PAD = Buffer.from(
  '28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A',
  'hex'
);
const md5 = (...b) =>
  crypto.createHash('md5').update(Buffer.concat(b)).digest();
function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = Buffer.alloc(data.length);
  let a = 0,
    b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    b = (b + S[a]) & 255;
    [S[a], S[b]] = [S[b], S[a]];
    out[k] = data[k] ^ S[(S[a] + S[b]) & 255];
  }
  return out;
}
const padPw = (pw) =>
  Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
function makeEnc(userPw, ownerPw, P) {
  const id = md5(Buffer.from('inkleaf-fixture-id'));
  let h = md5(padPw(ownerPw));
  for (let i = 0; i < 50; i++) h = md5(h);
  const ok = h.subarray(0, 16);
  let O = rc4(ok, padPw(userPw));
  for (let i = 1; i <= 19; i++) O = rc4(Buffer.from(ok.map((x) => x ^ i)), O);
  const Pb = Buffer.alloc(4);
  Pb.writeInt32LE(P);
  let k = md5(padPw(userPw), O, Pb, id);
  for (let i = 0; i < 50; i++) k = md5(k.subarray(0, 16));
  const key = k.subarray(0, 16);
  let U = rc4(key, md5(PAD, id));
  for (let i = 1; i <= 19; i++) U = rc4(Buffer.from(key.map((x) => x ^ i)), U);
  U = Buffer.concat([U, Buffer.alloc(16)]);
  return { key, O, U, P, id };
}
const objKey = (enc, n) => {
  const s = Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0]);
  return md5(enc.key, s).subarray(0, 16);
};
const hex = (b) => '<' + Buffer.from(b).toString('hex') + '>';

/** pages: [{ w,h, text:[lines], images:[{w,h,fill(buf)}] }]; opts: {userPw, ownerPw, P} */
function writePdf(file, pages, opts = {}) {
  const fd = fs.openSync(file, 'w');
  let pos = 0;
  const offs = [];
  const w = (b) => {
    b = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
    fs.writeSync(fd, b);
    pos += b.length;
  };
  const enc =
    opts.userPw !== undefined || opts.ownerPw
      ? makeEnc(
          opts.userPw || '',
          opts.ownerPw || opts.userPw || 'owner',
          opts.P ?? -44
        )
      : null;
  const n = pages.length;
  let next = 4 + (enc ? 1 : 0);
  const encObj = enc ? 4 : 0;
  const pageNums = [];
  const plan = pages.map((p) => {
    const pn = next++,
      cn = next++;
    const imgs = (p.images || []).map(() => next++);
    pageNums.push(pn);
    return { pn, cn, imgs };
  });
  const total = next;
  w('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n');
  const obj = (num, dict, stream) => {
    offs[num] = pos;
    w(`${num} 0 obj\n`);
    if (stream) {
      let s = stream;
      if (enc) s = rc4(objKey(enc, num), s);
      w(dict.replace('>>', `/Length ${s.length} >>`) + '\nstream\n');
      w(s);
      w('\nendstream\nendobj\n');
    } else w(dict + '\nendobj\n');
  };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(
    2,
    `<< /Type /Pages /Count ${n} /Kids [${pageNums.map((x) => x + ' 0 R').join(' ')}] >>`
  );
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  if (enc)
    obj(
      4,
      `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${enc.P} /O ${hex(enc.O)} /U ${hex(enc.U)} >>`
    );
  pages.forEach((p, i) => {
    const { pn, cn, imgs } = plan[i];
    const W = p.w || 612,
      H = p.h || 792;
    const xo = imgs.length
      ? ` /XObject << ${imgs.map((o, k) => `/Im${k} ${o} 0 R`).join(' ')} >>`
      : '';
    obj(
      pn,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${cn} 0 R /Resources << /Font << /F1 3 0 R >>${xo} >> >>`
    );
    let c = '';
    (p.images || []).forEach((im, k) => {
      c += `q ${W} 0 0 ${H} 0 0 cm /Im${k} Do Q\n`;
    });
    (p.text || []).forEach((t, k) => {
      c += `BT /F1 ${p.size || 14} Tf 56 ${H - 72 - k * (p.lead || 22)} Td (${t.replace(/[\\()]/g, '\\$&')}) Tj ET\n`;
    });
    obj(cn, '<< >>', Buffer.from(c, 'latin1'));
    (p.images || []).forEach((im, k) => {
      const buf = Buffer.alloc(im.w * im.h * (im.comps || 3));
      im.fill(buf);
      obj(
        imgs[k],
        `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /${im.comps === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 >>`,
        buf
      );
    });
  });
  const xref = pos;
  w(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++)
    w(String(offs[i]).padStart(10, '0') + ' 00000 n \n');
  const idHex = enc ? hex(enc.id) : hex(md5(Buffer.from(file)));
  w(
    `trailer\n<< /Size ${total} /Root 1 0 R${enc ? ` /Encrypt ${encObj} 0 R` : ''} /ID [${idHex} ${idHex}] >>\nstartxref\n${xref}\n%%EOF\n`
  );
  fs.closeSync(fd);
}
function noiseFill(seed) {
  return (buf) => {
    let s = seed >>> 0 || 1;
    const u = new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
    for (let i = 0; i < u.length; i++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      u[i] = s;
    }
    for (let i = u.length * 4; i < buf.length; i++) buf[i] = i & 255;
  };
}
module.exports = { writePdf, noiseFill };
