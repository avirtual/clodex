'use strict';

const MAX_PATTERNS = 200;
const MAX_CHARS = 512;
const LABEL_RE = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/;

function hostOf(raw) {
  if (!raw) return { error: 'no host' };
  if (/[@\\]/.test(raw)) return { error: `"${raw}" is not a valid host: "@" and "\\" are not allowed` };
  if (raw.includes('*')) return { error: '"*" is allowed only as a leading "*." on the host or a trailing "/*" on the path' };
  if (/:/.test(raw)) return { error: 'ports and IPv6 hosts are not supported; a host pattern matches every port' };
  let h;
  try { h = new URL(`http://${raw}/`).hostname; } catch { return { error: `"${raw}" is not a valid host` }; }
  if (!h || !h.split('.').every((l) => LABEL_RE.test(l))) return { error: `"${raw}" is not a valid host` };
  return { host: h };
}

function parse(pattern) {
  if (typeof pattern !== 'string') return { error: 'a pattern must be text' };
  const raw = pattern.trim();
  if (!raw) return { error: 'empty pattern' };
  if (raw.length > MAX_CHARS) return { error: `longer than ${MAX_CHARS} characters` };
  let rest = raw;
  const allow = rest.startsWith('!');
  if (allow) rest = rest.slice(1);
  let scheme = null;
  const sm = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (sm) {
    scheme = sm[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return { error: `only http:// or https:// may lead a pattern, not ${sm[1]}://` };
    rest = rest.slice(sm[0].length);
  }
  if (/[?#\s]/.test(rest)) return { error: 'queries, fragments and spaces are not supported' };
  const slash = rest.indexOf('/');
  let hostPart = slash < 0 ? rest : rest.slice(0, slash);
  let pathPart = slash < 0 ? null : rest.slice(slash);
  let subOnly = false;
  if (hostPart.startsWith('*.')) { subOnly = true; hostPart = hostPart.slice(2); }
  const h = hostOf(hostPart);
  if (h.error) return { error: h.error };
  let prefix = false;
  if (pathPart != null) {
    if (pathPart.endsWith('/*')) { prefix = true; pathPart = pathPart.slice(0, -1); }
    if (pathPart.includes('*')) return { error: '"*" is allowed only as a leading "*." on the host or a trailing "/*" on the path' };
    try { pathPart = new URL(`http://x${pathPart}`).pathname; } catch { return { error: `"${pathPart}" is not a valid path` }; }
  }
  return { rule: { raw, allow, scheme, host: h.host, subOnly, path: pathPart, prefix } };
}

function validate(patterns) {
  if (!Array.isArray(patterns)) return { ok: false, error: 'patterns must be a list', line: 0 };
  const kept = [];
  for (let i = 0; i < patterns.length; i += 1) {
    if (typeof patterns[i] === 'string' && !patterns[i].trim()) continue;
    const r = parse(patterns[i]);
    if (r.error) return { ok: false, error: r.error, line: i + 1 };
    kept.push(r.rule.raw);
    if (kept.length > MAX_PATTERNS) return { ok: false, error: `more than ${MAX_PATTERNS} patterns`, line: i + 1 };
  }
  return { ok: true, patterns: kept };
}

function matches(rule, u) {
  if (rule.scheme && u.protocol !== rule.scheme + ':') return false;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  const sub = h.endsWith('.' + rule.host);
  if (rule.subOnly ? !sub : !(sub || h === rule.host)) return false;
  if (rule.path == null) return true;
  let decoded = u.pathname;
  try { decoded = decodeURIComponent(u.pathname); } catch {}
  return [u.pathname, decoded].some((p) => (rule.prefix ? p.startsWith(rule.path) : p === rule.path));
}

function rulesOf(patterns) {
  const out = [];
  for (const p of Array.isArray(patterns) ? patterns.slice(0, MAX_PATTERNS) : []) {
    const r = parse(p);
    if (r.rule) out.push(r.rule);
  }
  return out;
}

function urlOf(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch { return null; }
}

function compile(patterns) {
  const rules = rulesOf(patterns);
  return (url) => {
    const u = urlOf(url);
    if (!u || rules.some((r) => r.allow && matches(r, u))) return null;
    const hit = rules.find((r) => !r.allow && matches(r, u));
    return hit ? hit.raw : null;
  };
}

function compilePolicy(policy) {
  const p = policy && typeof policy === 'object' ? policy : {};
  const lists = [['service', rulesOf(p.service)], ['global', rulesOf(p.global)]];
  return (url) => {
    const u = urlOf(url);
    if (!u || lists.some(([, rules]) => rules.some((r) => r.allow && matches(r, u)))) return null;
    for (const [list, rules] of lists) {
      const hit = rules.find((r) => !r.allow && matches(r, u));
      if (hit) return { pattern: hit.raw, list };
    }
    return null;
  };
}

function typedUrl(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return s;
  return 'https://' + s;
}

module.exports = { compile, compilePolicy, validate, parse, typedUrl, MAX_PATTERNS, MAX_CHARS };
