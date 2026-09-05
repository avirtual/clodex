'use strict';
// Run: node --test test/prefs-env-row.test.js
//
// t676 — the Preferences ▸ Env row. Two claims, neither visible from renderer.js
// (which has no harness), which is why the row builder takes its `document` as a
// parameter:
//
//   the NAME must not truncate before the VALUE does. The row was built with
//   inline `flex:1` on the key against `flex:2` on the value, so
//   CLAUDE_CODE_BASH_OUTPUT_AUDIENCE_NOTE ellipsised to CLAUDE_CODE_BASH_OU…
//   while `off` sat in two thirds of the row. The layout numbers themselves are
//   not testable without a browser, so what is pinned here is that the row
//   carries the CSS CLASS that holds them and no inline layout at all — plus a
//   CSS-side assertion that the class actually says what it must.
//
//   the shipped MARKER tracks the value, not just the key. A row shows it only
//   while the operator's value still equals the one Clodex ships; an edit drops
//   it, which is the only way the marker means anything.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { envRowView, buildEnvRow } = require('../renderer/lib/env-row');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

// The smallest document the builder touches: createElement, className/textContent/
// title, appendChild. Deliberately not jsdom — the assertions are about which
// attributes get set, and a real DOM would add nothing but a dependency.
function fakeDoc() {
  const make = (tag) => ({
    tag, className: '', textContent: '', title: undefined, children: [],
    appendChild(c) { this.children.push(c); return c; },
  });
  return { createElement: make };
}

const DEFAULTS = {
  CLAUDE_CODE_BASH_OUTPUT_AUDIENCE_NOTE: { value: 'off', note: 'drops the audience note' },
};

const LONG = 'CLAUDE_CODE_BASH_OUTPUT_AUDIENCE_NOTE';

const build = (v, defaults = {}) => buildEnvRow(fakeDoc(), envRowView(v, defaults));

// --- the name column ---------------------------------------------------------

test('the row carries the layout CLASS and sets NO inline style', () => {
  const { row, keyEl, valEl } = build({ key: LONG, value: 'off', secret: false });
  assert.strictEqual(row.className, 'prefs-env-row');
  assert.strictEqual(keyEl.className, 'prefs-env-name');
  assert.strictEqual(valEl.className, 'hint-text prefs-env-val');
  // An inline style cannot be overridden by a stylesheet rule, so a builder that
  // set one back would defeat the class it also sets — green on the class
  // assertion above and broken on screen.
  for (const el of [row, keyEl, valEl]) {
    assert.strictEqual(el.style, undefined, `${el.tag} must not carry an inline style`);
  }
});

test('the CSS class lets the name take what it needs and the value take the rest', () => {
  // The bug was entirely in these two declarations, so they are worth asserting
  // as text: `flex: 1` on the name against `flex: 2` on the value is what cut
  // the name first. Both need min-width:0 or neither shrinks inside a flex row.
  const rule = (sel) => {
    const m = css.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`));
    assert.ok(m, `styles.css must carry a ${sel} rule`);
    return m[1];
  };
  const name = rule('.prefs-env-row .prefs-env-name');
  assert.match(name, /flex:\s*0 1 auto/, 'the name is sized to its content, not a fraction of the row');
  assert.match(name, /min-width:\s*0/);
  assert.match(name, /white-space:\s*nowrap/);
  assert.match(name, /text-overflow:\s*ellipsis/, 'a name longer than the whole row still ellipsises');

  const val = rule('.prefs-env-row .prefs-env-val');
  assert.match(val, /flex:\s*1 1 auto/, 'the value takes the remaining width');
  assert.match(val, /min-width:\s*0/);
  assert.match(val, /text-overflow:\s*ellipsis/);

  assert.match(rule('.prefs-env-row button'), /flex:\s*none/, 'the buttons never shrink');
});

test('renderer.js builds env rows through the shared builder, not inline cssText', () => {
  // The builder is only the fix if the renderer actually calls it. The old row
  // is one `row.style.cssText = 'display:flex…'` away from coming back, and
  // every assertion above would stay green.
  assert.match(rendererSrc, /buildEnvRow\(document, envRowView\(/,
    'refreshPrefsEnv must build its rows through renderer/lib/env-row.js');
  const fn = rendererSrc.slice(rendererSrc.indexOf('async function refreshPrefsEnv'),
    rendererSrc.indexOf('async function addPrefsEnvVar'));
  assert.ok(fn.length > 200, 'ENTER: refreshPrefsEnv was actually located in the source');
  assert.doesNotMatch(fn, /cssText/, 'no inline layout may survive in the row loop');
});

test('the workspace-scope toggle hides the Restore button\'s ROW, not the button alone', () => {
  // Hiding just the button leaves its wrapping .prefs-row's margin-top as an
  // empty gap under the workspace scope — the row is what must go.
  const fn = rendererSrc.slice(rendererSrc.indexOf('async function refreshPrefsEnv'),
    rendererSrc.indexOf('async function addPrefsEnvVar'));
  assert.match(fn, /prefsEnvRestoreRow\.style\.display = scope === 'global' \? '' : 'none';/,
    'the row wrapper is what toggles, not prefsEnvRestore itself');
});

// --- titles ------------------------------------------------------------------

test('a long name and its value both carry the full text as a title', () => {
  const { keyEl, valEl } = build({ key: LONG, value: 'off', secret: false }, DEFAULTS);
  assert.strictEqual(keyEl.title, `${LONG} — drops the audience note`, 'a shipped key hovers its note');
  assert.strictEqual(valEl.title, `${LONG}=off`);
});

test('a key with no shipped note still hovers its own full name', () => {
  const { keyEl, valEl } = build({ key: LONG, value: 'off', secret: false });
  assert.strictEqual(keyEl.title, LONG, 'the ellipsised name must be readable on hover regardless');
  assert.strictEqual(valEl.title, `${LONG}=off`);
});

test('a secret row hovers no value — the title is another place bytes could leak', () => {
  const { keyEl, valEl } = build({ key: 'TOK', secret: true, hasValue: true }, DEFAULTS);
  assert.strictEqual(keyEl.title, 'TOK');
  assert.strictEqual(valEl.title, 'TOK is stored write-only');
  assert.strictEqual(valEl.textContent, '•••••••• (secret — set)');
  assert.ok(!JSON.stringify(valEl).includes('hasValue'), 'nothing but the mask reaches the cell');
});

// --- the shipped marker ------------------------------------------------------

const markerOf = (row) => row.children.find((c) => c.className === 'prefs-env-shipped');

test('the marker shows while the value equals the shipped one, and goes when it is edited', () => {
  const pristine = build({ key: LONG, value: 'off', secret: false }, DEFAULTS);
  const marker = markerOf(pristine.row);
  assert.ok(marker, 'a pristine shipped key is marked');
  assert.strictEqual(marker.textContent, 'shipped');

  const edited = build({ key: LONG, value: 'on', secret: false }, DEFAULTS);
  assert.strictEqual(markerOf(edited.row), undefined,
    'an edited value drops the marker — a marker that tracked only the KEY would claim the shipped '
    + 'value is in force while the operator has replaced it');
});

test('a key Clodex does not ship is never marked', () => {
  assert.strictEqual(markerOf(build({ key: 'AWS_PROFILE', value: 'acct', secret: false }, DEFAULTS).row), undefined);
});

test('a shipped key stored as a SECRET is not marked', () => {
  // The value is masked out of the IPC result, so there is nothing to compare —
  // marking it would be asserting a match nothing checked.
  assert.strictEqual(markerOf(build({ key: LONG, secret: true, hasValue: true }, DEFAULTS).row), undefined);
});

test('the marker sits between the name and the value, so neither is displaced', () => {
  const { row } = build({ key: LONG, value: 'off', secret: false }, DEFAULTS);
  assert.deepStrictEqual(row.children.map((c) => c.className),
    ['prefs-env-name', 'prefs-env-shipped', 'hint-text prefs-env-val']);
});

test('an empty-string value is a legitimate row, not an absent one', () => {
  const { valEl } = build({ key: 'EMPTY', value: '', secret: false });
  assert.strictEqual(valEl.textContent, '');
  assert.strictEqual(valEl.title, 'EMPTY=');
});
