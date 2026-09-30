'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { utf8CutAt } = require('./file-peek');
const { seatImageHead } = require('./seat-images');
const { durableMessageCopyOf } = require('./file-resolve');

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

function isFile(p) {
  return !!p && fs.existsSync(p);
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
        .filter((e) => fs.existsSync(path.resolve(e.path)) || isFile(durableMessageCopyOf(e.path, path)))
        .map((e) => ({ ...e }));
    },
    size() { return entries.length; },
  };
}

function seedFiledRing(ring, dirs) {
  const found = new Map();
  for (const { dir, kind, mapPath } of dirs) {
    if (!dir) continue;
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      const kept = mapPath ? mapPath(p) : p;
      if (!found.has(kept)) found.set(kept, { path: kept, src: p, kind, bytes: st.size, ts: Math.round(st.mtimeMs) });
    }
  }
  const sorted = [...found.values()].sort((a, b) => a.ts - b.ts);
  const take = sorted.slice(Math.max(0, sorted.length - ring.cap));
  for (const e of take) ring.note({ ...e, head: seatImageHead(path.basename(e.path)) || firstLineOf(e.src) });
  return take.length;
}

module.exports = {
  FILED_CAP, HEAD_MAX_BYTES,
  utf8CutAt, clipHead, firstLineOf, filedEntry, spillHead,
  createFiledRing, seedFiledRing,
};
