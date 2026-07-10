// Run: node --test
// Covers the clodex-paths grammar: pathFor for every kind, runDirFor, the
// unknown-kind guard, and the legacy-suffix helpers the one-time sweep consumes.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  KINDS, LEGACY_SUFFIXES, runDirFor, pathFor, legacyPathsFor, legacySuffixes,
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

test('pathFor: 18 per-agent kinds are defined', () => {
  assert.strictEqual(Object.keys(KINDS).length, 18);
  // every kind has a matching legacy suffix (the sweep depends on the pairing)
  assert.deepStrictEqual(Object.keys(KINDS).sort(), Object.keys(LEGACY_SUFFIXES).sort());
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
