'use strict';
// plugin-boundary.test.js — the NO-BACKDOOR lint (plugin-plan.md [internal design doc, not in this repo] §7,
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
//
// WHAT THIS IS NOT: a security control. It must never be described as one, in a
// comment here or a line in the published contract. Clodex runs with
// `contextIsolation: false` and `nodeIntegration: true`; a plugin is in-process
// code with the full authority of the app, and docs/plugin-api.md says so
// plainly — the host API is a CONTRACT, not a containment boundary. Anyone who
// wants past this lint gets past it, and no amount of regex changes that. What
// it catches is ACCIDENTS AND DRIFT: an author reaching for core in the obvious
// way, a "temporary" shortcut that outlives its author, a refactor that quietly
// re-fuses a plugin to internals. Judge every rule below by that standard —
// would it have caught the honest mistake? — and not by whether it stops an
// adversary, because it does not.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

// Builtins that hand back the module system itself, or a fresh compilation
// context, and so make every other rule in this file unenforceable. `module` is
// the sharp one: `require('module').createRequire(__filename)('/abs/path/to/
// session-manager.js')` reaches every live core singleton with an absolute path
// no specifier check can classify. `vm` does the same one level down. These are
// carved OUT of the builtin allowance rather than added to some other list,
// because the allowance is what would otherwise wave them through.
const DENIED_BUILTINS = new Set(['module', 'vm']);

// Node's own builtin list — never a hand-maintained copy, so `node:sqlite` and
// whatever lands next are covered the day the runtime gains them.
function isBuiltin(spec) {
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  if (DENIED_BUILTINS.has(bare)) return false;
  return Module.builtinModules.includes(bare) || spec.startsWith('node:');
}

function isDeniedBuiltin(spec) {
  return DENIED_BUILTINS.has(spec.startsWith('node:') ? spec.slice(5) : spec);
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

// A `require(` whose argument is NOT a single complete string literal.
// `require(k)`, `require('..' + '/x')` and `` require(`${d}/y`) `` all yield zero
// specifiers above and would sail through in silence — the scan cannot classify
// what it cannot read. A plugin has no legitimate need for a computed
// specifier: it requires its own files by fixed relative path and builtins by
// name. So the unauditable FORM is itself the violation.
//
// The rule is the exact complement of requireSpecs, not a shallow "is the next
// character a quote" — concatenation starts with a quote too, and it is the
// sharper of the two evasions. Every `require(` that requireSpecs could not
// fully parse is reported here, which makes the pair total by construction: a
// call site is either auditable or flagged, never neither.
const STATIC_REQUIRE_AT = /^require\s*\(\s*(['"])[^'"]*\1\s*\)/;
function dynamicRequires(src) {
  const bare = stripComments(src);
  const out = [];
  for (const m of bare.matchAll(/\brequire\s*\(/g)) {
    if (!STATIC_REQUIRE_AT.test(bare.slice(m.index))) out.push('require(<computed>)');
  }
  return out;
}

// Reaching `api` off any global alias, or as a free identifier. The old check was
// the literal `window.api`, which `globalThis.api`, `window['api']`, `self.api`
// and `const w = window; w.api` all walk past. Two rules, because no single one
// covers both halves:
//   1. `api` off a known global object, dot or bracket form.
//   2. a bare `api.` — catches the aliased case (`w.api.foo()` reads as `api.`
//      too) at the cost of flagging any local named `api`, which is the point:
//      a plugin has `rhost`, and a local called `api` is a rename away from the
//      thing being banned.
// `process.binding` / `process.mainModule` ride along here: same shape (a reach
// through a global for the module system), same remedy.
const GLOBAL_API_RE = /\b(?:window|globalThis|self|top|parent)\s*(?:\.\s*api\b|\[\s*['"]api['"]\s*\])/;
// The lookbehind must NOT exclude `.` — `w.api.foo()` is exactly the aliased
// case rule 2 exists to catch, and a dot is what precedes it. It excludes word
// characters (so `pluginapi.`, `capiX.` are not hits) and `-` (so a live string
// containing `plugin-api.md` is not one either).
const BARE_API_RE = /(?<![\w$\-])api\s*\./;
const PROCESS_ESCAPE_RE = /\bprocess\s*\.\s*(?:binding|mainModule)\b/;

// Walk one plugin directory, returning `{ kind, file, spec, why }` for every
// violation. `kind` is what the self-test asserts over: a violation class the
// lint cannot name is a violation class the self-test cannot pin.
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
      const bare = stripComments(src);
      for (const spec of requireSpecs(src)) {
        if (isDeniedBuiltin(spec)) {
          out.push({ kind: 'denied-builtin', file: rel, spec, why: 'hands back the module system itself — every other rule here becomes unenforceable' });
          continue;
        }
        if (isBuiltin(spec)) continue;
        if (!spec.startsWith('.')) {
          out.push({ kind: 'bare-package', file: rel, spec, why: 'bare package name (plugins vendor no deps; see Phase 5)' });
          continue;
        }
        // Relative — it must land inside the plugin's own directory. Resolve
        // against the requiring FILE's dir, exactly as Node does, so a nested
        // `lib/x.js` requiring `../y.js` is judged correctly.
        const resolved = path.resolve(path.dirname(abs), spec);
        const inside = resolved === pluginDir || resolved.startsWith(pluginDir + path.sep);
        if (!inside) {
          out.push({ kind: 'escapes-dir', file: rel, spec, why: 'escapes the plugin directory — core is reachable only via the host argument' });
        }
      }
      for (const spec of dynamicRequires(src)) {
        out.push({ kind: 'dynamic-require', file: rel, spec, why: 'dynamic require — unauditable; this scan cannot classify a computed specifier' });
      }
      // Renderer halves: no direct window.api. `rhost.invoke` is the only door.
      if (GLOBAL_API_RE.test(bare)) {
        out.push({ kind: 'global-api', file: rel, spec: 'window.api', why: 'use rhost.invoke() — the single multiplexed plugin:invoke channel (§3.4)' });
      } else if (BARE_API_RE.test(bare)) {
        // else-if: an aliased reach usually matches both, and one violation per
        // file per class reads better than a doubled report of one mistake.
        out.push({ kind: 'bare-api', file: rel, spec: 'api.', why: 'a free `api.` — an aliased window.api, or a local whose name invites becoming one; use rhost' });
      }
      if (PROCESS_ESCAPE_RE.test(bare)) {
        out.push({ kind: 'process-escape', file: rel, spec: 'process.binding/mainModule', why: 'reaches the module system through a global — same escape as require("module")' });
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
      + violations.map((v) => `  [${v.kind}] ${v.file}: ${v.spec} — ${v.why}`).join('\n'),
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

test('requireSpecs cannot see a computed specifier — which is why dynamicRequires exists', () => {
  // Not a shortcoming to fix in requireSpecs: a computed specifier has no
  // literal to extract. The right answer is to refuse the FORM, so this pins
  // the blindness and the next test pins the refusal that covers it.
  assert.deepStrictEqual(requireSpecs('const a = require(k);'), []);
  assert.deepStrictEqual(requireSpecs("const a = require('..' + '/x');"), []);
});

test('dynamicRequires flags every require whose argument is not a plain string', () => {
  assert.strictEqual(dynamicRequires('const a = require(k);').length, 1);
  assert.strictEqual(dynamicRequires("const a = require('..' + '/x');").length, 1);
  assert.strictEqual(dynamicRequires('const a = require(`${d}/y`);').length, 1);
  assert.strictEqual(dynamicRequires('const a = require(process.env.X);').length, 1);
  // Static forms — including the ones the spec-extractor already reads — are not
  // dynamic, or every legal plugin file would trip this.
  assert.deepStrictEqual(dynamicRequires("const a = require('./util');"), []);
  assert.deepStrictEqual(dynamicRequires('const a = require("node:fs");'), []);
  assert.deepStrictEqual(dynamicRequires("// require(k) in a comment"), []);
});

test('isBuiltin accepts node builtins and rejects packages', () => {
  for (const b of ['fs', 'path', 'node:fs', 'node:child_process', 'crypto']) {
    assert.ok(isBuiltin(b), `${b} should be a builtin`);
  }
  for (const p of ['electron', 'node-pty', '@xterm/addon-fit', './engine']) {
    assert.ok(!isBuiltin(p), `${p} should not be a builtin`);
  }
});

test('isBuiltin does NOT wave through the module system itself', () => {
  // These ARE node builtins, so the allowance would pass them by default. They
  // are denied because each one re-opens every door this file closes.
  for (const m of ['module', 'node:module', 'vm', 'node:vm']) {
    assert.ok(!isBuiltin(m), `${m} must not be allowed as a builtin`);
    assert.ok(isDeniedBuiltin(m), `${m} must report as a DENIED builtin, not merely a non-builtin`);
  }
  assert.ok(!isDeniedBuiltin('fs'), 'fs is an ordinary builtin');
  assert.ok(!isDeniedBuiltin('./module'), 'a local file named module.js is not the builtin');
});

test('the global-api rules see every alias, not just the literal window.api', () => {
  for (const form of [
    'const r = window.api.listSessions();',
    'const r = globalThis.api.listSessions();',
    "const r = window['api'].listSessions();",
    'const r = self.api.listSessions();',
    'const r = top.api.listSessions();',
    'const r = parent  .  api .listSessions();',
  ]) {
    assert.ok(GLOBAL_API_RE.test(form), `should flag: ${form}`);
  }
  // The aliased reach has no global token left to match — the bare rule is what
  // covers it.
  const aliased = 'const w = window;\nconst r = w.api.listSessions();';
  assert.ok(!GLOBAL_API_RE.test(aliased), 'aliasing defeats the global rule by construction');
  assert.ok(BARE_API_RE.test(aliased), 'the bare `api.` rule must catch the aliased reach');

  // Things that must NOT trip the bare rule, or the lint is unusable.
  for (const ok of ['rhost.invoke("x");', 'const pluginApi = 1; pluginApi.x;', 'let capiX = 2; capiX.y;']) {
    assert.ok(!BARE_API_RE.test(ok), `should not flag: ${ok}`);
  }
});

// A synthetic plugin under plugins/ — written, scanned, removed. Using the REAL
// directory (not a temp path) is deliberate: it proves the resolution logic
// against the actual pluginDir the production scan computes, so a future
// "simplification" of the inside-check can't pass a mocked path while failing
// the real one.
function withSyntheticPlugin(files, fn) {
  const id = '__lint_selftest__';
  const dir = path.join(PLUGINS_DIR, id);
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    return fn(scanPlugin(id), id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The kinds found per file, sorted — the shape the self-tests assert over.
// Deliberately NOT a count. A count is the assertion this file used to make,
// and it is the reason the lint could stay green through every blind spot the
// review found: `assert 3 violations` measures the discriminations the scanner
// already makes, so a class it cannot see subtracts nothing from the total and
// nothing goes red. Asserting WHICH kinds means a new blind spot shows up as a
// missing name, and a fixture for a class the scanner is blind to fails.
function kindsByFile(violations) {
  const out = {};
  for (const v of violations) {
    const base = path.basename(v.file);
    (out[base] ||= []).push(v.kind);
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

test('scanPlugin flags escapes and bare packages, and allows own-directory requires', () => {
  withSyntheticPlugin({
    'engine.js': [
      "const own = require('./lib/util');",           // legal — inside
      "const fs2 = require('node:fs');",              // legal — builtin
      "const sm = require('../../session-manager');", // ILLEGAL — escapes
      "const el = require('electron');",              // ILLEGAL — bare package
    ].join('\n'),
    // A nested file whose `../` still lands inside the plugin dir must pass —
    // the resolve-against-the-requiring-file rule, not a naive '../' ban.
    'lib/util.js': "const sib = require('../engine');",
  }, (v) => {
    assert.deepStrictEqual(kindsByFile(v), { 'engine.js': ['bare-package', 'escapes-dir'] });
  });
});

test('scanPlugin flags a require("module") escape — the builtin allowance must not cover it', () => {
  withSyntheticPlugin({
    'engine.js': [
      "const fs2 = require('node:fs');", // legal — an ordinary builtin still passes
      "const r = require('module').createRequire(__filename);",
      "const sm = r('/abs/session-manager.js');",
    ].join('\n'),
    'vm-half.js': "const vm = require('node:vm');",
    'proc.js': 'const m = process.mainModule.require("../../stores");',
  }, (v) => {
    assert.deepStrictEqual(kindsByFile(v), {
      'engine.js': ['denied-builtin'],
      'vm-half.js': ['denied-builtin'],
      // Two kinds, both correct and independently load-bearing: the specifier
      // scan reads `.require("../../stores")` as an escaping require (it is),
      // AND the global reach is named outright. Either alone would catch this
      // line; the second exists for the case where the specifier is computed
      // and the first goes blind.
      'proc.js': ['escapes-dir', 'process-escape'],
    });
  });
});

test('scanPlugin flags a computed require specifier as unauditable', () => {
  withSyntheticPlugin({
    'engine.js': [
      "const own = require('./lib/util');", // legal
      'const k = "../../session-manager";',
      'const sm = require(k);',            // ILLEGAL — unauditable
    ].join('\n'),
    'concat.js': "const sm = require('..' + '/../session-manager');",
    'lib/util.js': '// nothing',
  }, (v) => {
    assert.deepStrictEqual(kindsByFile(v), {
      'engine.js': ['dynamic-require'],
      'concat.js': ['dynamic-require'],
    });
  });
});

test('scanPlugin flags api reached off any global, and via an alias', () => {
  withSyntheticPlugin({
    'renderer.js': 'const r = window.api.listSessions();',
    'global-this.js': 'const r = globalThis.api.listSessions();',
    'bracket.js': "const r = window['api'].listSessions();",
    'aliased.js': 'const w = window;\nconst r = w.api.listSessions();',
    'clean.js': "const r = rhost.invoke('list');\n// window.api is banned here",
  }, (v) => {
    assert.deepStrictEqual(kindsByFile(v), {
      'renderer.js': ['global-api'],
      'global-this.js': ['global-api'],
      'bracket.js': ['global-api'],
      'aliased.js': ['bare-api'],
    }, 'clean.js must not appear: rhost.invoke is the sanctioned door, and a comment is not code');
  });
});
