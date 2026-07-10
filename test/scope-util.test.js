'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { scopeOf, visibleTo, autoEnabledFor, unionEnabled, reconcilePartialSelection } = require('../scope-util');

// --- scopeOf: normalize the two optional frontmatter keys -------------------
test('scopeOf: absent keys → empty scope (global)', () => {
  assert.deepStrictEqual(scopeOf({}), { workspace: '', sessions: [] });
  assert.deepStrictEqual(scopeOf(null), { workspace: '', sessions: [] });
  assert.deepStrictEqual(scopeOf({ name: 'x', description: 'y' }), { workspace: '', sessions: [] });
});

test('scopeOf: workspace trims; sessions splits the comma-list', () => {
  assert.deepStrictEqual(scopeOf({ workspace: '  trading ' }), { workspace: 'trading', sessions: [] });
  assert.deepStrictEqual(scopeOf({ sessions: 'stocks, trader ,  ' }),
    { workspace: '', sessions: ['stocks', 'trader'] });
  assert.deepStrictEqual(scopeOf({ workspace: 'trading', sessions: 'a,b' }),
    { workspace: 'trading', sessions: ['a', 'b'] });
});

// --- visibleTo: the offer-surface predicate ---------------------------------
test('visibleTo: global (no scope) is visible to everyone, even empty ctx', () => {
  assert.equal(visibleTo({}, {}), true);
  assert.equal(visibleTo({}, { session: 'x', workspace: 'y' }), true);
  assert.equal(visibleTo({ name: 'z' }, { session: 'anything' }), true);
});

test('visibleTo: workspace-scoped matches only its workspace display name', () => {
  const meta = { workspace: 'trading' };
  assert.equal(visibleTo(meta, { workspace: 'trading' }), true);
  assert.equal(visibleTo(meta, { workspace: 'default' }), false);
  assert.equal(visibleTo(meta, { session: 'trading' }), false); // not a session match
  assert.equal(visibleTo(meta, {}), false);                      // no ws in ctx
});

test('visibleTo: sessions-scoped matches only named sessions', () => {
  const meta = { sessions: 'stocks, trader' };
  assert.equal(visibleTo(meta, { session: 'stocks' }), true);
  assert.equal(visibleTo(meta, { session: 'trader' }), true);
  assert.equal(visibleTo(meta, { session: 'clodex' }), false);
  assert.equal(visibleTo(meta, { workspace: 'stocks' }), false); // not a ws match
  assert.equal(visibleTo(meta, {}), false);
});

test('visibleTo: both keys → union (either axis grants visibility)', () => {
  const meta = { workspace: 'trading', sessions: 'stocks' };
  assert.equal(visibleTo(meta, { workspace: 'trading', session: 'other' }), true); // ws axis
  assert.equal(visibleTo(meta, { workspace: 'other', session: 'stocks' }), true);  // session axis
  assert.equal(visibleTo(meta, { workspace: 'other', session: 'nope' }), false);   // neither
});

// --- autoEnabledFor: the spawn-seam auto-include ----------------------------
test('autoEnabledFor: returns sessions-scoped names for the session, in list order', () => {
  const lib = [
    { name: 'global-a', meta: {} },
    { name: 'crypto', meta: { sessions: 'trader, stocks' } },
    { name: 'ws-only', meta: { workspace: 'trading' } },   // ws scope is NOT auto-included
    { name: 'both', meta: { workspace: 'trading', sessions: 'stocks' } },
  ];
  assert.deepStrictEqual(autoEnabledFor(lib, 'stocks'), ['crypto', 'both']);
  assert.deepStrictEqual(autoEnabledFor(lib, 'trader'), ['crypto']);
  assert.deepStrictEqual(autoEnabledFor(lib, 'clodex'), []); // named nowhere
});

test('autoEnabledFor: no session / empty library → nothing', () => {
  assert.deepStrictEqual(autoEnabledFor([{ name: 'x', meta: { sessions: 'a' } }], null), []);
  assert.deepStrictEqual(autoEnabledFor(null, 'a'), []);
});

// --- unionEnabled: persisted ∪ auto-include, dedup, persisted first ---------
test('unionEnabled: unions persisted selection with sessions-scoped auto-includes', () => {
  const lib = [
    { name: 'crypto', meta: { sessions: 'stocks' } },
    { name: 'manual', meta: {} },
  ];
  // persisted 'manual' kept; 'crypto' auto-added; order = persisted first.
  assert.deepStrictEqual(unionEnabled(['manual'], lib, 'stocks'), ['manual', 'crypto']);
});

test('unionEnabled: dedups when a scoped item is also persisted-enabled', () => {
  const lib = [{ name: 'crypto', meta: { sessions: 'stocks' } }];
  assert.deepStrictEqual(unionEnabled(['crypto'], lib, 'stocks'), ['crypto']);
});

test('unionEnabled: no auto-includes → persisted unchanged; empty persisted safe', () => {
  const lib = [{ name: 'crypto', meta: { sessions: 'other' } }];
  assert.deepStrictEqual(unionEnabled(['a', 'b'], lib, 'stocks'), ['a', 'b']);
  assert.deepStrictEqual(unionEnabled(null, lib, 'stocks'), []);
});

// --- reconcilePartialSelection: the scoped-checklist Save semantics ----------
test('reconcile: an out-of-scope persisted item (never rendered) survives Save', () => {
  // Rendered only [g1, g2]; user unchecked g2. Persisted also had 'hidden'
  // (out of scope, not rendered) — it must NOT be dropped.
  assert.deepStrictEqual(
    reconcilePartialSelection(['g1', 'g2', 'hidden'], ['g1', 'g2'], ['g1']).sort(),
    ['g1', 'hidden']);
});

test('reconcile: checked rendered items win; unchecked rendered items drop', () => {
  assert.deepStrictEqual(
    reconcilePartialSelection([], ['a', 'b', 'c'], ['a', 'c']).sort(), ['a', 'c']);
});

test('reconcile: auto names are excluded from the saved set (never persisted)', () => {
  // 'crypto' is auto (rendered checked+disabled → collected as checked), but must
  // not be written to the record — the spawn union re-adds it.
  assert.deepStrictEqual(
    reconcilePartialSelection(['manual'], ['manual', 'crypto'], ['manual', 'crypto'], ['crypto']),
    ['manual']);
});

test('reconcile: auto exclusion + out-of-scope survival compose', () => {
  assert.deepStrictEqual(
    reconcilePartialSelection(['keep-hidden', 'manual'], ['manual', 'crypto'], ['manual', 'crypto'], ['crypto']).sort(),
    ['keep-hidden', 'manual']);
});
