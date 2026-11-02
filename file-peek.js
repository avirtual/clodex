'use strict';

const fs = require('node:fs');
const { PEEK_MAX_BYTES, textEncodingRefusal } = require('./file-edit');

const SNIFF_BYTES = 8192;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

function imageMediaType(buf) {
  if (!buf || buf.length < 3) return null;
  const at = (sig, from = 0) => buf.length >= from + sig.length && sig.every((b, i) => buf[from + i] === b);
  if (at([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
  if (at([0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (at([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif';
  if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

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
      const magic = Buffer.alloc(Math.min(12, st.size));
      if (magic.length > 0) fs.readSync(fd, magic, 0, magic.length, 0);
      const image = imageMediaType(magic);
      if (image && st.size <= IMAGE_MAX_BYTES) {
        const whole = Buffer.alloc(st.size);
        let got = 0;
        while (got < st.size) {
          const r = fs.readSync(fd, whole, got, st.size - got, got);
          if (r <= 0) break;
          got += r;
        }
        return {
          ok: true, path: filePath, size: st.size, mtime: Math.trunc(st.mtimeMs), offset: 0, length: got,
          truncated: false, binary: true, image, content: whole.subarray(0, got).toString('base64'),
        };
      }
      if (image) {
        return { ok: true, path: filePath, size: st.size, mtime: Math.trunc(st.mtimeMs), offset: 0, length: 0, truncated: false, binary: true, image, content: null };
      }
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
    const text = buf.subarray(0, got);
    const encoding = textEncodingRefusal(text);
    return {
      ok: true, path: filePath, size: st.size, mtime: Math.trunc(st.mtimeMs),
      offset, length: got, truncated: offset + got < st.size, binary: false,
      content: text.toString('utf-8'),
      ...(encoding ? { editable: false, encoding } : { editable: true }),
    };
  } catch (e) { return { ok: false, code: 'unreadable', error: e.message }; }
}

module.exports = { peekFile, peekInt, utf8CutAt, imageMediaType, PEEK_MAX_BYTES, IMAGE_MAX_BYTES };
