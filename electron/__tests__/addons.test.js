'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const { extractZip, crc32Update, checkName } = require('../addons/zip');
const {
  checkRedirect,
  downloadFile,
  DownloadError,
} = require('../addons/download');
const { createManager } = require('../addons/libreoffice');
const { getManifest, validateEntry } = require('../addons/manifest');
const { TSA, getTsa } = require('../net/tsa-allowlist');
const tsa = require('../net/tsa');

// ---- in-memory zip builder (supports malicious variants) ----
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.data || '');
    const method = e.method === undefined ? 8 : e.method;
    const comp = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = e.crc !== undefined ? e.crc : crc32Update(0, raw);
    const usize = e.usize !== undefined ? e.usize : raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, comp]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(((e.unix ? 3 : 0) << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(e.unix ? (e.unix << 16) >>> 0 : 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-addon-test-'));
}
function writeZip(dir, buf) {
  const f = path.join(dir, 'pack.zip');
  fs.writeFileSync(f, buf);
  return f;
}
async function rejects(entries, re, limits) {
  const d = tmpdir();
  try {
    const out = path.join(d, 'out');
    fs.mkdirSync(out);
    await assert.rejects(
      extractZip(writeZip(d, makeZip(entries)), out, { limits }),
      re
    );
    return fs.readdirSync(out);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

test('zip: extracts a normal pack (deflate + stored + dirs)', async () => {
  const d = tmpdir();
  try {
    const out = path.join(d, 'out');
    fs.mkdirSync(out);
    const files = await extractZip(
      writeZip(
        d,
        makeZip([
          { name: 'soffice.js', data: 'console.log(1)'.repeat(50) },
          { name: 'sub/', data: '', method: 0 },
          {
            name: 'sub/a.wasm',
            data: Buffer.from([0, 0x61, 0x73, 0x6d]),
            method: 0,
          },
        ])
      ),
      out
    );
    assert.deepEqual(files.sort(), ['soffice.js', 'sub/a.wasm']);
    assert.equal(
      fs.readFileSync(path.join(out, 'soffice.js'), 'utf8'),
      'console.log(1)'.repeat(50)
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('zip: rejects zip-slip, absolute, drive-letter and backslash names; nothing escapes', async () => {
  for (const name of [
    '../evil.txt',
    'a/../../evil.txt',
    '/etc/passwd',
    'C:/Windows/x.txt',
    'C:evil.txt',
    'a\\..\\evil.txt',
    'a\\b.txt',
    './x.txt',
    'a//b.txt',
    'x\0y.txt',
    'CON',
    'dir/aux.txt',
    'trail.',
    'a:b',
  ]) {
    const left = await rejects([{ name, data: 'x' }], /./);
    assert.deepEqual(left, [], `nothing extracted for ${JSON.stringify(name)}`);
  }
});

test('zip: rejects symlinks and special files', async () => {
  await rejects(
    [{ name: 'link', data: '../../etc/passwd', unix: 0xa1ff }],
    /Symbolic link/
  );
  await rejects([{ name: 'dev', data: '', unix: 0x2180 }], /Special file/);
});

test('zip: rejects duplicate names (also case-insensitively) and file/dir conflicts', async () => {
  await rejects(
    [
      { name: 'a.js', data: '1' },
      { name: 'a.js', data: '2' },
    ],
    /Duplicate/
  );
  await rejects(
    [
      { name: 'a.js', data: '1' },
      { name: 'A.JS', data: '2' },
    ],
    /Duplicate/
  );
  await rejects(
    [
      { name: 'a', data: '1' },
      { name: 'a/b.js', data: '2' },
    ],
    /Conflicting/
  );
});

test('zip: rejects executables, too many entries, oversized totals and compression bombs', async () => {
  await rejects([{ name: 'run.exe', data: 'MZ' }], /Executable/);
  await rejects(
    [
      { name: 'a.js', data: '1' },
      { name: 'b.js', data: '1' },
      { name: 'c.js', data: '1' },
    ],
    /too many/,
    { maxEntries: 2 }
  );
  await rejects(
    [
      { name: 'a.js', data: 'x'.repeat(100) },
      { name: 'b.js', data: 'x'.repeat(100) },
    ],
    /too much/,
    { maxTotalBytes: 150 }
  );
  // real bomb: 8 MB of zeros deflates to a few KB -> ratio far above the limit
  await rejects(
    [{ name: 'bomb.bin', data: Buffer.alloc(8 * 1024 * 1024) }],
    /ratio/
  );
});

test('zip: declared size lies are caught while streaming (no unbounded write)', async () => {
  const d = tmpdir();
  try {
    const out = path.join(d, 'out');
    fs.mkdirSync(out);
    const big = Buffer.alloc(100000, 7);
    // header claims 10 bytes but the deflate stream holds 100000
    const zip = makeZip([{ name: 'liar.bin', data: big, usize: 10, crc: 0 }]);
    await assert.rejects(extractZip(writeZip(d, zip), out), /./);
    const f = path.join(out, 'liar.bin');
    assert.ok(!fs.existsSync(f) || fs.statSync(f).size <= 10);
    // bad CRC
    fs.rmSync(out, { recursive: true });
    fs.mkdirSync(out);
    await assert.rejects(
      extractZip(
        writeZip(d, makeZip([{ name: 'a.js', data: 'abc', crc: 123 }])),
        out
      ),
      /integrity/
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('zip: garbage / truncated input is rejected', async () => {
  const d = tmpdir();
  try {
    const out = path.join(d, 'out');
    fs.mkdirSync(out);
    await assert.rejects(
      extractZip(writeZip(d, Buffer.from('not a zip at all, definitely')), out),
      /Not a zip/
    );
    const good = makeZip([{ name: 'a.js', data: 'abc' }]);
    await assert.rejects(
      extractZip(writeZip(d, good.subarray(0, good.length - 10)), out),
      /./
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('zip: checkName accepts ordinary names', () => {
  assert.deepEqual(checkName('a/b/soffice.wasm.gz').segments, [
    'a',
    'b',
    'soffice.wasm.gz',
  ]);
  assert.equal(checkName('dir/').isDir, true);
});

// ---- redirect allowlist ----
test('download: redirect allowlist', () => {
  const from = 'https://github.com/o/r/releases/download/v1/p.zip';
  assert.ok(
    checkRedirect(from, 'https://objects.githubusercontent.com/x?y=1', 0)
  );
  assert.ok(
    checkRedirect(from, 'https://release-assets.githubusercontent.com/x', 2)
  );
  assert.ok(checkRedirect(from, '/o/r/other.zip', 0)); // relative stays on github.com
  assert.equal(checkRedirect(from, 'http://github.com/x', 0), null); // downgrade
  assert.equal(checkRedirect(from, 'https://evil.example.com/x', 0), null);
  assert.equal(checkRedirect(from, 'https://github.com.evil.com/x', 0), null);
  assert.equal(checkRedirect(from, 'https://evilgithub.com/x', 0), null);
  assert.equal(checkRedirect(from, 'https://user:pw@github.com/x', 0), null);
  assert.equal(checkRedirect(from, 'https://github.com:8443/x', 0), null);
  assert.equal(checkRedirect(from, 'file:///etc/passwd', 0), null);
  assert.equal(checkRedirect(from, 'https://github.com/x', 3), null); // max 3 redirects
  assert.equal(checkRedirect(from, undefined, 0), null);
});

function fakeRes(status, headers, body) {
  const r = Readable.from(body ? [body] : []);
  r.statusCode = status;
  r.headers = headers || {};
  return r;
}

test('download: follows allowed redirects, refuses others, enforces host and size', async () => {
  const d = tmpdir();
  try {
    const payload = Buffer.from('hello add-on');
    const seen = [];
    const get = async (url) => {
      seen.push(url);
      if (url.startsWith('https://github.com/'))
        return fakeRes(302, {
          location: 'https://objects.githubusercontent.com/blob',
        });
      return fakeRes(
        200,
        { 'content-length': String(payload.length) },
        payload
      );
    };
    const dest = path.join(d, 'f.zip');
    const r = await downloadFile({
      url: 'https://github.com/o/r/p.zip',
      destFile: dest,
      expectedHost: 'github.com',
      maxBytes: 1000,
      get,
    });
    assert.equal(
      r.sha256,
      crypto.createHash('sha256').update(payload).digest('hex')
    );
    assert.equal(seen.length, 2);

    const evil = async () =>
      fakeRes(302, { location: 'https://evil.example.com/x' });
    await assert.rejects(
      downloadFile({
        url: 'https://github.com/a',
        destFile: path.join(d, 'g'),
        expectedHost: 'github.com',
        maxBytes: 1000,
        get: evil,
      }),
      /untrusted/
    );
    await assert.rejects(
      downloadFile({
        url: 'https://other.com/a',
        destFile: path.join(d, 'h'),
        expectedHost: 'github.com',
        maxBytes: 1000,
        get,
      }),
      /host/
    );
    await assert.rejects(
      downloadFile({
        url: 'http://github.com/a',
        destFile: path.join(d, 'i'),
        expectedHost: 'github.com',
        maxBytes: 1000,
        get,
      }),
      /https/
    );
    let n = 0;
    const loop = async () => (
      n++,
      fakeRes(302, { location: 'https://github.com/again' })
    );
    await assert.rejects(
      downloadFile({
        url: 'https://github.com/a',
        destFile: path.join(d, 'j'),
        expectedHost: 'github.com',
        maxBytes: 1000,
        get: loop,
      }),
      /untrusted/
    );
    assert.equal(n, 4); // initial + 3 redirects, the 4th is refused
    // size cap (no content-length, body bigger than cap) leaves no file
    const big = async () => fakeRes(200, {}, Buffer.alloc(5000));
    const bf = path.join(d, 'k');
    await assert.rejects(
      downloadFile({
        url: 'https://github.com/a',
        destFile: bf,
        expectedHost: 'github.com',
        maxBytes: 1000,
        get: big,
      }),
      (e) => e instanceof DownloadError && e.code === 'too_large'
    );
    assert.ok(!fs.existsSync(bf));
    // content-length over cap rejected before reading
    const cl = async () =>
      fakeRes(200, { 'content-length': '999999' }, Buffer.alloc(10));
    await assert.rejects(
      downloadFile({
        url: 'https://github.com/a',
        destFile: path.join(d, 'l'),
        expectedHost: 'github.com',
        maxBytes: 1000,
        get: cl,
      }),
      /larger/
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---- manager: hash verification before extraction, install, sideload, remove ----
function managerFor(root, pack, extra = {}) {
  const manifest = validateEntry({
    name: 'libreoffice',
    title: 'Office converter',
    version: '9.9.9',
    url: 'https://github.com/o/r/releases/download/addons-v1/pack.zip',
    sha256: crypto.createHash('sha256').update(pack).digest('hex'),
    sizeBytes: pack.length,
    requiredFiles: ['soffice.js'],
    ...extra,
  });
  const events = [];
  return {
    manifest,
    events,
    mgr: createManager({
      root,
      manifest,
      emit: (e) => events.push(e),
      download: extra.download,
    }),
  };
}

test('manager: sideload installs, serves layout, records manifest; remove cleans up', async () => {
  const d = tmpdir();
  try {
    const pack = makeZip([
      { name: 'soffice.js', data: 'x'.repeat(200) },
      { name: 'soffice.wasm.gz', data: 'wasm', method: 0 },
    ]);
    const zipFile = writeZip(d, pack);
    const root = path.join(d, 'addons');
    const { mgr, events } = managerFor(root, pack);
    assert.equal((await mgr.status()).state, 'not-installed');
    const st = await mgr.installFromFile(zipFile);
    assert.equal(st.state, 'installed');
    assert.equal(st.basePath, '/addons/libreoffice/9.9.9/');
    assert.ok(
      fs.existsSync(path.join(root, 'libreoffice', '9.9.9', 'soffice.js'))
    );
    assert.ok(fs.existsSync(path.join(root, 'libreoffice', 'manifest.json')));
    assert.deepEqual(fs.readdirSync(path.join(root, 'libreoffice')).sort(), [
      '9.9.9',
      'manifest.json',
    ]); // no temp leftovers
    assert.ok(events.some((e) => e.state === 'verifying'));
    assert.equal((await mgr.remove()).state, 'not-installed');
    assert.ok(!fs.existsSync(path.join(root, 'libreoffice')));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('manager: hash mismatch is rejected before anything is extracted', async () => {
  const d = tmpdir();
  try {
    const pack = makeZip([{ name: 'soffice.js', data: 'x' }]);
    const other = makeZip([{ name: 'soffice.js', data: 'y' }]);
    const root = path.join(d, 'addons');
    const { mgr } = managerFor(root, pack);
    await assert.rejects(
      mgr.installFromFile(writeZip(d, other)),
      (e) => e.code === 'hash_mismatch'
    );
    assert.equal((await mgr.status()).state, 'error');
    assert.deepEqual(fs.readdirSync(path.join(root, 'libreoffice')), []); // temp dir removed, no version dir
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('manager: correct hash but malicious zip is rejected and leaves nothing installed', async () => {
  const d = tmpdir();
  try {
    const evil = makeZip([
      { name: 'soffice.js', data: 'x' },
      { name: '../../escape.txt', data: 'pwn' },
    ]);
    const root = path.join(d, 'addons');
    const { mgr } = managerFor(root, evil);
    await assert.rejects(
      mgr.installFromFile(writeZip(d, evil)),
      (e) => e.code === 'bad_archive'
    );
    assert.ok(!fs.existsSync(path.join(d, 'escape.txt')));
    assert.ok(!fs.existsSync(path.join(root, 'escape.txt')));
    assert.equal((await mgr.status()).state, 'error');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('manager: pack missing a required file is rejected', async () => {
  const d = tmpdir();
  try {
    const pack = makeZip([{ name: 'other.js', data: 'x' }]);
    const { mgr } = managerFor(path.join(d, 'addons'), pack);
    await assert.rejects(
      mgr.installFromFile(writeZip(d, pack)),
      (e) => e.code === 'bad_archive'
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('manager: install() asks for consent before any network, and honours Cancel', async () => {
  const d = tmpdir();
  try {
    const pack = makeZip([{ name: 'soffice.js', data: 'x' }]);
    let calls = 0;
    const download = async () => {
      calls++;
      throw new Error('should not be called');
    };
    const { mgr } = managerFor(path.join(d, 'addons'), pack, { download });
    let asked;
    await assert.rejects(
      mgr.install(async (info) => ((asked = info), false)),
      (e) => e.code === 'cancelled'
    );
    assert.equal(calls, 0);
    assert.equal(asked.host, 'github.com');
    assert.ok(asked.sizeBytes > 0);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('manager: install() downloads (injected), verifies hash then extracts', async () => {
  const d = tmpdir();
  try {
    const pack = makeZip([{ name: 'soffice.js', data: 'x'.repeat(50) }]);
    const download = async ({
      destFile,
      onProgress,
      expectedHost,
      maxBytes,
    }) => {
      assert.equal(expectedHost, 'github.com');
      assert.equal(maxBytes, pack.length + 1024 * 1024);
      fs.writeFileSync(destFile, pack);
      onProgress(pack.length, pack.length);
    };
    const { mgr } = managerFor(path.join(d, 'addons'), pack, { download });
    const st = await mgr.install(async () => true);
    assert.equal(st.state, 'installed');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('manager: placeholder hash is refused (no download attempted)', async () => {
  const d = tmpdir();
  try {
    const manifest = {
      ...getManifest('libreoffice', { isPackaged: true }),
      sha256: '0'.repeat(64),
    };
    let calls = 0;
    const mgr = createManager({
      root: path.join(d, 'a'),
      manifest,
      download: async () => {
        calls++;
      },
    });
    await assert.rejects(
      mgr.install(async () => true),
      (e) => e.code === 'unavailable'
    );
    assert.equal(calls, 0);
    assert.equal((await mgr.status()).available, false);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('manifest: validation and test override guard', () => {
  assert.throws(() =>
    validateEntry({
      name: 'x',
      version: '../1',
      url: 'https://github.com/a',
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
      requiredFiles: ['a'],
    })
  );
  assert.throws(() =>
    validateEntry({
      name: 'x',
      version: '1',
      url: 'http://github.com/a',
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
      requiredFiles: ['a'],
    })
  );
  assert.throws(() =>
    validateEntry({
      name: 'x',
      version: '1',
      url: 'https://github.com/a',
      sha256: 'zz',
      sizeBytes: 1,
      requiredFiles: ['a'],
    })
  );
  const fake = () =>
    JSON.stringify({ version: '7.7.7', sha256: 'b'.repeat(64), sizeBytes: 10 });
  const env = { INKLEAF_TEST: '1', INKLEAF_TEST_ADDON_MANIFEST: 'x.json' };
  assert.equal(
    getManifest('libreoffice', { isPackaged: false, env, readFile: fake })
      .version,
    '7.7.7'
  );
  assert.notEqual(
    getManifest('libreoffice', { isPackaged: true, env, readFile: fake })
      .version,
    '7.7.7'
  ); // packaged ignores override
  assert.notEqual(
    getManifest('libreoffice', { isPackaged: false, env: {}, readFile: fake })
      .version,
    '7.7.7'
  );
  assert.equal(getManifest('nope', { isPackaged: true }), null);
  assert.equal(getManifest('__proto__', { isPackaged: true }), null);
});

// ---- TSA ----
function tsReq(hashOidBytes, digest) {
  const oid = Buffer.concat([
    Buffer.from([0x06, hashOidBytes.length]),
    hashOidBytes,
  ]);
  const alg = Buffer.concat([
    Buffer.from([0x30, oid.length + 2]),
    oid,
    Buffer.from([0x05, 0x00]),
  ]);
  const dig = Buffer.concat([Buffer.from([0x04, digest.length]), digest]);
  const mi = Buffer.concat([
    Buffer.from([0x30, alg.length + dig.length]),
    alg,
    dig,
  ]);
  const body = Buffer.concat([
    Buffer.from([0x02, 0x01, 0x01]),
    mi,
    Buffer.from([0x01, 0x01, 0xff]),
  ]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
const SHA256_OID = Buffer.from([
  0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
]);

test('tsa: allowlist is fixed, ids only, and mirrors timestamp-tsa.ts hosts', () => {
  assert.equal(getTsa('https://evil.com'), null);
  assert.equal(getTsa('__proto__'), null);
  assert.equal(getTsa('constructor'), null);
  assert.equal(getTsa(undefined), null);
  const ts = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'js', 'config', 'timestamp-tsa.ts'),
    'utf8'
  );
  const tsHosts = [...ts.matchAll(/url: '([^']+)'/g)]
    .map((m) => new URL(m[1]).hostname)
    .sort();
  const mine = Object.values(TSA)
    .map((t) => new URL(t.url).hostname)
    .sort();
  assert.deepEqual(mine, tsHosts);
  for (const t of Object.values(TSA))
    assert.match(t.url, /^https?:\/\/[a-z0-9.]+(\/[a-z]+)?$/);
});

test('tsa: request parsing validates a TimeStampReq', () => {
  const digest = crypto.createHash('sha256').update('doc').digest();
  const p = tsa.parseTimeStampReq(tsReq(SHA256_OID, digest));
  assert.equal(p.hashAlgo, 'sha256');
  assert.equal(p.digestHex, digest.toString('hex'));
  assert.throws(() =>
    tsa.parseTimeStampReq(Buffer.from('POST / HTTP/1.1\r\nHost: x\r\n\r\n'))
  );
  assert.throws(() =>
    tsa.parseTimeStampReq(
      Buffer.concat([tsReq(SHA256_OID, digest), Buffer.from([0])])
    )
  ); // trailing byte
  assert.throws(() =>
    tsa.parseTimeStampReq(tsReq(SHA256_OID, digest.subarray(0, 20)))
  ); // wrong digest length
  assert.throws(() => tsa.parseTimeStampReq(Buffer.alloc(70000, 0x30)));
});

test('tsa: requestTimestamp posts the DER body with the right headers; redirects only to the same host', async () => {
  const digest = crypto.randomBytes(32);
  const request = tsReq(SHA256_OID, digest);
  const seen = [];
  const reply = Buffer.concat([Buffer.from([0x30, 0x10]), Buffer.alloc(16, 1)]);
  const transport = async (url, body, headers) => {
    seen.push({ url, body, headers });
    return { status: 200, headers: {}, body: reply };
  };
  const out = await tsa.requestTimestamp({
    tsaId: 'freetsa',
    request,
    transport,
  });
  assert.deepEqual(out, reply);
  assert.equal(seen[0].url, 'https://freetsa.org/tsr');
  assert.equal(seen[0].headers['Content-Type'], 'application/timestamp-query');
  assert.deepEqual(seen[0].body, request);
  assert.ok(!('Cookie' in seen[0].headers));

  await assert.rejects(
    tsa.requestTimestamp({ tsaId: 'nope', request, transport }),
    /Unknown/
  );
  const cross = async () => ({
    status: 302,
    headers: { location: 'https://evil.example.com/' },
    body: Buffer.alloc(0),
  });
  await assert.rejects(
    tsa.requestTimestamp({ tsaId: 'freetsa', request, transport: cross }),
    (e) => e.code === 'redirect'
  );
  const toHttp = async () => ({
    status: 301,
    headers: { location: 'http://freetsa.org/tsr' },
    body: Buffer.alloc(0),
  });
  await assert.rejects(
    tsa.requestTimestamp({ tsaId: 'freetsa', request, transport: toHttp }),
    (e) => e.code === 'redirect'
  );
  let hops = 0;
  const same = async (url) => {
    hops++;
    return hops === 1
      ? { status: 302, headers: { location: '/tsr2' }, body: Buffer.alloc(0) }
      : { status: 200, headers: {}, body: reply };
  };
  assert.deepEqual(
    await tsa.requestTimestamp({ tsaId: 'freetsa', request, transport: same }),
    reply
  );
  const bad = async () => ({
    status: 200,
    headers: {},
    body: Buffer.from('<html>captive portal</html>'),
  });
  await assert.rejects(
    tsa.requestTimestamp({ tsaId: 'freetsa', request, transport: bad }),
    (e) => e.code === 'bad_reply'
  );
  const huge = async () => ({
    status: 200,
    headers: {},
    body: Buffer.alloc(tsa.MAX_RESPONSE_BYTES + 1, 0x30),
  });
  await assert.rejects(
    tsa.requestTimestamp({ tsaId: 'freetsa', request, transport: huge }),
    (e) => e.code === 'too_large'
  );
  const s500 = async () => ({
    status: 500,
    headers: {},
    body: Buffer.alloc(0),
  });
  await assert.rejects(
    tsa.requestTimestamp({ tsaId: 'freetsa', request, transport: s500 }),
    (e) => e.code === 'http_error'
  );
});

test('tsa: checkRedirect never leaves the host or downgrades', () => {
  assert.ok(tsa.checkRedirect('http://ts.ssl.com/', 'https://ts.ssl.com/x', 0));
  assert.equal(
    tsa.checkRedirect('http://ts.ssl.com/', 'http://other.com/', 0),
    null
  );
  assert.equal(
    tsa.checkRedirect('https://freetsa.org/tsr', 'http://freetsa.org/tsr', 0),
    null
  );
  assert.equal(
    tsa.checkRedirect('http://ts.ssl.com/', 'http://ts.ssl.com/x', 3),
    null
  );
});

test('tsa: rate limit is one call per 2 seconds', () => {
  tsa._resetRateLimit();
  tsa.rateLimit(10000);
  assert.throws(
    () => tsa.rateLimit(11000),
    (e) => e.code === 'rate_limited'
  );
  tsa.rateLimit(12001);
  tsa._resetRateLimit();
});
