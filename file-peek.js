'use strict';

const fs = require('node:fs');
const { PEEK_MAX_BYTES } = require('./file-edit');

function utf8CutAt(buf, n) {
  if (n > buf.length) return buf.length;
  if (n <= 0) return 0;
  for (let i = n - 1; i >= 0 && i >= n - 4; i -= 1) {
    const b = buf[i];
    if ((b & 0xC0) === 0x80) continue;
    if (b < 0x80) return n;
    const need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : 2;
    return n - i >= need ? n : i;
  }
  return n;
}

function peekInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

function peekFile(filePath, opts = {}) {
  const offset = peekInt(opts.offset, 0);
  const length = Math.min(peekInt(opts.length, PEEK_MAX_BYTES), PEEK_MAX_BYTES);
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, code: 'not-found', error: 'no such file' };
    return { ok: false, code: 'unreadable', error: e.message };
  }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, code: 'not-a-file', error: 'Not a regular file' };
  try {
    const fd = fs.openSync(filePath, 'r');
    let buf;
    try {
      const n = Math.max(0, Math.min(length, st.size - offset));
      buf = Buffer.alloc(n);
      if (n > 0) fs.readSync(fd, buf, 0, n, offset);
    } finally { fs.closeSync(fd); }
    const binary = buf.subarray(0, 8192).includes(0);
    const got = offset + buf.length < st.size ? utf8CutAt(buf, buf.length) : buf.length;
    return {
      ok: true, path: filePath, size: st.size, mtime: st.mtimeMs,
      offset, length: got, truncated: offset + got < st.size, binary,
      content: binary ? null : buf.subarray(0, got).toString('utf-8'),
    };
  } catch (e) { return { ok: false, code: 'unreadable', error: e.message }; }
}

module.exports = { peekFile, peekInt, utf8CutAt, PEEK_MAX_BYTES };
