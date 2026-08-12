'use strict';
// Run: node --test test/no-live-registry-in-tests.test.js
//
// A source-text guard: no test may construct a ticket store or a team manifest
// without a `clodexHome`. Both factories fall back to `defaultClodexHome()` —
// correct for the app, and for a test it silently resolves to the OPERATOR'S
// real ~/.clodex, so a test run reads (and one save away from writes) live
// ticket boards and team manifests. The fallbacks are right and stay; this is
// the guard that keeps tests off them.
//
// Modelled on exec-scripts-materialize.test.js's forbidden-pattern scan.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;

// Built by concatenation, never as one literal: written whole, this file's own
// source would contain a bare `createTicketsStore(` and the guard would flag
// itself. Split this way, the guard scans itself like every other file.
const FACTORIES = ['createTicketsStore', 'createTeamManifest'].map((n) => `${n}(`);

// Every .js under test/, including fixtures and including files not yet tracked
// by git — a guard keyed on `git ls-files` cannot see an offender (or itself)
// until it is committed, which is exactly when nobody re-runs it.
function testFiles(dir = TEST_DIR) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...testFiles(p));
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Comments out, or the guard flags PROSE: clodex-home-app-root.test.js's header
// names `createTeamManifest({ fs })` as the bug it exists to prevent, and a
// scan of raw text reads that sentence as the offence it describes. Only block
// comments and whole-line `//` are stripped — a trailing comment on a code line
// survives and can only produce a LOUD false positive, never hide a real call
// the way stripping `//` mid-line (inside a URL string) could.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

// The argument text of each call, by scanning to the matching close paren.
// Args here are single object literals, so brace/paren depth is enough.
function callArgs(src, needle) {
  const out = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf(needle, from);
    if (i < 0) return out;
    let depth = 0;
    let j = i + needle.length - 1;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ index: i, args: src.slice(i + needle.length, j) });
    from = j > i ? j : i + needle.length;
  }
}

test('no test constructs a ticket store or team manifest without a clodexHome', () => {
  const files = testFiles();
  // ENTER: the enumeration must have found the suite. Every assertion below is
  // an ABSENCE assertion, so a glob that returns nothing passes forever.
  assert.ok(files.length > 100, `ENTER: expected the whole test dir, enumerated ${files.length}`);
  assert.ok(files.includes(path.join(TEST_DIR, 'tickets-migrate.test.js')),
    'ENTER: a known test file must be in the enumeration');

  const offenders = [];
  let callSites = 0;
  const seenFactory = new Map(FACTORIES.map((f) => [f, 0]));
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const needle of FACTORIES) {
      for (const { args } of callArgs(src, needle)) {
        callSites++;
        seenFactory.set(needle, seenFactory.get(needle) + 1);
        if (!/clodexHome/.test(args)) {
          offenders.push(`${path.relative(TEST_DIR, file)}: ${needle}${args.trim()})`);
        }
      }
    }
  }

  // ENTER again, on the needle rather than the file list: a factory renamed in
  // source leaves this guard matching nothing and reporting zero offenders.
  assert.ok(callSites > 0, 'ENTER: the scan must have found real call sites');
  for (const [needle, n] of seenFactory) {
    assert.ok(n > 0, `ENTER: no call sites found for ${needle} — has the factory been renamed?`);
  }

  assert.deepStrictEqual(offenders, [],
    'each of these resolves to the operator\'s real ~/.clodex — pass a temp clodexHome');
});
