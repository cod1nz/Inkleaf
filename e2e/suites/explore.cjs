const H = require('../lib/harness.cjs');
const path = require('path');
H.overall(120000);
H.boot().then(
  H.guard(async () => {
    for (const t of [
      'merge-pdf',
      'split-pdf',
      'compress-pdf',
      'rotate-pdf',
      'ocr-pdf',
      'protect-pdf',
      'unlock-pdf',
      'pdf-to-jpg',
      'jpg-to-pdf',
      'remove-restrictions',
    ]) {
      await H.openTool(t, [
        path.join(H.FIX, t.includes('jpg-to') ? 'image.jpg' : 'normal-3p.pdf'),
      ]);
      await H.sleep(1200);
      const info = await H.js(
        `JSON.stringify({btns:[...document.querySelectorAll('button')].filter(b=>b.id).map(b=>b.id+(b.disabled?'(dis)':'')).slice(0,25), inputs:[...document.querySelectorAll('input,select,textarea')].map(i=>i.id+':'+i.type).slice(0,25), li:document.querySelectorAll('#file-list li, [id*=file-list] > *').length})`
      );
      console.log(t, H.url().slice(0, 60), info);
    }
  })
);
