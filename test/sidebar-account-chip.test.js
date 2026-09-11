'use strict';
// Run: node --test test/sidebar-account-chip.test.js
//
// t812 — the account chip on a sidebar row. The whole claim is CONDITIONAL
// rendering: the label shows only when it is not `default`. Almost every seat
// in almost every workspace is on `default`, so a chip that painted
// unconditionally would add a pill to every row in the sidebar — a regression
// nothing else here would catch, because the chip would be "working".
//
// The shipped source is EXTRACTED AND RUN, the idiom of
// test/plugins-dialog-fits.test.js: renderer.js cannot be required (DOM-bound,
// window.api at load), and a source-shape grep for the chip's markup would pass
// over a template that emits it with the wrong condition, or onto a node that is
// never appended.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
const { DEFAULT_LABEL } = require('../renderer/lib/account-select');

// The smallest node the builder touches: dataset, innerHTML (kept as the raw
// string — the assertions below read the emitted MARKUP, which is what the
// browser would parse), addEventListener, querySelector.
function fakeNode() {
  return {
    tag: 'div', className: '', dataset: {}, innerHTML: '',
    addEventListener() {},
    querySelector() { return { addEventListener() {} }; },
  };
}

// Every renderer.js-scope name addSessionToSidebar closes over. A name missing
// here is a ReferenceError at call time, not a silent pass.
const FREE = [
  'document', 'window', 'esc', 'baseName', 'typeGlyph', 'ACCOUNT_DEFAULT',
  'switchSession', 'openSessionInfoPopover', 'archiveSessionRow', 'startRename',
  'insertLocalSessionRow', 'sidebarMeta', 'scheduleSidebarRelayout',
];

function loadBuilder() {
  const start = rendererSrc.indexOf('function addSessionToSidebar(');
  assert.ok(start >= 0, 'ENTER: addSessionToSidebar was not found in the shipped renderer');
  const end = rendererSrc.indexOf('\n}\n', start);
  assert.ok(end > start, 'ENTER: the end of addSessionToSidebar was not found');
  const body = rendererSrc.slice(start, end + 2);
  assert.match(body, /session-account/, 'ENTER: the slice captured the account chip');

  let made = null;
  const env = {
    document: { createElement: () => { made = fakeNode(); return made; } },
    window: { api: { flushPending: async () => ({ ok: true }), showSessionContextMenu() {} } },
    esc: (s) => String(s),
    baseName: (p) => String(p || '').split('/').filter(Boolean).pop() || '',
    typeGlyph: () => 'A',
    ACCOUNT_DEFAULT: DEFAULT_LABEL,
    switchSession() {}, openSessionInfoPopover() {}, archiveSessionRow() {},
    startRename() {}, insertLocalSessionRow() {},
    sidebarMeta: new Map(),
    scheduleSidebarRelayout() {},
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function(...FREE, `${body}; return addSessionToSidebar;`)(...FREE.map((n) => env[n]));
  return (account) => {
    fn('seat-a', 'claude', '/proj/app', null, null, null, false, account);
    return made;
  };
}

const build = loadBuilder();

// The chip's own element, by the selector applyAccountChip uses. Matched
// non-greedily so a later `<span class="session-...">` cannot be swallowed in.
function chipOf(html) {
  const m = /<span class="session-account"([^>]*)>([\s\S]*?)<\/span>/.exec(html);
  return m ? { attrs: m[1], text: m[2] } : null;
}

test('a NON-default account paints the chip with its label and the account tooltip', () => {
  const item = build('sub-2');
  assert.strictEqual(item.dataset.account, 'sub-2', 'the row carries the label for the refresh loop to read');
  const chip = chipOf(item.innerHTML);
  assert.ok(chip, 'the chip element is in the emitted markup');
  assert.strictEqual(chip.text, 'sub-2');
  assert.strictEqual(chip.attrs, ' data-tip="account sub-2"');
});

test('`default` renders NO chip — the common row is visually unchanged', () => {
  const item = build(DEFAULT_LABEL);
  // Assert the ROW exists first, or an empty innerHTML would satisfy the
  // absence below while proving nothing at all (ENTER).
  assert.match(item.innerHTML, /class="session-name"/, 'ENTER: the row really was built');
  assert.match(item.innerHTML, /class="session-badges"/, 'ENTER: and it has a badge strip to hold a chip');
  const chip = chipOf(item.innerHTML);
  assert.ok(chip, 'the chip SLOT is always emitted — applyAccountChip fills it later without a rebuild');
  assert.strictEqual(chip.text, '', 'but it is empty, so `.session-account:empty` hides it');
  assert.strictEqual(chip.attrs, '', 'and it carries no tooltip claiming an account');
  assert.strictEqual('account' in item.dataset, false, 'nor does the row claim one in its dataset');
});

test('no account at all (a row built before the label is known) is the same as default', () => {
  for (const missing of [null, undefined, '']) {
    const item = build(missing);
    assert.strictEqual(chipOf(item.innerHTML).text, '', `${String(missing)} paints nothing`);
    assert.strictEqual('account' in item.dataset, false);
  }
});

test('the chip is INSIDE .session-badges, where applyAccountChip and the CSS look for it', () => {
  const html = build('sub-2').innerHTML;
  const open = html.indexOf('<span class="session-badges">');
  const close = html.indexOf('</span>\n      </div>', open);
  assert.ok(open >= 0 && close > open, 'ENTER: the badge strip was located');
  assert.ok(html.indexOf('<span class="session-account"') > open, 'the chip is after the strip opens');
  assert.ok(html.indexOf('<span class="session-account"') < close, 'and before it closes');
});

test('an account label is ESCAPED on its way into the markup and the tooltip', () => {
  // Labels are registry-constrained today, but the row is also built from a
  // session:list `account` that falls back to a DIRECTORY BASENAME — which the
  // operator types by hand into an env box and which is under no such grammar.
  const src = rendererSrc.slice(rendererSrc.indexOf('function addSessionToSidebar('));
  const chipLine = /const accountChip = [^\n]*\n/.exec(src);
  assert.ok(chipLine, 'ENTER: the chip text is computed on its own line');
  assert.match(chipLine[0], /esc\(account\)/, 'the chip text goes through esc()');
  const markup = /<span class="session-account"[^\n]*\n/.exec(src);
  assert.match(markup[0], /data-tip="account \$\{esc\(account\)\}"/, 'and so does the tooltip');
});

test('applyAccountChip clears the row when a seat MOVES back to default', () => {
  // The move action restarts a seat onto another account, so the chip has to
  // come and GO on the refresh loop. A clear that only blanked the text would
  // leave `dataset.account` claiming the old one to every reader of the row.
  const start = rendererSrc.indexOf('function applyAccountChip(');
  assert.ok(start >= 0, 'ENTER: applyAccountChip was not found in the shipped renderer');
  const body = rendererSrc.slice(start, rendererSrc.indexOf('\n}\n', start) + 2);

  const chip = { textContent: 'sub-2', dataset: { tip: 'account sub-2' } };
  const row = { dataset: { account: 'sub-2' }, querySelector: () => chip };
  const env = {
    sessionList: { querySelector: () => row },
    CSS: { escape: (s) => s },
    ACCOUNT_DEFAULT: DEFAULT_LABEL,
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const apply = new Function(...names, `${body}; return applyAccountChip;`)(...names.map((n) => env[n]));

  apply('seat-a', DEFAULT_LABEL);
  assert.strictEqual(chip.textContent, '');
  assert.strictEqual('tip' in chip.dataset, false, 'the stale tooltip is dropped, not left behind');
  assert.strictEqual('account' in row.dataset, false, 'and so is the stale dataset claim');

  // ENTER: the same function DOES set both back, so the clears above are a
  // clear and not a function that writes nothing.
  apply('seat-a', 'sub-3');
  assert.strictEqual(chip.textContent, 'sub-3');
  assert.strictEqual(chip.dataset.tip, 'account sub-3');
  assert.strictEqual(row.dataset.account, 'sub-3');
});

test('.session-account:empty is hidden, or the default row would keep an empty pill', () => {
  assert.match(cssSrc, /\.session-account:empty\s*\{\s*display:\s*none;?\s*\}/,
    'the empty chip slot must collapse');
});
