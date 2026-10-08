'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SUBQ_ID_RE = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,127}$/;
const SUBQ_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SUBQ_ID8_RE = /^agent-([0-9a-f]{8})$/;
const SUBQ_RESERVED_NAME_RE = /^agent(-|$)/;
const SUB_ID_TAIL_RE = /-([0-9a-f]{16})$/;
const SUBQ_DM_SUFFIX = '.dm';
const NAME_FILE_MAX = 256;

function id8Of(id) {
  const s = String(id || '');
  const tail = SUB_ID_TAIL_RE.exec(s);
  return tail ? tail[1].slice(-8) : s.slice(0, 8);
}

function readNameFile(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(NAME_FILE_MAX);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, NAME_FILE_MAX, 0));
  } finally {
    fs.closeSync(fd);
  }
}

function appendReceipt(dir, rec, now) {
  try { fs.appendFileSync(path.join(dir, 'receipts.jsonl'), JSON.stringify({ ts: now, ...rec }) + '\n', { mode: 0o600 }); } catch {}
}

function resolveSubagent(dir, target) {
  if (typeof target !== 'string' || !SUBQ_ID_RE.test(target)) return null;
  if (fs.existsSync(path.join(dir, `${target}.nonce`))) return target;
  if (!SUBQ_RESERVED_NAME_RE.test(target)) {
    let id;
    try { id = String(readNameFile(path.join(dir, 'names', target)) || '').trim(); } catch { return null; }
    return SUBQ_ID_RE.test(id) && fs.existsSync(path.join(dir, `${id}.nonce`)) ? id : null;
  }
  const m = SUBQ_ID8_RE.exec(target);
  if (!m) return null;
  let ids = [];
  try { ids = fs.readdirSync(dir).filter((n) => n.endsWith('.nonce')).map((n) => n.slice(0, -'.nonce'.length)); } catch { return null; }
  const hits = ids.filter((id) => SUBQ_ID_RE.test(id) && id8Of(id) === m[1]);
  return hits.length === 1 ? hits[0] : null;
}

function claimQueue(dir, id, pid) {
  const q = path.join(dir, id);
  let names = [];
  try { names = fs.readdirSync(q).filter((n) => !n.startsWith('.')).sort(); } catch { return null; }
  if (names.length === 0) return null;
  const claim = `${q}.draining.${pid}`;
  try { fs.mkdirSync(claim, { recursive: true, mode: 0o700 }); } catch { return null; }
  const notes = [];
  for (const n of names) {
    try { fs.renameSync(path.join(q, n), path.join(claim, n)); } catch { continue; }
    let raw;
    try { raw = fs.readFileSync(path.join(claim, n), 'utf8').replace(/\n+$/, ''); } catch { continue; }
    if (!n.endsWith(SUBQ_DM_SUFFIX)) { notes.push({ from: null, text: raw }); continue; }
    const nl = raw.indexOf('\n');
    notes.push({ from: nl < 0 ? raw : raw.slice(0, nl), text: nl < 0 ? '' : raw.slice(nl + 1) });
  }
  return { claim, notes, body: notes.map((x) => (x.from == null ? x.text : `[dm from ${x.from}] ${x.text}`)).join('\n') };
}

function retireSubagent(dir, id, why, { pendingRoot, seat, born, now, pid }) {
  const got = claimQueue(dir, id, pid);
  if (got && got.body) {
    try {
      const seq = `${now}.${String(pid % 1e9).padStart(9, '0')}`;
      require('./pending-store').parkDelivery(pendingRoot, seat, `[agent:sub] undelivered to ${id} (${why}): ${got.body}`, seq, null, false, born);
      appendReceipt(dir, { id, ev: 'undelivered' }, now);
      fs.rmSync(got.claim, { recursive: true, force: true });
    } catch {}
  } else if (got) {
    try { fs.rmSync(got.claim, { recursive: true, force: true }); } catch {}
  }
  try { fs.unlinkSync(path.join(dir, `${id}.nonce`)); } catch {}
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'names')); } catch {}
  for (const n of names) {
    const p = path.join(dir, 'names', n);
    try { if (String(readNameFile(p) || '').trim() === id) fs.unlinkSync(p); } catch {}
  }
}

function recordName(dir, name, id, pid) {
  if (typeof name !== 'string' || typeof id !== 'string' || !SUBQ_NAME_RE.test(name) || !SUBQ_ID_RE.test(id)) return;
  const names = path.join(dir, 'names');
  const tmp = path.join(names, `.${name}.${pid}.tmp`);
  try {
    fs.mkdirSync(names, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, id, { mode: 0o600 });
    fs.renameSync(tmp, path.join(names, name));
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function nameOfSubagent(dir, id) {
  if (typeof dir !== 'string' || !dir || typeof id !== 'string' || !SUBQ_ID_RE.test(id)) return null;
  if (!fs.existsSync(path.join(dir, `${id}.nonce`))) return null;
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'names')).sort(); } catch { return null; }
  for (const n of names) {
    if (!SUBQ_NAME_RE.test(n) || SUBQ_RESERVED_NAME_RE.test(n)) continue;
    try {
      if (String(readNameFile(path.join(dir, 'names', n)) || '').trim() === id) return n;
    } catch {}
  }
  return null;
}

function clearSubq(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function subqHookOutput(raw, { dir, pendingRoot, seat, born = null, now = Date.now(), pid = process.pid } = {}) {
  let d;
  try { d = JSON.parse(raw); } catch { return ''; }
  if (!d || typeof d !== 'object' || !dir) return '';
  const ctx = { pendingRoot, seat, born, now, pid };
  if (d.agent_id !== undefined) {
    const id = d.agent_id;
    if (typeof id !== 'string' || !SUBQ_ID_RE.test(id)) return '';
    if (d.hook_event_name === 'SubagentStop') {
      retireSubagent(dir, id, 'it finished before its next tool call', ctx);
      return '';
    }
    const got = claimQueue(dir, id, pid);
    if (!got) return '';
    try { fs.rmSync(got.claim, { recursive: true, force: true }); } catch {}
    if (!got.body) return '';
    let nonce = '';
    try { nonce = fs.readFileSync(path.join(dir, `${id}.nonce`), 'utf8').trim(); } catch {}
    if (!nonce) {
      appendReceipt(dir, { id, ev: 'no-nonce' }, now);
      return '';
    }
    appendReceipt(dir, { id, ev: 'delivered', bytes: Buffer.byteLength(got.body) }, now);
    const context = got.notes.map((x) => (x.from == null ? `[parent ${nonce}] ${x.text}` : `[dm ${nonce} from ${x.from}] ${x.text}`)).join('\n');
    return JSON.stringify({ hookSpecificOutput: { hookEventName: d.hook_event_name || 'PostToolUse', additionalContext: context } });
  }
  if (d.tool_name === 'Agent') {
    const r = d.tool_response || {};
    recordName(dir, d.tool_input && d.tool_input.name, r.agentId || r.agent_id, pid);
  } else if (d.tool_name === 'TaskStop') {
    const id = resolveSubagent(dir, d.tool_input && d.tool_input.task_id);
    if (id) retireSubagent(dir, id, 'it was stopped before its next tool call', ctx);
  }
  return '';
}

module.exports = { SUBQ_ID_RE, SUBQ_NAME_RE, SUBQ_RESERVED_NAME_RE, SUBQ_DM_SUFFIX, id8Of, resolveSubagent, nameOfSubagent, clearSubq, subqHookOutput };
