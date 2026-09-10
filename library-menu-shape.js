'use strict';

const FOLD_AT = 16;

function categoryMenu(categories, opts = {}) {
  const { empty, foldAt = FOLD_AT } = opts;
  const all = (Array.isArray(categories) ? categories : []).filter(Boolean);
  const head = all[0] || { label: 'Library', rows: [] };
  const rest = all.slice(1).filter((c) => c.rows && c.rows.length);
  const headRows = (head.rows && head.rows.length)
    ? head.rows
    : (empty ? [{ label: empty, enabled: false }] : []);
  const total = rest.reduce((n, c) => n + c.rows.length, headRows.length);

  if (total > foldAt) {
    const out = [{ label: head.label, submenu: headRows }];
    for (const c of rest) out.push({ label: c.label, submenu: c.rows });
    return out;
  }

  const out = [...headRows];
  for (const c of rest) {
    out.push({ type: 'separator' }, { label: c.label, enabled: false }, ...c.rows);
  }
  return out;
}

module.exports = { categoryMenu, FOLD_AT };
