// Run: node --test
// Covers meta-tiers: the tier table and mergeMeta, the seam that lets a
// sidebar-meta refresh say WHICH questions it asked. Both failure polarities
// this exists to close are pinned here, each with a control — they are opposite
// readings of the same ambiguity, so a fix for one can reintroduce the other.
const { test } = require('node:test');
const assert = require('node:assert');
const { META_TIERS, mergeMeta } = require('../meta-tiers');

test('META_TIERS: the PR keys are one tier, separate from activity', () => {
  assert.deepStrictEqual(META_TIERS, {
    activity: ['lastActivityTs'],
    pr: ['branch', 'prState', 'prNumber'],
  });
});

// ── Polarity 1: a null-filled key read as news ──────────────────────────────
// The shipped defect. The 30s tier does not ask git/gh anything, so whatever it
// says about the PR is filler; a spread merge could not tell that from an
// answer, and the chip painted at boot then vanished forever at the first tick.
test('mergeMeta: an unclaimed tier leaves the expensive tier\'s answer alone', () => {
  const boot = { lastActivityTs: 100, branch: 'master', prState: 'open', prNumber: 7 };

  // CONTROL: the same merge, with the PR tier CLAIMED and carrying null — the
  // "gh is not installed" answer — really does land. Without this the assertion
  // below passes on a mergeMeta that ignores incoming PR keys unconditionally,
  // which would pin the chip on instead of pinning it correct.
  const claimedNull = mergeMeta(boot, {
    _tiers: ['activity', 'pr'], lastActivityTs: 200, branch: null, prState: null, prNumber: null,
  });
  assert.strictEqual(claimedNull.prState, null, 'CONTROL: a CLAIMED null overwrites the answer');

  const fast = mergeMeta(boot, { _tiers: ['activity'], lastActivityTs: 200 });
  assert.strictEqual(fast.prState, 'open', 'the boot tier\'s PR answer survives the cheap refresh');
  assert.strictEqual(fast.prNumber, 7);
  assert.strictEqual(fast.branch, 'master');
  assert.strictEqual(fast.lastActivityTs, 200, 'ENTER: the cheap tier\'s own key really did update');
});

// A fast-tier payload that still carries filler nulls must not be able to wipe
// the answer either: the tier marker, not the key's presence, is what decides.
// This is the shape an older/looser producer sends, and the whole point of the
// marker is that the consumer stops trusting presence.
test('mergeMeta: unclaimed keys are dropped even when the payload spells them out', () => {
  const boot = { branch: 'master', prState: 'open', prNumber: 7 };
  const merged = mergeMeta(boot, { _tiers: ['activity'], lastActivityTs: 200, prState: null });
  assert.strictEqual(merged.prState, 'open',
    'presence in the payload is not authority — only a claimed tier is');
});

// ── Polarity 2: an omitted key read as unchanged ────────────────────────────
// t189's noWire and t190's MF2. The claimed tier is the last word on all of its
// keys, so a key the producer stopped sending must land as ABSENT, not stale.
test('mergeMeta: a claimed tier clears the keys it no longer reports', () => {
  const cached = { lastActivityTs: 100, branch: 'feature', prState: 'open', prNumber: 7 };
  const merged = mergeMeta(cached, { _tiers: ['pr'], prState: 'none' });

  // CONTROL: an UNclaimed tier's key of the same shape is untouched by the same
  // merge. Without it, "branch is gone" passes on a mergeMeta that wipes
  // everything it was not handed.
  assert.strictEqual(merged.lastActivityTs, 100, 'CONTROL: the unclaimed tier is preserved');

  assert.ok(!('branch' in merged),
    'a key omitted from a CLAIMED tier is absent, not stale — the shape that left a '
    + 'revoked grant painted for the life of the window');
  assert.ok(!('prNumber' in merged));
  assert.strictEqual(merged.prState, 'none', 'ENTER: the pr tier really did apply');
});

test('mergeMeta: keys in no tier keep plain-spread semantics', () => {
  const cached = { team: 'clodex', createdAt: 1, pluginGrants: ['scoped:turns'] };
  const merged = mergeMeta(cached, { _tiers: ['activity', 'pr'], lastActivityTs: 5, pluginGrants: [] });
  assert.deepStrictEqual(merged.pluginGrants, [], 'an untiered key still overwrites');
  assert.strictEqual(merged.team, 'clodex', 'and an untiered key the payload omits is kept');
  assert.strictEqual(merged.createdAt, 1);
});

// A payload with no marker claims nothing. That is what an older main process
// across a peer or web connection sends, and it must degrade to the old spread
// rather than start deleting the keys it never learned to claim.
test('mergeMeta: an unmarked payload is a plain spread, deleting nothing', () => {
  const cached = { branch: 'master', prState: 'open', lastActivityTs: 100 };
  const merged = mergeMeta(cached, { lastActivityTs: 200, prState: 'merged' });
  assert.deepStrictEqual(merged, { branch: 'master', prState: 'merged', lastActivityTs: 200 });
});

// The partial-marker shapes. Both are safe by construction today — and that is
// the reason to pin them: the reasoning that an empty or unknown claim cannot
// delete anything is exactly the reasoning a later refactor would quietly break.
test('mergeMeta: an empty claim deletes nothing, and still drops tiered payload keys', () => {
  const cached = { branch: 'master', prState: 'open', lastActivityTs: 100 };
  const merged = mergeMeta(cached, { _tiers: [], prState: 'merged', team: 'clodex' });
  assert.strictEqual(merged.prState, 'open', 'claiming nothing authorizes nothing');
  assert.strictEqual(merged.branch, 'master');
  assert.strictEqual(merged.lastActivityTs, 100);
  assert.strictEqual(merged.team, 'clodex', 'ENTER: the merge ran — the untiered key landed');
});

test('mergeMeta: an unknown tier is inert, not a crash and not a wipe', () => {
  const cached = { branch: 'master', prState: 'open', lastActivityTs: 100 };
  const merged = mergeMeta(cached, { _tiers: ['bogus'], team: 'clodex' });
  assert.deepStrictEqual(merged,
    { branch: 'master', prState: 'open', lastActivityTs: 100, team: 'clodex' });

  // A prototype key is the same case wearing a truthy value: a bare
  // META_TIERS[tier] lookup returns a non-iterable function, and the TypeError
  // is swallowed whole by refreshSidebarMeta's bare `catch {}` — the row would
  // then miss every later refresh with nothing logged anywhere.
  assert.doesNotThrow(() => mergeMeta(cached, { _tiers: ['constructor'] }));
  assert.deepStrictEqual(mergeMeta(cached, { _tiers: ['constructor'] }), cached);
});

test('mergeMeta: the marker never reaches the stored row, and prev is not mutated', () => {
  const cached = { prState: 'open' };
  const merged = mergeMeta(cached, { _tiers: ['activity'], lastActivityTs: 5 });
  assert.ok(!('_tiers' in merged), '_tiers is merge metadata, not sidebar meta');
  assert.deepStrictEqual(cached, { prState: 'open' }, 'the cached row is not mutated in place');
  assert.deepStrictEqual(mergeMeta(undefined, { _tiers: ['pr'], prState: 'none' }), { prState: 'none' });
});
