'use strict';
// Run: node --test test/prefs-account-row.test.js
//
// t812 — the Preferences ▸ Accounts row. Same shape and same reason as
// test/prefs-env-row.test.js: the builder takes its `document` as a parameter so
// the classes and the per-kind BUTTON SET are assertable without a browser.
//
// The button set is the claim that bites. `default` is the implicit account:
// it has no registry row to remove and it is the SOURCE settings are copied
// FROM, so Re-sync and Remove must not exist on it — accounts.js refuses both
// with an error, and a row that offered them would make the pane's only
// feedback an error string the operator triggered by clicking what we drew.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { accountRowView, buildAccountRow } = require('../renderer/lib/account-row');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

function fakeDoc() {
  const make = (tag) => ({
    tag, className: '', textContent: '', title: undefined, type: undefined,
    dataset: {}, children: [],
    appendChild(c) { this.children.push(c); return c; },
  });
  return { createElement: make };
}

const HOME = '/home/u';
const DEFAULT = { label: 'default', email: null, configDir: `${HOME}/.claude`, plan: 'unknown' };
const SUB2 = { label: 'sub-2', email: 'two@x.com', configDir: '/minted/sub-2', plan: 'max' };

const build = (a, seats = 0) => buildAccountRow(fakeDoc(), accountRowView(a, seats, HOME));

// --- the view ----------------------------------------------------------------

test('accountRowView: a registered row, as literals', () => {
  assert.deepStrictEqual(accountRowView(SUB2, 3, HOME), {
    label: 'sub-2',
    isDefault: false,
    email: 'two@x.com',
    plan: 'max',
    dir: '/minted/sub-2',
    seats: '3 seats',
    dirTitle: '/minted/sub-2',
  });
});

test('accountRowView: the default row abbreviates ~ and carries no plan', () => {
  assert.deepStrictEqual(accountRowView(DEFAULT, 1, HOME), {
    label: 'default',
    isDefault: true,
    email: '—',
    plan: '',
    dir: '~/.claude',
    seats: '1 seat',
    dirTitle: `${HOME}/.claude`,
  });
});

test('accountRowView: the seat count is a count, and zero says so rather than going blank', () => {
  assert.strictEqual(accountRowView(SUB2, 0, HOME).seats, '0 seats');
  assert.strictEqual(accountRowView(SUB2, undefined, HOME).seats, '0 seats');
});

// --- the built row -----------------------------------------------------------

test('a registered row carries the layout CLASS, its label, and NO inline style', () => {
  const { row } = build(SUB2, 2);
  assert.strictEqual(row.className, 'prefs-account-row');
  assert.strictEqual(row.dataset.label, 'sub-2');
  const classes = row.children.map((c) => c.className);
  assert.deepStrictEqual(classes, [
    'prefs-account-name',
    'hint-text prefs-account-email',
    'prefs-account-plan',
    'hint-text prefs-account-dir',
    'hint-text prefs-account-seats',
    'secondary prefs-account-login',
    'secondary prefs-account-move',
    'secondary prefs-account-resync',
    'secondary prefs-account-remove',
  ]);
  // An inline style cannot be overridden by a stylesheet rule, so a builder that
  // set one back would defeat the class it also sets.
  for (const el of [row, ...row.children]) {
    assert.strictEqual(el.style, undefined, `${el.tag} must not carry an inline style`);
  }
});

test('the DEFAULT row has Log in ONLY — no Move, no Re-sync, no Remove', () => {
  const { row, login, move, resync, remove } = build(DEFAULT, 1);
  assert.ok(login, 'every account can be logged into');
  assert.strictEqual(move, null, 'moving seats TO default is Move-on-a-registered-row inverted; not offered here');
  assert.strictEqual(resync, null, 'the default IS the source settings are copied from');
  assert.strictEqual(remove, null, 'the default is implicit — there is no registry row to drop');
  const buttons = row.children.filter((c) => c.tag === 'button');
  assert.deepStrictEqual(buttons.map((b) => b.textContent), ['Log in']);
  // ENTER: a registered row really does get the other three, so the absence
  // above is per-kind and not a builder that draws no buttons at all.
  const reg = build(SUB2, 0);
  assert.deepStrictEqual(
    reg.row.children.filter((c) => c.tag === 'button').map((b) => b.textContent),
    ['Log in', 'Move', 'Re-sync settings', 'Remove'],
  );
});

test('every button is type=button, or a click inside a form would submit it', () => {
  const { row } = build(SUB2, 0);
  for (const b of row.children.filter((c) => c.tag === 'button')) {
    assert.strictEqual(b.type, 'button');
  }
});

test('the full config dir stays in the TITLE while the cell shows the abbreviated one', () => {
  const { row } = build(DEFAULT, 0);
  const dir = row.children.find((c) => c.className === 'hint-text prefs-account-dir');
  assert.strictEqual(dir.textContent, '~/.claude');
  assert.strictEqual(dir.title, `${HOME}/.claude`);
});

test('the row classes the builder sets exist in the stylesheet', () => {
  // The builder above pins that the class is SET; without this the pane could
  // ship every row unstyled and stacked, and both halves would be green.
  for (const cls of ['.prefs-account-row', '.prefs-account-name', '.prefs-account-dir', '.prefs-account-seats']) {
    assert.ok(css.includes(cls), `${cls} is not defined in styles.css`);
  }
  const rowRule = css.slice(css.indexOf('.prefs-account-row {'));
  assert.match(rowRule.slice(0, 120), /display: flex/, 'the row lays out horizontally');
});
