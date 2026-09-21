'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { utf8CutAt } = require('./file-peek');

const FILED_CAP = 50;
const HEAD_MAX_BYTES = 120;
const HEAD_READ_BYTES = 1024;

function clipHead(text) {
  const one = String(text == null ? '' : text).split('\n')[0].trim();
  const buf = Buffer.from(one, 'utf8');
  if (buf.length <= HEAD_MAX_BYTES) return one;
  return buf.subarray(0, utf8CutAt(buf, HEAD_MAX_BYTES)).toString('utf8');
}

function firstLineOf(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HEAD_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_READ_BYTES, 0);
    const text = buf.subarray(0, utf8CutAt(buf.subarray(0, n), n)).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim()) return clipHead(line);
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function filedEntry(filePath, kind, head) {
  let bytes = 0;
  try { bytes = fs.statSync(filePath).size; } catch { bytes = 0; }
  return { path: filePath, kind, head: clipHead(head), bytes, ts: Date.now() };
}

function spillHead(filePath, ev) {
  if (!ev || ev.verb === 'prose' || !ev.head) return 'prose';
  const title = firstLineOf(filePath);
  return title ? `[agent:${ev.head}] ${title}` : `[agent:${ev.head}]`;
}

function createFiledRing(cap = FILED_CAP) {
  const entries = [];
  return {
    cap,
    note(entry) {
      if (!entry || typeof entry.path !== 'string' || !entry.path) return null;
      const rec = {
        path: entry.path,
        kind: entry.kind,
        head: clipHead(entry.head),
        bytes: Number.isFinite(entry.bytes) ? entry.bytes : 0,
        ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(),
      };
      const i = entries.findIndex((e) => e.path === rec.path);
      if (i >= 0) entries.splice(i, 1);
      entries.unshift(rec);
      if (entries.length > cap) entries.length = cap;
      return rec;
    },
    has(filePath) {
      return entries.some((e) => e.path === filePath);
    },
    list() {
      return entries
        .filter((e) => fs.existsSync(path.resolve(e.path)))
        .map((e) => ({ ...e }));
    },
    size() { return entries.length; },
  };
}

function seedFiledRing(ring, dirs) {
  const found = [];
  for (const { dir, kind } of dirs) {
    if (!dir) continue;
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      found.push({ path: p, kind, bytes: st.size, ts: Math.round(st.mtimeMs) });
    }
  }
  found.sort((a, b) => a.ts - b.ts);
  const take = found.slice(Math.max(0, found.length - ring.cap));
  for (const e of take) ring.note({ ...e, head: firstLineOf(e.path) });
  return take.length;
}

module.exports = {
  FILED_CAP, HEAD_MAX_BYTES,
  utf8CutAt, clipHead, firstLineOf, filedEntry, spillHead,
  createFiledRing, seedFiledRing,
};
