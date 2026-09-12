'use strict';
// exec-scripts-materialize.test.js — pins the exec helper scripts' packaging and
// materialization (bin-materialize.js EXEC_SCRIPTS / materializeExecScripts), plus
// the seeded exec-defs that invoke them. The scripts run from ~/.clodex/bin/ where
// only the materialized files exist, so a local require() added to one of them
// would strand it at runtime for the user; and a def carrying an absolute repo
// path or a false description bounces every seat that follows it. Both are made
// red at dev time here instead.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EXEC_SCRIPTS, materializeExecScripts } = require('../bin-materialize');

const ROOT = path.join(__dirname, '..');

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

// A description is the ONLY per-command guidance a seat gets, and stores.js
// pristine-hash seeding pushes it to existing installs — so a false one ships
// and bounces every seat that follows it. This asserts the description against
// the script's OWN guards rather than against a copy of them: "stop/list take
// just `agent`" shipped once and was contradicted by `die('stop needs an id')`.
test('clodex-monitor: the described per-action fields match the script\'s guards', () => {
  const def = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'library', 'exec', 'clodex-monitor.json'), 'utf8'));
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'clodex-monitor.js'), 'utf8');
  const desc = String(def.description || '');
  assert.ok(desc, 'the def carries a description at all');
  assert.ok(desc.length <= 200, `description must fit the 200-char cap, got ${desc.length}`);

  // Every field the SCRIPT requires per action must be named in the description.
  if (/die\('stop needs an id'\)/.test(src)) {
    assert.match(desc, /stop needs the `id`/,
      'the script rejects a stop without an id — a description omitting it sends the seat into a bounce');
  }
  if (/die\('start needs a command or a ws:\{url\}'\)/.test(src)) {
    assert.match(desc, /start needs command or ws/, 'start\'s requirement must be stated');
  }
  if (/die\('agent \(your own name\) is required'\)/.test(src)) {
    assert.match(desc, /`agent` is your OWN name/, 'every action needs agent, and which name it is');
  }
  // And it must not claim an action takes LESS than the script demands.
  assert.ok(!/stop\/list take just `agent`/.test(desc),
    'stop requires an id; this exact claim shipped false once');
});

// Same rule as clodex-monitor above, against the guard the script actually
// carries: `tree` is a refusal path, so a description that omits it sends a seat
// into a bounce it cannot diagnose, and one that promises a fallback would be
// read as "no tree means my worktree" — the false green the refusal exists to
// prevent.
test('clodex-run-tests: the described `tree` field matches the script\'s guard', () => {
  const def = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'library', 'exec', 'clodex-run-tests.json'), 'utf8'));
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'clodex-run-tests.js'), 'utf8');
  const desc = String(def.description || '');
  assert.ok(desc, 'the def carries a description at all');

  assert.match(src, /hasOwnProperty\.call\(payload, 'tree'\)/,
    'ENTER: the script still branches on the PRESENCE of `tree` — the assertions below describe that guard');
  assert.match(desc, /`tree`/, 'the optional field must be named, or the reader cannot act on it');
  assert.match(desc, /TEAM ROOT/,
    'and the default must be stated: with no `tree` this measures the root, not the caller\'s worktree');

  // The runner it drives is the project's own, and naming it is what makes the
  // grant portable in the reader's head rather than only on disk.
  assert.match(src, /path\.join\(measure, 'scripts', 'run-tests\.js'\)/,
    'ENTER: the script still drives scripts/run-tests.js');
  assert.match(desc, /scripts\/run-tests\.js/, 'the description names the file the project must supply');
});

test('.dockerignore re-includes exactly the EXEC_SCRIPTS the image must ship', () => {
  assert.ok(EXEC_SCRIPTS.length >= 3,
    'ENTER: EXEC_SCRIPTS still names at least three helpers — the list this pins against');
  const lines = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
  const reincluded = lines.filter((l) => l.startsWith('!scripts/')).sort();
  const expected = EXEC_SCRIPTS.map((f) => `!${f}`).sort();
  assert.deepStrictEqual(reincluded, expected,
    'every EXEC_SCRIPTS entry must be negated back in, or the image ships without it and the exec dies as module-not-found');
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
