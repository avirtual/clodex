'use strict';
// The Activity tab's badge state machine (renderer/lib/activity-badge.js).
//
// This logic shipped two operator-visible defects before it was a leaf: the
// badge stuck at 0 while the tab was visible (t206 D2, found only by measurement
// under a DOM stub), and subs first seen while watching being permanently unable
// to badge later. Both are arithmetic over three maps, which is why the machine
// is here and not in the tab.
//
// The two load-bearing facts these tests exist to hold shut:
//   1. the AWAY-PERIOD is the unit, not the window — a sub that took a turn
//      while the operator was not looking badges, and `requests` is only ever an
//      advanced/not-advanced edge, never a rendered count;
//   2. badge accounting runs ABOVE the tab's unmount guard, so a sub that ran
//      before the pane ever mounted still badges.
const { test } = require('node:test');
const assert = require('node:assert');

const { createBadgeState, feedKeyOf } = require('../renderer/lib/activity-badge');

// The chip map the tab hands in: feedKey -> { name, key, label, state, sub }.
// Only `sub.requests` is read, but the whole shape is built so a test that
// starts reading more fields does not silently get `undefined`.
const liveMap = (...rows) => new Map(rows.map(([name, key, requests, over = {}]) => [
  feedKeyOf(name, key),
  { name, key, label: key, state: 'active', sub: { key, requests, ...over } },
]));

test('a sub first observed this away-period badges once, not per observation', () => {
  const b = createBadgeState();
  const live = liveMap(['alpha', 'sub1', 4]);

  assert.deepStrictEqual(b.notice(live), ['alpha sub1']);
  // Same roster, same away-period: presence already counted, so nothing more.
  assert.deepStrictEqual(b.notice(live), []);
  assert.deepStrictEqual(b.notice(live), []);

  // Whole-state equality: a partial check reads around exactly the bookkeeping
  // the two shipped defects lived in — an unwritten lastReq still satisfies a
  // notified-only assertion.
  assert.deepStrictEqual(b.snapshot(), {
    notified: ['alpha sub1'],
    lastReq: { 'alpha sub1': 4 },
    awayReq: {},
    firstSeen: { 'alpha sub1': 1 },
    seenSeq: 1,
  });
});

// The t206 D2 shape: the sub was already on screen when the operator looked
// away, so its mere presence is NOT activity — only an advance is.
test('a sub already known when the away-period began badges only once requests advance', () => {
  const b = createBadgeState();
  b.notice(liveMap(['alpha', 'sub1', 4]));
  b.arm(); // operator looks away

  // Same requests count: watched, ran nothing since. No badge.
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', 4])), []);
  // Advanced past the snapshot: took a turn while away.
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', 5])), ['alpha sub1']);
  // Still at most once per away-period, however many more requests land.
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', 9])), []);
});

// The second shipped defect: a sub first seen WHILE WATCHING must not be locked
// out of badging forever. `arm` clears `notified`, so the next away-period is a
// fresh verdict for it.
test('a sub first seen while watching can still badge in a later away-period', () => {
  const b = createBadgeState();
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', 2])), ['alpha sub1']);
  b.arm();
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', 2])), []);
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', 3])), ['alpha sub1']);
  b.arm();
  // A second away-period, and the sub is eligible again rather than notified-for-life.
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', 4])), ['alpha sub1']);
});

// `arm` snapshots lastReq rather than counting from zero. If it counted from
// zero, every sub with any requests at all would badge on the next observation.
test('arm snapshots the newest requests seen, so watched turns do not badge later', () => {
  const b = createBadgeState();
  b.notice(liveMap(['alpha', 'sub1', 1]));
  b.notice(liveMap(['alpha', 'sub1', 7])); // turns the operator watched happen
  b.arm();
  assert.deepStrictEqual(b.snapshot().awayReq, { 'alpha sub1': 7 });
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', 7])), []);
});

// The away-period is the unit, not the window: several hide/show cycles with a
// steadily-advancing sub badge once per period, not once ever and not per turn.
test('the away-period is the unit — one badge per period, per sub', () => {
  const b = createBadgeState();
  const badges = [];
  let req = 0;
  for (let period = 0; period < 3; period++) {
    b.arm();
    req += 2;
    badges.push(b.notice(liveMap(['alpha', 'sub1', req])));
    badges.push(b.notice(liveMap(['alpha', 'sub1', req]))); // idle re-poll
  }
  assert.deepStrictEqual(badges, [
    ['alpha sub1'], [],
    ['alpha sub1'], [],
    ['alpha sub1'], [],
  ]);
});

// `requests` is null on the wire for some subs. Such a sub can never be counted
// for advance, so it badges on appearance only — never on a later poll.
test('a sub with no requests count badges on appearance and never advances', () => {
  const b = createBadgeState();
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', null])), ['alpha sub1']);
  b.arm();
  // Nothing was ever written to lastReq, so it is absent from the snapshot —
  // which makes it "fresh" again rather than stuck. That is the honest answer
  // for a sub whose activity we cannot measure.
  assert.deepStrictEqual(b.snapshot().awayReq, {});
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', null])), ['alpha sub1']);
});

// A non-numeric requests value must not be treated as a count: `undefined > 4`
// is false but `NaN` arithmetic elsewhere is legal and silent.
test('a non-numeric requests value is treated as absent, not as a count', () => {
  const b = createBadgeState();
  b.notice(liveMap(['alpha', 'sub1', 4]));
  b.arm();
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', 'lots'])), []);
  // The bogus value was not written over the good one.
  assert.deepStrictEqual(b.snapshot().lastReq, { 'alpha sub1': 4 });
});

// A requests count that goes BACKWARDS (a sub restarted under the same key, a
// payload from a re-linked proxy) is not an advance.
test('requests going backwards is not an advance', () => {
  const b = createBadgeState();
  b.notice(liveMap(['alpha', 'sub1', 9]));
  b.arm();
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', 3])), []);
});

test('several subs each badge on their own, in payload-iteration order', () => {
  const b = createBadgeState();
  assert.deepStrictEqual(
    b.notice(liveMap(['alpha', 'sub1', 1], ['beta', 'sub2', 1], ['alpha', 'sub2', 1])),
    ['alpha sub1', 'beta sub2', 'alpha sub2'],
  );
  b.arm();
  // Only the one that advanced.
  assert.deepStrictEqual(
    b.notice(liveMap(['alpha', 'sub1', 1], ['beta', 'sub2', 5], ['alpha', 'sub2', 1])),
    ['beta sub2'],
  );
});

// --- chip-order stamps ------------------------------------------------------

test('stamps are assigned in first-observation order and never renumbered', () => {
  const b = createBadgeState();
  b.notice(liveMap(['alpha', 'sub1', 1]));
  b.notice(liveMap(['beta', 'sub1', 1], ['alpha', 'sub1', 1]));
  assert.deepStrictEqual(b.snapshot().firstSeen, { 'alpha sub1': 1, 'beta sub1': 2 });
  // The wire reorders every poll (recency order); the stamps must not follow.
  b.notice(liveMap(['beta', 'sub1', 2], ['alpha', 'sub1', 2]));
  assert.deepStrictEqual(b.snapshot().firstSeen, { 'alpha sub1': 1, 'beta sub1': 2 });
});

test('stamp is idempotent and returns the existing stamp', () => {
  const b = createBadgeState();
  assert.strictEqual(b.stamp('alpha sub1'), 1);
  assert.strictEqual(b.stamp('alpha sub1'), 1);
  assert.strictEqual(b.stamp('beta sub1'), 2);
  assert.strictEqual(b.snapshot().seenSeq, 2);
});

// --- dropParent -------------------------------------------------------------

test('dropParent clears one parent\'s keys and leaves every other parent alone', () => {
  const b = createBadgeState();
  b.notice(liveMap(['alpha', 'sub1', 3], ['beta', 'sub1', 4]));
  b.arm();
  b.notice(liveMap(['alpha', 'sub1', 5], ['beta', 'sub1', 6]));
  b.dropParent('alpha');
  assert.deepStrictEqual(b.snapshot(), {
    notified: ['beta sub1'],
    lastReq: { 'beta sub1': 6 },
    awayReq: { 'beta sub1': 4 },
    firstSeen: { 'beta sub1': 2 },
    // NOT rewound: reusing a stamp would place a future chip in a dead one's slot.
    seenSeq: 2,
  });
});

test('dropParent does not rewind seenSeq, so a later sub never reuses a dead slot', () => {
  const b = createBadgeState();
  b.notice(liveMap(['alpha', 'sub1', 1], ['alpha', 'sub2', 1]));
  b.dropParent('alpha');
  b.notice(liveMap(['gamma', 'sub1', 1]));
  assert.deepStrictEqual(b.snapshot().firstSeen, { 'gamma sub1': 3 });
});

// The separator is what makes the prefix match exact rather than a guess, and
// session names cannot contain a space. A parent whose name is a PREFIX of
// another must not take its keys down with it.
test('dropParent matches on the whole name, not a bare prefix', () => {
  const b = createBadgeState();
  b.notice(liveMap(['alpha', 'sub1', 1], ['alpha-two', 'sub1', 1]));
  b.dropParent('alpha');
  assert.deepStrictEqual(b.snapshot().notified, ['alpha-two sub1']);
  assert.deepStrictEqual(b.snapshot().lastReq, { 'alpha-two sub1': 1 });
});

test('a dropped parent that comes back is fresh, and badges again', () => {
  const b = createBadgeState();
  b.notice(liveMap(['alpha', 'sub1', 5]));
  b.arm();
  b.dropParent('alpha');
  assert.deepStrictEqual(b.notice(liveMap(['alpha', 'sub1', 5])), ['alpha sub1']);
});

test('feedKeyOf joins parent and child with the one separator names cannot contain', () => {
  assert.strictEqual(feedKeyOf('alpha', 'sub1'), 'alpha sub1');
  assert.strictEqual(feedKeyOf('a.b-c_d', 'agent-7'), 'a.b-c_d agent-7');
});
