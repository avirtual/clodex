'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { confine } = require('./path-confine');
const { atomicWriteFileSync } = require('./fs-util');

const SPILL_MIN_BYTES = 800;
const SPILL_MAX_BYTES = 262144;

const SPILL_VERBS = new Set([
  'task.add', 'task.respec', 'task.reject',
  'context.compact', 'context.clear', 'context.reload',
  'notify-user',
]);

const ID_RE = /^[0-9a-f]{16}$/;
const AGENT_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const POINTER_RE = /^\s*@spill:([0-9a-f]{16})\s*$/;
const TITLED_POINTER_RE = /^([^\n]{0,79}[^\s\n]) @spill:([0-9a-f]{16})\s*$/;

function verbKeyOf(intent) {
  if (!intent || typeof intent.type !== 'string') return null;
  return intent.sub ? `${intent.type}.${intent.sub}` : intent.type;
}

function isSpillVerb(intent) {
  const key = verbKeyOf(intent);
  return key !== null && SPILL_VERBS.has(key);
}

function validAgent(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name.includes('\n') || name.includes('\r')) return false;
  return AGENT_RE.test(name);
}

function spillRootFor(root) {
  if (typeof root !== 'string' || !root) return null;
  return path.join(root, 'spill');
}

function spillDirFor(root, agent) {
  if (!validAgent(agent)) return null;
  const spillRoot = spillRootFor(root);
  if (!spillRoot) return null;
  return confine(spillRoot, agent);
}

function spillPathFor(root, agent, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const dir = spillDirFor(root, agent);
  return dir === null ? null : path.join(dir, `${id}.md`);
}

function spillIdOf(body) {
  return crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').slice(0, 16);
}

function writeSpill(root, agent, body) {
  if (typeof body !== 'string') return null;
  const dir = spillDirFor(root, agent);
  if (dir === null) return null;
  try {
    const buf = Buffer.from(body, 'utf8');
    if (buf.length > SPILL_MAX_BYTES) return null;
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const final = path.join(dir, `${id}.md`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(final)) return id;
    atomicWriteFileSync(final, buf);
    return id;
  } catch {
    return null;
  }
}

function resolveSpill(root, agent, id) {
  const p = spillPathFor(root, agent, id);
  if (p === null) return { ok: false, reason: 'invalid', path: null };
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return { ok: false, reason: 'missing', path: p };
  }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: 'not-a-file', path: p };
  if (st.size > SPILL_MAX_BYTES) return { ok: false, reason: 'too-large', path: p };
  let buf;
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    buf = fs.readFileSync(fd);
  } catch {
    return { ok: false, reason: 'unreadable', path: p };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { fd = undefined; } }
  }
  if (!buf.length) return { ok: false, reason: 'empty', path: p };
  return { ok: true, body: buf.toString('utf8'), path: p };
}

function pointerOf(body) {
  if (typeof body !== 'string') return null;
  const m = POINTER_RE.exec(body);
  if (m) return m[1];
  const t = TITLED_POINTER_RE.exec(body);
  return t ? t[2] : null;
}

function pointerText(id) {
  return `@spill:${id}`;
}

module.exports = {
  SPILL_MIN_BYTES,
  SPILL_MAX_BYTES,
  SPILL_VERBS,
  ID_RE,
  AGENT_RE,
  POINTER_RE,
  TITLED_POINTER_RE,
  verbKeyOf,
  isSpillVerb,
  validAgent,
  spillRootFor,
  spillDirFor,
  spillPathFor,
  spillIdOf,
  writeSpill,
  resolveSpill,
  pointerOf,
  pointerText,
};
