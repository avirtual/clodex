'use strict';

const { composerIsEmpty, composerHasDraft } = require('./voice-submit');

const SPLIT_SETTLE_MS = 250;
const SPLIT_EXIT_MS = 50;
const RULE = /^─+$/u;

function isRuleRow(row, cols) {
  if (typeof row !== 'string') return false;
  const r = row.trimEnd();
  return r.length >= cols - 1 && RULE.test(r);
}

function isComposerRow(row) {
  if (typeof row !== 'string') return false;
  const r = row.trimEnd();
  return composerIsEmpty(r) || composerHasDraft(r);
}

const LABELED_RULE = /^─+( \S.*? )?─+$/u;
const CODEX_COMPOSER = /^›[ \u00a0]/u;
const CODEX_PICKER_ROW = /^›[ \u00a0]\d+\.\s/u;
const CODEX_MENU_ROW = /^(\s{2}\/\S|›[ \u00a0])/u;
const CODEX_STATUS_ROW = /^\s{2}(?:Context \d+% used\b|\? for shortcuts)/u;
const isBlank = (row) => !/\S/u.test(row || '');

function isLabeledRuleRow(row, cols) {
  if (typeof row !== 'string') return false;
  const r = row.trimEnd();
  return r.length >= cols - 1 && LABELED_RULE.test(r);
}

function isCodexComposerRow(rows, i) {
  const row = rows[i];
  if (typeof row !== 'string' || !CODEX_COMPOSER.test(row) || CODEX_PICKER_ROW.test(row)) return false;
  for (const r of rows.slice(i + 1, i + 7)) {
    if (typeof r !== 'string' || CODEX_COMPOSER.test(r)) return false;
    if (CODEX_STATUS_ROW.test(r)) return true;
  }
  return false;
}

function codexStripTop(rows, i) {
  let j = i - 1;
  if (j >= 0 && isBlank(rows[j])) j--;
  if (j < 0 || typeof rows[j] !== 'string' || !CODEX_MENU_ROW.test(rows[j])) return i;
  while (j > 0 && typeof rows[j - 1] === 'string' && CODEX_MENU_ROW.test(rows[j - 1])) j--;
  return j;
}

function museStripIsIdle(rows, i, cols) {
  let j = i + 2;
  while (j < rows.length && !isRuleRow(rows[j], cols)) j++;
  if (j >= rows.length) return true;
  return rows.slice(j + 1).filter((r) => !isBlank(r)).length <= 1;
}

const CLODENT_PROMPT = /^>(?: |$)/u;
const CLODENT_ASK = /^Allow\? \[y\/n\]/u;

const nothingBelow = (rows, i) => rows.slice(i + 1).every(isBlank);

function isClodentPromptRow(rows, i, hint) {
  const last = i + (hint.wrapped | 0);
  return i === hint.promptRow && Number.isInteger(hint.cursorY) && hint.cursorY >= i && hint.cursorY <= last && typeof rows[i] === 'string' && CLODENT_PROMPT.test(rows[i]) && nothingBelow(rows, last);
}

function isClodentAsk(rows, cursorY) {
  return Number.isInteger(cursorY) && typeof rows[cursorY] === 'string' && CLODENT_ASK.test(rows[cursorY]) && nothingBelow(rows, cursorY);
}

const ANCHORS = {
  claude: { at: (rows, i, cols) => isRuleRow(rows[i], cols) && isComposerRow(rows[i + 1]), top: (rows, i) => i },
  muse: { at: (rows, i, cols) => isLabeledRuleRow(rows[i], cols) && isComposerRow(rows[i + 1]) && museStripIsIdle(rows, i, cols), top: (rows, i) => i },
  codex: { at: (rows, i) => isCodexComposerRow(rows, i), top: codexStripTop },
  clodent: { at: (rows, i, cols, hint) => isClodentPromptRow(rows, i, hint), top: (rows, i) => i, marksPrompt: true, plainFull: isClodentAsk, workingPane: true },
};

const marksPrompt = (platform) => !!ANCHORS[platform] && !!ANCHORS[platform].marksPrompt;
const workingPane = (platform) => !!ANCHORS[platform] && !!ANCHORS[platform].workingPane;

function findAnchor(rows, cursorY, cols, platform = 'claude', promptRow = -1, wrapped = 0) {
  const anchor = ANCHORS[platform];
  if (!anchor || !Array.isArray(rows) || rows.length < 2) return -1;
  const start = Math.max(0, Math.min(rows.length - 1, Number.isInteger(cursorY) ? cursorY : rows.length - 1));
  const hint = { cursorY, promptRow, wrapped };
  for (let i = start; i >= 0; i--) if (anchor.at(rows, i, cols, hint)) return i;
  for (let i = start + 1; i < rows.length - 1; i++) if (anchor.at(rows, i, cols, hint)) return i;
  return -1;
}

function measureSplit(rows, cursorY, cols, platform = 'claude', promptRow = -1, { wrapped = 0, working = false } = {}) {
  const at = findAnchor(rows, cursorY, cols, platform, promptRow, wrapped);
  if (at < 0) {
    const anchor = ANCHORS[platform];
    const plain = !!anchor && !!anchor.plainFull && Array.isArray(rows) && anchor.plainFull(rows, cursorY);
    if (!plain && working && workingPane(platform) && Array.isArray(rows)) return { mode: 'split', top: rows.length, bottom: rows.length - 1, at: -1 };
    return { mode: 'full', top: -1, bottom: -1, busy: !plain && Array.isArray(rows) && rows.some((r) => !isBlank(r)) };
  }
  const top = ANCHORS[platform].top(rows, at);
  let bottom = rows.length - 1;
  while (bottom > at + 1 && isBlank(rows[bottom])) bottom--;
  if (Number.isInteger(cursorY)) bottom = Math.max(bottom, Math.min(cursorY, rows.length - 1));
  return { mode: 'split', top, bottom, at };
}

function sheetBand(rows, maxRows) {
  if (!Array.isArray(rows)) return null;
  const top = rows.findIndex((r) => !isBlank(r));
  if (top < 0) return null;
  let bottom = rows.length - 1;
  while (bottom > top && isBlank(rows[bottom])) bottom--;
  const cap = Math.max(1, maxRows | 0);
  return { top: Math.max(top, bottom - cap + 1), bottom };
}

function initialSplitState() {
  return { mode: 'full', top: -1, bottom: -1, pending: null, wakeAt: null };
}

function reduceSplit(state, measured, now, settleMs = SPLIT_SETTLE_MS, exitMs = SPLIT_EXIT_MS) {
  const cur = state || initialSplitState();
  if (!measured || measured.mode !== 'split') {
    if (cur.mode !== 'split') return initialSplitState();
    const since = cur.pending && cur.pending.kind === 'exit' ? cur.pending.since : now;
    if (now - since >= exitMs) return initialSplitState();
    return { mode: 'split', top: cur.top, bottom: cur.bottom, pending: { kind: 'exit', since }, wakeAt: since + exitMs };
  }
  const h = measured.bottom - measured.top + 1;
  if (cur.mode !== 'split') {
    const since = cur.pending && cur.pending.kind === 'enter' ? cur.pending.since : now;
    if (now - since >= settleMs) {
      return { mode: 'split', top: measured.top, bottom: measured.bottom, pending: null, wakeAt: null };
    }
    return { mode: 'full', top: -1, bottom: -1, pending: { kind: 'enter', since }, wakeAt: since + settleMs };
  }
  const curH = cur.bottom - cur.top + 1;
  if (h >= curH) {
    return { mode: 'split', top: measured.top, bottom: measured.bottom, pending: null, wakeAt: null };
  }
  const same = cur.pending && cur.pending.kind === 'shrink' && cur.pending.h === h;
  const since = same ? cur.pending.since : now;
  if (now - since >= settleMs) {
    return { mode: 'split', top: measured.top, bottom: measured.bottom, pending: null, wakeAt: null };
  }
  return {
    mode: 'split',
    top: measured.top,
    bottom: measured.top + curH - 1,
    pending: { kind: 'shrink', h, since },
    wakeAt: since + settleMs,
  };
}

module.exports = {
  CODEX_STATUS_ROW,
  SPLIT_SETTLE_MS,
  SPLIT_EXIT_MS,
  isRuleRow,
  isComposerRow,
  isLabeledRuleRow,
  isCodexComposerRow,
  findAnchor,
  marksPrompt,
  workingPane,
  measureSplit,
  sheetBand,
  initialSplitState,
  reduceSplit,
};
