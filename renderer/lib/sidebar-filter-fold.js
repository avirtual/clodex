'use strict';

const SUMMARY_PARTS = [
  { control: 'search', isDefault: (v) => !String(v || '').trim(), text: (v) => `“${String(v).trim()}”` },
  { control: 'group', isDefault: (v) => !v || v === 'none', strip: 'Group: ' },
  { control: 'sort', isDefault: (v) => !v || v === 'recency', strip: 'Sort: ' },
  { control: 'status', isDefault: (v) => !v || v === 'all' },
  { control: 'activity', isDefault: (v) => !v || v === 'all' },
];

function filterSummary(view, labelsByControl) {
  const v = view || {};
  const labels = labelsByControl || {};
  const out = [];
  for (const part of SUMMARY_PARTS) {
    const value = v[part.control];
    if (part.isDefault(value)) continue;
    if (part.text) { out.push(part.text(value)); continue; }
    const byValue = labels[part.control] || {};
    const label = byValue[String(value)];
    if (!label) continue;
    out.push(part.strip && label.startsWith(part.strip) ? label.slice(part.strip.length) : label);
  }
  return out.join(' · ');
}

function setFilterFolded(els, folded, { summary = '', persist = null } = {}) {
  const on = !!folded;
  const targets = [els && els.bar, els && els.header];
  for (const el of targets) {
    if (el && el.classList) el.classList.toggle('collapsed', on);
  }
  if (els && els.summary) els.summary.textContent = on ? summary : '';
  if (persist) persist({ filterFolded: on });
}

module.exports = { filterSummary, setFilterFolded };
