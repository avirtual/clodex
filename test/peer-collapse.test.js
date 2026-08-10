// Run: node --test test/peer-collapse.test.js
// The defaulting rule the peer-header fold rests on (t276): the persisted set
// names EXPANDED peers, so absence — of the whole stored value, or of one id —
// reads as COLLAPSED. That asymmetry is the feature: a fresh workspace must not
// open showing every peer's sessions. Storing collapsed ids instead would make
// every absence read as expanded, and the tests below are the ones that would
// catch that inversion.
const { test } = require('node:test');
const assert = require('node:assert');
const { isPeerExpanded, togglePeerExpanded } = require('../renderer/lib/peer-collapse');

test('absence reads as COLLAPSED — no stored value, and an unknown id', () => {
  // A workspace that has never stored a view at all.
  assert.strictEqual(isPeerExpanded(undefined, 'p1'), false);
  assert.strictEqual(isPeerExpanded(null, 'p1'), false);
  // A workspace whose stored list exists but is empty.
  assert.strictEqual(isPeerExpanded([], 'p1'), false);
  // A peer seen for the first time in a workspace that has other peers open.
  assert.strictEqual(isPeerExpanded(['p2', 'p3'], 'p1'), false);
  // ENTER: an id that IS in the list must read expanded, or every assertion
  // above passes on a function that simply always returns false.
  assert.strictEqual(isPeerExpanded(['p2', 'p1'], 'p1'), true);
});

test('ids are compared as strings, so a numeric peer id round-trips through JSON', () => {
  assert.strictEqual(isPeerExpanded(['7'], 7), true);
  assert.deepStrictEqual(togglePeerExpanded([], 7), ['7']);
});

test('toggle round-trips: collapsed -> expanded -> collapsed', () => {
  const opened = togglePeerExpanded([], 'p1');
  assert.deepStrictEqual(opened, ['p1']);
  assert.strictEqual(isPeerExpanded(opened, 'p1'), true);

  const closed = togglePeerExpanded(opened, 'p1');
  assert.deepStrictEqual(closed, []);
  assert.strictEqual(isPeerExpanded(closed, 'p1'), false);
});

test('toggle does not mutate its input and does not prune unknown ids', () => {
  // A peer that has gone offline (or been removed and re-added) is not in
  // peerStatuses, but its id must survive a toggle of some OTHER peer —
  // pruning would silently re-collapse it on the next reconnect.
  const before = ['gone-peer', 'p1'];
  const after = togglePeerExpanded(before, 'p2');
  assert.deepStrictEqual(before, ['gone-peer', 'p1'], 'input array must not be mutated');
  assert.deepStrictEqual(after, ['gone-peer', 'p1', 'p2']);
  assert.strictEqual(isPeerExpanded(after, 'gone-peer'), true);
});

test('a junk stored value degrades to collapsed rather than throwing', () => {
  // What a hand-edited or older workspace record could hold.
  assert.strictEqual(isPeerExpanded('p1', 'p1'), false, 'a bare string is not a set of ids');
  assert.strictEqual(isPeerExpanded({ p1: true }, 'p1'), false);
  assert.deepStrictEqual(togglePeerExpanded('nonsense', 'p1'), ['p1']);
  assert.deepStrictEqual(togglePeerExpanded([null, 3, 'p9'], 'p1'), ['p9', 'p1'],
    'non-string entries are dropped, so they cannot come back as "null" ids');
});
