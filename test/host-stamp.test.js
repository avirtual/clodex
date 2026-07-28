'use strict';
// host-stamp.test.js — the stale-host signal (t93).
//
// WHAT THIS GUARDS. The main process serves the modules it loaded at boot,
// indefinitely; a fix merged under a running host is inert until restart. The
// signal that says so is only worth having if it can tell the two states APART,
// so every test below drives BOTH outcomes — a fresh host and a stale one. A
// check that reads the same either way would prove nothing, which is the whole
// reason this ticket exists.
//
// The other half is the quiet-when-fresh design. t79 says silence is a failure
// mode; t82 says a NOTE on every dispatch trains the lead to ignore the ones
// that matter. Both hold here only because staleness is rare and binary, so the
// "says NOTHING when fresh" assertions are load-bearing, not politeness.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  computeModuleDigest, isStale, writeHostStamp, readHostStamp, staleNotice,
} = require('../host-stamp');

const REPO = path.join(__dirname, '..');

// A throwaway source tree. mtimes are set EXPLICITLY everywhere it matters:
// two writes inside the same filesystem-timestamp granularity can otherwise
// produce identical stats, which would make a "digest changed" test flaky in
// exactly the direction that hides a real failure.
function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-hs-'));
  const src = path.join(root, 'src');
  const run = path.join(root, 'run');
  fs.mkdirSync(src); fs.mkdirSync(run);
  fs.writeFileSync(path.join(src, 'alpha.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(src, 'beta.js'), 'module.exports = 2;');
  return { root, src, run };
}

const touch = (file, whenMs) => fs.utimesSync(file, new Date(whenMs), new Date(whenMs));

test('isStale: the two states are distinguishable — this is THE check', () => {
  // If these two lines ever agree, the entire signal is decorative.
  assert.strictEqual(isStale('digest-A', 'digest-A'), false, 'same code loaded as is on disk = fresh');
  assert.strictEqual(isStale('digest-A', 'digest-B'), true, 'different code on disk = stale');
});

test('isStale: FAILS CLOSED to fresh when either side is unknown', () => {
  // A notice we cannot substantiate is worse than none: it trains the reader to
  // ignore the real ones (the t82 lesson about a NOTE on every dispatch). So an
  // unreadable tree or a missing stamp must never read as stale.
  assert.strictEqual(isStale(null, 'digest-B'), false, 'no boot stamp (host predates t93) is not evidence of staleness');
  assert.strictEqual(isStale('digest-A', null), false, 'unreadable source dir is not evidence either');
  assert.strictEqual(isStale(null, null), false);
  assert.strictEqual(isStale('', 'digest-B'), false, 'empty digest is unknown, not different');
  assert.strictEqual(isStale('digest-A', ''), false);
});

test('computeModuleDigest: changes when a watched module changes, both by mtime and by size', () => {
  const { root, src } = mkTree();
  const before = computeModuleDigest(src);
  assert.ok(before, 'ENTER: the tree produced a digest at all');

  // mtime alone (same bytes, same size) — this is the merge case: git rewrites
  // a file whose length happens to be unchanged.
  touch(path.join(src, 'alpha.js'), Date.now() + 60_000);
  const afterTouch = computeModuleDigest(src);
  assert.notStrictEqual(afterTouch, before, 'a same-size edit must still register');

  // size (different bytes)
  fs.writeFileSync(path.join(src, 'beta.js'), 'module.exports = 2; // grown');
  const afterGrow = computeModuleDigest(src);
  assert.notStrictEqual(afterGrow, afterTouch, 'a length change must register');
  fs.rmSync(root, { recursive: true, force: true });
});

test('computeModuleDigest: subdirectory churn is not host staleness', () => {
  const { root, src } = mkTree();
  const before = computeModuleDigest(src);
  // Editing tests or the renderer does not change what the MAIN PROCESS loaded,
  // so it must not raise a restart notice — noise here would be constant. The
  // mechanism is scope, not an ignore list: subdirectories are never descended.
  for (const dir of ['test', 'renderer', 'node_modules', 'docs', 'tasks']) {
    fs.mkdirSync(path.join(src, dir), { recursive: true });
    fs.writeFileSync(path.join(src, dir, 'thing.js'), 'module.exports = 3;');
  }
  assert.strictEqual(computeModuleDigest(src), before,
    'churn below the top level must not read as a stale host');
  assert.ok(!before.includes('thing.js'), 'and their files are not in the digest at all');
  fs.rmSync(root, { recursive: true, force: true });
});

test('computeModuleDigest: unreadable dir returns null (cannot tell), not a bogus digest', () => {
  assert.strictEqual(computeModuleDigest(path.join(os.tmpdir(), 'clodex-does-not-exist-93')), null);
});

test('writeHostStamp/readHostStamp: roundtrip, and null on missing or corrupt', () => {
  const { root, src, run } = mkTree();
  const stamp = writeHostStamp(run, src, { pid: 4242, now: 1_700_000_000_000 });
  assert.ok(stamp, 'ENTER: the stamp was written');
  assert.strictEqual(stamp.pid, 4242);
  assert.strictEqual(stamp.dir, src, 'the stamp records WHICH tree it digested, so the reader can re-digest it');

  const back = readHostStamp(run);
  assert.strictEqual(back.digest, stamp.digest, 'roundtrips through disk');
  assert.strictEqual(back.bootedAt, 1_700_000_000_000);

  assert.strictEqual(readHostStamp(path.join(root, 'nope')), null, 'missing stamp = null');
  fs.writeFileSync(path.join(run, '.host.json'), '{not json');
  assert.strictEqual(readHostStamp(run), null, 'corrupt stamp = null, never a throw');
  fs.rmSync(root, { recursive: true, force: true });
});

test('staleNotice: SILENT on a fresh host — the happy path says nothing at all', () => {
  const { root, src, run } = mkTree();
  writeHostStamp(run, src, { pid: 7, now: Date.now() });
  assert.strictEqual(staleNotice(readHostStamp(run), computeModuleDigest(src)), null,
    'a fresh host must produce NO notice: a note on every reply trains the lead to ignore them');
  fs.rmSync(root, { recursive: true, force: true });
});

test('staleNotice: SPEAKS on a stale host, naming the pid, the age, and the consequence', () => {
  const { root, src, run } = mkTree();
  const bootedAt = Date.now() - 3 * 60 * 60 * 1000;
  writeHostStamp(run, src, { pid: 55910, now: bootedAt });
  // The merge happens AFTER boot — exactly the observed incident.
  touch(path.join(src, 'alpha.js'), Date.now() + 60_000);

  const notice = staleNotice(readHostStamp(run), computeModuleDigest(src));
  assert.ok(notice, 'ENTER: the host is stale and the notice fired');
  assert.match(notice, /55910/, 'names the pid, so the reader can tell WHICH process to restart');
  assert.match(notice, /3h/, 'names the age — an 8h-old host is a different story from a 2m-old one');
  assert.match(notice, /restart/i, 'and says what to DO; a notice that only states a fact gets skimmed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('staleNotice: no stamp means silence, not a guess', () => {
  assert.strictEqual(staleNotice(null, 'digest-B'), null, 'a host older than this feature reports nothing');
  assert.strictEqual(staleNotice({ pid: 1, digest: 'x' }, null), null, 'and an unreadable tree reports nothing');
});

// ── The parity pin ──────────────────────────────────────────────────────────
// scripts/clodex-team.js DUPLICATES the digest grammar, because it is flat-copied
// into run/bin/ and may require node builtins only (same reason TICKET_FILTERS is
// duplicated there). Duplication is the right call, but it has one failure mode
// that is worse than the bug this ticket fixes: if the two grammars drift by a
// single file, the exec surface reports STALE permanently, on every invocation,
// forever. A notice that is always on is worse than no notice at all — it is the
// t82 failure taken to its limit.
//
// So this test runs BOTH implementations against the SAME real directory and
// demands identical output. It is the highest-value test in this file.
test('digest parity: the clodex-team copy and host-stamp agree exactly', () => {
  const leafSrc = fs.readFileSync(path.join(REPO, 'scripts', 'clodex-team.js'), 'utf8');
  const start = leafSrc.indexOf('function hostModuleDigest');
  const end = leafSrc.indexOf('function staleHostLine');
  assert.ok(start > 0 && end > start, 'ENTER: found the duplicated digest block in the leaf script');
  const leafDigest = new Function('fs', 'path', `${leafSrc.slice(start, end)}\nreturn hostModuleDigest;`)(fs, path);

  // The real repo, not a fixture: the grammars must agree on the tree they will
  // actually be asked about, including whatever files exist today.
  const mine = computeModuleDigest(REPO);
  const theirs = leafDigest(REPO);
  assert.ok(mine && mine.includes('session-manager.js'), 'ENTER: digesting the real main-process tree');
  assert.strictEqual(theirs, mine,
    'the duplicated grammar drifted — the exec surface would now report a PERMANENT false stale');
});

test('digest parity: both copies agree on a tree full of subdirectories', () => {
  const leafSrc = fs.readFileSync(path.join(REPO, 'scripts', 'clodex-team.js'), 'utf8');
  const start = leafSrc.indexOf('function hostModuleDigest');
  const end = leafSrc.indexOf('function staleHostLine');
  const leafDigest = new Function('fs', 'path', `${leafSrc.slice(start, end)}\nreturn hostModuleDigest;`)(fs, path);

  // Parity on the repo alone could hold by luck. This tree makes the scoping
  // rule explicit: subdirectories are never descended, so a module inside one
  // is invisible to BOTH copies no matter what it is called.
  //
  // (An earlier version of this test drove an ignore LIST. A revert proved the
  // list was unreachable — a directory never passes `\.js$` and `test.js` never
  // equals `test` — so it was deleted from both copies as dead code, and this
  // test now pins the rule that actually does the work.)
  const { root, src } = mkTree();
  for (const name of ['test', 'renderer', 'node_modules', 'docs', 'tasks', 'cli', 'scripts', 'web-dist']) {
    fs.mkdirSync(path.join(src, name), { recursive: true });
    fs.writeFileSync(path.join(src, name, 'x.js'), 'module.exports = 0;');
  }
  const mine = computeModuleDigest(src);
  assert.strictEqual(leafDigest(src), mine, 'the two copies must agree on scope, not just on field order');
  assert.ok(!mine.includes('x.js:'), 'nothing inside a subdirectory reaches the digest');
  assert.ok(mine.includes('alpha.js:'), 'ENTER: flat modules DO reach it, so the filter is not rejecting everything');
  fs.rmSync(root, { recursive: true, force: true });
});
