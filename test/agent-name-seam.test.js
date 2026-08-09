'use strict';
// agent-name-seam.test.js — F004. Two regexes describe "an agent name" and they
// live on opposite sides of a process boundary:
//
//   catalogs.js   AGENT_NAME_RE   gates session CREATION
//   wire/route.js AGENT_RE        gates whether the proxy will ROUTE it
//
// Neither file references the other, and until this file existed nothing
// asserted they agree. They did not: the router demanded an alphanumeric first
// character, so `_scratch`, `.hidden` and `-dash` were creatable, were handed a
// wire base URL by session-manager.js:952, looked healthy in every surface, and
// 400'd every single request. That session never reached Anthropic — total,
// silent feature loss for the affected agent.
//
// This is the shape the introspection audit calls Class A: each half correct,
// each half tested in its own file, the CONTRACT between them owned by nothing.
// So the test is deliberately a SEAM test — one corpus, both gates, asserted in
// both directions. Adding a case to CORPUS is how you extend it; there is no
// per-regex list to keep in sync, which is the whole point.

const test = require('node:test');
const assert = require('node:assert');

const { AGENT_NAME_RE } = require('../catalogs');
const { parseAgentPath } = require('../wire/route');

// creatable: what catalogs.js MUST say. The routing side is not listed — the
// contract under test is that it says the same thing, so stating it twice would
// let the file pass while the two disagree.
const CORPUS = [
  // ── plain names ──────────────────────────────────────────────────────────
  ['clodex', true],
  ['ok1', true],
  ['9x', true],
  ['a_b', true],
  ['a.b-c_d', true],
  ['my-agent_1.2', true],
  ['A', true],
  ['clodex-hand-5', true],
  // ── the F004 cases: creatable, and the router used to refuse them ────────
  ['_scratch', true],
  ['.hidden', true],
  ['-dash', true],
  ['..a', true],
  ['a..', true],
  ['.a', true],
  ['_', true],
  ['-', true],
  // ── dot-only runs: refused by BOTH, and t115 is why (name-dot-only.test.js)
  ['.', false],
  ['..', false],
  ['...', false],
  ['....', false],
  // ── charset ──────────────────────────────────────────────────────────────
  ['', false],
  ['bad name', false],
  ['a/b', false],
  ['a\\b', false],
  ['a:b', false],
  ['a%2fb', false],
  ['a?b', false],
  ['a#b', false],
  ['naïve', false],
  // ── length: 64 is the ceiling on both sides ──────────────────────────────
  ['x'.repeat(64), true],
  ['x'.repeat(65), false],
];

// The router only ever sees a name inside a path, so route it the way proxy.js
// does (`/agent/<name>/v1/messages`) rather than testing its literal. A name is
// routable only if it round-trips: extracting some OTHER string would be a
// different bug wearing the same green tick.
function routable(name) {
  const parsed = parseAgentPath(`/agent/${name}/v1/messages`);
  return !!parsed && parsed.agent === name && parsed.rest === '/v1/messages';
}

test('every creatable agent name is routable, and vice versa', () => {
  const divergent = [];
  for (const [name, creatable] of CORPUS) {
    const c = AGENT_NAME_RE.test(name);
    const r = routable(name);
    assert.equal(c, creatable,
      `catalogs AGENT_NAME_RE: expected ${JSON.stringify(name)} to be `
      + `${creatable ? 'creatable' : 'refused'}`);
    if (c !== r) divergent.push(`${JSON.stringify(name)} creatable=${c} routable=${r}`);
  }
  assert.deepEqual(divergent, [],
    'a name the creation gate and the wire router disagree about is a session '
    + 'that starts, looks healthy, and 400s forever (F004): ' + divergent.join('; '));
});

// The bare-name check above cannot see a name that escapes its own path
// segment, because a `/` fails both gates for the same boring charset reason.
// These pin the traversal shapes directly at the router, where the damage would
// be, so loosening the charset later cannot quietly re-open them.
test('the router refuses a dot segment even with a path after it', () => {
  assert.equal(parseAgentPath('/agent/../v1/messages'), null);
  assert.equal(parseAgentPath('/agent/./v1/messages'), null);
  assert.equal(parseAgentPath('/agent/...'), null);
  assert.equal(parseAgentPath('/agent/'), null);
  assert.equal(parseAgentPath('/agent'), null);
});

// The names in CORPUS marked creatable are exactly the ones the app can mint,
// so a name that routes but CANNOT be created is the mirror hazard: the router
// would carry traffic for an identity no gate ever issued. proxy.js:229 still
// requires a registered token, so this is defence in depth rather than the only
// check — but the two rules agreeing is what makes that argument checkable.
test('the router admits nothing the creation gate would refuse', () => {
  const admitted = CORPUS
    .filter(([name, creatable]) => !creatable && routable(name))
    .map(([name]) => JSON.stringify(name));
  assert.deepEqual(admitted, [],
    'the wire router would route these names, but no gate in the app can mint '
    + 'them: ' + admitted.join(', '));
});
