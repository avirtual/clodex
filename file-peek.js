'use strict';

const fs = require('node:fs');
const { PEEK_MAX_BYTES } = require('./file-edit');

const SNIFF_BYTES = 8192;

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

function utf8ForwardFrom(fd, offset, size) {
  const probe = Buffer.alloc(3);
  const n = fs.readSync(fd, probe, 0, Math.min(3, Math.max(0, size - offset)), offset);
  let i = 0;
  while (i < n && (probe[i] & 0xC0) === 0x80) i += 1;
  return offset + i;
}

function peekFile(filePath, opts = {}) {
  const asked = peekInt(opts.offset, 0);
  const length = Math.min(peekInt(opts.length, PEEK_MAX_BYTES), PEEK_MAX_BYTES);
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, code: 'not-found', error: 'no such file' };
    return { ok: false, code: 'unreadable', error: e.message };
  }
  if (!st.isFile()) return { ok: false, code: 'not-a-file', error: 'Not a regular file' };
  try {
    const fd = fs.openSync(filePath, 'r');
    let buf;
    let binary;
    let offset = asked;
    try {
      if (offset > 0 && offset < st.size) offset = utf8ForwardFrom(fd, offset, st.size);
      const n = Math.max(0, Math.min(length, st.size - offset));
      buf = Buffer.alloc(n);
      if (n > 0) fs.readSync(fd, buf, 0, n, offset);
      const sniff = Math.min(SNIFF_BYTES, st.size);
      if (offset === 0 && n >= sniff) {
        binary = buf.subarray(0, sniff).includes(0);
      } else {
        const head = Buffer.alloc(sniff);
        if (sniff > 0) fs.readSync(fd, head, 0, sniff, 0);
        binary = head.includes(0);
      }
    } finally { fs.closeSync(fd); }
    if (binary) {
      return { ok: true, path: filePath, size: st.size, mtime: Math.trunc(st.mtimeMs), offset: 0, length: 0, truncated: false, binary: true, content: null };
    }
    const got = offset + buf.length < st.size ? utf8CutAt(buf, buf.length) : buf.length;
    return {
      ok: true, path: filePath, size: st.size, mtime: Math.trunc(st.mtimeMs),
      offset, length: got, truncated: offset + got < st.size, binary: false,
      content: buf.subarray(0, got).toString('utf-8'),
    };
  } catch (e) { return { ok: false, code: 'unreadable', error: e.message }; }
}

module.exports = { peekFile, peekInt, utf8CutAt, PEEK_MAX_BYTES };
