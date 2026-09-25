'use strict';

const KEYS = new Set(['u', 'k', 'w', 'a', 'e']);

function lineStart(value, pos) {
  return value.lastIndexOf('\n', pos - 1) + 1;
}

function lineEnd(value, pos) {
  const i = value.indexOf('\n', pos);
  return i === -1 ? value.length : i;
}

function composerReadlineEdit({ key, ctrlKey, metaKey, altKey, value, selectionStart, selectionEnd }) {
  if (!ctrlKey || metaKey || altKey || typeof key !== 'string') return null;
  const k = key.toLowerCase();
  if (!KEYS.has(k)) return null;
  const text = String(value == null ? '' : value);
  const start = Math.max(0, Math.min(text.length, selectionStart == null ? text.length : selectionStart));
  const end = Math.max(start, Math.min(text.length, selectionEnd == null ? start : selectionEnd));
  if (k === 'a') return { value: text, cursor: lineStart(text, start) };
  if (k === 'e') return { value: text, cursor: lineEnd(text, end) };
  if (end > start) return { value: text.slice(0, start) + text.slice(end), cursor: start };
  let from = start;
  let to = start;
  if (k === 'u') from = lineStart(text, start);
  else if (k === 'k') to = lineEnd(text, start);
  else {
    const floor = lineStart(text, start);
    while (from > floor && /\s/.test(text[from - 1])) from--;
    while (from > floor && !/\s/.test(text[from - 1])) from--;
  }
  return { value: text.slice(0, from) + text.slice(to), cursor: from };
}

module.exports = { composerReadlineEdit };
