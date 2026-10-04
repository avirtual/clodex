'use strict';

const WELL_KNOWN = ['fbclid', 'gclid', 'msclkid', 'twclid', '_', '_t', 'cb', 'nocache'];
const WELL_KNOWN_PREFIX = ['utm_'];
const TIMEY = ['t', 'ts', 'time', 'timestamp', 'rand', 'r', 'v'];
const DIGITS_RE = /^\d{9,}$/;
const TOKEN_RE = /^[0-9a-z]{16,}$/i;
const CONTEXT_MAX = 40;
const LABEL_KEY_MAX = 400;
const COUNTER_WORDS = ['like', 'likes', 'repost', 'reposts', 'reply', 'replies', 'view', 'views', 'bookmark', 'bookmarks', 'posts', 'followers', 'following'];
const COUNTER_RE = /\d[\d.,]*[KkMm]?/;

function isVolatile(name, value, learned) {
  const k = String(name).toLowerCase();
  if (learned && learned.indexOf(name) >= 0) return true;
  if (WELL_KNOWN.indexOf(k) >= 0 || WELL_KNOWN_PREFIX.some((p) => k.startsWith(p))) return true;
  if (TIMEY.indexOf(k) < 0) return false;
  return DIGITS_RE.test(value) || TOKEN_RE.test(value);
}

function normHref(href, origin, learned) {
  let u;
  try { u = new URL(href, origin); } catch { return ''; }
  if (u.protocol === 'javascript:') return '';
  const base = u.origin === origin ? u.pathname : u.origin + u.pathname;
  const kept = [];
  for (const [k, v] of u.searchParams) if (!isVolatile(k, v, learned)) kept.push([k, v]);
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return kept.length ? base + '?' + kept.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') : base;
}

function labelHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

function keyLabel(label) {
  const s = String(label || '').replace(/\s+/g, ' ').trim();
  return s.length > LABEL_KEY_MAX ? s.slice(0, LABEL_KEY_MAX) + '~' + labelHash(s.slice(LABEL_KEY_MAX)) : s;
}

function counterWord(t) {
  const w = String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  return COUNTER_WORDS.indexOf(w) >= 0 ? w : '';
}

function counterMask(label) {
  const t = String(label == null ? '' : label).split(' ');
  const num = (x) => new RegExp('^[^\\w]*' + COUNTER_RE.source + '[^\\w]*$').test(x || '');
  return t.map((x, i) => (num(x) && (counterWord(t[i - 1] || '') || counterWord(t[i + 1] || '')) ? x.replace(COUNTER_RE, '#') : x)).join(' ');
}

function actionOf(masked) {
  const t = String(masked || '').split(' ').filter(Boolean);
  if (!t.length || !t.every((x) => /^[^\w]*#[^\w]*$/.test(x) || counterWord(x))) return '';
  const w = t.map(counterWord).filter(Boolean).pop() || '';
  return w.replace(/ies$/, 'y').replace(/(like|repost|view|bookmark)s$/, '$1');
}

function keyOf(d) {
  return String(d.kind || '') + '\u0000' + keyLabel(d.label) + '\u0000' + String(d.href || '').replace(/#/g, '%23');
}

function storedKey(base, ordinal, context) {
  if (!ordinal) return base;
  const c = String(context || '').replace(/\s+/g, ' ').trim();
  return base + '#' + ordinal + '|' + (c.length > CONTEXT_MAX ? c.slice(0, CONTEXT_MAX).trim() : c);
}

function parseStored(stored) {
  const s = String(stored || '');
  const a = s.indexOf('\u0000');
  const b = a < 0 ? -1 : s.indexOf('\u0000', a + 1);
  if (b < 0) return { base: s, kind: '', label: '', ordinal: 0, context: '' };
  const h = s.indexOf('#', b);
  const base = h < 0 ? s : s.slice(0, h);
  const rest = h < 0 ? '' : s.slice(h + 1);
  const bar = rest.indexOf('|');
  return {
    base, kind: s.slice(0, a), label: s.slice(a + 1, b),
    ordinal: h < 0 ? 0 : Number(rest.slice(0, bar < 0 ? rest.length : bar)) || 0,
    context: h < 0 || bar < 0 ? '' : rest.slice(bar + 1),
  };
}

function splitHref(href) {
  const s = String(href || '').split('#')[0];
  const q = s.indexOf('?');
  if (q < 0) return { path: s, params: [] };
  return { path: s.slice(0, q), params: [...new URLSearchParams(s.slice(q + 1))] };
}

function sameDoc(prevUrl, curUrl, learned) {
  let a;
  let b;
  try { a = new URL(prevUrl); b = new URL(curUrl); } catch { return false; }
  if (a.origin !== b.origin || a.pathname !== b.pathname) return false;
  const rest = (u) => [...u.searchParams].filter(([k, v]) => !isVolatile(k, v, learned))
    .map(([k, v]) => k + '=' + v).sort().join('&');
  return rest(a) === rest(b);
}

function learnVolatile(prevEls, curEls, prevUrl, curUrl, learned) {
  const have = learned || [];
  const groups = (els) => {
    const m = new Map();
    for (const d of els || []) {
      const { path, params } = splitHref(d.href);
      if (!params.length) continue;
      const names = params.map((p) => p[0]);
      if (new Set(names).size !== names.length) continue;
      const g = String(d.kind) + '\u0000' + String(d.label) + '\u0000' + path + '?' + names.slice().sort().join('&');
      m.set(g, m.has(g) ? null : new Map(params));
    }
    return m;
  };
  const before = groups(prevEls);
  const after = groups(curEls);
  const out = [];
  for (const [g, cur] of after) {
    const prev = before.get(g);
    if (!prev || !cur) continue;
    const diff = [...cur.keys()].filter((k) => cur.get(k) !== prev.get(k));
    if (diff.length !== 1) continue;
    const name = diff[0];
    if (out.includes(name) || isVolatile(name, cur.get(name), have)) continue;
    if (sameDoc(prevUrl, curUrl, have)) out.push(name);
  }
  return out;
}

const PAGE_SOURCE = [
  `const WELL_KNOWN = ${JSON.stringify(WELL_KNOWN)};`,
  `const WELL_KNOWN_PREFIX = ${JSON.stringify(WELL_KNOWN_PREFIX)};`,
  `const TIMEY = ${JSON.stringify(TIMEY)};`,
  `const DIGITS_RE = new RegExp(${JSON.stringify(DIGITS_RE.source)});`,
  `const TOKEN_RE = new RegExp(${JSON.stringify(TOKEN_RE.source)}, 'i');`,
  `const CONTEXT_MAX = ${CONTEXT_MAX};`,
  `const LABEL_KEY_MAX = ${LABEL_KEY_MAX};`,
  `const COUNTER_WORDS = ${JSON.stringify(COUNTER_WORDS)};`,
  `const COUNTER_RE = new RegExp(${JSON.stringify(COUNTER_RE.source)});`,
  counterWord.toString(), counterMask.toString(), actionOf.toString(),
  isVolatile.toString(), normHref.toString(), labelHash.toString(), keyLabel.toString(), keyOf.toString(), storedKey.toString(), parseStored.toString(),
].join('\n');

module.exports = {
  WELL_KNOWN, WELL_KNOWN_PREFIX, TIMEY, CONTEXT_MAX, LABEL_KEY_MAX, PAGE_SOURCE,
  COUNTER_WORDS, isVolatile, normHref, keyLabel, keyOf, counterMask, actionOf, storedKey, parseStored, learnVolatile, sameDoc,
};
