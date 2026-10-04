'use strict';

const SERVICE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LINE_RE = /^\[agent:browser\s+([^\]]*)\](.*)$/s;
const SUBCOMMANDS = ['open', 'read', 'services', 'release'];
const URL_MAX = 4096;
const MAX_MIN = 500;
const MAX_MAX = 8000;
const DEFAULT_MAX = 2500;

const FLAGS = {
  open: {},
  read: { text: 'bool', links: 'bool', main: 'bool', filter: 'value', page: 'value', max: 'value' },
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

function tokenize(inner) {
  const out = [];
  let cur = '';
  let has = false;
  let quoted = false;
  for (const ch of inner) {
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (quoted) throw new Error('unbalanced double quote in the bracket');
  if (has) out.push(cur);
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

function intArg(name, v, min) {
  if (!/^[0-9]+$/.test(v) || Number(v) < min) throw new Error(`--${name} must be an integer ≥ ${min}`);
  return Number(v);
}

function toCommand(intent) {
  const toks = tokenize(String((intent && intent.raw) || ''));
  const sub = toks.shift();
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
      filter: flags.filter == null ? null : flags.filter,
      page: flags.page == null ? 1 : intArg('page', flags.page, 1),
      max,
    };
  }
  if (sub === 'services') {
    if (positional.length) throw new Error(`unexpected '${positional[0]}' for services`);
    return { sub };
  }
  return { sub, service: serviceArg(sub, positional, false) };
}

module.exports = { parseLine, toCommand, tokenize, SERVICE_RE, SUBCOMMANDS, DEFAULT_MAX };
