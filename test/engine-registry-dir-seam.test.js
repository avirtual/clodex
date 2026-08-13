'use strict';
// engine-registry-dir-seam.test.js — t359. createEngine hardcoded
// `path.join(os.homedir(), '.clodex')` as its registry root, with no seam and no
// derivation from userDataPath. Twelve test files pass a temp userDataPath and
// reasonably believe they are hermetic; the registry root ignored it entirely, so
// every full-suite run seeded the OPERATOR'S live ~/.clodex/library from whatever
// branch the suite happened to run in. Observed in the wild: a live exec def took
// on a field that existed only on an unmerged worktree.
//
// The discriminator this file pins is two-sided, because either side alone is
// satisfiable by a broken fix:
//   - a test-constructed engine must not write the real home  (seam is honoured)
//   - a default-constructed engine must still resolve the real home
//     (a fix that just stops seeding satisfies the first and breaks the app)
//
// On the second side, see `resolveRegistryDir` below: this file deliberately
// never CONSTRUCTS a default engine, because doing so is the very write the
// ticket forbids. The default is therefore pinned as a pure resolution, and the
// end-to-end production seed stays unexercised by the suite — a limitation
// recorded here rather than papered over.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createEngine, resolveRegistryDir } = require('../engine');

const REAL_HOME = path.join(os.homedir(), '.clodex');

const silent = { info() {}, warn() {}, error() {} };

// Content hash, not mtime. The operator's live app may legitimately rewrite a
// seeded file with identical bytes while the suite runs; that is harmless. A
// CHANGE of bytes under the real home is the damage, and is what we assert
// against. Missing file hashes as null so an appearing/vanishing file is caught.
function hashTree(root) {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          out.set(p, require('node:crypto').createHash('sha256')
            .update(fs.readFileSync(p)).digest('hex'));
        } catch { out.set(p, null); }
      }
    }
  };
  walk(root);
  return out;
}

function diffTrees(before, after) {
  const changed = [];
  for (const [p, h] of after) if (before.get(p) !== h) changed.push(p);
  for (const [p] of before) if (!after.has(p)) changed.push(`${p} (removed)`);
  return changed;
}

// NOTE: this test never writes, moves or removes anything under the real home.
// It reads it twice and compares. That read-only posture is load-bearing — the
// whole defect is that something believed itself hermetic and was not.
test('a test-constructed engine seeds its OWN registry root and leaves the real home byte-identical', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t359-home-'));
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t359-ud-'));

  const before = hashTree(REAL_HOME);
  try {
    const eng = createEngine({
      userDataPath: tmpUserData,
      seams: { registryDir: tmpHome },
      log: silent,
    });

    // ENTER: the engine actually adopted the seam. Without this the assertions
    // below are all satisfiable by an engine that resolved somewhere else
    // entirely and simply wrote nothing we happen to be looking at.
    assert.strictEqual(eng.REGISTRY_DIR, tmpHome,
      'the engine must adopt the injected registry root');

    // THE assertion that must fail against unfixed code: seeding followed the
    // seam, so the shipped library defaults landed in the temp tree.
    assert.ok(fs.existsSync(path.join(tmpHome, 'library')),
      'seedLibraryDefaults must write the INJECTED root, not the real home');
    assert.ok(fs.existsSync(path.join(tmpHome, 'library', 'exec')),
      'the seeded exec library must land under the injected root');

    // materializeExecScripts is a second, independent writer of the same root
    // (engine.js:1706) — a fix that seams only initStores leaves this one
    // pointed at the operator's home.
    assert.ok(fs.existsSync(path.join(tmpHome, 'bin', 'clodex-team.js')),
      'materializeExecScripts must follow the injected root too');

    const after = hashTree(REAL_HOME);
    const changed = diffTrees(before, after);
    assert.deepStrictEqual(changed, [],
      `constructing a test engine must not change one byte under ${REAL_HOME}`);
  } finally {
    // Only the temp trees. Never the real home — see the ticket's hard constraint.
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  }
});

// The other side of the discriminator. Pure resolution, no construction, no IO:
// proving the production default still points at the real home must not itself
// write the real home.
test('the default registry root is still the real home when no seam is given', () => {
  assert.strictEqual(resolveRegistryDir({}), REAL_HOME,
    'omitting the seam must resolve the operator home exactly as before');
  assert.strictEqual(resolveRegistryDir(undefined), REAL_HOME,
    'a missing seams object must resolve the operator home');
  assert.strictEqual(resolveRegistryDir({ registryDir: '/tmp/elsewhere' }), '/tmp/elsewhere',
    'an explicit seam wins');
});

// The safety net behind the seam: a caller that FORGETS the seam under
// `node --test` must not seed the real home anyway. Driven through initStores
// directly rather than createEngine, so the assertion is about the guard and
// not about the engine's wiring — and so nothing here constructs an engine
// pointed at the operator's tree.
test('initStores refuses to seed the real home when running under node --test', () => {
  const { initStores } = require('../stores');
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t359-guard-'));
  const warnings = [];
  const before = hashTree(REAL_HOME);
  try {
    // ENTER: the guard's own precondition. If node ever stops setting this, the
    // guard silently stops firing and the assertion below would pass vacuously
    // for the wrong reason.
    assert.ok(process.env.NODE_TEST_CONTEXT,
      'this test is meaningless unless node --test marks the process');

    initStores(tmpUserData, {
      log: { info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} },
      registryDir: REAL_HOME, // the mistake this net exists to catch
    });

    assert.ok(warnings.some((w) => /refusing to seed/.test(w)),
      `the guard must announce itself; got ${JSON.stringify(warnings)}`);
    assert.deepStrictEqual(diffTrees(before, hashTree(REAL_HOME)), [],
      'the guard must leave the real home byte-identical');
  } finally {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  }
});

// createEngine starts background timers that keep the loop alive.
after(() => { setImmediate(() => process.exit(0)); });
