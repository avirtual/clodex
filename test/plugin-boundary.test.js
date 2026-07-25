'use strict';
// plugin-boundary.test.js — the NO-BACKDOOR lint (docs/plugin-plan.md §7,
// Phase 0). Modelled on the leak/electron boundary scanners: a static walk of
// `plugins/**`, failing on any require that reaches OUTSIDE the plugin's own
// directory.
//
// Why this gate is the load-bearing one for the whole program. The plan's thesis
// is that a plugin talks to core through ONE small, named, versioned surface —
// the `host` / `rhost` argument — and that this is what makes the taxonomy a
// real contract instead of documentation. A single `require('../../session-manager')`
// silently converts a plugin back into a core module that happens to live in a
// subdirectory: it gains the full internal wiring, the versioned surface stops
// being the whole truth, and "a plugin can be dropped in" becomes "a plugin can
// be dropped in if it's one of our friends". That is exactly the "core with
// hardcoded friends" outcome the vision doc names. Discipline does not hold this
// line across years; a scanner does.
//
// The allowed set is deliberately tiny:
//   * node builtins (`fs`, `path`, `node:child_process`, …) — Tier A plugins are
//     trusted in-process code; the process boundary is Tier B's job (Phase 5),
//     not this lint's. A plugin owning its own child process is a DESIGN GOAL
//     (§5.2 wirescope), so builtins must stay legal.
//   * relative paths that resolve INSIDE the plugin's own directory — a plugin
//     may be many files.
// Everything else — bare package names, `electron`, and every `../` that escapes
// the plugin dir — is a violation. Bare packages are refused because the repo
// vendors no runtime deps into plugins and a plugin's dependency story is a
// Phase-5 decision (BYO tier), not something to let in by silence now.
//
// Renderer halves additionally must not touch `window.api` directly: they invoke
// through `rhost.invoke(...)`, which namespaces by plugin id and rides the single
// multiplexed `plugin:invoke` channel (§3.4). A raw `window.api` call bypasses
// the dispatch map and is unremovable on disable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

// Node's own builtin list — never a hand-maintained copy, so `node:sqlite` and
// whatever lands next are covered the day the runtime gains them.
function isBuiltin(spec) {
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  return Module.builtinModules.includes(bare) || spec.startsWith('node:');
}

function stripComments(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// Every require specifier in a source file. Comments stripped first so a prose
// mention of `require('../../session-manager')` in a header comment explaining
// WHY it's forbidden doesn't trip the guard — the same false-positive class
// electron-boundary.test.js already documents.
function requireSpecs(src) {
  return [...stripComments(src).matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}

// Walk one plugin directory, returning `{ file, spec, why }` for every violation.
function scanPlugin(pluginId) {
  const pluginDir = path.join(PLUGINS_DIR, pluginId);
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const rel = path.relative(ROOT, abs);
      const src = fs.readFileSync(abs, 'utf8');
      for (const spec of requireSpecs(src)) {
        if (isBuiltin(spec)) continue;
        if (!spec.startsWith('.')) {
          out.push({ file: rel, spec, why: 'bare package name (plugins vendor no deps; see Phase 5)' });
          continue;
        }
        // Relative — it must land inside the plugin's own directory. Resolve
        // against the requiring FILE's dir, exactly as Node does, so a nested
        // `lib/x.js` requiring `../y.js` is judged correctly.
        const resolved = path.resolve(path.dirname(abs), spec);
        const inside = resolved === pluginDir || resolved.startsWith(pluginDir + path.sep);
        if (!inside) {
          out.push({ file: rel, spec, why: 'escapes the plugin directory — core is reachable only via the host argument' });
        }
      }
      // Renderer halves: no direct window.api. `rhost.invoke` is the only door.
      if (/\bwindow\s*\.\s*api\b/.test(stripComments(src))) {
        out.push({ file: rel, spec: 'window.api', why: 'use rhost.invoke() — the single multiplexed plugin:invoke channel (§3.4)' });
      }
    }
  };
  walk(pluginDir);
  return out;
}

function pluginIds() {
  try {
    return fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

// Phase 0/1 ships an EMPTY plugins/ dir on purpose (registries land in core
// first; the workbench pilot is Phase 2). Assert the scan is wired anyway, so it
// is green-and-live rather than green-and-absent when the first plugin arrives.
test('plugins/ exists and is scannable', () => {
  assert.ok(fs.existsSync(PLUGINS_DIR), 'plugins/ directory is missing');
  assert.ok(fs.statSync(PLUGINS_DIR).isDirectory(), 'plugins/ is not a directory');
});

for (const id of pluginIds()) {
  test(`plugins/${id} requires only its own files and node builtins`, () => {
    const violations = scanPlugin(id);
    assert.deepStrictEqual(
      violations, [],
      `no-backdoor violations in plugins/${id}:\n`
      + violations.map((v) => `  ${v.file}: require('${v.spec}') — ${v.why}`).join('\n'),
    );
  });
}

// Scanner self-tests. The gate has nothing to scan until Phase 2, so without
// these it would be a green no-op that nobody notices is broken. Each locks one
// discrimination the lint must make — modelled on the electron-boundary guard's
// fires-on-import / silent-on-comment pair.
test('requireSpecs sees real requires and ignores commented ones', () => {
  assert.deepStrictEqual(requireSpecs("const a = require('./git-scm');"), ['./git-scm']);
  assert.deepStrictEqual(requireSpecs('const a = require("node:fs");'), ['node:fs']);
  assert.deepStrictEqual(requireSpecs("// never require('../../session-manager')"), []);
  assert.deepStrictEqual(requireSpecs("/*\n * not require('electron')\n */"), []);
});

test('isBuiltin accepts node builtins and rejects packages', () => {
  for (const b of ['fs', 'path', 'node:fs', 'node:child_process', 'crypto']) {
    assert.ok(isBuiltin(b), `${b} should be a builtin`);
  }
  for (const p of ['electron', 'node-pty', '@xterm/addon-fit', './engine']) {
    assert.ok(!isBuiltin(p), `${p} should not be a builtin`);
  }
});

test('scanPlugin flags escapes and allows own-directory requires', () => {
  // A synthetic plugin under plugins/ — written, scanned, removed. Using the
  // REAL directory (not a temp path) is deliberate: it proves the resolution
  // logic against the actual pluginDir the production scan computes, so a
  // future "simplification" of the inside-check can't pass a mocked path while
  // failing the real one.
  const id = '__lint_selftest__';
  const dir = path.join(PLUGINS_DIR, id);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'engine.js'), [
      "const own = require('./lib/util');",       // legal — inside
      "const fs2 = require('node:fs');",          // legal — builtin
      "const sm = require('../../session-manager');", // ILLEGAL — escapes
      "const el = require('electron');",          // ILLEGAL — bare package
    ].join('\n'));
    // A nested file whose `../` still lands inside the plugin dir must pass —
    // the resolve-against-the-requiring-file rule, not a naive '../' ban.
    fs.writeFileSync(path.join(dir, 'lib', 'util.js'), "const sib = require('../engine');");
    fs.writeFileSync(path.join(dir, 'renderer.js'), 'const r = window.api.listSessions();');

    const v = scanPlugin(id);
    const specs = v.map((x) => x.spec).sort();
    assert.deepStrictEqual(specs, ['../../session-manager', 'electron', 'window.api'],
      `expected exactly the three violations, got ${JSON.stringify(v, null, 2)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
