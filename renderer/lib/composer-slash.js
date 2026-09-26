'use strict';

function slashQuery(value, cursor) {
  const text = String(value == null ? '' : value);
  const pos = Math.max(0, Math.min(text.length, cursor == null ? text.length : cursor));
  const start = pos <= 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
  if (text[start] !== '/') return null;
  const token = /^\/\S*/.exec(text.slice(start))[0];
  const end = start + token.length;
  if (pos <= start || pos > end) return null;
  return { query: text.slice(start + 1, pos), start, end };
}

function filterCommands(list, query) {
  const items = Array.isArray(list) ? list : [];
  const q = String(query == null ? '' : query).toLowerCase();
  if (!q) return items.slice();
  const prefix = [];
  const inner = [];
  for (const item of items) {
    const name = String((item && item.name) || '').replace(/^\//, '').toLowerCase();
    if (name.startsWith(q)) prefix.push(item);
    else if (name.includes(q)) inner.push(item);
  }
  return prefix.concat(inner);
}

function slashMenuKey({ key, open, index, count, shiftKey, ctrlKey, metaKey, altKey }) {
  if (!open || ctrlKey || metaKey || altKey) return null;
  if (key === 'Escape') return { close: true };
  if (!(count > 0) || shiftKey) return null;
  const at = Number.isInteger(index) ? index : 0;
  if (key === 'ArrowDown') return { index: (at + 1) % count };
  if (key === 'ArrowUp') return { index: (at - 1 + count) % count };
  if (key === 'Tab' || key === 'Enter') return { pick: true };
  return null;
}

module.exports = { slashQuery, filterCommands, slashMenuKey };
