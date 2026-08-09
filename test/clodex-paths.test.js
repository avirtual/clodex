// Run: node --test
// Covers the clodex-paths grammar: pathFor for every kind, runDirFor, the
// unknown-kind guard, and the legacy-suffix helpers the one-time sweep consumes.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  KINDS, LEGACY_SUFFIXES, runDirFor, pathFor, legacyPathsFor, legacySuffixes,
  projectDirFor, taskDirFor,
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

test('pathFor: 23 per-agent kinds are defined', () => {
  assert.strictEqual(Object.keys(KINDS).length, 23);
  // every kind has a matching legacy suffix (the sweep depends on the pairing) —
  // ipcdelta.sh has no flat ancestor but keeps a defensive suffix so the
  // invariant (every kind sweepable) holds.
  assert.deepStrictEqual(Object.keys(KINDS).sort(), Object.keys(LEGACY_SUFFIXES).sort());
});

test('fileHeat is NOT a kind — heat lives outside the rm -rf`d run dir (F003)', () => {
  // The run dir is destroyed on every exit path, so anything with a window
  // longer than one session cannot be a kind. `pathFor` must refuse the name
  // rather than hand back a path that would be swept: a caller that still
  // reaches for the old grammar fails loud instead of silently writing into the
  // dir the fix moved the data out of.
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
