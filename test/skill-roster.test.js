'use strict';
// skill-roster.test.js — the roster/scoped classification.
//
// The shipped bug was a `last one wins` that let a DIRECTORY-SCOPED listing
// evict the session's real roster: 22 unreachable names offered, five loaded
// ones gone. Both halves are asserted on every case, because either alone
// passes for a function that solved the other by deleting it.
//
// Fixtures are the real transcript shapes, measured from
// ~/.claude/projects/-Users-bogdan-projects-crypto/df35306d-…jsonl (lines 9 and
// 143): the same attachment keys, and the non-initial record's extra top-level
// `session_id`, which is present because a clean fixture would not have caught
// a parser keying off record shape.

const test = require('node:test');
const assert = require('node:assert');

const { classifySkillRoster, emptyRoster } = require('../skill-roster');

const ROSTER = ['warm-cache', 'dataviz', 'artifact-design', 'artifact-diagramming',
  'artifact-capabilities', 'loop', 'schedule', 'run'];
const SCOPED = ['agentic-macro-read', 'agentic-research', 'assess', 'compare',
  'create-team-skill', 'defi-add', 'defi-fetch', 'defi-scan', 'defi-status',
  'lite-research', 'macro-read', 'market', 'opportunity', 'project', 'read',
  'research', 'rising', 'score', 'signals', 'targets', 'test-team-comms', 'watchlist'];

// The CLI's own bullet shape. Scoped lines carry the `(from …)` suffix; roster
// lines never do.
const bullet = (n, dir) => dir
  ? `- ${n}: does a thing (from ${dir}.claude/skills — applies when working on files under ${dir})`
  : `- ${n}: does a thing`;

function listing(names, { initial, dir = null, extraTop = false } = {}) {
  const rec = {
    parentUuid: 'p-1', isSidechain: false,
    attachment: {
      type: 'skill_listing',
      content: names.map((n) => bullet(n, dir)).join('\n'),
      skillCount: names.length,
      isInitial: initial,
      names,
    },
    type: 'attachment', uuid: 'u-1', timestamp: '2026-08-14T20:00:00.000Z',
    userType: 'external', entrypoint: 'cli', cwd: '/Users/bogdan/projects/crypto',
    sessionId: 'df35306d', version: '2.0.0', gitBranch: 'master',
  };
  // Only the non-initial record carries this; asserted-around, never depended on.
  if (extraTop) rec.session_id = 'df35306d';
  return JSON.stringify(rec);
}

// Non-listing traffic, so the scan is never pointed at a file of pure fixtures.
const NOISE = [
  '',
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  JSON.stringify({ type: 'attachment', attachment: { type: 'todo_list', items: [] } }),
];

const names = (r) => r.outOfScope.map((s) => s.name);

test('initial-only: the roster is the roster, nothing is out of scope', () => {
  const got = classifySkillRoster([...NOISE, listing(ROSTER, { initial: true })]);
  assert.deepStrictEqual(got, { roster: ROSTER, outOfScope: [], sawRoster: true });
});

test('initial then scoped: the measured case — the roster SURVIVES and the 22 are marked', () => {
  const got = classifySkillRoster([
    ...NOISE,
    listing(ROSTER, { initial: true }),
    listing(SCOPED, { initial: false, dir: 'app/', extraTop: true }),
  ]);
  // The half the bug got wrong: every dropped name is back.
  assert.deepStrictEqual(got.roster, ROSTER);
  for (const n of ['warm-cache', 'dataviz', 'artifact-design', 'artifact-diagramming', 'artifact-capabilities']) {
    assert.ok(got.roster.includes(n), `${n} was dropped by the scoped listing`);
  }
  // The other half: present, but NOT silently merged into the roster.
  assert.deepStrictEqual(names(got), [...SCOPED].sort());
  for (const n of SCOPED) assert.ok(!got.roster.includes(n), `${n} must not enter the roster`);
  assert.deepStrictEqual(got.outOfScope, [...SCOPED].sort().map((name) => ({ name, dir: 'app/' })));
  assert.strictEqual(got.sawRoster, true);
});

test('order does not decide: a scoped listing FIRST is still out of scope', () => {
  const got = classifySkillRoster([
    listing(SCOPED, { initial: false, dir: 'app/', extraTop: true }),
    listing(ROSTER, { initial: true }),
  ]);
  assert.deepStrictEqual(got.roster, ROSTER);
  assert.deepStrictEqual(names(got), [...SCOPED].sort());
});

test('scoped-only (§3 fallback): no roster is claimed, and the scoped set stays marked', () => {
  // A /clear'ed or compacted transcript can hold only non-initial listings.
  // Promoting them to the roster IS the shipped bug, so the fallback is an
  // EMPTY roster — the popover falls back to its static seed and says so.
  const got = classifySkillRoster([
    ...NOISE,
    listing(SCOPED, { initial: false, dir: 'app/', extraTop: true }),
  ]);
  assert.deepStrictEqual(got, {
    roster: [],
    outOfScope: [...SCOPED].sort().map((name) => ({ name, dir: 'app/' })),
    sawRoster: false,
  });
});

test('multiple dirs union; a dir RESTATING its set drops what it no longer has', () => {
  const got = classifySkillRoster([
    listing(ROSTER, { initial: true }),
    listing(['assess', 'compare'], { initial: false, dir: 'app/' }),
    listing(['debate-a'], { initial: false, dir: 'debate/' }),
    listing(['research-a'], { initial: false, dir: 'research/' }),
    // app/ re-entered, and `compare` is gone from it.
    listing(['assess'], { initial: false, dir: 'app/' }),
  ]);
  assert.deepStrictEqual(got.roster, ROSTER);
  assert.deepStrictEqual(got.outOfScope, [
    { name: 'assess', dir: 'app/' },
    { name: 'debate-a', dir: 'debate/' },
    { name: 'research-a', dir: 'research/' },
  ]);
  // The staleness half: a name the dir dropped is not offered forever.
  assert.ok(!names(got).includes('compare'));
});

test('§4 staleness: the LAST initial listing wins, so a shrunken roster shrinks', () => {
  // Measured: one real transcript carries isInitial=true count=5 then count=4,
  // with `warm-cache` dropped. Unioning initial listings would offer it forever.
  const got = classifySkillRoster([
    listing(['warm-cache', 'dataviz', 'loop'], { initial: true }),
    listing(['dataviz', 'loop'], { initial: true }),
  ]);
  assert.deepStrictEqual(got, { roster: ['dataviz', 'loop'], outOfScope: [], sawRoster: true });
});

test('a roster listing RECLAIMS a name an earlier scoped listing marked', () => {
  const got = classifySkillRoster([
    listing(['assess'], { initial: false, dir: 'app/' }),
    listing(['assess', 'loop'], { initial: true }),
  ]);
  assert.deepStrictEqual(got, { roster: ['assess', 'loop'], outOfScope: [], sawRoster: true });
});

test('alwaysInScope keeps a seed built-in off the out-of-scope list', () => {
  const got = classifySkillRoster(
    [listing(['run', 'assess'], { initial: false, dir: 'app/' })],
    { alwaysInScope: ['run'] });
  assert.deepStrictEqual(got.outOfScope, [{ name: 'assess', dir: 'app/' }]);
});

test('a scoped listing with no parseable dir is still marked, with a null dir', () => {
  // The dir comes from prose and is decorative; losing it must not silently
  // reclassify the skill as loaded.
  const got = classifySkillRoster([
    listing(ROSTER, { initial: true }),
    listing(['mystery'], { initial: false }),
  ]);
  assert.deepStrictEqual(got.outOfScope, [{ name: 'mystery', dir: null }]);
});

test('a plugin name containing a colon keeps its dir', () => {
  // Bullets cannot be split at the first colon: `tmp:warm-cache` is one real name.
  const got = classifySkillRoster([
    listing(['tmp:warm-cache'], { initial: false, dir: 'app/' }),
  ]);
  assert.deepStrictEqual(got.outOfScope, [{ name: 'tmp:warm-cache', dir: 'app/' }]);
});

test('an absent isInitial counts as roster, not as scoped', () => {
  // An older/other CLI build that omits the field must render as it always did
  // rather than greying out the whole popover.
  const rec = JSON.parse(listing(['a', 'b'], { initial: true }));
  delete rec.attachment.isInitial;
  const got = classifySkillRoster([JSON.stringify(rec)]);
  assert.deepStrictEqual(got, { roster: ['a', 'b'], outOfScope: [], sawRoster: true });
});

test('malformed and irrelevant lines are skipped, not thrown on', () => {
  const got = classifySkillRoster([
    '{ this is not json but mentions skill_listing',
    JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing' } }),          // no names
    JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', names: 'x' } }), // names not an array
    JSON.stringify({ type: 'user', attachment: { type: 'skill_listing', names: ['nope'] } }),  // wrong record type
    null, undefined, 42,
    listing(ROSTER, { initial: true }),
  ]);
  assert.deepStrictEqual(got, { roster: ROSTER, outOfScope: [], sawRoster: true });
});

test('no listing at all => empty, and it is the same shape emptyRoster() returns', () => {
  const got = classifySkillRoster(NOISE);
  assert.deepStrictEqual(got, { roster: [], outOfScope: [], sawRoster: false });
  // engine.js returns emptyRoster() on a read failure; a caller destructuring
  // `.outOfScope` must not have to care which path produced the result.
  assert.deepStrictEqual(emptyRoster(), got);
});

test('accepts a raw string as well as split lines', () => {
  const text = [listing(ROSTER, { initial: true }), listing(SCOPED, { initial: false, dir: 'app/' })].join('\n');
  assert.deepStrictEqual(classifySkillRoster(text), classifySkillRoster(text.split('\n')));
});

test('empty / nullish input does not throw', () => {
  for (const v of [null, undefined, '', []]) {
    assert.deepStrictEqual(classifySkillRoster(v), { roster: [], outOfScope: [], sawRoster: false });
  }
});

// A name that is a colon-prefix of another is not hypothetical: `read` is in the
// measured crypto listing, and a plugin is free to ship `read:extended` beside
// it. Matched shortest-first, the prefix claims the longer name's bullet and the
// longer name goes dirless — so both dirs are asserted, not just the survivor's.
test('a name that prefixes another does not steal its bullet', () => {
  const pair = ['read', 'read:extended'];
  const rec = JSON.stringify({
    type: 'attachment',
    attachment: {
      type: 'skill_listing',
      isInitial: false,
      skillCount: 2,
      names: pair,
      content: [
        `- read: does a thing (from app/.claude/skills — applies when working on files under app/)`,
        `- read:extended: does a thing (from lib/.claude/skills — applies when working on files under lib/)`,
      ].join('\n'),
    },
  });
  const got = classifySkillRoster([rec]);
  assert.deepStrictEqual(got.outOfScope, [
    { name: 'read', dir: 'app/' },
    { name: 'read:extended', dir: 'lib/' },
  ]);
});
