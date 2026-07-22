'use strict';

// pending-store: layer-3 delivery parking. Verifies the zero-loss, order-
// preserving, single-delivery guarantees the DM channel needs (unlike the
// lossy ack channel). No CLI required — pure fs behavior.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parkDelivery, drainPending, hasPending, hasActivePending, countPending, peekPending, parkIdInUse, claimParkedById, agentDir } = require('../pending-store');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pending-test-'));
}

test('park then drain round-trips the text', () => {
  const root = tmpRoot();
  parkDelivery(root, 'alice', '[agent:from bob] hi', '0001');
  const out = drainPending(root, 'alice', 't1');
  assert.deepStrictEqual(out, ['[agent:from bob] hi']);
});

test('drain preserves arrival order (lexical seq sort)', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'first', '1736900000000.000001');
  parkDelivery(root, 'a', 'second', '1736900000000.000002');
  parkDelivery(root, 'a', 'third', '1736900000001.000000');
  assert.deepStrictEqual(drainPending(root, 'a', 't'), ['first', 'second', 'third']);
});

test('drain empties the store — a second drain returns nothing', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'x', '0001');
  assert.deepStrictEqual(drainPending(root, 'a', 't1'), ['x']);
  assert.deepStrictEqual(drainPending(root, 'a', 't2'), []);
});

test('drain of an empty/absent store returns [] (no throw)', () => {
  const root = tmpRoot();
  assert.deepStrictEqual(drainPending(root, 'nobody', 't'), []);
});

test('two concurrent drainers: the atomic claim gives all to one, none double-delivered', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'm1', '0001');
  parkDelivery(root, 'a', 'm2', '0002');
  // Simulate the hook and the cap-fire both draining "at once": whichever
  // renames the dir first wins the whole snapshot; the other gets nothing.
  const first = drainPending(root, 'a', 'hook');
  const second = drainPending(root, 'a', 'cap');
  const all = [...first, ...second].sort();
  assert.deepStrictEqual(all, ['m1', 'm2'], 'every message delivered exactly once');
  assert.ok(first.length === 2 || second.length === 2, 'one drainer got the whole batch');
  assert.ok(first.length === 0 || second.length === 0, 'the other got nothing');
});

test('a message parked after a claim lands in a fresh store and drains next turn', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'early', '0001');
  const first = drainPending(root, 'a', 'hook');   // claims + removes the dir
  parkDelivery(root, 'a', 'late', '0002');          // recreates the dir
  const second = drainPending(root, 'a', 'cap');
  assert.deepStrictEqual(first, ['early']);
  assert.deepStrictEqual(second, ['late']);
});

test('hasPending reflects parked state without claiming', () => {
  const root = tmpRoot();
  assert.equal(hasPending(root, 'a'), false);
  parkDelivery(root, 'a', 'x', '0001');
  assert.equal(hasPending(root, 'a'), true);
  // peek must not consume — a following drain still sees it
  assert.equal(hasPending(root, 'a'), true);
  assert.deepStrictEqual(drainPending(root, 'a', 't'), ['x']);
  assert.equal(hasPending(root, 'a'), false);
});

test('countPending returns the parked count without claiming (drives the ✉ badge)', () => {
  const root = tmpRoot();
  assert.equal(countPending(root, 'a'), 0, 'absent store → 0');
  parkDelivery(root, 'a', 'm1', '0001');
  parkDelivery(root, 'a', 'm2', '0002');
  assert.equal(countPending(root, 'a'), 2);
  // Peek must not consume — a following drain still sees both.
  assert.equal(countPending(root, 'a'), 2);
  assert.deepStrictEqual(drainPending(root, 'a', 't'), ['m1', 'm2']);
  assert.equal(countPending(root, 'a'), 0, 'drained store → 0');
});

test('peekPending returns {from, snippet} per park, in arrival order, without claiming', () => {
  const root = tmpRoot();
  assert.deepStrictEqual(peekPending(root, 'a'), [], 'absent store → []');
  parkDelivery(root, 'a', '[agent:from bob] hi there', '0001');
  parkDelivery(root, 'a', '[agent:from carol] second message', '0002');
  assert.deepStrictEqual(peekPending(root, 'a'), [
    { from: 'bob', snippet: 'hi there' },
    { from: 'carol', snippet: 'second message' },
  ]);
  // Peek is read-only — a following drain still sees both.
  assert.deepStrictEqual(drainPending(root, 'a', 't'), ['[agent:from bob] hi there', '[agent:from carol] second message']);
});

test('peekPending clamps the snippet to a single ellipsized line', () => {
  const root = tmpRoot();
  const long = 'x'.repeat(200);
  parkDelivery(root, 'a', `[agent:from bob] ${long}`, '0001');
  parkDelivery(root, 'a', '[agent:from bob] line one\nline two', '0002');
  const out = peekPending(root, 'a', { snipLen: 60 });
  assert.ok(out[0].snippet.length <= 60, 'snippet clamped');
  assert.ok(out[0].snippet.endsWith('…'), 'ellipsized');
  assert.equal(out[1].snippet, 'line one', 'only the first line');
});

test('peekPending caps the number of entries parsed (max)', () => {
  const root = tmpRoot();
  for (let i = 1; i <= 8; i++) parkDelivery(root, 'a', `[agent:from bob] m${i}`, SEQ(i));
  assert.equal(peekPending(root, 'a').length, 5, 'default max 5');
  assert.equal(peekPending(root, 'a', { max: 3 }).length, 3);
});

test('peekPending falls back to from=? for a non-dm notice (no [agent:from] prefix)', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'a system notice with no sender prefix', '0001');
  assert.deepStrictEqual(peekPending(root, 'a'), [{ from: '?', snippet: 'a system notice with no sender prefix' }]);
});

test('countPending ignores stray .tmp files and the id suffix (counts real parks only)', () => {
  const root = tmpRoot();
  const dir = agentDir(root, 'a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.0001.json.tmp'), '{"text":"half');  // in-flight publish
  parkDelivery(root, 'a', 'whole', '0002');
  parkDelivery(root, 'a', 'tagged', SEQ(3), 'ab12c');                   // id-tagged park
  assert.equal(countPending(root, 'a'), 2, 'two real parks, the .tmp excluded');
});

test('countPending reports 0 while a drain claim is mid-flight (claimed = committed)', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'x', '0001');
  // Simulate the atomic claim without completing it: the agent dir is renamed to
  // a `.draining.` sibling, so countPending's agentDir ENOENTs → 0.
  fs.renameSync(agentDir(root, 'a'), `${agentDir(root, 'a')}.draining.midflight`);
  assert.equal(countPending(root, 'a'), 0);
});

test('a stray .tmp in the store is ignored by drain (never a partial read)', () => {
  const root = tmpRoot();
  const dir = agentDir(root, 'a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.0001.json.tmp'), '{"text":"half');  // simulated in-flight publish
  parkDelivery(root, 'a', 'whole', '0002');
  assert.deepStrictEqual(drainPending(root, 'a', 't'), ['whole']);
});

test('multi-line delivery text survives verbatim', () => {
  const root = tmpRoot();
  const body = '[agent:from bob] line one\nline two\n(reply: start a line with [agent:dm bob])';
  parkDelivery(root, 'a', body, '0001');
  assert.deepStrictEqual(drainPending(root, 'a', 't'), [body]);
});

// --- Resend handle (parked-on-hold escalation) --------------------------------

// Id-matching is STRUCTURAL: an id-tagged basename is `<ts>.<counter>.<id>.json`
// (4 dot-segments), so these parks use the production `<ts>.<counter>` seq shape
// main.js's _nextParkSeq mints (one internal dot) rather than a toy seq — a
// zero-dot seq would collapse the segment count the id-match relies on.
const SEQ = (n) => `1736900000000.${String(n).padStart(9, '0')}`;

test('an id-tagged park still drains normally (drain is oblivious to the id)', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'held', SEQ(1), 'ab12c');
  // The next-turn hook / cap drain reads *.json regardless of the id suffix.
  assert.deepStrictEqual(drainPending(root, 'a', 't'), ['held']);
});

test('claimParkedById finds and removes a parked delivery by id', () => {
  const root = tmpRoot();
  parkDelivery(root, 'alice', '[agent:from bob] hi', SEQ(1), 'xy9z');
  const got = claimParkedById(root, 'xy9z');
  assert.deepStrictEqual(got, { name: 'alice', text: '[agent:from bob] hi' });
  // Consumed: a following drain sees nothing.
  assert.deepStrictEqual(drainPending(root, 'alice', 't'), []);
});

test('claimParkedById searches across all agent stores', () => {
  const root = tmpRoot();
  parkDelivery(root, 'alice', 'for alice', SEQ(1), 'aaa11');
  parkDelivery(root, 'bob', 'for bob', SEQ(1), 'bbb22');
  assert.deepStrictEqual(claimParkedById(root, 'bbb22'), { name: 'bob', text: 'for bob' });
  // alice's park is untouched by bob's claim.
  assert.deepStrictEqual(drainPending(root, 'alice', 't'), ['for alice']);
});

test('claimParkedById returns null for an unknown id (already delivered / bad id)', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'x', SEQ(1), 'real1');
  assert.equal(claimParkedById(root, 'nope9'), null);
  assert.equal(claimParkedById(root, 'real1') !== null, true);
});

// The counter of a NO-id typing-park is a 9-digit run — a valid resend token
// shape. A structural (segment-count) match must NOT let `[agent:resend
// <counter>]` claim an operator-typing park that was never advertised.
test('claimParkedById / parkIdInUse never match a no-id typing-park by its counter', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'typing park', SEQ(7));   // no id → `<ts>.000000007.json`
  assert.equal(parkIdInUse(root, '000000007'), false);
  assert.equal(claimParkedById(root, '000000007'), null);
  // ...and the park is still intact for its normal next-turn drain.
  assert.deepStrictEqual(drainPending(root, 'a', 't'), ['typing park']);
});

test('claim vs whole-dir drain: the message is delivered exactly once', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'once', SEQ(1), 'zzz00');
  // Drain wins first: the whole dir is claimed, so a following resend finds nothing.
  assert.deepStrictEqual(drainPending(root, 'a', 'hook'), ['once']);
  assert.equal(claimParkedById(root, 'zzz00'), null);
});

test('parkIdInUse reflects whether an id is taken, across dirs', () => {
  const root = tmpRoot();
  assert.equal(parkIdInUse(root, 'k7q'), false);
  parkDelivery(root, 'a', 'x', SEQ(1), 'k7q');
  assert.equal(parkIdInUse(root, 'k7q'), true);
  // A different agent's store is searched too.
  parkDelivery(root, 'b', 'y', SEQ(1), 'm3p');
  assert.equal(parkIdInUse(root, 'm3p'), true);
  // Gone once claimed.
  claimParkedById(root, 'k7q');
  assert.equal(parkIdInUse(root, 'k7q'), false);
});

test('re-park under the same id after a claim is findable again (dialog-hold re-park)', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'blocked', SEQ(1), 'dup44');
  const first = claimParkedById(root, 'dup44');
  assert.deepStrictEqual(first, { name: 'a', text: 'blocked' });
  // Target still dialog-held → re-park under the same id.
  parkDelivery(root, 'a', 'blocked', SEQ(2), 'dup44');
  assert.deepStrictEqual(claimParkedById(root, 'dup44'), { name: 'a', text: 'blocked' });
});

// --- passive delivery class (ride-along notifications) ---

test('passive park uses the .passive.json marker and still drains in order', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'tick 1', '1736900000000.000000001', null, true);
  parkDelivery(root, 'a', 'real dm', '1736900000000.000000002');
  const files = fs.readdirSync(agentDir(root, 'a')).sort();
  assert.deepStrictEqual(files, ['1736900000000.000000001.passive.json', '1736900000000.000000002.json']);
  // The drain is oblivious to the marker: both come out, arrival order kept.
  assert.deepStrictEqual(drainPending(root, 'a', 't'), ['tick 1', 'real dm']);
});

test('hasActivePending: false for passive-only, true for mixed, false when empty', () => {
  const root = tmpRoot();
  assert.strictEqual(hasActivePending(root, 'a'), false);
  parkDelivery(root, 'a', 'tick', '0001', null, true);
  assert.strictEqual(hasActivePending(root, 'a'), false);   // passive-only → no turn
  assert.strictEqual(hasPending(root, 'a'), true);          // but not invisible
  parkDelivery(root, 'a', 'dm', '0002');
  assert.strictEqual(hasActivePending(root, 'a'), true);    // an active justifies the claim
  drainPending(root, 'a', 't');
  assert.strictEqual(hasActivePending(root, 'a'), false);
});

test('id-tagged parks are active; the passive marker never matches a minted resend id', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'held dm', '1736900000000.000000001', 'ab12c');
  assert.strictEqual(hasActivePending(root, 'a'), true);
  // Structural guard: a passive filename has "passive" in the id segment slot,
  // which parkFileHasId can only match for the literal id "passive" — minted
  // ids are 5 or 10 chars, so no resend can claim a passive park.
  parkDelivery(root, 'a', 'tick', '1736900000000.000000002', null, true);
  assert.strictEqual(parkIdInUse(root, 'ab12c'), true);
  assert.strictEqual(claimParkedById(root, 'ab12c').text, 'held dm');
});
