'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loginLabel, CHANGE_MAX, redactUrl, hostOf } = require('./read-format');

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
  if (idle.stopped) return `stopped a stalled load after ${Math.round(idle.ms / 1000)}s`;
  const n = Array.isArray(idle.inflight) ? idle.inflight.length : 0;
  return n ? `still busy after ${Math.round(idle.ms / 1000)}s (${n} requests in flight: ${idle.inflight.slice(0, 3).map(redactUrl).join(', ')})`
    : `still busy after ${Math.round(idle.ms / 1000)}s`;
}

function openReply(service, r) {
  const parts = [`opened ${service}`, String(r.status == null ? '?' : r.status), JSON.stringify(String(r.title || '')), redactUrl(r.url || ''),
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
  const head = `${PREFIX} read ${service} · page ${info.page}/${info.pages} · ${info.elements} elements · ${tokLabel(info.tokens)}`
    + (info.stripped ? ' · chrome stripped' : '') + (info.hidden > 0 ? ` · ${info.hidden} elements hidden` : '') + (info.loading ? ' · still loading' : '');
  return withPath(head, fileTail(file, sessionType));
}

function fileTail(file, sessionType) {
  return sessionType === 'claude' ? ` → @${showPath(file)} ` : ` → saved to ${showPath(file)} — read it with your Read tool.`;
}

function looksPdf(r) {
  return /\.pdf$/i.test(String(r.file || '')) || /^application\/pdf\b/i.test(String(r.mime || ''));
}

function downloadTarget(cmd) {
  if (cmd.n != null) return `[${cmd.n}]`;
  if (cmd.url) return clipUrl(cmd.url);
  return 'current page';
}

function downloadReply(service, cmd, r) {
  const head = `${PREFIX} downloaded ${service} ${downloadTarget(cmd)}`;
  const parts = [`${Number(r.bytes || 0).toLocaleString('en-US')} B`, String(r.mime || 'unknown type')];
  if (r.same) parts.unshift('same as an existing file');
  if (r.magic === 'html' && looksPdf(r)) {
    parts.push(`WARNING: not a PDF — looks like a web page (session expired?) — read ${service}`);
  } else {
    if (r.magic === 'pdf') parts.push('%PDF ok');
    parts.push(`${(Number(r.ms || 0) / 1000).toFixed(1)}s`);
  }
  return withPath(head, ` → ${showPath(String(r.file || ''))} · ${parts.join(' · ')}`);
}

function screenshotReply(service, r, file, sessionType) {
  const drawn = r.numbers == null ? '' : ` · ${r.numbers} numbers drawn`;
  return withPath(`${PREFIX} screenshot ${service} ${r.width}×${r.height}${drawn}`, fileTail(file, sessionType));
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

function servicesReply(services, mirror, urlOf = () => '') {
  const names = Object.keys(services || {}).sort((a, b) => (services[b].lastUsedAt || 0) - (services[a].lastUsedAt || 0));
  if (!names.length) return reply('no services yet — [agent:browser open <service>] <url>');
  const items = names.map((n) => {
    const state = mirror && mirror.get(n);
    const open = !!state && state !== 'closed';
    const win = open ? `window open · ${state}` : 'closed';
    const rec = services[n] || {};
    const host = hostOf((open && urlOf(n)) || rec.lastUrl);
    const opened = rec.openedHost || hostOf(rec.lastUrl);
    const site = host ? `${host}${opened && opened !== host ? ` (was ${opened})` : ''} · ` : '';
    return `${n} — ${site}${loginState(rec.login)} · ${win}`;
  });
  return reply(`services: ${items.join(' │ ')}`);
}

function ago(ms) {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
}

function clipUrl(url) {
  const u = redactUrl(url || '');
  return u.length > 160 ? u.slice(0, 159) + '…' : u;
}

const TEXT = {
  lease: (service, seat, agoMs) => `${service} is in use by ${seat} (last command ${ago(agoMs)} ago). It frees after 5 min without commands, when they emit [agent:browser release ${service}], or when their session ends.`,
  noElement: (service, n) => `[${n}] is no longer on this page of ${service} — read again`,
  retiredN: (service, n, now) => `[${n}] retired: its text changed since your read${now ? ` (now [${now}]?)` : ''} — read again`,
  unknownN: (service, n) => `[${n}] was not in your read of ${service} — read again`,
  ambiguousN: (service, n, label, context) => `[${n}] on ${service} no longer points at one element (was ${JSON.stringify(String(label || ''))}${context ? ` in ${JSON.stringify(String(context))}` : ''}) — read again and use the new number`,
  held: (service, reason) => `the operator has control of ${service} (${reason === 'takeover' ? 'takeover' : 'sign-in'}). Emit [agent:browser wait ${service}] and end your turn.`,
  operatorBusy: (service) => `the operator has been using the ${service} window for the last 60s; try again in a minute or emit [agent:browser wait ${service}].`,
  passwordField: (service, n) => `[${n}] is a password field — credentials never pass through agents. The operator has been asked to sign in; emit [agent:browser wait ${service}] and end your turn. Do not ask anyone for the password.`,
  readFirst: (service) => `read ${service} first — numbers come from your read`,
  denied: (url, pattern, service, verb = 'open') => `${verb} refused: ${redactUrl(url)} matches denylist pattern ${JSON.stringify(String(pattern))} (${service ? `service ${service}` : 'global'}) — ask the operator to change the browser pane denylist in Settings`,
  deniedBar: (pattern, service) => `Refused: matches denylist pattern ${JSON.stringify(String(pattern))} (${service ? `service ${service}` : 'global'})`,
  consequential: (n, label, category) => `[${n}] ${JSON.stringify(String(label || ''))} ${category === 'publish' ? 'publishes as the operator' : `looks consequential (${category})`} — re-issue with --confirm if the operator asked for it`,
  waited: (service, ms) => `${service} waited ${Number((ms / 1000).toFixed(1))}s`,
  restarted: (service) => `numbers from before the browser restarted are void on ${service} — read again`,
  notSelect: (n) => `[${n}] is not a native select — click it, read, then click the option`,
  notEditable: (n, kind) => `[${n}] is not a text field (${kind}) — click it, or use select for a list`,
  driving: (seat, service, waiting) => `agent ${seat} ${waiting ? 'is waiting on' : 'is driving'} ${service} — wait or ask it to release`,
  takeover: ' · the operator took over during this command',
  popup: ' · link opened a new window; followed it in this view',
  noText: (service, text) => `no visible element with the text ${JSON.stringify(String(text))} on ${service} — read ${service}, or try a shorter part of the text`,
  manyText: (service, text, count, hits, verb = 'click') => `${JSON.stringify(String(text))} matches ${count} visible elements on ${service}: ${
    hits.slice(0, 5).map((h) => `[${h.n}] ${JSON.stringify(String(h.text || ''))}`).join(', ')}${count > 5 ? `, …(+${count - 5} more)` : ''} — ${verb} one by number`,
};

function operatorNav(service, url, title, inPage = false) {
  return reply(`the operator navigated ${service} to ${redactUrl(url)}${inPage ? ' (in-page)' : ''} (${JSON.stringify(oneLine(title || '', 120))}) — read before using numbers`);
}

function isGoogle(login) {
  return !!(login && (login.idp === 'google' || login.googleRejected));
}

function signinKind(login) {
  if (!login) return 'sign-in page';
  if (login.password) return 'password field';
  if (login.otp) return 'one-time code field';
  if (login.captcha) return 'captcha';
  if (login.idp) return `${login.idp} sign-in`;
  return 'sign-in page';
}

function signinReply(service, login, url) {
  if (isGoogle(login)) {
    return reply(`sign-in on ${service} goes through Google (accounts.google.com), which refuses sign-in inside embedded browsers, so the operator probably cannot log in here. Tell the operator in one line and stop: they can try the portal's own email/password login, or download the files by hand. Do not ask for credentials.`);
  }
  return reply(`sign-in needed on ${service} (${signinKind(login)} at ${clipUrl(url)}). The operator has been notified and signs in themselves in the browser window. Do not ask anyone for a password or code and do not type one. Emit [agent:browser wait ${service}] and end your turn; the reply comes when the operator hands the window back.`);
}

function signinNotice(service, seat, url, login) {
  if (isGoogle(login)) {
    return {
      title: `Browser: ${service} uses Google sign-in`,
      body: 'Google refuses sign-in inside embedded browsers ("This browser or app may not be secure"). If the portal has its own email/password login, use it in the window and press Hand back; otherwise this service cannot be automated yet.',
    };
  }
  return {
    title: `Browser: sign in to ${service}`,
    body: `${seat} opened ${url} and hit a sign-in page. Click "browser: needs you" in the status bar (or find the "${service} — Clodex Browser" window), sign in, then press "Hand back to agent". The agent never sees what you type.`,
  };
}

function dropSuffix(labels) {
  if (!labels.length) return '';
  const n = labels.length;
  return ` — dropped ${n} queued command${n === 1 ? '' : 's'} after it: ${labels.join(', ')}`;
}

function pageLabel(r) {
  if (!r || !r.navigated) return 'same page';
  if (r.inPage) return `navigated → ${redactUrl(r.url)} (in-page) · numbers kept where the page repeats`;
  return `navigated → ${redactUrl(r.url)} (${JSON.stringify(String(r.title || ''))}) · numbers kept where the page repeats`;
}

function actReply(sub, service, cmd, r) {
  let head;
  if (sub === 'click') {
    const n = r.n != null ? r.n : cmd.n;
    head = `clicked ${service} [${n}]${r.fresh ? ' (numbered now)' : ''} ${r.kind} ${JSON.stringify(String(r.label || ''))}${r.textChanged ? ` (text under [${n}] changed since your read)` : ''}`;
  }
  else if (sub === 'type') head = `typed ${service} [${cmd.n}] (${[...String(cmd.text)].length} chars)${cmd.enter ? ' + Enter' : ''}`;
  else if (sub === 'select') head = `selected ${service} [${cmd.n}] = ${JSON.stringify(String(r.text || ''))}`;
  else head = `pressed ${cmd.key} on ${service}`;
  const parts = [head, pageLabel(r)];
  const idle = idleLabel(r.idle);
  if (idle) parts.push(idle);
  let text = parts.join(' · ');
  if (r.download) text += downloadTail(r.download, r.popupUrl);
  else if (r.popupUrl) text += ` · → popup ${clipUrl(r.popupUrl)}`;
  else if (r.popup) text += TEXT.popup;
  else if ((!r.navigated || r.inPage) && typeof r.changed === 'string') text += changeTail(sub, r);
  if (r.takeover) text += TEXT.takeover;
  return oneLine(`${PREFIX} ${text}`, REPLY_MAX + CHANGE_MAX);
}

function changeTail(sub, r) {
  const target = r.target ? ` · target: ${r.target}` : '';
  if (r.changed) return ` · changed: ${JSON.stringify(r.changed)}${target}`;
  if (target) return target;
  if (sub === 'type' && typeof r.value === 'string') {
    const v = [...r.value];
    return ` · value now ${JSON.stringify(v.length > 60 ? v.slice(0, 59).join('') + '…' : r.value)}`;
  }
  return r.watched ? ` · no change on the target within ${Math.round((r.watched || 0) / 1000)}s` : ' · no visible change';
}

function bytesLabel(n) {
  return `${Number(n).toLocaleString('en-US')} B`;
}

function downloadTail(d, popupUrl) {
  const where = showPath(String(d.file || d.name || ''));
  if (d.failed) return ` · → download ${where} failed: ${d.failed}`;
  if (d.bytes == null) return ` · → download ${where} still downloading`;
  if (d.same) return ` · → download same as ${where} · ${bytesLabel(d.bytes)}`;
  const from = d.url ? ` · from ${clipUrl(d.url)}${popupUrl ? ' (PDF popup)' : ''}` : '';
  return ` · → download ${where} · ${bytesLabel(d.bytes)} · ${String(d.mime || 'unknown type')}${from}`;
}

function shortEl(r, k) {
  return `${r.tag || '?'}${r.id ? `#${r.id}` : ''}${(r.classes || []).slice(0, k).map((c) => `.${c}`).join('')}`;
}

function attrValue(v) {
  const s = oneLine(v);
  return !s || /\s/.test(s) ? JSON.stringify(s) : s;
}

function listenersLabel(l) {
  if (!l) return 'unknown';
  const own = (l.types || []).join(', ');
  const up = l.ancestor ? `${l.ancestorType || 'click'} on ancestor ${l.ancestor}` : '';
  if (own && up) return `${own} · ${up}`;
  if (own) return own;
  return up ? `none here · ${up}` : 'none';
}

function inspectReply(service, r) {
  const attrs = (r.attrs || []).map(([k, v]) => `${oneLine(k)}=${attrValue(v)}`).join(' ');
  const rect = r.rect || {};
  const lines = [
    `${PREFIX} inspect ${service} [${r.n}]${r.fresh ? ' (numbered now)' : ''}: ${oneLine(shortEl(r, 5))} · ${oneLine(r.kind || '')} ${r.label || r.kind !== 'clickable' ? JSON.stringify(String(r.label || '')) : '(icon)'}`,
    `  attrs: ${attrs || 'none'}`,
    `  listeners: ${oneLine(listenersLabel(r.listeners))}`,
    `  cursor: ${oneLine(r.cursor || '?')} · at ${rect.x},${rect.y} size ${rect.w}×${rect.h} · ${r.visible ? 'visible' : 'hidden'}`,
    `  in: ${(r.ancestors || []).slice().reverse().map((a) => oneLine(a)).join(' > ') || '(none)'}`,
    `  html: ${oneLine(r.html || '')}`,
  ];
  return lines.join('\n');
}

function waitReply(service, r, forText) {
  const secs = (Number(r.ms) / 1000).toFixed(1);
  if (forText != null) {
    return r.found ? reply(`${service} shows ${JSON.stringify(forText)} after ${secs}s`)
      : reply(`${service} does not show ${JSON.stringify(forText)} after ${Math.round(r.ms / 1000)}s`);
  }
  if (r.ok) return reply(`${service} idle after ${secs}s`);
  return reply(`${service} ${idleLabel(r)}`);
}

function handbackReply(service, frame) {
  const signed = frame.login && frame.login.password ? 'still on a sign-in page' : 'signed in';
  return reply(`the operator handed ${service} back · now ${redactUrl(frame.url || '')} (${JSON.stringify(String(frame.title || ''))}) · ${signed} · read to continue`);
}

const HANDOVER_MAX = 800;
const INSTRUCTION_MAX = 400;

function handover(service, url, title, instruction) {
  let ask = oneLine(instruction == null ? '' : instruction);
  if (ask.length > INSTRUCTION_MAX) ask = ask.slice(0, INSTRUCTION_MAX - 1) + '…';
  const pre = oneLine(`${PREFIX} the operator opened ${service} at ${clipUrl(url)} (${JSON.stringify(oneLine(title || '', 60))}) and handed it to you —`, HANDOVER_MAX) + ' ';
  const tail = ` — start with [agent:browser read ${service}]`;
  const room = Math.max(1, HANDOVER_MAX - pre.length - tail.length);
  let what = ask || 'read it and report what you see';
  if (what.length > room) what = what.slice(0, room - 1) + '…';
  return `${pre}${what}${tail}`;
}

function heldTimeout(service, ms) {
  return reply(`the operator still has control of ${service} after ${ago(ms)} — emit [agent:browser wait ${service}] again, or end your turn`);
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
  downloadReply, screenshotReply, inspectReply,
  PREFIX, REPLY_MAX, TEXT, ago, signinReply, signinNotice, dropSuffix, actReply, waitReply, handbackReply, heldTimeout, isGoogle,
  handover, INSTRUCTION_MAX, operatorNav,
};
