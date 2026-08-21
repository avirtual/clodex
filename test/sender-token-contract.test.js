'use strict';

// The REVERSE direction of the sender-token contract (docs/renderer-events.md
// §C): nothing stops a handler reaching for a method the sender does not
// provide. That is how `peer-deploy-line` lost a 15-minute deploy's output —
// the handler called `isDestroyed` because the WINDOW-HANDLE contract (five
// methods, session-manager.js header) guarantees it, the web host's token did
// not carry it, and the throw landed in a bare catch. The forward half (the web
// adapter SUPPLIES both methods) is pinned in test/web-host.test.js; this file
// pins that no consumer reaches PAST them.
//
// Text-scan, not a parser: acorn is unresolvable in this repo (CLAUDE.md), so
// the scan is forced. That makes the scanner itself the risk — one that matches
// nothing passes every file silently — so the planted-violation tests below are
// not decoration, they are what makes a green here mean anything.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'ipc-handlers.js');

// Exactly two, measured across every consumer. Adding one here without adding it
// to BOTH adapters is the divergence this whole contract exists to prevent.
const CONTRACT = new Set(['send', 'isDestroyed']);

function stripComments(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// Two lanes, because the sender is reached two ways and a scanner covering only
// the first reads clean over the site where the original bug actually lived:
//   1. direct   — `e.sender.foo`
//   2. aliased  — `const wc = e.sender;` … `wc.foo`
// Lane 2 needs the alias names discovered first; they are whatever the file
// binds `.sender` to, so a rename cannot slip a consumer past the scan.
function senderAliases(src) {
  return [...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\.sender\b/g)]
    .map((m) => m[1]);
}

function scan(src) {
  const code = stripComments(src);
  const direct = [...code.matchAll(/\.sender\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const aliases = senderAliases(code);
  const aliased = [];
  for (const a of new Set(aliases)) {
    const re = new RegExp(`\\b${a}\\.([A-Za-z_$][\\w$]*)`, 'g');
    for (const m of code.matchAll(re)) aliased.push(m[1]);
  }
  return { direct, aliased, aliases, all: [...direct, ...aliased] };
}

test('every sender member ipc-handlers.js touches is in the contracted set', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const { direct, aliased, aliases, all } = scan(src);

  // ENTER guards. Every assertion below is an ABSENCE ("no violations"), and an
  // absence is trivially true of an empty set — so a regex that stopped matching
  // (a rename, a refactor to a shape the lanes miss) would vacuum out the whole
  // test and stay green. These three make that failure loud instead.
  assert.ok(direct.length > 0, 'ENTER: the direct `e.sender.x` lane matched nothing — scanner is blind');
  assert.ok(aliases.length > 0, 'ENTER: no `const x = e.sender` alias found — the alias lane is blind');
  assert.ok(aliased.length > 0, 'ENTER: alias lane resolved no member accesses — scanner is blind');

  const violations = [...new Set(all.filter((m) => !CONTRACT.has(m)))].sort();
  assert.deepStrictEqual(
    violations, [],
    `ipc-handlers.js reaches for sender method(s) outside the two-method contract `
    + `(docs/renderer-events.md §C): ${violations.join(', ')}. Either use send/isDestroyed, `
    + `or widen the contract in BOTH adapters (web-host.js's token AND the docs) first — `
    + `a method only the window-handle contract guarantees throws on the web host.`,
  );
});

// The scanner is the test. Verified by RUNNING it against planted violations of
// each shape, not by reading it.
test('the scan catches a violation on the direct lane', () => {
  const planted = `handle('x', (e) => { e.sender.isFocused(); });`;
  assert.deepEqual(scan(planted).all, ['isFocused']);
});

test('the scan catches a violation reached through an alias', () => {
  const planted = `handle('x', (e) => { const wc = e.sender; wc.isFocused(); });`;
  const got = scan(planted);
  assert.deepEqual(got.aliases, ['wc']);
  assert.deepEqual(got.aliased, ['isFocused']);
});

test('the scan does not flag a commented mention', () => {
  assert.deepEqual(scan('// e.sender.isFocused() would throw here\n').all, []);
});

// `theme:set` passes `e.sender` as a VALUE and names no method. That is not a
// contract use and must not be invented as one — if this starts flagging, the
// member regex has begun matching past the expression it is scoped to.
test('passing the sender as a value names no method', () => {
  assert.deepEqual(scan(`handle('theme:set', (e, n) => { setUiTheme(n, e.sender); });`).all, []);
});
