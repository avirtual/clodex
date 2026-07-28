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
  changedSince, bootstrapNotice, hostNotice,
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

// ── The stamp-less fallback (t94) ───────────────────────────────────────────
// The bug these guard: everything above needs a stamp, the stamp is written by
// the host AT BOOT, so a host predating the feature has none — and the check
// then went silent on the one host it was built for. Silence read as "fresh".
// So the load-bearing property is that THREE states are distinguishable, and
// the third does not look like the first.

test('the three host states are DISTINGUISHABLE — this is the whole t94 fix', () => {
  const { root, src, run } = mkTree();
  const startedAt = Date.now() - 90 * 60 * 1000;
  const host = { pid: 4242, startedAt, root: src };

  // 1. stamped + matching → silent
  writeHostStamp(run, src, { pid: 4242, now: startedAt });
  const fresh = hostNotice(run, src, host);

  // 2. stamped + drifted → the asserted stale line.
  // Explicit, clearly-later mtime: writing "now" can land in the same
  // filesystem-timestamp tick as mkTree's write, leaving the digest unchanged
  // and the test green for the wrong reason.
  touch(path.join(src, 'alpha.js'), Date.now() + 60_000);
  const stamped = hostNotice(run, src, host);

  // 3. NO stamp, same drifted tree → must still say something
  fs.rmSync(path.join(run, '.host.json'));
  const unstamped = hostNotice(run, src, host);

  assert.strictEqual(fresh, null, 'fresh says nothing');
  assert.ok(stamped, 'ENTER: the stamped path detected the drift');
  assert.ok(unstamped, 'a host with NO stamp must NOT be silent — that silence was the bug');
  assert.notStrictEqual(unstamped, fresh, 'state 3 must be distinguishable from state 1');
  assert.notStrictEqual(unstamped, stamped, 'and it must not impersonate the stamped verdict either');
  fs.rmSync(root, { recursive: true, force: true });
});

test('bootstrapNotice: reports evidence and refuses to claim more than it can prove', () => {
  const { root, src } = mkTree();
  const startedAt = Date.now() - 3 * 60 * 60 * 1000;
  touch(path.join(src, 'alpha.js'), Date.now());

  const notice = bootstrapNotice({ pid: 55910, startedAt, root: src });
  assert.ok(notice, 'ENTER: a module changed after the process started');
  assert.match(notice, /55910/, 'names the pid to restart');
  assert.match(notice, /3h/, 'names the age');
  assert.match(notice, /alpha\.js/, 'names the evidence — WHICH module changed');
  assert.match(notice, /UNCONFIRMED/, 'and states plainly that staleness is not proven');

  // The wording is load-bearing, not cosmetic. require() is lazy: a module
  // edited after boot but before its first require IS live in the host, so
  // "changed since boot" does NOT prove "not loaded". If someone later
  // "tightens" this into an assertion of staleness, it becomes a claim the
  // mechanism cannot support — the t91 failure mode, in the other direction.
  assert.ok(!/^STALE HOST/.test(notice), 'must not assert staleness outright');
  assert.match(notice, /restart/i, 'but still tells the reader what to DO');
  fs.rmSync(root, { recursive: true, force: true });
});

test('bootstrapNotice: SILENT when nothing changed under the host', () => {
  const { root, src } = mkTree();
  // Host started AFTER the files were written: nothing changed underneath it,
  // so this is a genuinely fresh host and silence is the correct answer.
  const notice = bootstrapNotice({ pid: 7, startedAt: Date.now() + 60_000, root: src });
  assert.strictEqual(notice, null, 'no changed module = fresh = say nothing');
  fs.rmSync(root, { recursive: true, force: true });
});

test('bootstrapNotice: "cannot determine" is its OWN state, never silence', () => {
  // The t94 lesson in one assertion: not-knowing must not be rendered as
  // nothing-to-report. Both unreadable-tree and unknown-start-time are
  // legitimately unknowable, and both must SAY so.
  const gone = bootstrapNotice({ pid: 9, startedAt: Date.now() - 1000, root: path.join(os.tmpdir(), 'clodex-nope-94') });
  assert.ok(gone, 'an unreadable tree is not evidence of freshness');
  assert.match(gone, /cannot determine/i);

  const noStart = bootstrapNotice({ pid: 9, startedAt: NaN, root: '/somewhere' });
  assert.ok(noStart, 'an unreadable start time is not evidence of freshness either');
  assert.match(noStart, /cannot determine/i);
});

test('changedSince: same scope as the digest, and it is mtime that drives it', () => {
  const { root, src } = mkTree();
  const t0 = Date.now();
  touch(path.join(src, 'alpha.js'), t0 - 60_000);
  touch(path.join(src, 'beta.js'), t0 + 60_000);
  assert.deepStrictEqual(changedSince(src, t0), ['beta.js'],
    'only the module modified AFTER the cutoff counts');

  // Scope must match computeModuleDigest exactly, or the two surfaces disagree
  // about which files even matter.
  fs.mkdirSync(path.join(src, 'test'), { recursive: true });
  fs.writeFileSync(path.join(src, 'test', 'deep.js'), 'x');
  fs.writeFileSync(path.join(src, 'notes.md'), 'x');
  assert.deepStrictEqual(changedSince(src, t0), ['beta.js'],
    'a subdirectory module and a non-.js file are both out of scope, same as the digest');
  assert.strictEqual(changedSince(path.join(os.tmpdir(), 'clodex-nope-94b'), t0), null,
    'unreadable dir is null (cannot tell), not an empty list (nothing changed)');
  fs.rmSync(root, { recursive: true, force: true });
});

test('hostNotice: a present stamp WINS over the fallback', () => {
  const { root, src, run } = mkTree();
  writeHostStamp(run, src, { pid: 1, now: Date.now() });
  // The stamp says fresh; the fallback would fire, since this host's "start
  // time" is long before the fixture files were written. The stamped answer is
  // the precise one and must take precedence — otherwise every stamped host
  // gets the vaguer UNCONFIRMED line as well.
  const notice = hostNotice(run, src, { pid: 1, startedAt: Date.now() - 86_400_000, root: src });
  assert.strictEqual(notice, null, 'a matching stamp means fresh, full stop');
  fs.rmSync(root, { recursive: true, force: true });
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

// ── The leaf's fallback: parity of BEHAVIOUR, and of what it may claim ───────
// scripts/clodex-team.js duplicates the fallback too, for the same strict-leaf
// reason. Reading its source to check for a phrase would be a containment check
// — the phrase can be present and the logic wrong — so these run the leaf's own
// code and observe what it does.

function leafStaleHostLine(homeDir) {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'clodex-team.js'), 'utf8');
  const start = src.indexOf('function hostModuleDigest');
  const end = src.indexOf('// Mirror of session-manager.js _taskList');
  assert.ok(start > 0 && end > start, 'ENTER: found the leaf stale-host block');
  const humanizeAge = (ms) => {
    const m = Math.round(ms / 60_000);
    return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
  };
  return new Function('fs', 'path', 'CLODEX_HOME', 'humanizeAge', 'process', 'require',
    `${src.slice(start, end)}\nreturn { staleHostLine, staleHostLineFor, liveHost, hostProcess };`,
  )(fs, path, homeDir, humanizeAge, process, require);
}

test('leaf fallback: finds the live host by pid and speaks when modules changed under it', () => {
  const { root, src, run } = mkTree();
  // A registration pointing at THIS test process, whose start time is real and
  // whose argv is a node binary — not an electron/dist path, so `packaged` is
  // the branch under test below. Here we drive the changed-modules branch by
  // handing the leaf a host record directly through its own probe.
  fs.mkdirSync(path.join(run, 'someagent'), { recursive: true });
  fs.writeFileSync(path.join(run, 'someagent', 'agent.json'),
    JSON.stringify({ name: 'someagent', pid: process.pid, cwd: src }));

  const leaf = leafStaleHostLine(root);
  const probed = leaf.hostProcess(process.pid);
  assert.ok(probed, 'ENTER: ps resolved a real running process — the fallback CAN observe a host');
  assert.ok(Number.isFinite(probed.startedAt), 'and parsed its start time');
  assert.ok(probed.startedAt <= Date.now(), 'a start time in the past, not a parse artifact');

  assert.strictEqual(leaf.hostProcess(0), null, 'an invalid pid yields no evidence, never a throw');
  fs.rmSync(root, { recursive: true, force: true });
});

test('leaf fallback: SPEAKS end-to-end on a stamp-less host with changed modules', () => {
  // The whole t94 defect, driven through the leaf's real staleHostLine: a
  // registration pointing at a LIVE process (this one), no .host.json, and
  // modules whose mtime postdates that process. Before t94 this returned ''.
  //
  // This test exists because a revert that deleted the leaf's entire fallback
  // failed NOTHING — the other leaf tests probed hostProcess and the source
  // text, so none of them drove the speaking path.
  const { root, src, run } = mkTree();
  fs.mkdirSync(path.join(run, 'someagent'), { recursive: true });
  fs.writeFileSync(path.join(run, 'someagent', 'agent.json'),
    JSON.stringify({ name: 'someagent', pid: process.pid, cwd: src }));
  // Well past this process's start, and explicitly set so the write cannot land
  // inside the same timestamp tick.
  touch(path.join(src, 'alpha.js'), Date.now() + 60_000);

  const leaf = leafStaleHostLine(root);
  // The real host root is this process's cwd, not the fixture, so point the
  // probe at the fixture tree the way a dev host's argv would.
  const orig = leaf.hostProcess(process.pid);
  assert.ok(orig, 'ENTER: this process is observable via ps');
  const line = leaf.staleHostLineFor({ ...orig, root: src, packaged: false });
  assert.match(line, /MAY BE STALE/, 'a stamp-less host with changed modules must NOT be silent');
  assert.match(line, /alpha\.js/, 'and must name the evidence');
  assert.match(line, /UNCONFIRMED/, 'while saying it is not proven');
  fs.rmSync(root, { recursive: true, force: true });
});

test('leaf fallback: DISCOVERY works end-to-end — registry pid → ps → argv → the line', () => {
  // Everything from a bare registration to the printed line, with no host
  // record handed in. This is the path a revert proved untested: deleting the
  // whole `staleHostLineFor(liveHost())` call failed nothing, because the other
  // tests all supplied the host themselves.
  //
  // A real child process is spawned from a path shaped like a dev host's argv
  // (node_modules/electron/dist/...), because that shape is precisely what the
  // discovery regex reads to find the app root. Faking it would test the fake.
  const { root, run } = mkTree();
  const appRoot = path.join(root, 'app');
  const binDir = path.join(appRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeElectron = path.join(binDir, 'Electron');
  fs.symlinkSync(process.execPath, fakeElectron);
  fs.writeFileSync(path.join(appRoot, 'session-manager.js'), 'module.exports = {};');

  const child = require('node:child_process').spawn(fakeElectron, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(path.join(run, 'someagent'), { recursive: true });
    fs.writeFileSync(path.join(run, 'someagent', 'agent.json'),
      JSON.stringify({ name: 'someagent', pid: child.pid, cwd: appRoot }));
    // Changed after the child started. Explicit mtime so it cannot land inside
    // the same timestamp tick and read as unchanged.
    touch(path.join(appRoot, 'session-manager.js'), Date.now() + 60_000);

    const line = leafStaleHostLine(root).staleHostLine();
    assert.match(line, /MAY BE STALE/, 'discovery must reach the line: registry pid → ps → app root → changed modules');
    assert.match(line, new RegExp(String(child.pid)), 'ENTER: it is the spawned host being reported, found via its registration');
    assert.match(line, /session-manager\.js/, 'and it names the changed module');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('leaf fallback: SILENT when no registration names a live process', () => {
  const { root, run } = mkTree();
  // A dead pid: nothing is running, so nothing can be stale, so the surface
  // must stay quiet. This is the case that must NOT be confused with "unknown".
  fs.mkdirSync(path.join(run, 'ghost'), { recursive: true });
  fs.writeFileSync(path.join(run, 'ghost', 'agent.json'), JSON.stringify({ name: 'ghost', pid: 2 ** 22 }));
  assert.strictEqual(leafStaleHostLine(root).staleHostLine(), '',
    'no live host = nothing to report');
  fs.rmSync(root, { recursive: true, force: true });
});

test('leaf fallback: a STAMPED host still takes the stamped path, unchanged by t94', () => {
  const { root, src, run } = mkTree();
  fs.writeFileSync(path.join(run, '.host.json'), JSON.stringify({
    pid: 999, bootedAt: Date.now() - 7_200_000, dir: src, digest: 'stale-digest-from-boot',
  }));
  const line = leafStaleHostLine(root).staleHostLine();
  assert.match(line, /STALE HOST/, 'the stamped verdict is asserted, because a digest mismatch PROVES it');
  assert.match(line, /999/, 'ENTER: it is this stamp being reported');
  assert.ok(!/UNCONFIRMED/.test(line), 'and it must not be softened into the fallback wording');
  fs.rmSync(root, { recursive: true, force: true });
});

test('leaf fallback: wording parity — the leaf hedges exactly where host-stamp does', () => {
  // Both copies must draw the SAME line between what is proven and what is
  // merely evidenced. If one asserts where the other hedges, a reader who
  // learns to trust one surface is misled by the other.
  const { root, src } = mkTree();
  touch(path.join(src, 'alpha.js'), Date.now());
  const mine = bootstrapNotice({ pid: 55910, startedAt: Date.now() - 3 * 3600 * 1000, root: src });

  const leafSrc = fs.readFileSync(path.join(REPO, 'scripts', 'clodex-team.js'), 'utf8');
  const fallback = leafSrc.slice(leafSrc.indexOf('function staleHostLine'));
  assert.match(mine, /UNCONFIRMED/, 'ENTER: host-stamp hedges the stamp-less case');
  assert.match(fallback, /UNCONFIRMED/, 'so must the leaf');
  assert.match(fallback, /MAY BE STALE/, 'leaf headline hedges too, rather than asserting STALE HOST');
  assert.match(fallback, /HOST UNKNOWN/, 'and it keeps a distinct cannot-tell state');
  fs.rmSync(root, { recursive: true, force: true });
});
