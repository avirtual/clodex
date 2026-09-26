'use strict';

const CELL_RUN_KEYS = ['x', 'n', 'fg', 'bg', 'bold', 'dim', 'inverse'];
const CLAUDE_SELECTED_FG = '#5769f7';
const LABEL_AT = 2;

const PROMPT_COMPOSER = /^❯[  ]\//u;
const CODEX_COMPOSER = /^›[  ]\//u;
const CODEX_STATUS_ROW = /^\s{2}(?:Context \d+% used\b|\? for shortcuts)/u;
const RULE = /^─{3,}/u;
const LABELED_RULE = /^──/u;
const ENTRY = /^(?:›|\s)\s\/\S/u;
const isBlank = (row) => !/\S/u.test(row || '');

function isCellRun(run) {
  if (!run || typeof run !== 'object') return false;
  if (!Number.isInteger(run.x) || run.x < 0 || !Number.isInteger(run.n) || run.n < 1) return false;
  return Object.keys(run).every((k) => CELL_RUN_KEYS.includes(k));
}

function parseEntry(row) {
  if (typeof row !== 'string' || !ENTRY.test(row)) return null;
  const rest = row.slice(LABEL_AT).trimEnd();
  const gap = /\s{2,}/u.exec(rest);
  if (!gap) return { name: rest, description: '', nameAt: LABEL_AT, descAt: -1 };
  return {
    name: rest.slice(0, gap.index),
    description: rest.slice(gap.index + gap[0].length),
    nameAt: LABEL_AT,
    descAt: LABEL_AT + gap.index + gap[0].length,
  };
}

function continuationOf(row, descAt) {
  if (descAt < 0 || typeof row !== 'string' || row.length <= descAt) return null;
  if (!isBlank(row.slice(0, descAt)) || /\s/u.test(row[descAt])) return null;
  return row.slice(descAt).trimEnd();
}

function findComposer(rows, platform) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (typeof row !== 'string') continue;
    if (platform === 'codex') {
      if (CODEX_COMPOSER.test(row) && rows.slice(i + 1, i + 7).some((r) => CODEX_STATUS_ROW.test(r || ''))) return i;
    } else if (platform === 'claude') {
      if (PROMPT_COMPOSER.test(row) && RULE.test(rows[i - 1] || '') && RULE.test(rows[i + 1] || '')) return i;
    } else if (platform === 'muse') {
      if (PROMPT_COMPOSER.test(row) && LABELED_RULE.test(rows[i - 1] || '')) return i;
    }
  }
  return -1;
}

function menuLines(rows, anchor, platform) {
  const out = [];
  if (platform === 'codex') {
    let j = anchor - 1;
    if (j >= 0 && isBlank(rows[j])) j--;
    while (j >= 0 && ENTRY.test(rows[j] || '')) out.unshift(j--);
    return out;
  }
  if (platform === 'claude') {
    let descAt = -1;
    for (let j = anchor + 2; j < rows.length && !isBlank(rows[j]); j++) {
      const e = parseEntry(rows[j]);
      if (e) { descAt = e.descAt; out.push(j); continue; }
      if (continuationOf(rows[j], descAt) === null) break;
      out.push(j);
    }
    return out;
  }
  for (let j = anchor + 1; j < rows.length && !RULE.test(rows[j] || ''); j++) {
    if (parseEntry(rows[j])) out.push(j);
  }
  return out;
}

function runsOf(cells, j) {
  const r = Array.isArray(cells) ? cells[j] : null;
  return Array.isArray(r) ? r.filter(isCellRun) : [];
}

function nameRuns(runs, entry) {
  const end = entry.nameAt + entry.name.length;
  return runs.filter((r) => r.x < end && r.x + r.n > entry.nameAt);
}

function isSelected(row, runs, entry, platform) {
  if (platform === 'codex') return row.startsWith('›');
  const onName = nameRuns(runs, entry);
  if (platform === 'claude') return onName.some((r) => r.fg === CLAUDE_SELECTED_FG);
  if (platform === 'muse') return onName.some((r) => r.bold);
  return false;
}

function boldSpans(runs, entry, descOffset, descAt) {
  const spans = [];
  const nameEnd = entry ? entry.nameAt + entry.name.length : -1;
  for (const r of runs) {
    if (!r.bold) continue;
    if (entry && r.x >= entry.nameAt && r.x + r.n <= nameEnd) {
      spans.push({ field: 'name', start: r.x - entry.nameAt, end: r.x - entry.nameAt + r.n });
    } else if (descAt >= 0 && r.x >= descAt) {
      const start = descOffset + r.x - descAt;
      spans.push({ field: 'description', start, end: start + r.n });
    }
  }
  return spans;
}

function readMenuRows(rows, cells, platform) {
  if (!Array.isArray(rows)) return null;
  const anchor = findComposer(rows, platform);
  if (anchor < 0) return null;
  const lines = menuLines(rows, anchor, platform);
  const out = [];
  let cur = null;
  for (const j of lines) {
    const runs = runsOf(cells, j);
    const entry = parseEntry(rows[j]);
    if (entry) {
      const selected = isSelected(rows[j], runs, entry, platform);
      const marks = platform === 'claude' || (platform === 'codex' && !selected);
      cur = {
        name: entry.name,
        description: entry.description,
        selected,
        matchSpans: marks ? boldSpans(runs, entry, 0, entry.descAt) : [],
        descAt: entry.descAt,
      };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const text = continuationOf(rows[j], cur.descAt);
    const offset = cur.description.length + 1;
    cur.description = `${cur.description} ${text}`;
    if (platform === 'claude') cur.matchSpans.push(...boldSpans(runs, null, offset, cur.descAt));
  }
  if (!out.length) return null;
  return { rows: out.map((r) => ({ name: r.name, description: r.description, selected: r.selected, matchSpans: r.matchSpans })), anchor };
}

module.exports = { CELL_RUN_KEYS, CLAUDE_SELECTED_FG, isCellRun, readMenuRows };
