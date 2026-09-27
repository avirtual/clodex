'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'side-pane.js'), 'utf8');

function body(name) {
  const start = SRC.indexOf(`\n  function ${name}(`);
  assert.ok(start >= 0, `ENTER: side-pane.js defines ${name}()`);
  const end = SRC.indexOf('\n  }\n', start);
  assert.ok(end > start, `ENTER: ${name}() has a closing brace at its own indent`);
  return { start, end, text: SRC.slice(start, end) };
}

function all(re) {
  const out = [];
  for (const m of SRC.matchAll(re)) out.push(m.index);
  return out;
}

test('side-pane open(): dock.reveal() once, before runEffect', () => {
  const open = body('open');
  const reveals = all(/dock\.reveal\(\)/g);
  assert.strictEqual(reveals.length, 1, 'dock.reveal() appears exactly once in side-pane.js');
  assert.ok(reveals[0] > open.start && reveals[0] < open.end, 'and it is inside open()');
  const effect = open.text.indexOf('runEffect(seat, id, effect');
  assert.ok(effect >= 0, 'ENTER: open() runs the effect');
  assert.ok(reveals[0] - open.start < effect, 'dock.reveal() precedes runEffect(seat, id, effect');
});

test('side-pane: every dock.setShown( call is inside renderChrome()', () => {
  const chrome = body('renderChrome');
  const calls = all(/dock\.setShown\(/g);
  assert.ok(calls.length > 0, 'ENTER: side-pane.js calls dock.setShown');
  for (const at of calls) {
    assert.ok(at > chrome.start && at < chrome.end, `dock.setShown( at offset ${at} is outside renderChrome()`);
  }
});
