'use strict';
// echo-rewrite-wiring.test.js — the two wrong changes that would silently undo
// t641's prompt-echo rewrite, neither of which any other test reds on.
//
// 1. Unwrapping the pty-data write back to `terminal.write(data)`. The rewriter
//    keeps working, every prompt-echo.test.js row still passes, and not one byte
//    on screen is recoloured — the rewrite is simply never called.
// 2. Dropping the `peer ?` fence at the construction site. A peer pane's bytes
//    are ANOTHER box's terminal, already rendered there under that box's theme;
//    rewriting them recolours output this box never produced, keyed off a
//    palette that does not describe the sending seat.
//
// Source-shape assertions, in the style of restore-fit.test.js and
// spawn-focus-steal.test.js: both mechanisms are DOM- and IPC-bound inside
// renderer.js, which no fixture in this suite can construct, so what is pinned
// is that the call is wrapped and the construction is guarded.
//
// Being source-shape, this pin is INVISIBLE from the code it guards: nothing at
// either site in renderer.js says a test depends on its shape, so an author who
// reasons their way to removing the fence meets this file only after the suite
// reds. That is the whole reason it exists, and why it names both sites.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf8');

// The whole `window.api.onPtyData((name, data) => { … });` registration. Ended
// on the `});` at column 0, so a nested arrow or catch inside cannot close the
// region early — a clipped region would read as an ABSENT rewrite and red for
// the wrong reason.
function ptyDataHandler(src) {
  const m = src.match(/window\.api\.onPtyData\(\([\s\S]*?\n\}\);/);
  return m ? m[0] : null;
}

// The construction statement, located by the callee rather than by its argument
// or its assigned name: `currentEchoPalette` is a themes-island export that may
// be renamed or wrapped, and the fence is a property of the CALL, not of what is
// passed to it.
function rewriterConstructionLines(src) {
  return src.split('\n').filter((l) => /createEchoRewriter\s*\(/.test(l) && !/require\(/.test(l));
}

test('renderer routes pty data through the session rewriter, not raw', () => {
  const handler = ptyDataHandler(SRC);
  assert.ok(handler, 'ENTER: onPtyData is still the pty-data route into xterm');
  assert.match(handler, /terminal\.write\(/,
    'ENTER: the handler still writes into a terminal — otherwise the rest asserts nothing');

  assert.match(handler, /terminal\.write\([^\n]*echoRewrite\(/,
    'the pty-data write must pass through the session echo rewriter: unwrapping it '
    + 'leaves every prompt-echo unit test green while nothing on screen is recoloured');
});

test('the echo rewriter is constructed only behind the peer fence', () => {
  const lines = rewriterConstructionLines(SRC);
  assert.strictEqual(lines.length, 1,
    `ENTER: exactly one createEchoRewriter call site is expected; found ${lines.length}`);

  assert.match(lines[0], /\bpeer\b/,
    'the construction must stay guarded by `peer`: a peer pane\'s bytes were rendered '
    + 'on another box under another theme, so rewriting them recolours output this box '
    + 'never produced');
});

// Not redundant with the fence assertion above: satisfying `\bpeer\b` on the
// construction line while handing a live rewriter to peer panes is exactly the
// shape a careless edit produces (`peer ? createEchoRewriter(…) : identity`
// inverts the arms and still matches). The identity arm is what makes the fence
// a fence, so it is pinned by its position — before the construction.
test('the peer arm of the fence is the identity function, not the rewriter', () => {
  const lines = rewriterConstructionLines(SRC);
  assert.strictEqual(lines.length, 1, 'ENTER: single construction site');

  const line = lines[0];
  const peerAt = line.indexOf('peer');
  const buildAt = line.indexOf('createEchoRewriter');
  assert.ok(peerAt > -1 && buildAt > peerAt,
    'the peer test must precede the construction on that line');

  assert.match(line.slice(peerAt, buildAt), /\?[^?]*chunk[^?]*=>[^?]*chunk/,
    'the peer arm must pass chunks through untouched');
});
