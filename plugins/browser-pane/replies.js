'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loginLabel } = require('./read-format');

const ANSI = new RegExp('\\u001B\\[[0-9;?]*[a-zA-Z]|\\u001B\\][^\\u0007]*\\u0007', 'g');
const CTRL = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g');
const RUNS = new RegExp('\\s+', 'g');

const PREFIX = '[agent:browser]';
const REPLY_MAX = 600;
const SEAT_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const KEEP_FILES = 50;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FILE_RE = /^[rs]-(\d+)\.(txt|jpg)$/;

function oneLine(text, max = 0) {
  let s = String(text).replace(ANSI, '').replace(CTRL, ' ').replace(RUNS, ' ').trim();
  if (max > 0 && s.length > max) s = s.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
  return s;
}

function reply(text) {
  return oneLine(`${PREFIX} ${text}`, REPLY_MAX);
}

function errorReply(message) {
  return reply(`error: ${message}`);
}

function showPath(p) {
  return /\s/.test(p) ? `"${p}"` : p;
}

function withPath(head, tail) {
  const room = REPLY_MAX - oneLine(tail).length;
  return oneLine(head, Math.max(40, room)) + tail;
}

function idleLabel(idle) {
  if (!idle) return '';
  const secs = (Number(idle.ms) / 1000).toFixed(1);
  if (idle.ok) return `idle ${secs}s`;
  const n = Array.isArray(idle.inflight) ? idle.inflight.length : 0;
  return n ? `still busy after ${Math.round(idle.ms / 1000)}s (${n} requests in flight: ${idle.inflight.slice(0, 3).join(', ')})`
    : `still busy after ${Math.round(idle.ms / 1000)}s`;
}

function openReply(service, r) {
  const parts = [`opened ${service}`, String(r.status == null ? '?' : r.status), JSON.stringify(String(r.title || '')), String(r.url || ''),
    `login: ${loginLabel(r.login)}`];
  const idle = idleLabel(r.idle);
  if (idle) parts.push(idle);
  parts.push('next: read');
  return reply(parts.join(' · '));
}

function tokLabel(n) {
  return n < 1000 ? `≈${n} tok` : `≈${(n / 1000).toFixed(1)}k tok`;
}

function readReply(service, info, file, sessionType) {
  const head = `${PREFIX} read ${service} · page ${info.page}/${info.pages} · ${info.elements} elements · ${tokLabel(info.tokens)}`;
  const tail = sessionType === 'claude'
    ? ` → @${showPath(file)} `
    : ` → saved to ${showPath(file)} — read it with your Read tool.`;
  return withPath(head, tail);
}

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function loginState(login) {
  const st = login && login.state;
  if (st === 'logged-in') return `signed in${login.at ? ` (${stamp(login.at)})` : ''}`;
  if (st === 'login-page') return 'sign-in page';
  if (st === 'idp-refused') return 'Google sign-in refused';
  return 'unknown';
}

function servicesReply(services, mirror) {
  const names = Object.keys(services || {}).sort((a, b) => (services[b].lastUsedAt || 0) - (services[a].lastUsedAt || 0));
  if (!names.length) return reply('no services yet — [agent:browser open <service>] <url>');
  const items = names.map((n) => {
    const state = mirror && mirror.get(n);
    const win = state && state !== 'closed' ? `window open · ${state}` : 'closed';
    return `${n} — ${loginState(services[n].login)} · ${win}`;
  });
  return reply(`services: ${items.join(' │ ')}`);
}

function replyDir(seat, root) {
  if (!SEAT_RE.test(String(seat || ''))) throw new Error(`bad seat name for a reply file: ${seat}`);
  return path.join(root || os.tmpdir(), 'clodex-browser-pane', seat);
}

function prune(dir, now) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)); } catch { return; }
  const rows = [];
  for (const f of files) {
    const p = path.join(dir, f);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (now - st.mtimeMs > MAX_AGE_MS) { try { fs.unlinkSync(p); } catch {} continue; }
    rows.push({ p, mtime: st.mtimeMs, seq: Number(FILE_RE.exec(f)[1]) });
  }
  rows.sort((a, b) => (b.mtime - a.mtime) || (b.seq - a.seq));
  for (const r of rows.slice(KEEP_FILES)) { try { fs.unlinkSync(r.p); } catch {} }
}

function writeReplyFile(seat, content, { root, kind = 'r', ext = 'txt', now = Date.now() } = {}) {
  const dir = replyDir(seat, root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  let seq = 0;
  for (const f of fs.readdirSync(dir)) {
    const m = FILE_RE.exec(f);
    if (m) seq = Math.max(seq, Number(m[1]));
  }
  let file;
  for (;;) {
    seq += 1;
    file = path.join(dir, `${kind}-${String(seq).padStart(4, '0')}.${ext}`);
    try {
      fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  prune(dir, now);
  return file;
}

module.exports = {
  oneLine, reply, errorReply, openReply, readReply, servicesReply, writeReplyFile, replyDir, loginState, stamp,
  PREFIX, REPLY_MAX,
};
