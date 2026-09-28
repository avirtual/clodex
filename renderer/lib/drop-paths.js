'use strict';
// drop-paths.js — pure text-building for drag-dropping files onto a session:
// turn dropped host paths into the string typed at the prompt (each path
// shell-quoted, space-joined, one trailing space so the next keystroke doesn't
// glue to the path — the same shape iTerm produces). Leaf: no DOM, no electron;
// the drop wiring in renderer.js resolves File → path and routes the write.
// NEW module — deliberately NOT in the leak-scanner's RENDERER_SCANNED_MODULES
// (that guard is for move-only extractions).

// Paths made only of these bytes read identically bare or quoted — leave them
// bare so the common case stays clean.
const BARE_SAFE = /^[A-Za-z0-9_\/.+,~=-]+$/;

function shellQuotePath(p) {
  const s = String(p);
  if (BARE_SAFE.test(s)) return s;
  if (/[\x00-\x1f\x7f]/u.test(s)) {
    return `$'${s.replace(/[\\'\x00-\x1f\x7f]/gu, (c) => (c === '\\' || c === "'" ? `\\${c}` : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`))}'`;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Claude sessions get @-mention form instead: the CLI reads/attaches the file
// itself at prompt-submit — no agent Read round-trip. The @ parser terminates
// on unescaped whitespace and does NOT understand shell quoting, so spaces are
// backslash-escaped (the form the CLI's own path completion produces). Other
// mention-breaking bytes can't be escaped — those paths fall back to plain
// shell quoting (the agent reads; correct, just one round-trip slower).
const AT_SAFE = /^[A-Za-z0-9_\/.+,~= -]+$/;

function atMentionPath(p) {
  const s = String(p);
  if (!AT_SAFE.test(s)) return null;
  return '@' + s.replace(/ /g, '\\ ');
}

// The full drop payload for a list of paths. Empty/absent input → '' (caller
// skips the write rather than typing a lone space). style 'claude' prefers
// @-mentions per path, falling back to shell quoting path-by-path.
function dropText(paths, style) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return '';
  const render = style === 'claude'
    ? (p) => atMentionPath(p) ?? shellQuotePath(p)
    : shellQuotePath;
  return list.map(render).join(' ') + ' ';
}

module.exports = { shellQuotePath, atMentionPath, dropText };
