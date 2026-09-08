'use strict';
// plugin-invoke-args.test.js — every renderer `pluginInvoke` call must pass its
// method arguments as an ARRAY (t651 review round 1).
//
// The defect this pins shipped and was found by a human reading the diff, not by
// the suite. `pluginInvoke` is the frozen 3-arg contract row (api-contract.js,
// no argmap); preload forwards verbatim; ipc-handlers does
// `Array.isArray(args) ? args : []`. So a BARE argument is not a type error and
// not a crash — it is silently replaced by an empty array, and the host method
// runs with its parameter undefined. Register then reported a valid folder as
// "not a plugin Clodex can load" and Unregister reported `invalid plugin id: ""`:
// the engine's own defensive refusals, which made a wiring bug read as user
// error on a message that named the user's path.
//
// A SOURCE-SHAPE pin rather than a behavioural one, deliberately. The three
// broken lines shipped with every engine-side test green, because the tests
// called the host with the array shape the renderer did not use. Only a check
// over the call sites themselves covers all of them at once, and it cannot rot
// into passing when a dialog is reorganised.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Top-level argument text of each call, found by balancing brackets rather than
// by regex: a real argument list contains `[id, false, String((e && e.message))]`,
// whose inner parens and commas defeat any flat pattern — and a pattern that
// mis-splits them would silently drop call sites from the audit, which is the
// vacuous-green failure this file exists to avoid.
function callArgs(src, needle) {
  const calls = [];
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
    let i = at + needle.length;   // just past the '('
    let depth = 0;
    let quote = null;
    let start = i;
    const args = [];
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; continue; }
      if (c === ')' && depth === 0) { args.push(src.slice(start, i)); break; }
      if (c === ')' || c === ']' || c === '}') { depth--; continue; }
      if (c === ',' && depth === 0) { args.push(src.slice(start, i)); start = i + 1; }
    }
    const line = src.slice(0, at).split('\n').length;
    // Running off the end means quote state desynchronised: the truncated `args`
    // that follows would be dropped by the `>= 3` filter downstream, silently
    // retiring a call site from the audit instead of failing.
    assert.ok(i < src.length, `${needle} at line ${line} did not close — the walker scanned to EOF`);
    calls.push({ line, args: args.map((a) => a.trim()) });
  }
  return calls;
}

// Every `const args = …` / `let args = …` in the file, sliced from just past the
// `=` to the `;` that ends it, with the same bracket and quote machinery.
function argsInitialisers(src) {
  const out = [];
  for (const m of src.matchAll(/\b(?:const|let|var)\s+args\s*=/g)) {
    let i = m.index + m[0].length;
    const start = i;
    let depth = 0;
    let quote = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; continue; }
      if (c === ')' || c === ']' || c === '}') { depth--; continue; }
      if (c === ';' && depth === 0) break;
    }
    if (i >= src.length) return null; // unterminated: refuse to judge it
    out.push(src.slice(start, i).trim());
  }
  return out;
}

// The value positions of an initialiser: a ternary yields one per branch, and
// anything else is its own single value. Splitting on top-level `?` and `:`
// keeps a conditional honest without parsing it — `a ? [x] : [y]` must have an
// array in BOTH arms to earn the exemption, since either can reach the call.
function valuePositions(init) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  let sawTernary = false;
  for (let i = 0; i < init.length; i++) {
    const c = init[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth === 0 && (c === '?' || c === ':')) {
      if (c === '?') sawTernary = true;
      parts.push(init.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(init.slice(start));
  // Before the first `?` sits the CONDITION, not a value — drop it. With no
  // ternary at all the whole initialiser is the one value position.
  return (sawTernary ? parts.slice(1) : parts).map((p) => p.trim()).filter((p) => p !== '');
}

function argsBindingsAreArrays(src) {
  const inits = argsInitialisers(src);
  if (inits === null) return false;
  return inits.every((init) => {
    const values = valuePositions(init);
    return values.length >= 1 && values.every((v) => v.startsWith('['));
  });
}

// Every .js under renderer/ that contains the needle. A hardcoded list is what
// let menubar.js sit outside the audit unnoticed: the file that gets it wrong is
// exactly the one nobody remembered to add, and a missing entry is invisible
// against a total the remaining files already satisfy.
function filesWithPluginInvoke(dir, needle, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) { filesWithPluginInvoke(abs, needle, out); continue; }
    if (!ent.isFile() || !ent.name.endsWith('.js')) continue;
    if (fs.readFileSync(abs, 'utf-8').includes(needle)) out.push(path.relative(ROOT, abs));
  }
  return out;
}

test('every renderer pluginInvoke passes its method arguments as an array', () => {
  // The needle omits the `window.` prefix on purpose: menubar.js calls through a
  // bare `api` alias, and a needle carrying the prefix cannot see it.
  const NEEDLE = 'api.pluginInvoke(';
  const files = filesWithPluginInvoke(path.join(ROOT, 'renderer'), NEEDLE);
  // Named so a reader sees WHICH files are audited, and so a caller appearing in
  // a new file arrives here as a failure rather than as silence.
  assert.deepStrictEqual(files, ['renderer/renderer.js', 'renderer/web/menubar.js'],
    'ENTER: the renderer files calling pluginInvoke are the ones this pin audits');
  const calls = [];
  const exemptFiles = new Set();
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    const found = callArgs(src, NEEDLE);
    // The file reached this loop because a substring scan found the needle, so
    // the bracket walker finding nothing means the two disagree — the walker has
    // stopped seeing a call the audit is supposed to cover.
    assert.ok(found.length >= 1, `ENTER: ${rel} is scanned for pluginInvoke call sites, found ${found.length}`);
    for (const c of found) calls.push({ ...c, rel });
    if (argsBindingsAreArrays(src)) exemptFiles.add(rel);
  }

  // The pin is worthless if the scan found nothing — a file reorganisation that
  // renamed the call would otherwise turn this subject green forever.
  assert.ok(calls.length >= 10,
    `ENTER: expected the renderer's pluginInvoke call sites to be found, got ${calls.length}`);
  const methods = calls.map((c) => c.args[1]);
  for (const want of ["'plugins.register'", "'plugins.unregister'", "'plugins.validateCandidate'"]) {
    assert.ok(methods.includes(want),
      `ENTER: ${want} is among the scanned call sites — it is one of the three the pin was written for`);
  }

  // A call with no third argument is fine: the method takes none, and the
  // handler's own `: []` is then the correct answer rather than a silent
  // substitution. Only a PRESENT third argument is constrained.
  //
  // A third argument spelled `args` is a variable, so the call site alone cannot
  // say whether it holds an array. Waiving it on the NAME would waive
  // `pluginInvoke('_host', 'plugins.register', args)` with `args` a bare string —
  // the exact defect this file exists to catch, wearing the exempt spelling. So
  // the exemption is earned by the BINDING instead: every `args` declared in the
  // file must initialise to an array in all of its branches. One that does not
  // withdraws the exemption for the whole file, and the pass-throughs then read
  // as bare arguments and fail. Parameters are not declarations here — a
  // forwarded `args` is the caller's already-built array, not a literal.
  assert.ok(exemptFiles.size >= 1,
    'ENTER: at least one scanned file earns the `args` exemption, so the check below waives something real');
  const passThrough = (c) => c.args[2] === 'args' && exemptFiles.has(c.rel);
  assert.ok(calls.some(passThrough),
    'ENTER: an `args` pass-through is among the scanned calls — the exemption waives a real call site');
  const bare = calls
    .filter((c) => c.args.length >= 3 && c.args[2] !== '' && !c.args[2].startsWith('['))
    .filter((c) => !passThrough(c))
    .map((c) => `${c.rel}:${c.line} ${c.args[1]} <- ${c.args[2]}`);
  assert.deepStrictEqual(bare, [],
    'a bare argument is replaced by [] in ipc-handlers and the method runs with undefined — wrap it in an array');
});
