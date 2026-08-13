'use strict';
// engine-registry-dir-seam.test.js — t359. createEngine hardcoded
// `path.join(os.homedir(), '.clodex')` as its registry root, with no seam and no
// derivation from userDataPath. Eleven test files pass a temp userDataPath and
// reasonably believe they are hermetic; the registry root ignored it entirely, so
// every full-suite run seeded the OPERATOR'S live ~/.clodex/library from whatever
// branch the suite happened to run in. Observed in the wild: a live exec def took
// on a field that existed only on an unmerged worktree.
//
// The discriminator is two-sided, because either side alone is satisfiable by a
// broken fix:
//   - a test-constructed engine must not write the home it would have written
//   - a default-constructed engine must still RESOLVE the real home
//     (a fix that just stops seeding satisfies the first and breaks the app)
//
// Every case below runs under a FAKE $HOME. That is load-bearing twice over:
//   (a) it makes the assertions deterministic. Asserting over the operator's
//       real ~/.clodex is flaky by construction — the live Clodex app writes
//       run/<name>/ctx, wire-shadow.jsonl and agent memory files continuously,
//       so a before/after hash of that tree reports the APP's writes as if they
//       were the engine's. That is what made the first cut of this file red.
//   (b) it is fail-safe. If a regression drops the seam, the engine reseeds the
//       FAKE home and the test fails — instead of the test itself becoming the
//       thing that writes the operator's library.
// os.homedir() honours $HOME (including a runtime mutation) and only falls back
// to the passwd entry when it is unset, so faking it here is sufficient.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createEngine, resolveRegistryDir } = require('../engine');

const silent = { info() {}, warn() {}, error() {} };

// Runs fn with $HOME pointed at a scratch tree, restoring it afterwards. The
// engine resolves its root ONCE at construction, so the swap must be in place
// before createEngine is called, not merely before the write.
function withFakeHome(fn) {
  const prev = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t359-fakehome-'));
  process.env.HOME = home;
  try {
    assert.strictEqual(os.homedir(), home,
      'the fixture must actually move homedir, or every assertion below is about the real home');
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function fileCount(root) {
  let n = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else n += 1;
    }
  };
  walk(root);
  return n;
}

test('a test-constructed engine seeds its OWN registry root and writes no home at all', () => {
  withFakeHome((fakeHome) => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t359-home-'));
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t359-ud-'));
    try {
      const eng = createEngine({
        userDataPath: tmpUserData,
        seams: { registryDir: tmpHome },
        log: silent,
      });

      // ENTER: the engine actually adopted the seam. Without this the assertions
      // below are satisfiable by an engine that resolved somewhere else entirely
      // and simply wrote nothing we happen to be looking at.
      assert.strictEqual(eng.REGISTRY_DIR, tmpHome,
        'the engine must adopt the injected registry root');

      // Seeding followed the seam.
      assert.ok(fs.existsSync(path.join(tmpHome, 'library')),
        'seedLibraryDefaults must write the INJECTED root');
      assert.ok(fs.existsSync(path.join(tmpHome, 'library', 'exec')),
        'the seeded exec library must land under the injected root');

      // materializeExecScripts is a SECOND, independent writer of the same root
      // (engine.js:1706) — a fix that seams only initStores leaves this one
      // pointed at the home.
      assert.ok(fs.existsSync(path.join(tmpHome, 'bin', 'clodex-team.js')),
        'materializeExecScripts must follow the injected root too');

      // The assertion that must fail against unfixed code: with the seam given,
      // the home-derived root is never touched. Counting files rather than
      // hashing a live tree — under a fake HOME the correct count is exactly 0,
      // so there is nothing racy to observe. existsSync first, because a writer
      // that creates only DIRECTORIES under the root passes a file count of 0
      // vacuously.
      assert.strictEqual(fs.existsSync(path.join(fakeHome, '.clodex')), false,
        'an engine given a registryDir must not create the home-derived root at all');
      assert.strictEqual(fileCount(path.join(fakeHome, '.clodex')), 0,
        'an engine given a registryDir must not write the home-derived root');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });
});

// The other side of the discriminator. Pure resolution, no construction, no IO —
// proving the production default still points at the home must not write one.
test('the default registry root is the home-derived path, and ignores CLODEX_HOME', () => {
  withFakeHome((fakeHome) => {
    const expected = path.join(fakeHome, '.clodex');

    assert.strictEqual(resolveRegistryDir({ registryDir: '/tmp/elsewhere' }), '/tmp/elsewhere',
      'an explicit seam wins');

    // The production default. resolveRegistryDir throws under node --test when
    // no seam is given (the backstop), so unset that marker for exactly this
    // resolution — the property under test is what PRODUCTION resolves, and
    // production never runs with it set. Restored in the finally below.
    //
    // This case carries t118's pin, which the t359 diff otherwise deleted:
    // test/clodex-home-app-root.test.js used to construct an engine with no
    // seam while CLODEX_HOME held a decoy, so a root honouring the env var went
    // red. Every engine construction now passes an explicit registryDir, which
    // made that mutant green suite-wide while main.js and headless-main.js pass
    // no seam — production would have followed CLODEX_HOME with nothing red.
    // Hence a decoy here: `|| process.env.CLODEX_HOME` in resolveRegistryDir
    // must fail THIS assertion.
    const prevCtx = process.env.NODE_TEST_CONTEXT;
    const prevHomeVar = process.env.CLODEX_HOME;
    const decoy = path.join(fakeHome, 'decoy-clodex-home-from-env');
    try {
      delete process.env.NODE_TEST_CONTEXT;
      process.env.CLODEX_HOME = decoy;

      // ENTER: the decoy must differ from the answer, or the assertion holds
      // whatever the code does.
      assert.notStrictEqual(decoy, expected,
        'the fixture must make the decoy and the expected root DIFFER');

      assert.strictEqual(resolveRegistryDir({}), expected,
        'the app root must ignore CLODEX_HOME — t118: the env var is a seam for the standalone scripts only');
      assert.strictEqual(resolveRegistryDir(undefined), expected,
        'a missing seams object must resolve the operator home, still ignoring CLODEX_HOME');
    } finally {
      if (prevCtx === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = prevCtx;
      if (prevHomeVar === undefined) delete process.env.CLODEX_HOME;
      else process.env.CLODEX_HOME = prevHomeVar;
    }
  });
});

// The backstop the lead promoted from the reviewer's structural nit: forgetting
// the seam under `node --test` must be loud. Seeding is the least destructive
// writer of this root — registry.cleanup() unlinks run/*/agent.json and
// runLegacySweep rmSync's at the root, neither of which consults the seed guard.
test('resolveRegistryDir throws when the seam is forgotten under node --test', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT,
    'this test is meaningless unless node --test marks the process');
  assert.throws(() => resolveRegistryDir({}), /refusing to resolve the real/,
    'a forgotten seam must fail loudly rather than resolve the operator home');
  assert.throws(() => resolveRegistryDir(undefined), /refusing to resolve the real/,
    'a missing seams object must fail loudly too');
  // The seam still works under the same marker — the throw must not be a blanket ban.
  assert.strictEqual(resolveRegistryDir({ registryDir: '/tmp/ok' }), '/tmp/ok',
    'an explicit seam is still honoured under node --test');
});

// The safety net behind the seam: a caller that FORGETS the seam under
// `node --test` must not seed the home anyway. Driven through initStores
// directly, so the assertion is about the guard rather than the engine's wiring.
test('initStores refuses to seed the home-derived root when running under node --test', () => {
  withFakeHome((fakeHome) => {
    const { initStores } = require('../stores');
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t359-guard-'));
    const warnings = [];
    try {
      // ENTER: the guard's own precondition. If node ever stops setting this,
      // the guard silently stops firing and the assertion below would pass
      // vacuously for the wrong reason.
      assert.ok(process.env.NODE_TEST_CONTEXT,
        'this test is meaningless unless node --test marks the process');

      initStores(tmpUserData, {
        log: { info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} },
        registryDir: path.join(fakeHome, '.clodex'), // the mistake this net catches
      });

      assert.ok(warnings.some((w) => /refusing to seed/.test(w)),
        `the guard must announce itself; got ${JSON.stringify(warnings)}`);
      assert.strictEqual(fileCount(path.join(fakeHome, '.clodex', 'library')), 0,
        'the guard must leave the home-derived library empty');
    } finally {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });
});

// createEngine starts background timers that keep the loop alive.
after(() => { setImmediate(() => process.exit(0)); });

// Deliberately absent: any assertion over the operator's REAL ~/.clodex. It
// cannot be made stable while the app that owns that tree is running, and an
// unstable assertion here would be re-litigated every time the suite goes red
// for an unrelated reason. The fake-home cases above cover the same property.
// The end-to-end production seed (real home, real app) stays unexercised —
// a stated limitation, not an oversight.
