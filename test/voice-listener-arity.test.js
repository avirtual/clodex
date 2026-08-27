'use strict';

// voice-listener-arity.test.js — the r4 near-miss from t509, which is INVISIBLE
// IN A DIFF and therefore cannot be caught by review.
//
// The near-miss: `render` was registered directly as a `blur` listener and as a
// MutationObserver callback. Adding a `force` parameter to `render` — a one-line,
// obviously-correct-looking change in a different part of the file — would have
// turned every background repaint into a FORCE-paint, because both callers hand
// their callback a truthy first argument (an Event, a MutationRecord array). The
// registration lines would not appear in that diff at all.
//
// So the rule is about the BARE-IDENTIFIER form specifically: a callback
// registered by name must take no parameters. An INLINE arrow that declares
// `(e)` is not the hazard and is not forbidden — its parameter and its
// registration are the same expression, so the reviewer reading the
// registration sees the arity, and adding a parameter to it IS the diff. What
// r4 exploited is the distance between the two: a name here, a signature
// somewhere else, and nothing in either diff connecting them.
//
// THIS PIN CATCHES NOTHING TODAY — every registration below already complies.
// Its value is entirely forward-looking: it makes the r4 class un-reintroducible
// by the edit that would reintroduce it (adding a parameter to an existing
// function), which is an edit no reader of that function's file would connect to
// a registration in another one.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The voice island. Both surfaces register listeners over the shared core, and
// the r4 hazard is exactly that a function is reachable from more than one of
// them.
const FILES = ['renderer/voice-control.js', 'renderer/popovers/voice-popover.js'];

// Reads the balanced argument text of a call whose '(' is at `open`.
function argsAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

// Splits an argument list on TOP-LEVEL commas only, so an inline arrow body
// containing commas stays one argument.
function splitArgs(text) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

// The parameter list of a callback ARGUMENT, or null when the argument is a bare
// identifier (resolved separately against the file's own declarations).
function paramsOfExpression(arg) {
  let m = arg.match(/^(?:async\s+)?function\s*\*?\s*[A-Za-z0-9_$]*\s*\(([^)]*)\)/);
  if (m) return m[1];
  m = arg.match(/^(?:async\s+)?\(([^)]*)\)\s*=>/);
  if (m) return m[1];
  m = arg.match(/^(?:async\s+)?([A-Za-z0-9_$]+)\s*=>/);
  if (m) return m[1];
  return null;
}

// The parameter list of a named function declared in this file, or null when the
// name is not declared here. Both `function f(a)` and `const f = (a) =>` count.
function paramsOfNamed(src, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let m = src.match(new RegExp(`function\\s+${esc}\\s*\\(([^)]*)\\)`));
  if (m) return m[1];
  m = src.match(new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s+)?\\(([^)]*)\\)\\s*=>`));
  if (m) return m[1];
  m = src.match(new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s+)?([A-Za-z0-9_$]+)\\s*=>`));
  if (m) return m[1];
  m = src.match(new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s+)?function\\s*\\(([^)]*)\\)`));
  if (m) return m[1];
  return null;
}

// Every DOM-event/observer callback registration in `src`, as
// { kind, callback, params, resolved }. `params` is null only when the callback
// is a name this file does not declare — reported separately, since an unchecked
// registration is the same blind spot the pin exists to close.
function registrations(src) {
  const found = [];
  const push = (kind, open) => {
    const args = argsAt(src, open);
    if (args === null) return;
    const parts = splitArgs(args);
    const cb = kind === 'MutationObserver' ? parts[0] : parts[1];
    if (!cb) return;
    const expr = paramsOfExpression(cb);
    if (expr !== null) { found.push({ kind, callback: cb.slice(0, 40), params: expr.trim(), resolved: 'inline' }); return; }
    if (/^[A-Za-z0-9_$.]+$/.test(cb)) {
      const named = paramsOfNamed(src, cb.replace(/^.*\./, ''));
      found.push({ kind, callback: cb, params: named === null ? null : named.trim(), resolved: named === null ? 'unresolved' : 'named' });
      return;
    }
    found.push({ kind, callback: cb.slice(0, 40), params: null, resolved: 'unresolved' });
  };

  for (const m of src.matchAll(/\.addEventListener\s*\(/g)) push('addEventListener', m.index + m[0].length - 1);
  for (const m of src.matchAll(/new\s+MutationObserver\s*\(/g)) push('MutationObserver', m.index + m[0].length - 1);
  return found;
}

test('the voice island registers no DOM listener that accepts a parameter', () => {
  const all = [];
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    for (const r of registrations(src)) all.push({ file: rel, ...r });
  }

  // ENTER: the reduction above must not have emptied the set. Every assertion
  // below is a universal over `all`, and a universal is TRUE of an empty list —
  // so a regex that stopped matching the registration syntax would vacuum out
  // the whole pin and leave it green. The count is the guard: the island's
  // registrations are few and deliberate, and one appearing or disappearing
  // should be a decision someone makes on purpose.
  assert.strictEqual(all.length, 8, `expected 8 registrations, found ${all.length}: ${JSON.stringify(all, null, 2)}`);

  // Every callback must be resolvable, or the pin is silently not checking it.
  const unresolved = all.filter((r) => r.resolved === 'unresolved');
  assert.deepStrictEqual(unresolved, [], 'a callback this test cannot resolve is a callback it is not pinning');

  const byName = all.filter((r) => r.resolved === 'named');

  // The rule itself, asserted FIRST. A newly added by-name registration that
  // takes a parameter is BOTH an arity fault and a change to the inventory
  // below, and whichever assertion runs first is the message the author reads.
  // With the inventory first the report was "the registrations changed" — true,
  // uninteresting, and silent about the defect — so the r4 explanation went
  // unread precisely when it was earned.
  const offenders = byName.filter((r) => r.params !== '');
  assert.deepStrictEqual(
    offenders, [],
    'a listener registered by name whose function takes a parameter receives the '
    + 'Event/MutationRecord as that parameter — the r4 near-miss. Wrap it: '
    + 'addEventListener(ev, () => fn()).',
  );

  // ENTER: the by-name registrations must have survived the resolution. The rule
  // above is a universal over THIS subset, and today the island happens to
  // contain exactly one — so if the named-callback resolution broke, the rule
  // would pass over an empty set while the inline count above still looked
  // healthy. It runs second because a compliant addition should be reported as
  // an inventory change, and only a non-compliant one as an arity fault.
  assert.deepStrictEqual(
    byName.map((r) => `${r.file}:${r.callback}`),
    ['renderer/popovers/voice-popover.js:closeVoicePopover'],
    'the by-name registrations this rule is actually about',
  );
});

// The scanner is the thing that could silently stop working, so it is exercised
// against literal inputs rather than only against the real files. Each row
// carries its expected params as a LITERAL — recomputing them by the scanner's
// own rule would only assert that it agrees with itself.
test('the scanner reads the registration shapes it has to tell apart', () => {
  const CASES = [
    { what: 'wrapped arrow, no params', src: "x.addEventListener('focus', () => { r(); });", expect: [{ params: '', resolved: 'inline' }] },
    { what: 'arrow taking the event — legal, but the scanner must still report the arity', src: "x.addEventListener('focus', (e) => r(e));", expect: [{ params: 'e', resolved: 'inline' }] },
    { what: 'bare arrow param, no parens', src: "x.addEventListener('focus', e => r(e));", expect: [{ params: 'e', resolved: 'inline' }] },
    { what: 'function expression taking the event', src: "x.addEventListener('focus', function (e) { r(e); });", expect: [{ params: 'e', resolved: 'inline' }] },
    { what: 'bare name declared with no params', src: "function close() {}\nx.addEventListener('click', close);", expect: [{ params: '', resolved: 'named' }] },
    { what: 'bare name declared WITH a param — the r4 shape exactly', src: "function render(force) {}\nx.addEventListener('blur', render);", expect: [{ params: 'force', resolved: 'named' }] },
    { what: 'const arrow name with a param', src: "const render = (force) => {};\nx.addEventListener('blur', render);", expect: [{ params: 'force', resolved: 'named' }] },
    { what: 'MutationObserver wrapped', src: 'const o = new MutationObserver(() => emit());', expect: [{ params: '', resolved: 'inline' }] },
    { what: 'MutationObserver handed a parameterised name', src: 'function render(force) {}\nconst o = new MutationObserver(render);', expect: [{ params: 'force', resolved: 'named' }] },
    { what: 'a name from another module cannot be checked here', src: "x.addEventListener('click', other.thing);", expect: [{ params: null, resolved: 'unresolved' }] },
    { what: 'commas inside the arrow body do not split the argument', src: "x.addEventListener('click', () => { f(1, 2); });", expect: [{ params: '', resolved: 'inline' }] },
  ];
  for (const c of CASES) {
    const got = registrations(c.src).map((r) => ({ params: r.params, resolved: r.resolved }));
    assert.deepStrictEqual(got, c.expect, c.what);
  }
});
