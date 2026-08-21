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

// String-unaware, and that is a live assumption rather than a nicety: a `//`
// inside a string or template literal truncates the rest of THAT line, so a
// sender access sharing a line with a URL would be silently unscanned. Measured
// on ipc-handlers.js: two hits total, a real comment and the `https://github.com`
// template at the repoUrl default, neither on a sender line. The floors above are
// what would catch this if a future URL landed on one.
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
  const raw = [...code.matchAll(/\.sender\b/g)].length;
  const direct = [...code.matchAll(/\.sender\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const aliases = senderAliases(code);
  const aliased = [];
  for (const a of new Set(aliases)) {
    const re = new RegExp(`\\b${a}\\.([A-Za-z_$][\\w$]*)`, 'g');
    for (const m of code.matchAll(re)) aliased.push(m[1]);
  }
  return { raw, direct, aliased, aliases, all: [...direct, ...aliased] };
}

// The sender is passed as a VALUE, naming no method — not a contract use, and it
// must not be counted as an unmodelled shape. `theme:set` hands it to
// setUiTheme for broadcast-except-sender. A number, not a pattern, so a SECOND
// value-pass has to come through here and be looked at.
const KNOWN_VALUE_PASSES = 1;

test('every sender member ipc-handlers.js touches is in the contracted set', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const { raw, direct, aliased, aliases, all } = scan(src);

  // Every `.sender` in the file is accounted for by a shape the scan MODELS, or
  // this fails. Without it an unmodelled shape is invisible rather than red —
  // `const { isDestroyed } = e.sender`, `const { sender } = e`, or passing the
  // token into a helper whose parameter is then called all reach the sender in
  // ways neither lane sees, and the violation assertion below would read clean
  // over them. This file's own thesis is that a scanner matching nothing passes
  // silently; an unmodelled shape is that failure in miniature.
  assert.strictEqual(
    raw, direct.length + aliases.length + KNOWN_VALUE_PASSES,
    `the sender is reached in a shape this scan does not model: ${raw} \`.sender\` occurrences `
    + `but ${direct.length} direct + ${aliases.length} alias binding(s) + ${KNOWN_VALUE_PASSES} known `
    + 'value-pass(es). Model the new shape in scan() — do NOT raise the constant to make this pass, '
    + 'which would hide exactly the consumer the scan stopped covering.');

  // ENTER guards, as FLOORS rather than `> 0`. Every assertion below is an
  // ABSENCE ("no violations"), trivially true of an empty set — but total
  // blindness is not the realistic degradation. Partial is: extract the context
  // menus into a helper taking `sender` as a parameter and the direct lane drops
  // from 13 to 1, which passes a `> 0` guard while 12 consumers go unscanned.
  // A floor is a ratchet only when the population SHRINKS, and shrinking is
  // exactly the coverage loss worth hearing about. Same shape as the
  // per-directory floor in test/architecture-map-complete.test.js.
  //
  // These numbers are a measurement, not a target: if a real change removes
  // consumers, lower them in the same commit and say why.
  assert.ok(direct.length >= 13,
    `ENTER: the direct \`e.sender.x\` lane matched ${direct.length} sites, below the 13 measured — `
    + 'consumers moved out of this file or into a shape the lane does not see, and the scan no longer covers them');
  assert.ok(aliases.length > 0, 'ENTER: no `const x = e.sender` alias found — the alias lane is blind');
  assert.ok(aliased.length >= 2,
    `ENTER: the alias lane resolved ${aliased.length} member accesses, below the 2 measured — `
    + 'the aliased consumer moved or changed shape, and the lane that caught the original bug is not looking at it');

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
  assert.deepStrictEqual(scan(planted).all, ['isFocused']);
});

test('the scan catches a violation reached through an alias', () => {
  const planted = `handle('x', (e) => { const wc = e.sender; wc.isFocused(); });`;
  const got = scan(planted);
  assert.deepStrictEqual(got.aliases, ['wc']);
  assert.deepStrictEqual(got.aliased, ['isFocused']);
});

// The method set is stated in three places — this CONTRACT, the web adapter's
// expected key set in web-host.test.js, and the prose in renderer-events.md.
// Pinning the doc against CONTRACT makes it the DERIVED side rather than a third
// independent copy that drifts in silence. That drift is not hypothetical here:
// test/renderer-events-figures.test.js exists because this same doc once cited a
// session-manager.js banner that had been deleted.
test('the doc DECLARES exactly the contracted set, so the prose cannot drift from it', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'renderer-events.md'), 'utf8');
  const start = doc.indexOf('**The sender-token contract');
  assert.ok(start >= 0, 'ENTER: the sender-token section is gone from the doc');

  // Scoped to the DECLARATIVE sentence, not the section: the prose after it
  // names `isDestroyed` again as history ("the borrow came first"), so a
  // section-wide `includes` stays green while the sentence that STATES the set
  // loses a member. Measured — that exact mutant passed a section-wide check.
  const decl = doc.slice(start, doc.indexOf('and nothing else', start));
  assert.ok(decl.includes('is used through'), 'ENTER: the declarative sentence changed shape; re-scope this slice');

  // Every `name(` inside backticks in that sentence, which is how the members
  // are written there. deepStrictEqual in BOTH directions: a member the doc
  // omits and a member it invents are the same drift seen from two sides.
  const declared = [...decl.matchAll(/`([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(
    declared, [...CONTRACT].sort(),
    `docs/renderer-events.md declares [${declared}] but CONTRACT is [${[...CONTRACT].sort()}] — `
    + 'the doc and the scan have drifted. Fix whichever is wrong, but they ship together.');
});

test('the scan does not flag a commented mention', () => {
  assert.deepStrictEqual(scan('// e.sender.isFocused() would throw here\n').all, []);
});

// `theme:set` passes `e.sender` as a VALUE and names no method. That is not a
// contract use and must not be invented as one — if this starts flagging, the
// member regex has begun matching past the expression it is scoped to.
test('passing the sender as a value names no method', () => {
  assert.deepStrictEqual(scan(`handle('theme:set', (e, n) => { setUiTheme(n, e.sender); });`).all, []);
});
