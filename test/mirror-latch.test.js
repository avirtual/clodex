'use strict';
// mirror-latch.test.js — the renderer's mirror of a value main owns.
//
// The ordering this pins is unreachable from renderer.js, which has no harness:
// a catch-up pull is a promise, so it can resolve AFTER a broadcast has already
// delivered a newer answer. Getting that backwards points a live microphone at
// a seat main has already moved it off.

const { test } = require('node:test');
const assert = require('node:assert');

const { createMirrorLatch } = require('../renderer/lib/mirror-latch');

test('a late pull cannot overwrite a broadcast that already landed', () => {
  // THE CASE THE LATCH EXISTS FOR. Main moved the target to B and said so; the
  // pull this window fired at startup then answers with the older A.
  const m = createMirrorLatch(null);
  m.note('B');
  m.pull('A');
  assert.strictEqual(m.read(), 'B', 'the broadcast is the fresher answer and must win');
});

test('a pull that arrives FIRST is used, which is why it exists at all', () => {
  // The other direction: a window opened mid-dictation missed the edge, and the
  // target does not move again while he keeps talking to the seat he picked.
  const m = createMirrorLatch(null);
  m.pull('A');
  assert.strictEqual(m.read(), 'A');
});

test('a broadcast still wins after an early pull', () => {
  const m = createMirrorLatch(null);
  m.pull('A');
  m.note('B');
  assert.strictEqual(m.read(), 'B');
});

test('the value cannot double as the heard flag: a broadcast of the INITIAL value latches', () => {
  // The bug this shape replaced. `null` is a legitimate released mic target and
  // `false` a legitimate backgrounded app, so `value === initial` cannot mean
  // "nothing arrived yet" — a broadcast carrying exactly the initial value has
  // to latch out a later pull just the same.
  const m = createMirrorLatch(null);
  m.note(null);
  m.pull('A');
  assert.strictEqual(m.read(), null, 'a broadcast of null is still a broadcast');

  const f = createMirrorLatch(false, { normalize: (v) => v === true });
  f.note(false);
  f.pull(true);
  assert.strictEqual(f.read(), false, 'a broadcast of false is still a broadcast');
});

test('normalize runs on every entry point, including the initial value', () => {
  // The mirrors rely on this: `on === true` is what keeps a truthy non-boolean
  // from arming, and a raw value slipping through one of the three doors would
  // reintroduce exactly that.
  const f = createMirrorLatch('yes', { normalize: (v) => v === true });
  assert.strictEqual(f.read(), false, 'the initial value is normalized too');
  f.note(1);
  assert.strictEqual(f.read(), false, 'note normalizes');

  const g = createMirrorLatch(false, { normalize: (v) => v === true });
  g.pull(1);
  assert.strictEqual(g.read(), false, 'pull normalizes');

  const n = createMirrorLatch(null, { normalize: (v) => (typeof v === 'string' ? v : null) });
  n.note({});
  assert.strictEqual(n.read(), null, 'a non-string target is not a target');
});

test('heard() distinguishes "no host answers" from a legitimate falsy value', () => {
  // The headless host never reports app focus, and the tap must not try to
  // raise a window there — a distinction `read()` alone cannot carry.
  const m = createMirrorLatch(false, { normalize: (v) => v === true });
  assert.strictEqual(m.heard(), false);
  m.pull(false);
  assert.strictEqual(m.heard(), false, 'a pull is not a broadcast');
  m.note(false);
  assert.strictEqual(m.heard(), true, 'even a false broadcast counts as heard');
});
