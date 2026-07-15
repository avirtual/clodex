'use strict';
// drop-paths.js — pure text-building for drag-dropping files onto a session:
// turn dropped host paths into the string typed at the prompt (each path
// shell-quoted, space-joined, one trailing space so the next keystroke doesn't
// glue to the path — the same shape iTerm produces). Leaf: no DOM, no electron;
// the drop wiring in renderer.js resolves File → path and routes the write.
// NEW module — deliberately NOT in the leak-scanner's RENDERER_SCANNED_MODULES
// (that guard is for move-only extractions).

// Paths made only of these bytes read identically bare or quoted — leave them
// bare so the common case stays clean. Anything else (spaces, quotes, shell
// metacharacters, unicode) gets POSIX single-quoting, with embedded single
// quotes closed-escaped-reopened ('\'').
const BARE_SAFE = /^[A-Za-z0-9_\/.+,~=-]+$/;

function shellQuotePath(p) {
  const s = String(p);
  if (BARE_SAFE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The full drop payload for a list of paths. Empty/absent input → '' (caller
// skips the write rather than typing a lone space).
function dropText(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return '';
  return list.map(shellQuotePath).join(' ') + ' ';
}

module.exports = { shellQuotePath, dropText };
