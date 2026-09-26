'use strict';

const SCAN_ROWS = 4;
const ELAPSED = /^\d+[hms](?:\s+\d+[ms])*$/;

const SHAPES = {
  claude: /^\s*\S\s+([A-Z][^\s(]*(?:\s+[^\s(]+)*…)\s*\(([^)]*)\)/,
  codex: /^\s*•\s+(.+?)\s+\((\d+[hms][^)]*?)\s*•\s*esc to interrupt\)/,
  muse: /^\s*[^\w\s]\s+([A-Z].*?)\s+\((\d+[hms][^)]*?)\s*·\s*esc to interrupt\)/,
};

function claudeText(m) {
  const parts = m[2].split('·').map((p) => p.trim()).filter(Boolean);
  if (!parts.some((p) => ELAPSED.test(p))) return null;
  const rest = parts.filter((p) => !ELAPSED.test(p) && !/^esc to interrupt$/i.test(p));
  return rest.length ? `${m[1]} · ${rest.join(' · ')}` : m[1];
}

function matchRow(row, platform) {
  const shape = SHAPES[platform];
  const m = shape && shape.exec(row);
  if (!m) return null;
  return platform === 'claude' ? claudeText(m) : m[1];
}

function spinnerText(rows, top, platform) {
  if (!Array.isArray(rows) || !Number.isInteger(top) || !SHAPES[platform]) return null;
  let seen = 0;
  for (let i = Math.min(top, rows.length) - 1; i >= 0 && seen < SCAN_ROWS; i--) {
    const row = String(rows[i] || '');
    if (!row.trim()) continue;
    seen++;
    const text = matchRow(row, platform);
    if (text) return text;
  }
  return null;
}

module.exports = { spinnerText };
