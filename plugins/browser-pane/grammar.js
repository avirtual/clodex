'use strict';

const SERVICE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LINE_RE = /^\[agent:browser\s+([^\]]*)\](.*)$/s;
const SUBCOMMANDS = ['open', 'read', 'click', 'type', 'key', 'select', 'download', 'screenshot', 'inspect', 'wait', 'services', 'release'];
const KEY_NAMES = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'];
const WAIT_MS_MAX = 1800000;
const N_MAX = 1000000;
const URL_MAX = 4096;
const MAX_MIN = 500;
const MAX_MAX = 8000;
const DEFAULT_MAX = 2500;

const FLAGS = {
  open: {},
  read: { text: 'bool', links: 'bool', main: 'bool', all: 'bool', filter: 'value', page: 'value', max: 'value' },
  click: { text: 'value', to: 'value' },
  type: { enter: 'bool' },
  key: {},
  select: {},
  download: { to: 'value', as: 'value' },
  screenshot: { numbers: 'bool' },
  inspect: { text: 'value' },
  wait: { ms: 'value', for: 'value' },
  services: {},
  release: {},
};

function parseLine(line) {
  const m = LINE_RE.exec(String(line == null ? '' : line));
  if (!m) return null;
  const inner = m[1].trim();
  if (!inner) return null;
  return { raw: inner, body: m[2].trim() };
}

function tokenizeQ(inner) {
  const out = [];
  let cur = '';
  let has = false;
  let quoted = false;
  let q = false;
  for (const ch of inner) {
    if (ch === '"') { quoted = !quoted; has = true; q = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (has) out.push({ t: cur, q });
      cur = '';
      has = false;
      q = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (quoted) throw new Error('unbalanced double quote in the bracket');
  if (has) out.push({ t: cur, q });
  return out;
}

function tokenize(inner) {
  return tokenizeQ(inner).map((x) => x.t);
}

function joinText(sub, toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].q || !toks[i].t.startsWith('--text=')) { out.push(toks[i].t); continue; }
    let text = toks[i].t;
    let j = i + 1;
    for (; j < toks.length && !toks[j].t.startsWith('--'); j++) text += ' ' + toks[j].t;
    out.push(text);
    for (; j < toks.length; j++) {
      if (!toks[j].t.startsWith('--')) throw new Error(`unexpected '${toks[j].t}' for ${sub} — quote the text or put it last`);
      out.push(toks[j].t);
    }
    return out;
  }
  return out;
}

function validFlagList(sub) {
  const names = Object.keys(FLAGS[sub]);
  return names.length ? names.map((n) => `--${n}`).join(' ') : 'none';
}

function splitArgs(sub, toks) {
  const flags = {};
  const positional = [];
  for (const t of toks) {
    if (!t.startsWith('--')) { positional.push(t); continue; }
    const eq = t.indexOf('=');
    const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
    const kind = FLAGS[sub][name];
    if (!kind) throw new Error(`unknown flag --${name} for ${sub} — valid: ${validFlagList(sub)}`);
    if (kind === 'bool' && eq >= 0) throw new Error(`--${name} takes no value`);
    if (kind === 'value' && eq < 0) throw new Error(`--${name} needs a value, e.g. --${name}=…`);
    flags[name] = kind === 'bool' ? true : t.slice(eq + 1);
  }
  return { flags, positional };
}

function serviceArg(sub, positional, required) {
  if (positional.length > 1) throw new Error(`unexpected '${positional[1]}' for ${sub}`);
  const s = positional[0];
  if (s == null) {
    if (required) throw new Error(`${sub} needs a service — [agent:browser open <service>] <url>`);
    return null;
  }
  if (!SERVICE_RE.test(s)) {
    if (/^[0-9]+$/.test(s)) throw new Error(`unexpected '${s}' for ${sub}`);
    throw new Error(`bad service name '${s}' — use a-z, 0-9 and -, starting with a letter, at most 32 chars`);
  }
  return s;
}

function serviceAndN(sub, positional) {
  const usage = sub === 'type' ? '[agent:browser type [service] <n> [--enter]] <text>'
    : sub === 'select' ? '[agent:browser select [service] <n>] <option>'
      : sub === 'inspect' ? '[agent:browser inspect [service] <n>]' : '[agent:browser click [service] <n>]';
  if (positional.length > 2) throw new Error(`unexpected '${positional[2]}' for ${sub}`);
  const nTok = positional[positional.length - 1];
  if (nTok == null || !/^[0-9]+$/.test(nTok)) throw new Error(`${sub} needs an element number from your read — ${usage}`);
  const n = Number(nTok);
  if (n < 1 || n > N_MAX) throw new Error(`element number out of range: ${nTok}`);
  const service = positional.length === 2 ? serviceArg(sub, positional.slice(0, 1), false) : null;
  return { service, n };
}

function byText(sub, positional, text) {
  if (!text.trim()) throw new Error('--text needs the visible text, e.g. --text="Lista de plată"');
  const last = positional[positional.length - 1];
  if (last != null && /^[0-9]+$/.test(last)) throw new Error(`${sub} takes an element number or --text, not both`);
  if (positional.length > 1) throw new Error(`unexpected '${positional[1]}' for ${sub} — quote the text or put it last`);
  return { sub, service: serviceArg(sub, positional, false), n: null, text };
}

function clickCommand(positional, flags) {
  if (flags.to === '') throw new Error('--to needs a folder, e.g. --to=bills');
  const cmd = flags.text == null ? { sub: 'click', ...serviceAndN('click', positional) } : byText('click', positional, flags.text);
  return flags.to == null ? cmd : { ...cmd, to: flags.to };
}

function checkUrl(text) {
  if (!text) throw new Error('open needs a URL after the bracket — [agent:browser open <service>] <url>');
  if (text.length > URL_MAX) throw new Error('URL too long (max 4,096 chars)');
  let u;
  try { u = new URL(text); } catch { throw new Error(`not a URL: ${text}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`only http: and https: URLs can be opened, not ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new Error('a URL with user:pass@ is refused — credentials never pass through an agent; the operator signs in in the window');
  }
  return text;
}

function downloadCommand(positional, flags, body) {
  if (positional.length > 2) throw new Error(`unexpected '${positional[2]}' for download`);
  let service = null;
  let n = null;
  const last = positional[positional.length - 1];
  if (last != null && /^[0-9]+$/.test(last)) {
    n = Number(last);
    if (n < 1 || n > N_MAX) throw new Error(`element number out of range: ${last}`);
    if (positional.length === 2) service = serviceArg('download', positional.slice(0, 1), false);
  } else {
    if (positional.length === 2) throw new Error(`unexpected '${positional[1]}' for download`);
    service = serviceArg('download', positional, false);
  }
  if (flags.to === '') throw new Error('--to needs a folder, e.g. --to=bills');
  if (flags.as === '') throw new Error('--as needs a file name, e.g. --as=2026-08.pdf');
  if (body.length > URL_MAX) throw new Error('URL too long (max 4,096 chars)');
  if (n != null && body) throw new Error('download takes an element number or a URL, not both');
  return { sub: 'download', service, n, url: body || null, to: flags.to == null ? null : flags.to, as: flags.as == null ? null : flags.as };
}

function intArg(name, v, min) {
  if (!/^[0-9]+$/.test(v) || Number(v) < min) throw new Error(`--${name} must be an integer ≥ ${min}`);
  return Number(v);
}

function toCommand(intent) {
  const qt = tokenizeQ(String((intent && intent.raw) || ''));
  const sub = qt.length ? qt[0].t : undefined;
  const toks = sub === 'click' || sub === 'inspect' ? joinText(sub, qt.slice(1)) : qt.slice(1).map((x) => x.t);
  if (!SUBCOMMANDS.includes(sub)) {
    throw new Error(`unknown subcommand '${sub}' — use ${SUBCOMMANDS.join(', ')}`);
  }
  const { flags, positional } = splitArgs(sub, toks);
  if (sub === 'open') {
    const service = serviceArg(sub, positional, true);
    return { sub, service, url: checkUrl(String((intent && intent.body) || '').trim()) };
  }
  if (sub === 'read') {
    const service = serviceArg(sub, positional, false);
    if (flags.text && flags.links) throw new Error('--text and --links cannot be combined');
    if (flags.filter === '') throw new Error('--filter needs a value, e.g. --filter=pdf');
    const max = flags.max == null ? DEFAULT_MAX
      : Math.min(MAX_MAX, Math.max(MAX_MIN, intArg('max', flags.max, 1)));
    return {
      sub,
      service,
      mode: flags.text ? 'text' : flags.links ? 'links' : 'default',
      main: !!flags.main,
      all: !!flags.all,
      filter: flags.filter == null ? null : flags.filter,
      page: flags.page == null ? 1 : intArg('page', flags.page, 1),
      max,
    };
  }
  const body = String((intent && intent.body) || '').trim();
  if (sub === 'click') return clickCommand(positional, flags);
  if (sub === 'inspect') return flags.text == null ? { sub, ...serviceAndN(sub, positional) } : byText(sub, positional, flags.text);
  if (sub === 'type') {
    const sn = serviceAndN(sub, positional);
    if (!body && !flags.enter) throw new Error('type needs text after the bracket — [agent:browser type [service] <n> [--enter]] <text>');
    return { sub, ...sn, text: body, enter: !!flags.enter };
  }
  if (sub === 'select') {
    const sn = serviceAndN(sub, positional);
    if (!body) throw new Error('select needs the option after the bracket — [agent:browser select [service] <n>] <option>');
    return { sub, ...sn, option: body };
  }
  if (sub === 'key') {
    const service = serviceArg(sub, positional, false);
    if (!KEY_NAMES.includes(body)) throw new Error(`key needs one of ${KEY_NAMES.join(' ')} after the bracket`);
    return { sub, service, key: body };
  }
  if (sub === 'download') return downloadCommand(positional, flags, body);
  if (sub === 'screenshot') return { sub, service: serviceArg(sub, positional, false), ...(flags.numbers ? { numbers: true } : {}) };
  if (sub === 'wait') {
    const service = serviceArg(sub, positional, false);
    if (flags.for === '') throw new Error('--for needs a value, e.g. --for="Showing 1"');
    return {
      sub,
      service,
      ms: flags.ms == null ? null : Math.min(WAIT_MS_MAX, intArg('ms', flags.ms, 1)),
      forText: flags.for == null ? null : flags.for,
    };
  }
  if (sub === 'services') {
    if (positional.length) throw new Error(`unexpected '${positional[0]}' for services`);
    return { sub };
  }
  return { sub, service: serviceArg(sub, positional, false) };
}

module.exports = { parseLine, toCommand, tokenize, SERVICE_RE, SUBCOMMANDS, KEY_NAMES, DEFAULT_MAX, WAIT_MS_MAX };
