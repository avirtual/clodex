'use strict';

// pending-store: layer-3 delivery parking. Verifies the zero-loss, order-
// preserving, single-delivery guarantees the DM channel needs (unlike the
// lossy ack channel). No CLI required — pure fs behavior.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parkDelivery, drainPending, hasPending, hasActivePending, countPending, peekPending, allParkedTexts, parkIdInUse, claimParkedById, agentDir } = require('../pending-store');

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

// The fifth member of the blank-preview family t390 closed at three sites. A dm
// written as `[agent:dm x]` with its body on FOLLOWING lines parks as
// `[agent:from x] \nbody`, so the old `split('\n')[0]` previewed line 0 — which
// is empty — and the sidebar rendered its `|| '(no preview)'` fallback over a
// body that was present and previewable the whole time.
test('peekPending previews a following-lines body by its first REAL line', () => {
  const root = tmpRoot();
  const PARKED = '[agent:from bob] \nthe real first line\nand a second';
  parkDelivery(root, 'a', PARKED, '0001');

  // ENTER: the defect is invisible unless the body actually reached the store
  // on following lines. A subject that parked nothing, or parked a body the
  // greedy assembler flattened, makes an empty snippet the CORRECT answer and
  // vacuums the assertion below.
  assert.deepStrictEqual(allParkedTexts(root), [PARKED],
    'ENTER: the parked record carries its following-lines body intact');
  assert.strictEqual(PARKED.split('\n')[0], '[agent:from bob] ',
    'ENTER: line 0 after the prefix is empty — this is the discriminating shape');

  assert.deepStrictEqual(peekPending(root, 'a'),
    [{ from: 'bob', snippet: 'the real first line' }]);
});

// Where the off-by-one lives: previewLine is called with no max, so the ellipsis
// budget is spent here and nowhere else. slice(snipLen) instead of
// slice(snipLen - 1) overruns by the width of the '…' it just made room for.
test('peekPending ellipsizes a long following-lines body within snipLen', () => {
  const root = tmpRoot();
  const long = 'y'.repeat(200);
  const PARKED = `[agent:from bob] \n${long}`;
  parkDelivery(root, 'a', PARKED, '0001');

  assert.deepStrictEqual(allParkedTexts(root), [PARKED],
    'ENTER: the long body parked on a following line, not on the intent line');

  const out = peekPending(root, 'a', { snipLen: 60 });
  assert.deepStrictEqual(out, [{ from: 'bob', snippet: `${'y'.repeat(59)}…` }]);
  assert.strictEqual(out[0].snippet.length, 60,
    'the ellipsis is paid for out of snipLen, not added on top of it');
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

// --- generation stamps (`born`): whose mail is this? ---
//
// The store is keyed by NAME and a name outlives the session holding it, so a
// claim can turn up mail addressed to a different generation. Each entry carries
// its addressee's createdAt; each drain passes its own.
//
// WHY EVERY TEST BELOW ASSERTS THE STORE, NOT JUST THE RETURN VALUE. "Not
// delivered" has two very different implementations — dropped and put back — and
// the return value cannot tell them apart. A product that destroyed every
// non-matching entry would satisfy every "the successor's mail was not returned"
// assertion while committing exactly the data loss the stamp exists to prevent.
// So discard and put-back are pinned as a PAIR, each checking both the returned
// texts and what survives on disk: discard is trivially satisfied by destroying
// everything, put-back is trivially satisfied by destroying nothing, and only
// asserting both makes either one mean anything. Same move as the mint/preserve
// pair in test/createdat-restart.test.js.

const T1 = 1700000000000;      // a predecessor's birth
const T2 = 1700000009999;      // the current generation's
const T3 = 1700000099999;      // a successor's

test('generation: a PREDECESSOR\'s mail is discarded, not handed to the successor', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'mail for the dead seat', '0001', null, false, T1);
  const out = drainPending(root, 'a', 't', T2);
  assert.deepStrictEqual(out, [], 'a new seat must not inherit its predecessor\'s mail');
  // The other half: discarded means GONE, not quietly restored. Without this the
  // assertion above is also satisfied by a product that puts everything back,
  // which would loop the same stale mail forever.
  assert.strictEqual(hasPending(root, 'a'), false,
    'the predecessor\'s entry should be consumed and dropped — a restore here would re-offer it on every subsequent drain, forever');
});

test('generation: a SUCCESSOR\'s mail is PUT BACK — refusing without restoring would destroy it', () => {
  const root = tmpRoot();
  // I am the stale drainer: a hook subprocess descheduled across its parent's
  // death and the next create(). The entry is addressed to the seat that now
  // holds this name; it is not mine to consume.
  parkDelivery(root, 'a', 'mail for the seat that replaced me', '0001', null, false, T3);
  const out = drainPending(root, 'a', 't', T2);
  assert.deepStrictEqual(out, [], 'a stale drainer must not deliver its successor\'s mail into a dead session');
  // THE POINT OF THE BRANCH. drainPending's claim RENAMES THE WHOLE DIRECTORY
  // before reading a single byte, so by the time the generation check runs the
  // message exists nowhere else. An entry the drain declines to return and
  // declines to restore is not "left for the right reader" — it is DESTROYED,
  // and destroyed in exactly the race the stamp was added to survive. That is
  // why "refuse non-matching", which reads like the symmetric conservative
  // choice, is not: symmetric-looking guards are not symmetric when the
  // operation they guard is destructive.
  assert.strictEqual(hasPending(root, 'a'), true,
    'the successor\'s message must be back in the store: the claim already destroyed the original, so declining to return it WITHOUT restoring it loses the message outright — the exact loss this stamp exists to prevent');
  assert.deepStrictEqual(drainPending(root, 'a', 't', T3), ['mail for the seat that replaced me'],
    'and the seat it was addressed to must still be able to read it');
});

test('generation: an entry stamped for THIS drainer is delivered', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'mine', '0001', null, false, T2);
  assert.deepStrictEqual(drainPending(root, 'a', 't', T2), ['mine'],
    'a matching stamp must DELIVER — the discard/put-back branches must not be reachable for a seat\'s own mail, or the store never delivers anything again');
});

test('generation: one claim partitions a mixed batch three ways, in order', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'predecessor', '0001', null, false, T1);
  parkDelivery(root, 'a', 'mine 1', '0002', null, false, T2);
  parkDelivery(root, 'a', 'successor', '0003', null, false, T3);
  parkDelivery(root, 'a', 'mine 2', '0004', null, false, T2);
  assert.deepStrictEqual(drainPending(root, 'a', 't', T2), ['mine 1', 'mine 2'],
    'only this generation\'s mail, still in arrival order');
  // Exactly one file survives — the successor's. Counting pins BOTH directions
  // at once: 0 would mean the successor's was destroyed, 2 would mean the
  // predecessor's was restored alongside it.
  assert.strictEqual(countPending(root, 'a'), 1,
    'exactly one file survives the claim — 0 means the successor\'s message was destroyed, 2 means the dead predecessor\'s was restored alongside it');
  assert.deepStrictEqual(drainPending(root, 'a', 't', T3), ['successor'],
    'and the survivor is readable by the generation it was addressed to (a restore that corrupted the payload would still leave a file here)');
});

test('generation: an UNSTAMPED entry is delivered even to a drainer that has an expectation', () => {
  const root = tmpRoot();
  // Parked by a build that predates the stamp: its generation is unknowable, so
  // there is nothing to compare and dropping it would destroy real mail to
  // enforce a rule its sender never played by. The expectation below is a REAL
  // number — without that this test would just be the no-expectation case again.
  parkDelivery(root, 'a', 'parked before the stamp existed', '0001');
  assert.strictEqual(fs.readdirSync(agentDir(root, 'a'))
    .some((f) => JSON.parse(fs.readFileSync(path.join(agentDir(root, 'a'), f), 'utf8')).born !== undefined),
    false, 'precondition: the park really is unstamped');
  assert.deepStrictEqual(drainPending(root, 'a', 't', T2), ['parked before the stamp existed']);
});

test('generation: NO expectation delivers everything — the safe default, mirroring mint=false', () => {
  const root = tmpRoot();
  // Both entries are STAMPED, and neither matches the other, so the only thing
  // standing between them and a drop is the omitted-expectation default. An
  // unstamped fixture here would pass no matter what that default did.
  parkDelivery(root, 'a', 'from one generation', '0001', null, false, T1);
  parkDelivery(root, 'a', 'from another', '0002', null, false, T3);
  assert.deepStrictEqual(drainPending(root, 'a', 't'), ['from one generation', 'from another'],
    'a caller that passes no stamp must never silently drop mail');
});

test('generation: a restored entry keeps its original filename, so seq order and the resend id survive', () => {
  const root = tmpRoot();
  parkDelivery(root, 'a', 'first, held', '1736900000000.000000001', 'ab12c', false, T3);
  parkDelivery(root, 'a', 'second', '1736900000000.000000002', null, false, T3);
  drainPending(root, 'a', 'stale', T2);          // stale drainer: puts both back
  // Named by their ORIGINAL basenames, not re-minted ones: the seq prefix is what
  // the next drain sorts on, and the id segment is what [agent:resend] resolves.
  // A restore that re-parked under a fresh seq would silently reorder the queue
  // and strand the advertised handle.
  assert.deepStrictEqual(fs.readdirSync(agentDir(root, 'a')).sort(),
    ['1736900000000.000000001.ab12c.json', '1736900000000.000000002.json']);
  // Asserted through the PRODUCT'S OWN readers rather than my reading of the
  // filenames: order from drainPending, the handle from claimParkedById.
  assert.strictEqual(claimParkedById(root, 'ab12c').text, 'first, held',
    'the resend handle still resolves after the round trip — a restore under a re-minted filename would strand the id the sender was told to use');
  assert.deepStrictEqual(drainPending(root, 'a', 't', T3), ['second'],
    'and the remaining entry drains in its original seq position');
});
