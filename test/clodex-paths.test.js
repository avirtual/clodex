// Run: node --test
// Covers the clodex-paths grammar: pathFor for every kind, runDirFor, the
// unknown-kind guard, and the legacy-suffix helpers the one-time sweep consumes.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const {
  KINDS, LEGACY_SUFFIXES, runDirFor, pathFor, legacyPathsFor, legacySuffixes,
  projectDirFor, taskDirFor, spillDirFor,
  SEAT_KINDS, seatDirFor, seatPathFor, legacySeatPathFor,
} = require('../clodex-paths');

const ROOT = '/root/.clodex';

test('runDirFor: per-agent dir under run/', () => {
  assert.strictEqual(runDirFor(ROOT, 'alice'), path.join(ROOT, 'run', 'alice'));
});

test('pathFor: every kind resolves to run/<name>/<basename>', () => {
  for (const [kind, base] of Object.entries(KINDS)) {
    assert.strictEqual(pathFor(ROOT, 'alice', kind), path.join(ROOT, 'run', 'alice', base));
  }
});

test('pathFor: the three bare forms are unsuffixed', () => {
  assert.strictEqual(path.basename(pathFor(ROOT, 'a', 'transcript')), 'transcript.jsonl');
  assert.strictEqual(path.basename(pathFor(ROOT, 'a', 'registry')), 'agent.json');
  assert.strictEqual(path.basename(pathFor(ROOT, 'a', 'socket')), 'agent.sock');
});

test('pathFor: 30 per-agent kinds are defined', () => {
  assert.strictEqual(Object.keys(KINDS).length, 30);
  // every kind has a matching legacy suffix (the sweep depends on the pairing) —
  // ipcdelta.sh has no flat ancestor but keeps a defensive suffix so the
  // invariant (every kind sweepable) holds.
  assert.deepStrictEqual(Object.keys(KINDS).sort(), Object.keys(LEGACY_SUFFIXES).sort());
});

test('a retired kind name is refused, not silently re-admitted to run/', () => {
  // The run dir is destroyed on every exit path, so anything with a window
  // longer than one session cannot be a kind. `pathFor` must refuse such a name
  // rather than hand back a path that would be swept: a caller reaching for a
  // grammar that was deliberately moved out fails loud instead of silently
  // writing into the dir the data was moved out of. `fileHeat` is the worked
  // example — it WAS a kind, its multi-day window was truncated by the sweep,
  // and it must not come back as one.
  assert.ok(!('fileHeat' in KINDS));
  assert.ok(!('fileHeat' in LEGACY_SUFFIXES));
  assert.throws(() => pathFor(ROOT, 'a', 'fileHeat'), /unknown kind 'fileHeat'/);
});

test('pathFor: unknown kind throws (typo fails loud, not a stray file)', () => {
  assert.throws(() => pathFor(ROOT, 'a', 'nope'), /unknown kind 'nope'/);
});

test('legacyPathsFor: one flat path per suffix, at the root (not run/)', () => {
  const paths = legacyPathsFor(ROOT, 'bob');
  assert.strictEqual(paths.length, Object.keys(LEGACY_SUFFIXES).length);
  // all sit directly under ROOT (the OLD flat grammar), none under run/
  for (const p of paths) {
    assert.strictEqual(path.dirname(p), ROOT);
    assert.ok(path.basename(p).startsWith('bob'));
  }
  assert.ok(paths.includes(path.join(ROOT, 'bob.jsonl')));
  assert.ok(paths.includes(path.join(ROOT, 'bob-hook.sh')));
  assert.ok(paths.includes(path.join(ROOT, 'bob.sock')));
});

test('legacySuffixes: sorted longest-first for greedy owner-derivation', () => {
  const s = legacySuffixes();
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i - 1].length >= s[i].length, `not longest-first at ${i}: ${s[i - 1]} then ${s[i]}`);
  }
  // the ambiguous pair the ordering exists to disambiguate
  assert.ok(s.indexOf('-hook-output.json') < s.indexOf('.json'));
  assert.ok(s.indexOf('-ctxwarn.sh') < s.indexOf('-ctxwarn'));
});

test('projectDirFor: same-leaf checkouts get DIFFERENT dirs', () => {
  // The whole reason the hash exists. Bare leaves collide silently — two
  // checkouts named `api` sharing one artifact dir is a failure with no
  // symptom, so this is the property, not the formatting.
  const a = projectDirFor(ROOT, '/home/x/work/api');
  const b = projectDirFor(ROOT, '/home/x/side/api');
  assert.notStrictEqual(a, b);
  assert.ok(path.basename(a).startsWith('api-'));
  assert.ok(path.basename(b).startsWith('api-'));
  assert.strictEqual(path.dirname(a), path.join(ROOT, 'projects'));
});

test('projectDirFor: stable across calls and trailing-slash/relative spellings', () => {
  const canonical = projectDirFor(ROOT, '/home/x/work/api');
  assert.strictEqual(projectDirFor(ROOT, '/home/x/work/api'), canonical);
  assert.strictEqual(projectDirFor(ROOT, '/home/x/work/api/'), canonical);
  assert.strictEqual(projectDirFor(ROOT, '/home/x/work/./api'), canonical);
  assert.strictEqual(projectDirFor(ROOT, '/home/x/work/sub/../api'), canonical);
});

test('taskDirFor: task artifacts land under the project dir, never in the repo', () => {
  const d = taskDirFor(ROOT, '/home/x/work/api', 'durable-state');
  assert.ok(d.startsWith(path.join(ROOT, 'projects')), d);
  assert.strictEqual(path.basename(d), 'durable-state');
  assert.strictEqual(path.basename(path.dirname(d)), 'tasks');
  // The user's own tree is never a prefix of an artifact path.
  assert.ok(!d.startsWith('/home/x/work/api'), d);
});

test('spillDirFor: a SHARED root dir, deliberately not under run/', () => {
  const d = spillDirFor(ROOT, 'lead');
  assert.strictEqual(d, path.join(ROOT, 'spill', 'lead'));
  assert.ok(!d.startsWith(runDirFor(ROOT, 'lead')), d);
  assert.strictEqual(path.dirname(path.dirname(d)), ROOT);
});

test('spillDirFor is not a KIND, and a spill/ name cannot be reached through pathFor', () => {
  assert.ok(!('spill' in KINDS));
  assert.throws(() => pathFor(ROOT, 'a', 'spill'), /unknown kind 'spill'/);
});

test('seatDirFor: one home per seat under sessions/', () => {
  assert.strictEqual(seatDirFor(ROOT, 'alice'), path.join(ROOT, 'sessions', 'alice'));
});

const SEAT_ROWS = [
  ['messages', '/root/.clodex/sessions/alice/messages', '/root/.clodex/messages/alice'],
  ['notices', '/root/.clodex/sessions/alice/notices', '/root/.clodex/notices/alice'],
  ['promptcache', '/root/.clodex/sessions/alice/promptcache', '/root/.clodex/promptcache/alice'],
  ['memory', '/root/.clodex/sessions/alice/memory', '/root/.clodex/library/memory/alice'],
  ['spill', '/root/.clodex/sessions/alice/spill', '/root/.clodex/spill/alice'],
  ['monitors', '/root/.clodex/sessions/alice/monitors', '/root/.clodex/monitors/alice'],
  ['run', '/root/.clodex/sessions/alice/run', '/root/.clodex/run/alice'],
];

test('seatPathFor / legacySeatPathFor: 7 kinds, both spellings', () => {
  assert.strictEqual(SEAT_ROWS.length, Object.keys(SEAT_KINDS).length);
  for (const [kind, neu, old] of SEAT_ROWS) {
    assert.strictEqual(seatPathFor(ROOT, 'alice', kind), neu, kind);
    assert.strictEqual(legacySeatPathFor(ROOT, 'alice', kind), old, kind);
  }
});

test("legacySeatPathFor('run') and runDirFor agree — the link and the bind path are one", () => {
  assert.strictEqual(
    legacySeatPathFor(ROOT, 'alice', 'run'), runDirFor(ROOT, 'alice'),
    'the socket binds at runDirFor and the migration links at legacySeatPathFor: two spellings '
    + 'that drift leave the socket binding somewhere the link does not cover, with no symptom until a spawn');
});

test('seat kinds: an unknown one throws in BOTH directions, like pathFor', () => {
  assert.throws(() => seatPathFor(ROOT, 'a', 'nope'), /unknown seat kind 'nope'/);
  assert.throws(() => seatPathFor(ROOT, 'a', 'pending'), /unknown seat kind 'pending'/,
    'pending is not a seat kind: it is a transient delivery queue with two rename-claiming '
    + 'drainers, one of them a byte-pinned bash hook body, so it never leaves the shared root');
  assert.throws(() => legacySeatPathFor(ROOT, 'a', 'nope'), /unknown seat kind 'nope'/);
  assert.throws(() => seatPathFor(ROOT, 'a', 'transcript'), /unknown seat kind 'transcript'/,
    'a run/ artifact kind is not a seat kind: the two grammars are separate namespaces');
  assert.throws(() => pathFor(ROOT, 'a', 'messages'), /unknown kind 'messages'/,
    'and a seat kind is not an artifact kind, in the other direction');
});

test('the header names spill/ as a shared dir that outlives run/', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'clodex-paths.js'), 'utf8');
  const header = src.slice(0, src.indexOf("const path = require('path')"));
  const line = header.split('\n').find((l) => /\bspill\//.test(l));
  assert.ok(line, 'spill/ is absent from the shared-dir header');
  assert.match(line, /outlives run\/<name>\//);
});
