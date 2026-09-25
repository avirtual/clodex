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

function isAnchorAt(rows, i, cols) {
  return isRuleRow(rows[i], cols) && isComposerRow(rows[i + 1]);
}

function findAnchor(rows, cursorY, cols) {
  if (!Array.isArray(rows) || rows.length < 2) return -1;
  const start = Math.max(0, Math.min(rows.length - 1, Number.isInteger(cursorY) ? cursorY : rows.length - 1));
  for (let i = start; i >= 0; i--) if (isAnchorAt(rows, i, cols)) return i;
  for (let i = start + 1; i < rows.length - 1; i++) if (isAnchorAt(rows, i, cols)) return i;
  return -1;
}

function measureSplit(rows, cursorY, cols) {
  const top = findAnchor(rows, cursorY, cols);
  if (top < 0) return { mode: 'full', top: -1, bottom: -1 };
  let bottom = rows.length - 1;
  while (bottom > top + 1 && !/\S/u.test(rows[bottom] || '')) bottom--;
  if (Number.isInteger(cursorY)) bottom = Math.max(bottom, Math.min(cursorY, rows.length - 1));
  return { mode: 'split', top, bottom };
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
  SPLIT_SETTLE_MS,
  SPLIT_EXIT_MS,
  isRuleRow,
  isComposerRow,
  findAnchor,
  measureSplit,
  initialSplitState,
  reduceSplit,
};
