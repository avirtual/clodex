'use strict';
// web-shortcuts.js — pure map from a keydown event to a browser Alt-chord action
// (web-frontend Phase 5, Chunk 2). A browser tab reserves Cmd+T/W/1-9 for its own
// chrome, so the desktop's Cmd shortcuts (renderer.js) silently fail in-tab; the
// web frontend mirrors them onto Alt. This leaf only CLASSIFIES the chord —
// renderer.js owns the DOM dispatch and the window.__CLODEX_WEB__ gate.
//
// Classification is by e.code, NOT e.key: on macOS the Option/Alt key composes
// characters (Option+T → "†", Option+1 → "¡"), so e.key is the composed glyph,
// not "t"/"1". e.code is the physical key ("KeyT", "Digit1", "BracketRight"),
// unaffected by composition or keyboard layout.
//
// Returns null for anything that isn't a bound Alt chord, else one of:
//   { type: 'new' }                        Alt+T          — new session (dialog)
//   { type: 'close' }                      Alt+W          — close active session
//   { type: 'switch', index }              Alt+1..9       — nth session (0-based)
//   { type: 'cycle', dir: 'next'|'prev' }  Alt+Shift+] / Alt+Shift+[

function altChordAction(e) {
  if (!e || !e.altKey || e.metaKey || e.ctrlKey) return null;
  const code = e.code || '';
  if (e.shiftKey) {
    if (code === 'BracketRight') return { type: 'cycle', dir: 'next' };
    if (code === 'BracketLeft') return { type: 'cycle', dir: 'prev' };
    return null;
  }
  if (code === 'KeyT') return { type: 'new' };
  if (code === 'KeyW') return { type: 'close' };
  const m = /^Digit([1-9])$/.exec(code);
  if (m) return { type: 'switch', index: parseInt(m[1], 10) - 1 };
  return null;
}

module.exports = { altChordAction };
