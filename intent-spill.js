'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { confine } = require('./path-confine');
const { atomicWriteFileSync } = require('./fs-util');
const { FILED_SRC, FILED_POINTER_RE } = require('./spill-grammar');

const SPILL_MIN_BYTES = 800;
const SPILL_MAX_BYTES = 262144;
const SNAPSHOT_MAX_BYTES = 4096;
const SPILL_FILLER = '[Runtime note: action text omitted from retained history.]';
const SPILLED_BODY = '[Runtime note: Clodex filed this body in full; it is not carried in the transcript.]';
const SPILLED_BODY_FIRST = '[Runtime note: Clodex kept your first two long intent bodies in full as examples and files later ones; this body was delivered in full and is not carried in the transcript. Every new intent still needs its complete body; never write this note.]';

const SPILL_VERBS = new Set([
  'task.add', 'task.respec', 'task.reject', 'task.done',
  'shout', 'dm',
]);

const ID_RE = /^[0-9a-f]{16}$/;
const AGENT_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const POINTER_RE = /^\s*@spill:([0-9a-f]{16})\s*$/;
const TITLED_POINTER_RE = /^([^\n]{0,79}[^\s\n]) @spill:([0-9a-f]{16})\s*$/;
const TRAILING_POINTER_RE = new RegExp(String.raw`(?:(@spill:([0-9a-f]{16}))|${FILED_SRC})\s*$`);
const HEAD_RE = /^\[agent:([a-z]+)(?:\s+([a-z-]+))?\b([^\]]*)\]/;
const RECEIPT_RE = /^\(I sent (\S+(?: \S+)*?)(?: — "[^"]*")? in full, \d+ B; Clodex kept my text at (\/.+?\.md)\.\)$/;
const TAIL_RECEIPT_RE = /^\(I wrote \d+ B of prose after my last intent; it reached the operator's log and Clodex kept it at \/.+?\.md\.\)$/;

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

function pointerMatch(body) {
  if (typeof body !== 'string') return null;
  const m = POINTER_RE.exec(body);
  if (m) return { id: m[1], pointer: `@spill:${m[1]}` };
  const t = TITLED_POINTER_RE.exec(body);
  if (t) return { id: t[2], pointer: `@spill:${t[2]}` };
  const f = FILED_POINTER_RE.exec(body);
  return f ? { id: f[4], pointer: f[2] } : null;
}

function pointerOf(body) {
  const m = pointerMatch(body);
  return m ? m.id : null;
}

function trailingPointerOf(text) {
  if (typeof text !== 'string') return null;
  const m = TRAILING_POINTER_RE.exec(text);
  if (!m) return null;
  return m[1] ? { id: m[2], pointer: m[1] } : { id: m[5], pointer: m[3] };
}

function spilledBodyOf(body) {
  if (typeof body !== 'string') return null;
  const lines = body.trim().split('\n');
  const last = lines[lines.length - 1].trim();
  if (last === SPILLED_BODY) return SPILLED_BODY;
  if (last === SPILLED_BODY_FIRST) return SPILLED_BODY_FIRST;
  return null;
}

function spillSize(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function pointerText(id, { root, agent, bytes, prose = false }) {
  return `${spillSize(bytes)}${prose ? ' of prose' : ''} filed at ${spillPathFor(root, agent, id)}`;
}

function mimicKindOf(line) {
  if (typeof line !== 'string') return null;
  const t = line.trim();
  if (RECEIPT_RE.test(t)) return 'intent';
  if (TAIL_RECEIPT_RE.test(t)) return 'prose';
  if (t === SPILL_FILLER) return 'filler';
  if (t === SPILLED_BODY || t === SPILLED_BODY_FIRST) return 'spilled';
  if (pointerOf(t) !== null) return 'pointer';
  const m = HEAD_RE.exec(t);
  if (m && pointerOf(t.slice(m[0].length).trim()) !== null) return 'pointer';
  return null;
}

function receiptOf(line) {
  if (typeof line !== 'string') return null;
  const m = RECEIPT_RE.exec(line.trim());
  if (!m) return null;
  const words = m[1].split(' ');
  const key = SPILL_VERBS.has(words[0]) ? words[0] : `${words[0]}.${words[1]}`;
  if (!SPILL_VERBS.has(key)) return null;
  return { head: m[1], type: words[0], sub: key === words[0] ? null : words[1], path: m[2] };
}

function resolveReceipt(root, agent, filePath) {
  const dir = spillDirFor(root, agent);
  if (dir === null) return { ok: false, reason: 'invalid', path: null };
  const base = path.basename(filePath);
  const id = base.endsWith('.md') ? base.slice(0, -3) : '';
  if (!ID_RE.test(id) || confine(dir, base) !== path.resolve(filePath)) {
    return { ok: false, reason: 'outside', path: filePath };
  }
  const r = resolveSpill(root, agent, id);
  return r.ok ? { ...r, id } : r;
}

function capResumeSnapshot(head, board, max = SNAPSHOT_MAX_BYTES) {
  const rows = String(board == null ? '' : board).split('\n').filter((l) => l !== '');
  const full = rows.length ? `${head}\n${rows.join('\n')}` : head;
  if (Buffer.byteLength(full, 'utf8') <= max) return full;
  for (let keep = rows.length - 1; keep > 0; keep--) {
    const marker = `(… ${rows.length - keep} more rows — [agent:task list])`;
    const candidate = `${head}\n${rows.slice(0, keep).join('\n')}\n${marker}`;
    if (Buffer.byteLength(candidate, 'utf8') <= max) return candidate;
  }
  return `${head}\n(… ${rows.length} more rows — [agent:task list])`;
}

function bounceHead(intent) {
  const label = String(verbKeyOf(intent) || intent.type).replace('.', ' ');
  const args = [intent.target, intent.id, intent.who, intent.spec]
    .filter((v) => typeof v === 'string' && v !== '');
  for (const flag of ['urgent', 'park', 'start']) if (intent[flag] === true) args.push(flag);
  return { label, head: `[agent:${[label, ...args].join(' ')}]` };
}

function typedNoun(typed) {
  if (typed.startsWith('[Runtime note:')) return 'runtime note';
  if (typed.startsWith('(')) return 'receipt';
  return 'spill pointer';
}

function spillMimicBounce(intent, typed) {
  const token = String(typed).trim();
  const { label, head } = intent && intent.type ? bounceHead(intent) : { label: 'reply', head: '[agent:<verb> …]' };
  return [
    `[agent] Not executed: your \`${label}\` carried, where the body belongs, this line you did not write:`,
    `\`${token}\``,
    `That line is a ${typedNoun(token)}, Clodex's transcript rendering of a body you wrote earlier (it replaces the text to save context). `
      + 'It is never typed by you, and nothing was saved, sent or filed.',
    'Emit the complete intent again with the body written out in full:',
    `\\${head}`,
    '<the full body, written out>',
    '\\[agent:end]',
  ].join('\n');
}

module.exports = {
  SPILL_MIN_BYTES,
  SPILL_MAX_BYTES,
  SNAPSHOT_MAX_BYTES,
  SPILL_FILLER,
  SPILLED_BODY,
  SPILLED_BODY_FIRST,
  SPILL_VERBS,
  ID_RE,
  AGENT_RE,
  POINTER_RE,
  TITLED_POINTER_RE,
  FILED_POINTER_RE,
  TRAILING_POINTER_RE,
  HEAD_RE,
  RECEIPT_RE,
  TAIL_RECEIPT_RE,
  verbKeyOf,
  isSpillVerb,
  validAgent,
  spillRootFor,
  spillDirFor,
  spillPathFor,
  spillIdOf,
  writeSpill,
  resolveSpill,
  pointerMatch,
  pointerOf,
  trailingPointerOf,
  spilledBodyOf,
  spillSize,
  pointerText,
  mimicKindOf,
  receiptOf,
  resolveReceipt,
  capResumeSnapshot,
  spillMimicBounce,
};
