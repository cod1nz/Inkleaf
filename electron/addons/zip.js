'use strict';
/**
 * Hardened zip extraction for add-on packs. Nothing from the archive is trusted: names are validated, only
 * regular files and directories are accepted, sizes are enforced while streaming, and every file is created
 * with the exclusive flag inside the destination directory.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 2000,
  maxTotalBytes: 600 * 1024 * 1024,
  maxEntryBytes: 450 * 1024 * 1024,
  maxRatio: 200, // uncompressed / compressed, only enforced for entries above ratioFloor
  ratioFloor: 1024 * 1024,
});

const BLOCKED_EXT =
  /\.(exe|dll|bat|cmd|com|msi|scr|lnk|ps1|psm1|vbs|vbe|wsf|jar|app|dmg|pkg|so|dylib|sh|reg|cpl|hta)$/i;
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(\.|$)/i;

class ZipError extends Error {
  constructor(message, code = 'bad_archive') {
    super(message);
    this.code = code;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32Update(crc, buf) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Validates an entry name and returns its path segments (directory entries lose the trailing slash). */
function checkName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 512)
    throw new ZipError('Invalid entry name');
  if (name.includes('\0')) throw new ZipError('Invalid entry name');
  if (name.includes('\\')) throw new ZipError('Backslash in entry name');
  if (name.startsWith('/')) throw new ZipError('Absolute path in archive');
  if (/^[A-Za-z]:/.test(name))
    throw new ZipError('Drive letter in archive path');
  const isDir = name.endsWith('/');
  const segments = (isDir ? name.slice(0, -1) : name).split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..')
      throw new ZipError('Unsafe path in archive');
    if (/[:*?"<>|\u0000-\u001f]/.test(s))
      throw new ZipError('Unsafe characters in archive path');
    if (/[. ]$/.test(s)) throw new ZipError('Unsafe path in archive');
    if (RESERVED.test(s)) throw new ZipError('Reserved name in archive');
    if (/~\d/.test(s)) throw new ZipError('Unsafe path in archive');
  }
  if (!isDir && BLOCKED_EXT.test(segments[segments.length - 1]))
    throw new ZipError('Executable file in archive');
  return { segments, isDir };
}

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
    if (bytesRead === 0) throw new ZipError('Archive is truncated');
    off += bytesRead;
  }
  return buf;
}

/** Reads and fully validates the central directory. Returns { entries, cdOffset }. */
async function listEntries(fh, size, limits) {
  if (size < 22) throw new ZipError('Not a zip file');
  const tailLen = Math.min(size, 22 + 65535);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (
      tail.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + tail.readUInt16LE(i + 20) === tail.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a zip file');
  const disk = tail.readUInt16LE(eocd + 4);
  const cdDisk = tail.readUInt16LE(eocd + 6);
  const thisCount = tail.readUInt16LE(eocd + 8);
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || thisCount !== count)
    throw new ZipError('Multi-disk archives are not supported');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new ZipError('Zip64 archives are not supported');
  if (count > limits.maxEntries)
    throw new ZipError('Archive has too many entries');
  if (count === 0) throw new ZipError('Archive is empty');
  if (cdOffset + cdSize > size || cdSize > 8 * 1024 * 1024)
    throw new ZipError('Corrupt archive');
  const cd = await readAt(fh, cdOffset, cdSize);

  const entries = [];
  const seen = new Set();
  let total = 0;
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50)
      throw new ZipError('Corrupt archive');
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const csize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const diskStart = cd.readUInt16LE(p + 34);
    const extAttr = cd.readUInt32LE(p + 38);
    const localOffset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length)
      throw new ZipError('Corrupt archive');
    const rawName = cd.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1 || flags & 0x40)
      throw new ZipError('Encrypted entries are not supported');
    if (method !== 0 && method !== 8)
      throw new ZipError('Unsupported compression method');
    if (diskStart !== 0)
      throw new ZipError('Multi-disk archives are not supported');
    if (
      csize === 0xffffffff ||
      usize === 0xffffffff ||
      localOffset === 0xffffffff
    )
      throw new ZipError('Zip64 archives are not supported');

    let name;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    } catch {
      throw new ZipError('Invalid entry name encoding');
    }
    const { segments, isDir } = checkName(name);

    // Unix mode lives in the high 16 bits when the entry was made on a Unix host. Only regular files/dirs pass.
    const host = madeBy >> 8;
    const mode = extAttr >>> 16;
    if (host === 3 && mode !== 0) {
      const type = mode & 0xf000;
      if (type === 0xa000) throw new ZipError('Symbolic link in archive');
      if (type !== 0x8000 && type !== 0x4000)
        throw new ZipError('Special file in archive');
      if (isDir !== (type === 0x4000))
        throw new ZipError('Entry type does not match its name');
    }
    if (extAttr & 0x400) throw new ZipError('Reparse point in archive'); // windows FILE_ATTRIBUTE_REPARSE_POINT

    const key = segments.join('/').toLowerCase();
    if (seen.has(key)) throw new ZipError('Duplicate entry name in archive');
    seen.add(key);

    if (isDir) {
      if (usize !== 0 || csize > 2)
        throw new ZipError('Directory entry has data');
    } else {
      if (usize > limits.maxEntryBytes)
        throw new ZipError('Archive entry is too large', 'too_large');
      if (method === 0 && usize !== csize)
        throw new ZipError('Corrupt archive');
      if (
        usize > limits.ratioFloor &&
        usize / Math.max(csize, 1) > limits.maxRatio
      )
        throw new ZipError('Suspicious compression ratio', 'too_large');
      total += usize;
      if (total > limits.maxTotalBytes)
        throw new ZipError('Archive expands to too much data', 'too_large');
    }
    entries.push({ segments, isDir, method, crc, csize, usize, localOffset });
  }
  if (p !== cd.length) throw new ZipError('Corrupt archive');
  // A file entry may not also be a parent directory of another entry.
  const files = new Set(
    entries
      .filter((e) => !e.isDir)
      .map((e) => e.segments.join('/').toLowerCase())
  );
  for (const e of entries) {
    for (let i = 1; i < e.segments.length; i++) {
      if (files.has(e.segments.slice(0, i).join('/').toLowerCase()))
        throw new ZipError('Conflicting entries in archive');
    }
  }
  return { entries, cdOffset };
}

function limitTransform(maxBytes, expectedCrc) {
  let n = 0;
  let crc = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      if (n > maxBytes)
        return cb(
          new ZipError('Archive entry is larger than declared', 'too_large')
        );
      crc = crc32Update(crc, chunk);
      cb(null, chunk);
    },
    flush(cb) {
      if (n !== maxBytes)
        return cb(new ZipError('Archive entry size mismatch'));
      if (crc !== expectedCrc)
        return cb(new ZipError('Archive entry failed its integrity check'));
      cb();
    },
  });
}

/**
 * Extracts zipPath into destDir (must already exist and be empty). Returns the list of relative file paths.
 * Throws ZipError on any violation; the caller must delete destDir afterwards.
 */
async function extractZip(zipPath, destDir, opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  const signal = opts.signal;
  const destRoot = path.resolve(destDir);
  const fh = await fsp.open(zipPath, 'r');
  const written = [];
  try {
    const size = (await fh.stat()).size;
    const { entries, cdOffset } = await listEntries(fh, size, limits);
    for (const e of entries) {
      if (signal && signal.aborted)
        throw new ZipError('Cancelled', 'cancelled');
      const target = path.resolve(destRoot, ...e.segments);
      if (target !== destRoot && !target.startsWith(destRoot + path.sep))
        throw new ZipError('Unsafe path in archive');
      if (e.isDir) {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }
      const lh = await readAt(fh, e.localOffset, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50)
        throw new ZipError('Corrupt archive');
      const lflags = lh.readUInt16LE(6);
      const lmethod = lh.readUInt16LE(8);
      const lNameLen = lh.readUInt16LE(26);
      const lExtraLen = lh.readUInt16LE(28);
      if (lflags & 0x1 || lmethod !== e.method)
        throw new ZipError('Corrupt archive');
      const lname = await readAt(fh, e.localOffset + 30, lNameLen);
      if (
        lname.toString('utf8') !==
        e.segments.join('/') + (e.isDir ? '/' : '')
      )
        throw new ZipError('Archive headers disagree');
      const dataStart = e.localOffset + 30 + lNameLen + lExtraLen;
      if (
        e.csize > 0 &&
        (dataStart + e.csize > cdOffset || dataStart + e.csize > size)
      )
        throw new ZipError('Corrupt archive');

      await fsp.mkdir(path.dirname(target), { recursive: true });
      const input =
        e.csize > 0
          ? fs.createReadStream(zipPath, {
              start: dataStart,
              end: dataStart + e.csize - 1,
              highWaterMark: 256 * 1024,
            })
          : null;
      // 'wx': never overwrite or follow an existing path; 0o644: no execute bit is ever set.
      const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o644 });
      const stages = [];
      if (input) stages.push(input);
      else stages.push(require('node:stream').Readable.from([]));
      if (e.method === 8)
        stages.push(
          zlib.createInflateRaw({ maxOutputLength: Math.max(e.usize, 1) })
        );
      stages.push(limitTransform(e.usize, e.crc), out);
      try {
        await (signal ? pipeline(stages, { signal }) : pipeline(stages));
      } catch (err) {
        if (err && err.name === 'AbortError')
          throw new ZipError('Cancelled', 'cancelled');
        if (err instanceof ZipError) throw err;
        throw new ZipError('Archive entry is corrupt');
      }
      written.push(e.segments.join('/'));
    }
  } finally {
    await fh.close();
  }
  return written;
}

module.exports = {
  extractZip,
  listEntries,
  checkName,
  ZipError,
  DEFAULT_LIMITS,
  crc32Update,
};
