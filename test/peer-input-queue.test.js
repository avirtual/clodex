'use strict';

// PendingInput: the type-to-take buffer. Covers the kick/in-flight guard, FIFO
// flush ordering, the whole-chunk cap, and reset-on-failure.

const { test } = require('node:test');
const assert = require('node:assert');
const { PendingInput, DEFAULT_CAP_BYTES } = require('../peer-input-queue');

test('first offer kicks an acquire; concurrent offers do not', () => {
  const q = new PendingInput();
  assert.equal(q.offer('a'), true, 'first offer kicks');
  assert.equal(q.offer('b'), false, 'second offer while acquiring does not');
  assert.equal(q.offer('c'), false);
});

test('drain returns buffered keystrokes in FIFO order and clears state', () => {
  const q = new PendingInput();
  q.offer('h');
  q.offer('e');
  q.offer('l');
  q.offer('lo');
  assert.equal(q.drain(), 'hello');
  // Drained: acquiring reset, buffer empty, so a later keystroke kicks afresh.
  assert.equal(q.size, 0);
  assert.equal(q.offer('x'), true);
  assert.equal(q.drain(), 'x');
});

test('drain on an empty queue is the empty string (safe double-drain)', () => {
  const q = new PendingInput();
  q.offer('a');
  assert.equal(q.drain(), 'a');
  assert.equal(q.drain(), '', 'second drain yields nothing, sends nothing');
});

test('a chunk is kept whole when it fits and dropped whole when it overflows', () => {
  const q = new PendingInput({ capBytes: 8 });
  assert.equal(q.push('1234'), true);
  assert.equal(q.push('5678'), true);    // exactly at cap
  assert.equal(q.size, 8);
  assert.equal(q.push('9'), false, 'overflow chunk dropped whole');
  assert.equal(q.drain(), '12345678', 'no partial splice');
});

test('a mid-acquire paste survives if it fits under the cap', () => {
  const q = new PendingInput({ capBytes: 64 });
  q.offer('a');                          // kick
  const paste = 'x'.repeat(40);
  assert.equal(q.push(paste), true);
  assert.equal(q.drain(), 'a' + paste);
});

test('reset drops the buffer and ends the acquiring state', () => {
  const q = new PendingInput();
  q.offer('a');
  q.offer('b');
  q.reset();
  assert.equal(q.size, 0);
  assert.equal(q.drain(), '');
  // After a failed acquire, the next keystroke can kick a fresh one.
  assert.equal(q.offer('c'), true);
});

test('reset after an offer-during-acquiring lets the next offer kick again', () => {
  // The stuck-acquiring interleave: a keystroke arrives while an acquire is
  // already in flight (kick=false), then that acquire FAILS and resets the
  // buffer. The very next keystroke must kick a fresh acquire — otherwise
  // acquiring stays true forever and type-to-take goes silently dead.
  const q = new PendingInput();
  assert.equal(q.offer('a'), true, 'initial acquire kicks');
  assert.equal(q.offer('b'), false, 'keystroke during acquire does not re-kick');
  q.reset();                                // acquire failed → unconditional reset
  assert.equal(q.offer('c'), true, 'post-failure keystroke kicks a fresh acquire');
});

test('default cap is a few KB (human typing, not paste floods)', () => {
  assert.equal(DEFAULT_CAP_BYTES, 4096);
});
