'use strict';
// pot-cli-closure.test.js — pins the boiling-pot CLI's materialized closure
// (pot-bin.js POT_CLI_CLOSURE) against pot-cli.js's ACTUAL transitive local
// require()s. The CLI runs from ~/.clodex/bin/ where only the materialized files
// exist, so a local require() that isn't in the closure strands the CLI at
// runtime for the user. This test makes that a red test at dev time instead:
// add `require('./newdep')` to file-heat.js and forget to materialize it → fail.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { POT_CLI_CLOSURE, materializePotCli, EXEC_SCRIPTS, materializeExecScripts } = require('../pot-bin');

const ROOT = path.join(__dirname, '..');

// Walk the transitive closure of LOCAL requires (`require('./x')`) starting at
// pot-cli.js. Bare requires (node builtins, node_modules) are intentionally
// ignored — those resolve identically from ~/.clodex/bin/, only local files must
// be copied. Returns the set of basenames reachable, entry included.
function localClosure(entry) {
  const seen = new Set();
  const stack = [entry];
  const RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    let m;
    while ((m = RE.exec(src)) !== null) {
      let rel = m[1];
      if (!rel.endsWith('.js')) rel += '.js';
      const resolved = path.normalize(path.join(path.dirname(file), rel));
      stack.push(resolved);
    }
  }
  return seen;
}

test('POT_CLI_CLOSURE covers every transitive local require of pot-cli.js', () => {
  const reachable = localClosure('pot-cli.js');
  const listed = new Set(POT_CLI_CLOSURE);
  const missing = [...reachable].filter((f) => !listed.has(f));
  assert.deepStrictEqual(missing, [],
    `pot-cli.js reaches local files NOT materialized by pot-bin.js — the CLI would break from ~/.clodex/bin/: ${missing}`);
});

test('POT_CLI_CLOSURE has no dead entries (every listed file exists + is reached)', () => {
  const reachable = localClosure('pot-cli.js');
  for (const f of POT_CLI_CLOSURE) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `listed closure file missing on disk: ${f}`);
    assert.ok(reachable.has(f), `listed closure file not actually reached by pot-cli.js (dead entry): ${f}`);
  }
});

test('the entry point pot-cli.js is itself in the closure', () => {
  assert.ok(POT_CLI_CLOSURE.includes('pot-cli.js'), 'pot-cli.js must be materialized');
});

test('materializePotCli copies the whole closure into <root>/bin and marks pot-cli executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potbin-'));
  try {
    const { binDir, copied } = materializePotCli({ root, srcDir: ROOT });
    assert.strictEqual(copied, POT_CLI_CLOSURE.length, 'every closure file copied');
    for (const f of POT_CLI_CLOSURE) {
      assert.ok(fs.existsSync(path.join(binDir, f)), `materialized: ${f}`);
    }
    // pot-cli.js gets the executable bit; the plain requires do not.
    assert.ok(fs.statSync(path.join(binDir, 'pot-cli.js')).mode & 0o100, 'pot-cli.js is executable');
    // Overwrite-always: a second run doesn't throw and leaves the closure intact.
    const again = materializePotCli({ root, srcDir: ROOT });
    assert.strictEqual(again.copied, POT_CLI_CLOSURE.length, 'idempotent overwrite');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- exec helper scripts (Task 10 portability) --------------------------------
// A SEPARATE materialize path from the pot closure (kept off POT_CLI_CLOSURE so
// this file's closure guards don't see them). These prove the three-defect fix:
// the scripts are packaged (build.files), materialized into <root>/bin flat, and
// dependency-free (so a flat copy suffices).

test('EXEC_SCRIPTS are declared in package.json build.files (root *.js glob misses scripts/)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = pkg.build.files;
  for (const f of EXEC_SCRIPTS) {
    assert.ok(files.includes(f), `build.files must list ${f} (subdir not covered by "*.js")`);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `packaged script missing on disk: ${f}`);
  }
});

test('EXEC_SCRIPTS are dependency-free (no local require) — a flat copy is sufficient', () => {
  const RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for (const f of EXEC_SCRIPTS) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.strictEqual(RE.test(src), false, `${f} has a local require() — the flat copy would strand it`);
    RE.lastIndex = 0;
  }
});

test('materializeExecScripts copies the scripts flat into <root>/bin, overwrite-always', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execbin-'));
  try {
    const { binDir, copied } = materializeExecScripts({ root, srcDir: ROOT });
    assert.strictEqual(copied, EXEC_SCRIPTS.length, 'every exec script copied');
    for (const f of EXEC_SCRIPTS) {
      // Flat by basename — matches the ${CLODEX_BIN}/<name>.js the seeded defs carry.
      assert.ok(fs.existsSync(path.join(binDir, path.basename(f))), `materialized flat: ${path.basename(f)}`);
    }
    const again = materializeExecScripts({ root, srcDir: ROOT });
    assert.strictEqual(again.copied, EXEC_SCRIPTS.length, 'idempotent overwrite');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the seeded exec-defs carry the ${CLODEX_BIN} placeholder, not an absolute path', () => {
  for (const name of ['clodex-team', 'clodex-monitor']) {
    const def = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'library', 'exec', `${name}.json`), 'utf8'));
    assert.ok(Array.isArray(def.argv), `${name}: argv is an array`);
    assert.ok(def.argv.some((a) => a.includes('${CLODEX_BIN}')), `${name}: argv uses the placeholder`);
    assert.ok(!def.argv.some((a) => a.startsWith('/Users/') || a.startsWith('/home/')), `${name}: no absolute repo path`);
    assert.ok(!('cwd' in def), `${name}: cwd omitted (dispatcher defaults to session.cwd)`);
  }
});
