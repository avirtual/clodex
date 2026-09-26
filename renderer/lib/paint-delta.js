'use strict';

const PAINT_BLOCK_CAP = 200;
const BUSY_ROW = /esc to interrupt/u;
const BUSY_SPAN = 4;

const isBlank = (row) => !/\S/u.test(row || '');
const norm = (row) => String(row == null ? '' : row).trimEnd();

function trimTrailingBlank(rows) {
  let end = rows.length;
  while (end > 0 && isBlank(rows[end - 1])) end--;
  return rows.slice(0, end);
}

function windowAt(prev, next, s) {
  const len = Math.min(prev.length - s, next.length);
  for (let k = 0; k < len; k++) if (prev[s + k] !== next[k]) return -1;
  return len;
}

function createPaintDelta() {
  let prev = null;
  return {
    feed(rowsAboveAnchor) {
      const next = trimTrailingBlank((Array.isArray(rowsAboveAnchor) ? rowsAboveAnchor : []).map(norm));
      const before = prev;
      prev = next;
      if (!before) return [];
      for (let s = 0; s < before.length; s++) {
        const len = windowAt(before, next, s);
        if (len > 0) return next.slice(len);
      }
      return next.filter((r) => !isBlank(r));
    },
    reset() { prev = null; },
  };
}

function mergeByTs(fileRecords, extraRecords) {
  const a = Array.isArray(fileRecords) ? fileRecords : [];
  const b = Array.isArray(extraRecords) ? extraRecords : [];
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (typeof a[i].ts !== 'number' || typeof b[j].ts !== 'number' || a[i].ts <= b[j].ts) out.push(a[i++]);
    else out.push(b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

const isBusyScreen = (rows, top = Array.isArray(rows) ? rows.length : 0) => Array.isArray(rows) && rows.slice(Math.max(0, top - BUSY_SPAN), top).some((r) => BUSY_ROW.test(r || ''));

const stripMark = (row) => String(row || '').trim().replace(/^[›❯>][  ]?/u, '').trim();

function blockText(rows, dropped) {
  const drop = new Set([...dropped].map(stripMark).filter(Boolean));
  const all = rows.map(norm);
  let lead = 0;
  while (lead < all.length && (isBlank(all[lead]) || drop.has(stripMark(all[lead])))) lead++;
  const kept = all.slice(lead);
  let start = 0;
  let end = kept.length;
  while (start < end && isBlank(kept[start])) start++;
  while (end > start && isBlank(kept[end - 1])) end--;
  const body = kept.slice(start, end);
  if (!body.length) return '';
  return (body.length > PAINT_BLOCK_CAP ? ['…', ...body.slice(-PAINT_BLOCK_CAP)] : body).join('\n');
}

module.exports = { PAINT_BLOCK_CAP, createPaintDelta, mergeByTs, isBusyScreen, blockText };
