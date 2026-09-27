'use strict';

const { CODEX_STATUS_ROW } = require('./live-split');

const CLOSING_RULE = /^─{3,}\s*$/u;
const CLAUDE_MODE = /^\s{2}(⏵⏵|⏸)\s(.+?) on(?=\s|$)/u;
const RIGHT_COLUMN = /\s{3,}\S.*$/u;
const CYCLE_HINT = '(shift+tab to cycle)';
const MODE_KEYS = { 'bypass permissions': 'bypass', 'accept edits': 'accept-edits', 'auto mode': 'auto', 'plan mode': 'plan', 'manual mode': 'manual' };
const TASK = /^\d+ [a-z]+(?: [a-z]+)*$/u;
const CODEX_PLAN = /^(?:.*… )?Plan mode(?: \(shift\+tab to cycle\))?$/u;
const CODEX_WARNINGS = /⚠ (\d+) warnings?\b/u;
const CODEX_REACH = 6;
const MUSE_LABEL_MAX = 32;

const isBlank = (r) => !/\S/u.test(r || '');

function closingRule(rows, at) {
  let j = at + 2;
  while (j < rows.length && !CLOSING_RULE.test(rows[j] || '')) j++;
  return j < rows.length ? j : -1;
}

function rowsBelowClosingRule(rows, at) {
  const j = closingRule(rows, at);
  if (j < 0) return null;
  const out = [];
  for (let k = j + 1; k < rows.length && !isBlank(rows[k]); k++) out.push(rows[k]);
  return out;
}

function readClaude(rows, at) {
  const below = rowsBelowClosingRule(rows, at);
  if (!below) return null;
  for (let i = below.length - 1; i >= 0; i--) {
    const cut = below[i].replace(RIGHT_COLUMN, '');
    const m = CLAUDE_MODE.exec(cut);
    if (!m) continue;
    const segs = cut.slice(m[0].length).split(' · ').map((s) => s.replace(CYCLE_HINT, '').trim()).filter(Boolean);
    return { mode: { key: MODE_KEYS[m[2]] || 'other', label: m[2], cycles: true }, tasks: segs.find((s) => TASK.test(s)) || null, warnings: null };
  }
  return null;
}

function readCodex(rows, at) {
  let s = -1;
  for (let i = at + 1; i <= at + CODEX_REACH && i < rows.length; i++) {
    if (CODEX_STATUS_ROW.test(rows[i] || '')) { s = i; break; }
  }
  if (s < 0) return null;
  const block = [];
  for (let k = s; k < rows.length && k <= at + CODEX_REACH && !isBlank(rows[k]); k++) block.push(rows[k]);
  const plan = block.flatMap((r) => r.trim().split(/\s{2,}/u)).some((c) => CODEX_PLAN.test(c));
  const warn = block.map((r) => CODEX_WARNINGS.exec(r)).find(Boolean);
  const mode = plan ? { key: 'plan', label: 'Plan', cycles: true } : { key: 'default', label: 'Default', cycles: true };
  return { mode, tasks: null, warnings: warn ? Number(warn[1]) : null };
}

function readMuse(rows, at) {
  const j = closingRule(rows, at);
  if (j < 0) return null;
  let k = j + 1;
  while (k < rows.length && isBlank(rows[k])) k++;
  if (k >= rows.length) return null;
  const segs = rows[k].trim().split(' · ');
  if (segs.length < 4 || !/^[~/]/u.test(segs[2])) return null;
  const label = segs[segs.length - 1];
  if (/^[~/.]/u.test(label) || label.length > MUSE_LABEL_MAX) return null;
  return { mode: { key: 'posture', label, cycles: false }, tasks: null, warnings: null };
}

const READERS = { claude: readClaude, codex: readCodex, muse: readMuse };

function readStatusRows(rows, at, platform) {
  if (!Array.isArray(rows) || !Number.isInteger(at) || at < 0) return null;
  const read = Object.hasOwn(READERS, platform) ? READERS[platform] : null;
  return read ? read(rows, at) : null;
}

module.exports = { readStatusRows };
