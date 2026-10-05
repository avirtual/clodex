'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loginLabel, CHANGE_MAX, MOST_OF_PAGE, redactUrl, hostOf } = require('./read-format');

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
  if (r.shown === false) parts.push('window hidden (open --show or the pane\'s Show button raises it)');
  return reply(parts.join(' · '));
}

function tokLabel(n) {
  return n < 1000 ? `≈${n} tok` : `≈${(n / 1000).toFixed(1)}k tok`;
}

const DIGEST_HEADINGS = 6;
const DIGEST_LANDMARKS = 3;
const DIGEST_WARN = 30;
const DIGEST_WARN_FIRST = 10;
const DIGEST_WARN_LABEL = 40;
const DIGEST_LABEL = 60;
const HINT_STOP = new Set(['view', 'press', 'more', 'show', 'new', 'your', 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'posts', 'page']);
const DIGEST_TITLE = 120;
const COMPACT_HINT_POSTS = 5;
const WORD_RE = /[\p{L}\p{N}]{4,}/gu;

function readReply(service, info, file, sessionType, attach = { attach: true }) {
  const head = `${PREFIX} read ${service} · page ${info.page}/${info.pages} · ${info.elements} elements · ${tokLabel(info.tokens)}`
    + (info.stripped ? ' · chrome stripped' : '') + (info.hidden > 0 ? ` · ${info.hidden} elements hidden` : '') + (info.loading ? ' · still loading' : '');
  if (attach.attach) return withPath(head, fileTail(file, sessionType));
  const why = attach.budget == null ? '--path-only' : `over ${tokLabel(attach.budget)}`;
  const tail = sessionType === 'claude'
    ? ` → ${showPath(file)} (not attached: ${why}; read or grep it, or narrow with --filter=/--page=)` : fileTail(file, sessionType);
  return [withPath(head, tail), ...digestLines(info)].join('\n');
}

function topWord(texts) {
  const counts = new Map();
  for (const t of texts) {
    for (const w of new Set(String(t).toLowerCase().match(WORD_RE) || [])) if (!HINT_STOP.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
  }
  let best = null;
  for (const [w, c] of counts) if (c >= 2 && (!best || c > best[1])) best = [w, c];
  return best && best[0];
}

function readHint(info, headings) {
  const parts = [];
  const word = topWord(headings);
  if (!info.main && info.stripped) parts.push('--main');
  else if (word) parts.push(`--filter=${word}`);
  if (!info.compact && info.posts >= COMPACT_HINT_POSTS) parts.push('--compact');
  if (info.pages > 1) parts.push(`--page=${info.page < info.pages ? info.page + 1 : 1} (of ${info.pages})`);
  return parts.length ? [`  hint: ${parts.join(' · ')}`] : [];
}

function digestLines(info) {
  const d = info.digest || {};
  const c = d.counts;
  const size = `  size: ${tokLabel(info.tokens)} · page ${info.page}/${info.pages} · ${info.elements} elements`
    + (!c ? '' : c.all ? ` · new: all (${c.all})` : c.unknown ? ` · new: ? (${c.unknown})` : ` · new: ${c.fresh} · retired: ${c.retired} · changed: ${c.changed}`);
  const clip = (t) => oneLine(t, DIGEST_LABEL);
  const headings = (d.headings || []).slice(0, DIGEST_HEADINGS).map(clip).filter(Boolean);
  const landmarks = (d.landmarks || []).slice(0, DIGEST_LANDMARKS).map(clip).filter(Boolean);
  const outline = headings.length ? [`  headings: ${headings.join(' | ')}`] : landmarks.length ? [`  landmarks: ${landmarks.join(' | ')}`] : [];
  const warn = d.warn || [];
  const row = (w) => `[${w.n}] ${JSON.stringify(oneLine(w.label, DIGEST_WARN_LABEL))}`;
  const ads = d.ads || {};
  const adLine = ads.posts > 0 ? [`  ⚠ ad: ${ads.posts} ad${ads.posts === 1 ? '' : 's'} (${ads.elements} element${ads.elements === 1 ? '' : 's'}) — clicking any of them is a paid click; the compact feed marks them Ad`] : [];
  const folded = Object.entries(d.folded || {}).filter(([, n]) => n > 0);
  const foldLine = folded.length ? [`  ⚠ folded: ${folded.map(([k, n]) => `${k} ×${n}`).join(', ')}`] : [];
  const warnLine = !warn.length ? [] : warn.length <= DIGEST_WARN ? [`  ⚠: ${warn.map(row).join(' · ')}`] : [
    `  ⚠ ${warn.length}: ${[...warn.reduce((m, w) => m.set(w.cat, (m.get(w.cat) || 0) + 1), new Map())].map(([k, n]) => `${k} ×${n}`).join(', ')}`,
    `  ⚠ first ${DIGEST_WARN_FIRST}: ${warn.slice(0, DIGEST_WARN_FIRST).map(row).join(' · ')}`,
  ];
  return [
    `  title: ${JSON.stringify(oneLine(d.title || '', DIGEST_TITLE))} · ${oneLine(d.url || '')} · login: ${oneLine(d.login || '')}`,
    size,
    ...outline,
    ...warnLine,
    ...adLine,
    ...foldLine,
    ...readHint(info, headings),
  ];
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

function screenshotReply(service, r, file, sessionType, attach = true) {
  const drawn = r.numbers == null ? '' : ` · ${r.numbers} numbers drawn`;
  const tail = attach || sessionType !== 'claude' ? fileTail(file, sessionType) : ` → ${showPath(file)}`;
  return withPath(`${PREFIX} screenshot ${service} ${r.width}×${r.height}${drawn}`, tail);
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
    const sign = !open && rec.login && rec.login.state === 'login-page' ? 'sign-in was pending' : loginState(rec.login);
    return `${n} — ${site}${sign} · ${win}`;
  });
  return reply(`services: ${items.join(' │ ')}`);
}

function closedReply(service, rec, windows) {
  const login = rec && rec.login && rec.login.state === 'logged-in'
    ? ` · signed in stays (open ${service} ${rec.lastUrl || '<url>'} resumes it)` : '';
  const count = Number(windows) || 0;
  return reply(`closed ${service}${login} · ${count} window${count === 1 ? '' : 's'} open`);
}

function ago(ms) {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
}

function clipUrl(url) {
  const u = redactUrl(url || '');
  return u.length > 160 ? u.slice(0, 159) + '…' : u;
}

function clipNavUrl(u, max) {
  if (u.length <= max) return u;
  const base = u.split(/[?#]/)[0];
  return `${base.length < max ? base : base.slice(0, max - 1)}…`;
}

const TEXT = {
  lease: (service, seat, agoMs) => `${service} is in use by ${seat} (last command ${ago(agoMs)} ago). It frees after 5 min without commands, when they emit [agent:browser release ${service}], or when their session ends.`,
  noElement: (service, n) => `[${n}] is no longer on this page of ${service} — read again`,
  covered: (n, el) => {
    const label = JSON.stringify(String(el.hitLabel || ''));
    const head = `[${n}] ${JSON.stringify(String(el.label || ''))} is covered at its click point by`;
    if (el.hitN != null && el.hitConsequential) return `${head} [${el.hitN}] ⚠ ${label} (${el.hitConsequential}) — read again, or click it with --confirm if the operator asked for it`;
    if (el.hitN != null) return `${head} [${el.hitN}] ${label} — read again, or click the element that covers it`;
    const buttons = (el.hitButtons || []).map((b) => `[${b.n}] ${JSON.stringify(String(b.label || ''))}`).join(' · ');
    if (buttons) return `${head} an unnumbered element (${label}) whose buttons are ${buttons} — read again, or click one of them`;
    return `${head} an unnumbered element (${label}) — read again, or click the element that covers it`;
  },
  retiredN: (service, n, now) => `[${n}] retired: its text changed since your read${now ? ` (now [${now}]?)` : ''} — read again`,
  unknownN: (service, n) => `[${n}] was not in your read of ${service} — read again`,
  ambiguousN: (service, n, label, context) => `[${n}] on ${service} no longer points at one element (was ${JSON.stringify(String(label || ''))}${context ? ` in ${JSON.stringify(String(context))}` : ''}) — read again and use the new number`,
  held: (service, reason) => `the operator has control of ${service} (${reason === 'takeover' ? 'takeover' : 'sign-in'}). Emit [agent:browser wait ${service}] and end your turn.`,
  operatorBusy: (service) => `the operator has been using the ${service} window for the last 60s; try again in a minute or emit [agent:browser wait ${service}].`,
  passwordField: (service, n) => `[${n}] is a password field — credentials never pass through agents. The operator has been asked to sign in; emit [agent:browser wait ${service}] and end your turn. Do not ask anyone for the password.`,
  readFirst: (service) => `read ${service} first — numbers come from your read`,
  denied: (url, pattern, service, verb = 'open') => `${verb} refused: ${redactUrl(url)} matches denylist pattern ${JSON.stringify(String(pattern))} (${service ? `service ${service}` : 'global'}) — ask the operator to change the browser pane denylist in Settings`,
  deniedBar: (pattern, service) => `Refused: matches denylist pattern ${JSON.stringify(String(pattern))} (${service ? `service ${service}` : 'global'})`,
  consequential: (n, label, category) => `[${n}] ${JSON.stringify(String(label || ''))} ${category === 'ad' ? 'is an ad — clicking it is a paid click on the operator\'s account and leaves the site;' : category === 'publish' ? 'publishes as the operator —' : `looks consequential (${category}) —`} re-issue with --confirm if the operator asked for it`,
  submitUnknown: (key = 'Enter') => `could not tell what ${key} would ${key === 'Space' ? 'press' : key.startsWith('Arrow') ? 'choose' : 'submit'} — read again, or add --confirm if the operator asked for it`,
  consequentialSubmit: (from, sub, key = 'Enter') => {
    const label = JSON.stringify(String(sub.label || ''));
    const verb = !sub.choose ? 'press' : sub.change ? 'change' : 'choose';
    const what = sub.press ? `${verb} ${sub.n == null ? '' : `[${sub.n}] `}${label}`
      : sub.n == null ? `submit the form ${label}` : `submit through [${sub.n}] ${label}`;
    const why = sub.consequential === 'ad' ? 'which is an ad — a paid click on the operator\'s account that leaves the site;'
      : sub.consequential === 'publish' ? 'which publishes as the operator —' : `which looks consequential (${sub.consequential}) —`;
    const where = from == null ? (sub.press ? 'the focused control' : 'the focused field') : `[${from}]`;
    return `${key} ${sub.press ? 'on' : 'in'} ${where} would ${what} ${why} re-issue with --confirm if the operator asked for it`;
  },
  waited: (service, ms) => `${service} waited ${Number((ms / 1000).toFixed(1))}s`,
  restarted: (service) => `numbers from before the browser restarted are void on ${service} — read again`,
  notSelect: (n) => `[${n}] is not a native select — click it, read, then click the option`,
  notEditable: (n, kind) => `[${n}] is not a text field (${kind}) — click it, or use select for a list`,
  driving: (seat, service, waiting) => `agent ${seat} ${waiting ? 'is waiting on' : 'is driving'} ${service} — wait or ask it to release`,
  takeover: ' · the operator took over during this command',
  popup: ' · link opened a new window; followed it in this view',
  noText: (service, text) => `no visible element with the text ${JSON.stringify(String(text))} on ${service} — read ${service}, or try a shorter part of the text`,
  twinText: (service, text) => `${JSON.stringify(String(text))} on ${service} is an unnumbered twin of a numbered element with the same row text — read ${service}; the re-read numbers both`,
  manyText: (service, text, count, hits, verb = 'click') => `${JSON.stringify(String(text))} matches ${count} visible elements on ${service}: ${
    hits.slice(0, 5).map(textHit).join(', ')}${count > 5 ? `, …(+${count - 5} more)` : ''} — ${hits.every((h) => h.loose) ? `read ${service} and use a number` : `${verb} one by number`}`,
  looseText: (service, text, hit) => `${JSON.stringify(String(text))} on ${service} is only text: ${textHit(hit)} — read ${service} and use a number`,
  notService: (name, names) => `${name} is not a service here — services: ${names.length ? names.join(', ') : 'none'} — [agent:browser open ${name}] <url> opens a new one`,
};

function textHit(h) {
  if (h.loose) return `[–] ${JSON.stringify(String(h.text || ''))} (not clickable)`;
  return `[${h.n == null ? '?' : h.n}] ${JSON.stringify(String(h.text || ''))}`;
}

function operatorNav(service, url, title, inPage = false) {
  return reply(`the operator navigated ${service} to ${redactUrl(url)}${inPage ? ' (in-page)' : ''} (${JSON.stringify(oneLine(title || '', 120))}) — read before using numbers`);
}

function isGoogle(login) {
  return !!(login && login.googleRejected);
}

function signinKind(login) {
  if (!login) return 'sign-in page';
  if (login.password) return 'password field';
  if (login.otp) return 'one-time code field';
  if (login.captcha) return 'captcha';
  if (login.idp === 'google') return 'Google sign-in';
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
    body: `${seat} opened ${url} and hit a sign-in page. Click "browser: needs you" in the status bar, sign in, then press "Hand back to agent". The agent never sees what you type.`,
  };
}

function dropSuffix(labels) {
  if (!labels.length) return '';
  const n = labels.length;
  return ` — dropped ${n} queued command${n === 1 ? '' : 's'} after it: ${labels.join(', ')}`;
}

function pageLabel(r) {
  if (!r || !r.navigated) return 'same page';
  const u = clipNavUrl(redactUrl(r.url), 120);
  if (r.inPage) return `navigated → ${u} (in-page) · numbers kept where the page repeats`;
  return `navigated → (${JSON.stringify(String(r.title || ''))}) ${u} · numbers kept where the page repeats`;
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
  else if ((!r.navigated || r.inPage) && typeof r.changed === 'string') text += changeTail(sub, r, cmd.key);
  if (r.takeover) text += TEXT.takeover;
  return oneLine(`${PREFIX} ${text}`, REPLY_MAX + CHANGE_MAX);
}

function scrollRange(after, vh) {
  const end = Math.min(after.y + vh, after.height);
  const pct = (v) => Math.round((v / after.height) * 100);
  return `${after.y}–${end} of ${after.height} px (${pct(after.y)}–${pct(end)}%)`;
}

function scrollPosition(after, vh) {
  if (after.y <= 0) return 'top of page';
  if (after.y + vh >= after.height - 2) return 'bottom of page';
  return scrollRange(after, vh);
}

function itemsLabel(a, b) {
  const d = b - a;
  if (d === 0) return a > 0 ? `no new items (${a})` : null;
  const n = Math.abs(d);
  return `${d > 0 ? '+' : '−'}${n} item${n === 1 ? '' : 's'} (${a} → ${b})`;
}

function scrollReply(service, cmd, r) {
  const before = r.before || {};
  const after = r.after || {};
  const head = `scrolled ${service} ${cmd.dir}${cmd.pages > 1 ? ` ×${cmd.pages}` : ''}`;
  const tail = r.takeover ? TEXT.takeover : '';
  if ((cmd.dir === 'down' || cmd.dir === 'up') && !r.navigated && after.y === before.y) {
    return oneLine(`${PREFIX} ${head} · already at ${cmd.dir === 'down' ? 'bottom' : 'top'} of page${tail}`, REPLY_MAX);
  }
  const parts = [head];
  if (r.navigated) parts.push(pageLabel(r));
  const grew = (after.height || 0) - (before.height || 0);
  const fed = cmd.dir === 'bottom' && grew > 0;
  if (fed) parts.push('reached bottom', `feed loaded ${grew} px more`, `now ${scrollRange(after, r.vh || 0)}`);
  else parts.push(scrollPosition(after, r.vh || 0));
  const items = itemsLabel(before.items || 0, after.items || 0);
  if (items) parts.push(items);
  if (grew && !fed) parts.push(`page ${grew > 0 ? 'grew' : 'shrank'} ${Math.abs(grew)} px`);
  const idle = idleLabel(r.idle);
  if (idle) parts.push(idle);
  let text = parts.join(' · ');
  if ((!r.navigated || r.inPage) && typeof r.changed === 'string') text += changeTail('scroll', r);
  return oneLine(`${PREFIX} ${text}${tail}`, REPLY_MAX + CHANGE_MAX);
}

function navReply(service, cmd, r) {
  const parts = [`went ${cmd.sub} on ${service}`, r.stuck
    ? `did not leave the page (the site may block ${cmd.sub})${r.escape ? ` · way out: [agent:browser open ${service}] ${redactUrl(r.escape)}` : ''}`
    : pageLabel(r)];
  const idle = idleLabel(r.idle);
  if (idle) parts.push(idle);
  let text = parts.join(' · ');
  if ((!r.navigated || r.inPage) && typeof r.changed === 'string') text += changeTail('nav', r);
  text += ` · history: back ${r.canBack ? '✓' : '✗'} forward ${r.canForward ? '✓' : '✗'}`;
  if (r.takeover) text += TEXT.takeover;
  return oneLine(`${PREFIX} ${text}`, REPLY_MAX + CHANGE_MAX);
}

function clip60(s) {
  const v = [...String(s)];
  return v.length > 60 ? v.slice(0, 59).join('') + '…' : String(s);
}

function changeTail(sub, r, key) {
  const target = r.target ? ` · target: ${r.target}` : '';
  if (r.changed === MOST_OF_PAGE && !(sub === 'key' && key === 'Escape')) return ` · changed: most of the page${sub === 'scroll' ? '' : target}`;
  if (r.changed) return ` · changed: ${r.changed === MOST_OF_PAGE ? r.changed : JSON.stringify(r.changed)}${target}`;
  if (target) return target;
  if ((sub === 'key' || sub === 'click') && typeof r.choice === 'string') return ` · ${r.choiceKind === 'select' ? 'selected' : 'checked'} now ${JSON.stringify(clip60(r.choice))}`;
  if ((sub === 'type' || sub === 'key') && typeof r.value === 'string') {
    return ` · value now ${JSON.stringify(clip60(r.value))}`;
  }
  if (sub === 'scroll') return ' · page text unchanged';
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
    `${PREFIX} inspect ${service} [${r.n}]${r.fresh ? ' (numbered now)' : ''}: ${oneLine(shortEl(r, 5))} · ${oneLine(r.kind || '')} ${r.label || r.kind !== 'clickable' ? JSON.stringify(String(r.label || '')) : '(icon)'}${r.warn ? ` · ⚠ ${oneLine(r.warn.cat)} (${JSON.stringify(oneLine(r.warn.term))})` : ''}${typeof r.value === 'string' ? ` · value ${JSON.stringify(clip60(r.value))}` : ''}`,
    `  attrs: ${attrs || 'none'}`,
    `  listeners: ${oneLine(listenersLabel(r.listeners))}`,
    `  cursor: ${oneLine(r.cursor || '?')} · at ${rect.x},${rect.y} size ${rect.w}×${rect.h} · ${r.visible ? (r.clipped ? 'clipped (scroll its list)' : 'visible') : 'hidden'}`,
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

const REFUSED_RES = [
  /^\S+ refused: .* matches denylist pattern /,
  /^\[\d+\] ".*" (publishes as the operator|looks consequential \(|is an ad — )/,
  /^(Enter|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight) (in|on) .+ would (press|submit|choose|change) .* (publishes as the operator|looks consequential \(|is an ad — )/,
  /^\[\d+\] on \S+ no longer points at one element/,
  /^\[\d+\] retired: its text changed since your read/,
];

function classifyReply(line) {
  const body = String(line || '').replace(/^\[agent:browser\]\s*(error:\s*)?/, '');
  return REFUSED_RES.some((re) => re.test(body)) ? 'refused' : null;
}

module.exports = {
  closedReply,
  classifyReply,
  oneLine, reply, errorReply, openReply, readReply, servicesReply, writeReplyFile, replyDir, loginState, stamp,
  downloadReply, screenshotReply, inspectReply,
  PREFIX, REPLY_MAX, SEAT_RE, TEXT, ago, signinReply, signinNotice, dropSuffix, actReply, scrollReply, navReply, waitReply, handbackReply, heldTimeout, isGoogle,
  handover, INSTRUCTION_MAX, operatorNav,
};
