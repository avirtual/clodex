'use strict';
// restore-fit.test.js — a tab restored into the background must be measured
// BEFORE its buffered output is replayed into it.
//
// The live defect: on relaunch every restored terminal except `firstHealthy`
// sat at xterm's 80x24 default while `terminal.write(entry.replay)` painted
// bytes a 120x30 PTY had produced. Soft-wrapped text reflows when the tab is
// later fitted; a cursor-addressed TUI redraw does not, so the Claude composer
// stayed garbled until the CLI next repainted.
//
// Source-shape assertions, in the style of spawn-focus-steal.test.js: the
// mechanism is a resize and a write against a real laid-out DOM, which no
// fixture in this suite can build, so what is pinned is that the calls are
// there and in the order the fix depends on.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SRC = read('renderer/renderer.js');

// The whole `(async function restoreSessions() { … })();` IIFE. Ended on the
// `})();` at column 0, so a nested arrow or catch block inside cannot close it
// early — a clipped region would read as an ABSENT fit.
function restoreLoop(src) {
  const m = src.match(/\(async function restoreSessions\(\)[\s\S]*?\n\}\)\(\);/);
  return m ? m[0] : null;
}

// Located by the ARGUMENT, not by an exact call string: the replay is written
// through whatever transform the write site currently wraps it in (t641 added
// the prompt-echo rewrite), and pinning the literal `terminal.write(entry.replay)`
// made this an ENTER failure the moment a wrapper appeared — reporting the
// replay as absent when only its spelling had changed.
function replayWriteIndex(loop) {
  const m = loop.match(/terminal\.write\([^\n]*entry\.replay/);
  return m ? m.index : -1;
}

test('the restore loop measures each terminal before replaying into it', () => {
  const loop = restoreLoop(SRC);
  assert.ok(loop, 'ENTER: the restoreSessions IIFE is still the restore path');

  const write = replayWriteIndex(loop);
  assert.ok(write > 0, 'ENTER: the loop still writes the buffered replay');

  const fit = loop.indexOf('fitAddon.fit()');
  assert.ok(fit > 0, 'each restored terminal must be measured, not left at 80x24');
  assert.ok(fit < write,
    'the fit must precede the replay write: a cursor-addressed redraw painted at '
    + 'the wrong width does not reflow when the tab is fitted later');

  assert.match(loop, /resizeSession\(entry\.name/,
    'the PTY has to be told the size the terminal was measured at');
});

test('the restore loop does not defer its fit into a rAF', () => {
  const loop = restoreLoop(SRC);
  assert.ok(loop, 'ENTER: the restoreSessions IIFE is still the restore path');

  const helper = SRC.match(/function fitSessionInBackground[\s\S]*?\n\}/);
  assert.ok(helper, 'ENTER: fitSessionInBackground still exists to be ruled out');
  assert.match(helper[0], /requestAnimationFrame/,
    'ENTER: the helper defers — that deferral is why the loop may not use it');

  assert.doesNotMatch(loop, /fitSessionInBackground\(/,
    'the helper fits inside a rAF, which lands AFTER the synchronous replay write');

  // Not redundant with the helper check above: a rAF written INLINE here defers
  // the fit just as the helper would, while leaving `fitSessionInBackground(`
  // absent and the fit-before-write index comparison satisfied.
  // Sliced at the write because only a deferral BEFORE it can strand the replay
  // in an unsized buffer — an unrelated rAF added later in the region must not
  // red this.
  const write = replayWriteIndex(loop);
  assert.ok(write > 0, 'ENTER: the loop still writes the buffered replay');
  assert.doesNotMatch(loop.slice(0, write), /requestAnimationFrame/,
    'the fit must not be deferred by any route: a rAF callback runs after the '
    + 'synchronous write, whether it arrives via the helper or written inline');
});
