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
// broken lines sat next to eleven correct ones and every engine-side test was
// green, because the tests called the host with the array shape the renderer did
// not use. Only a check over the call sites themselves covers all of them at
// once, and it cannot rot into passing when a dialog is reorganised.

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
    calls.push({ line: src.slice(0, at).split('\n').length, args: args.map((a) => a.trim()) });
  }
  return calls;
}

test('every renderer pluginInvoke passes its method arguments as an array', () => {
  const files = ['renderer/renderer.js'];
  const calls = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    for (const c of callArgs(src, 'window.api.pluginInvoke(')) calls.push({ ...c, rel });
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
  const bare = calls
    .filter((c) => c.args.length >= 3 && c.args[2] !== '' && !c.args[2].startsWith('['))
    // A pass-through forwarding a caller's already-built array (the plugin bar's
    // `invoke` seam) is not a literal and is not the defect.
    .filter((c) => c.args[2] !== 'args')
    .map((c) => `${c.rel}:${c.line} ${c.args[1]} <- ${c.args[2]}`);
  assert.deepStrictEqual(bare, [],
    'a bare argument is replaced by [] in ipc-handlers and the method runs with undefined — wrap it in an array');
});
