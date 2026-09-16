'use strict';

const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const TYPE_WORDS = /^(?:true|false|null|yes|no|on|off|~|[-+]?\.inf|\.nan)$/i;
const LEAD_SPECIAL = /^[-?:,[\]{}#&*!|>'"%@` ]/;
const TRAIL_SPECIAL = /[ :]$/;
const CTRL_OTHER = new RegExp('[\\u0000-\\u0009\\u000B-\\u001F\\u007F]');
const RADIX_NUM = /^[-+]?0[xXoObB][0-9a-fA-F_]+$/;
const PLAIN_NUM = /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?$/;
const SEXAGESIMAL = /^[-+]?\d+(?::[0-5]?\d)+(?:\.\d*)?$/;

function numericLooking(s) {
  if (RADIX_NUM.test(s)) return true;
  if (SEXAGESIMAL.test(s)) return true;
  return PLAIN_NUM.test(s) && /[0-9]/.test(s);
}

function quoteText(s) {
  return JSON.stringify(s).replace(//g, '\\u007f');
}

function needsQuote(s) {
  if (s === '') return true;
  if (TYPE_WORDS.test(s)) return true;
  if (numericLooking(s)) return true;
  if (LEAD_SPECIAL.test(s)) return true;
  if (TRAIL_SPECIAL.test(s)) return true;
  if (s.includes(': ')) return true;
  if (s.includes(' #')) return true;
  if (CTRL_OTHER.test(s)) return true;
  if (s.includes('\n')) return true;
  return false;
}

function blockScalar(v) {
  if (typeof v !== 'string') return null;
  if (!v.includes('\n')) return null;
  if (CTRL_OTHER.test(v)) return null;
  if (v.endsWith('\n\n')) return null;
  const body = v.endsWith('\n') ? v.slice(0, -1) : v;
  const lines = body.split('\n');
  if (lines[0] === '' || /^[ \t]/.test(lines[0])) return null;
  if (lines.some((l) => /[ \t]$/.test(l))) return null;
  return { head: v.endsWith('\n') ? '|' : '|-', lines };
}

function renderable(v) {
  return !(v === undefined || typeof v === 'function' || typeof v === 'symbol');
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function keyText(k) {
  return BARE_KEY.test(k) ? k : quoteText(k);
}

function scalarText(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return quoteText(v.toISOString());
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  const s = typeof v === 'string' ? v : String(v);
  return needsQuote(s) ? quoteText(s) : s;
}

function liveKeys(obj) {
  return Object.keys(obj).filter((k) => renderable(obj[k]));
}

function emitValue(lines, value, indent, head) {
  const at = ' '.repeat(indent);
  const lead = head === null ? at : `${at}${head} `;
  const childIndent = indent + 2;
  if (Array.isArray(value)) {
    if (value.length === 0) { lines.push(`${lead}[]`); return; }
    if (head !== null) lines.push(at + head);
    for (const item of value) emitItem(lines, item, head === null ? indent : childIndent);
    return;
  }
  if (isObj(value)) {
    const keys = liveKeys(value);
    if (keys.length === 0) { lines.push(`${lead}{}`); return; }
    if (head !== null) lines.push(at + head);
    const base = head === null ? indent : childIndent;
    for (const k of keys) emitValue(lines, value[k], base, `${keyText(k)}:`);
    return;
  }
  const block = blockScalar(value);
  if (block) {
    lines.push(lead + block.head);
    for (const l of block.lines) lines.push(l === '' ? '' : ' '.repeat(childIndent) + l);
    return;
  }
  lines.push(lead + scalarText(value));
}

function emitItem(lines, item, indent) {
  const at = ' '.repeat(indent);
  const inner = indent + 2;
  if (isObj(item)) {
    if (liveKeys(item).length === 0) { lines.push(`${at}- {}`); return; }
    const sub = [];
    emitValue(sub, item, inner, null);
    sub[0] = `${at}- ${sub[0].slice(inner)}`;
    for (const l of sub) lines.push(l);
    return;
  }
  if (Array.isArray(item)) {
    if (item.length === 0) { lines.push(`${at}- []`); return; }
    const sub = [];
    for (const el of item) emitItem(sub, el, inner);
    sub[0] = `${at}- ${sub[0].slice(inner)}`;
    for (const l of sub) lines.push(l);
    return;
  }
  emitValue(lines, renderable(item) ? item : null, indent, '-');
}

function toYaml(value) {
  const lines = [];
  emitValue(lines, value, 0, null);
  return `${lines.join('\n')}\n`;
}

module.exports = { toYaml };
