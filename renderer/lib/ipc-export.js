'use strict';
// ipc-export.js — pure text-building for the IPC log's Export button: one
// grep-friendly line per message (ISO timestamp, from -> to, body with
// newlines flattened), plus the download filename. Leaf: no DOM; ipc-log.js
// keeps the capped line buffer and does the Blob/anchor download.
// NEW module — deliberately NOT in the leak-scanner's RENDERER_SCANNED_MODULES
// (that guard is for move-only extractions).

// Bound the retained buffer so a long-lived window can't grow without limit;
// at ~200 bytes/line this caps around 1MB.
const MAX_EXPORT_LINES = 5000;

function formatIpcLine(msg, date) {
  const ts = (date instanceof Date ? date : new Date()).toISOString();
  const from = msg && msg.from != null ? String(msg.from) : '?';
  const to = msg && msg.to != null ? String(msg.to) : '?';
  const body = msg && msg.body != null ? String(msg.body) : '';
  // One line per message keeps the file greppable; embedded newlines become
  // literal \n so nothing is lost.
  return `${ts} ${from} -> ${to} ${body.replace(/\r\n|\r|\n/g, '\\n')}`;
}

// Joined file content; '' for an empty log (caller skips the download).
function buildExportText(lines) {
  const list = (lines || []).filter(Boolean);
  if (!list.length) return '';
  return list.join('\n') + '\n';
}

// Local-time stamp so the filename matches what the operator's clock said.
function exportFilename(date) {
  const d = date instanceof Date ? date : new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return `clodex-ipc-log-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`;
}

module.exports = { MAX_EXPORT_LINES, formatIpcLine, buildExportText, exportFilename };
