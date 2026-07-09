// Regression guard for the M4 class of bug: an extracted module referencing a
// main.js module-scope identifier that was never injected through its deps
// object. Those are free identifiers — undefined at runtime — and they only
// explode when the code path runs (the setupCodexHook leak shipped green
// through 433 unit tests and broke on the first real GUI session restore).
//
// Heuristic static scan, not a parser: collect main.js's module-scope names,
// collect the extracted module's own definitions + deps destructure, strip
// comments/strings, and flag any identifier used in the module that only
// main.js defines. Imperfect stripping means a small documented whitelist.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Words that survive comment/string stripping imperfections (template
// literals containing `//` defeat the naive comment regex). Each entry must
// be justified: `spawn` appears only in prose comments — every real call in
// session-manager.js is `pty.spawn` (verified by grep at M4 review).
const WHITELIST = new Set(['spawn']);

function moduleScopeNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^(?:async )?function (\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:const|let) (\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:const|let) \{([^}]+)\}/gm)) {
    for (const p of m[1].split(',')) {
      const n = p.split(':')[0].trim();
      if (/^\w+$/.test(n)) names.add(n);
    }
  }
  return names;
}

function ownDefinitions(src) {
  const defs = new Set();
  for (const m of src.matchAll(/^(?:async )?function (\w+)/gm)) defs.add(m[1]);
  for (const m of src.matchAll(/\bclass (\w+)/g)) defs.add(m[1]);
  for (const m of src.matchAll(/^\s*(?:const|let) (\w+)/gm)) defs.add(m[1]);
  const destr = src.match(/const \{([\s\S]*?)\} = deps;/);
  if (destr) {
    for (const p of destr[1].split(',')) {
      const n = p.split('//')[0].trim();
      if (/^\w+$/.test(n)) defs.add(n);
    }
  }
  return defs;
}

function stripCommentsAndStrings(src) {
  return src
    .replace(/`(?:[^`\\]|\\.)*`/gs, '``')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function findLeaks(moduleFile) {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const modSrc = fs.readFileSync(path.join(ROOT, moduleFile), 'utf8');
  const mainNames = moduleScopeNames(mainSrc);
  const defs = ownDefinitions(modSrc);
  const used = new Set(stripCommentsAndStrings(modSrc).match(/\b[a-zA-Z_$][\w$]*\b/g) || []);
  return [...used].filter((n) => mainNames.has(n) && !defs.has(n) && !WHITELIST.has(n)).sort();
}

test('session-manager.js references no main.js-only identifiers', () => {
  const leaks = findLeaks('session-manager.js');
  assert.deepStrictEqual(
    leaks, [],
    `free identifiers leaked from main.js scope (add to deps + destructure): ${leaks.join(', ')}`,
  );
});
