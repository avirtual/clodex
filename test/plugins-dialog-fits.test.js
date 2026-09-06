'use strict';

// The Manage Plugins dialog is a flex column: the frame scrolls nothing, the
// list scrolls alone, so the Register / Install / Open Folder / Re-scan / Close
// bar cannot leave the screen with the rows. An `overflow: auto` back on
// #plugins-dialog restores the shipped defect, which is what the first subject
// forbids by value rather than by absence.
//
// The row subjects EXTRACT renderPluginsDialog from the shipped renderer.js and
// RUN it against stubs, rather than grepping its source. renderer.js cannot be
// required (DOM-bound, window.api at load), and a source-shape scan for
// `title = p.linkedFrom` passes over a title assigned to the wrong node or onto
// a node never appended — the idiom is test/plugin-dialog-snapshot.test.js's.
// Running it asserts the tree the operator actually gets: which node carries
// which class, which carries the untruncated text as its tooltip, and that every
// row button lands inside the .plugin-row-actions wrapper the column layout
// needs rather than directly on the row.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Comments carry no braces, so an un-stripped one is captured as part of the
// NEXT rule's selector and every lookup here silently misses.
const css = fs.readFileSync(path.join(ROOT, 'renderer/styles.css'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf-8');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf-8');

function rules(selectorRe) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => sel.split(',').some((s) => selectorRe.test(s.trim())))
    .map(([, sel, body]) => ({ sel: sel.trim(), body }));
}

function lastDeclaration(selectorRe, prop) {
  let value = null;
  for (const r of rules(selectorRe)) {
    const m = r.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
    if (m) value = m[1].trim();
  }
  return value;
}

// ── layout ──────────────────────────────────────────────────────────────────

test('the plugins dialog frame is a flex column that scrolls nothing', () => {
  assert.ok(rules(/^#plugins-dialog$/).length >= 1, 'ENTER: the #plugins-dialog frame rule was found');
  assert.strictEqual(lastDeclaration(/^#plugins-dialog$/, 'flex-direction'), 'column');
  assert.strictEqual(lastDeclaration(/^#plugins-dialog$/, 'overflow'), 'hidden',
    'overflow:auto on the frame is the shipped defect: the action bar scrolls away with the rows');
});

test('the list is the only thing that scrolls, and it can shrink to let it', () => {
  assert.ok(rules(/^#plugins-list$/).length >= 1, 'ENTER: the #plugins-list rule was found');
  assert.strictEqual(lastDeclaration(/^#plugins-list$/, 'overflow-y'), 'auto');
  assert.strictEqual(lastDeclaration(/^#plugins-list$/, 'min-height'), '0',
    'a flex child defaults to min-height:auto and refuses to shrink below its content, '
    + 'which pushes the action bar out of the frame instead of scrolling');
});

test('five action buttons wrap at the min-width instead of overflowing', () => {
  assert.strictEqual(lastDeclaration(/^#plugins-dialog \.dialog-actions$/, 'flex-wrap'), 'wrap');
  assert.strictEqual(lastDeclaration(/^#plugins-dialog \.dialog-actions$/, 'flex-shrink'), '0');
});

test('the description clamps to two lines and the path and source to one', () => {
  assert.strictEqual(lastDeclaration(/^\.plugin-row-note\.plugin-row-desc$/, '-webkit-line-clamp'), '2');
  assert.strictEqual(lastDeclaration(/^\.plugin-row-note\.plugin-row-path$/, 'text-overflow'), 'ellipsis');
  assert.strictEqual(lastDeclaration(/^\.plugin-row-note\.plugin-row-path$/, 'direction'), 'rtl',
    'the plugin folder name is at the END of the path — the ellipsis must eat the left');
  assert.strictEqual(lastDeclaration(/^\.plugin-row-note\.plugin-row-src$/, 'text-overflow'), 'ellipsis');
});

test('a warning note is never clamped', () => {
  for (const prop of ['-webkit-line-clamp', 'text-overflow']) {
    assert.strictEqual(lastDeclaration(/^\.plugin-row-note\.warn$/, prop), null,
      `a truncated error is worse than a tall row, so .warn must not carry ${prop}`);
  }
});

// ── the hint ────────────────────────────────────────────────────────────────

test('the hint is the two-sentence version', () => {
  assert.ok(html.includes('Plugins extend Clodex in-process. Turning one off removes its buttons, '
    + 'panels and styles from every open window immediately; a plugin with its own settings '
    + 'shows a <strong>Settings</strong> button on its row.'), 'the new hint is not in index.html');
  assert.ok(!html.includes('CLODEX_PLUGINS=0'),
    'the dropped sentences are row warnings and button tooltips now, not a wall above the list');
});

// ── the row builder, extracted and run ──────────────────────────────────────

function el(tag) {
  const e = {
    tagName: tag, className: '', title: '', type: '', value: '', checked: false, disabled: false,
    children: [], dataset: {}, style: {},
    appendChild(c) { e.children.push(c); return c; },
    addEventListener() {},
    classList: { add() {}, remove() {}, contains: () => false },
  };
  let html_ = '';
  Object.defineProperty(e, 'innerHTML', {
    get: () => html_,
    set(v) { html_ = v == null ? '' : String(v); if (html_ === '') e.children = []; },
  });
  let text = '';
  Object.defineProperty(e, 'textContent', { get: () => text, set(v) { text = v == null ? '' : String(v); } });
  return e;
}

// The free identifiers renderPluginsDialog closes over in renderer.js. A name
// missing here surfaces as a ReferenceError, not as a silent pass.
const FREE = ['pluginsList', 'window', 'document', 'sourceLine', 'pluginBar',
  'makePluginSettingsPanel', 'renderPluginsDialog', 'showPluginsRegisterNote',
  'openPluginsSourceUpdate', 'showToast', 'pluginsSourceTarget',
  'closePluginsSourceSection', 'confirm'];

function extractRenderPluginsDialog() {
  const start = rendererSrc.indexOf('async function renderPluginsDialog() {');
  assert.ok(start >= 0, 'renderPluginsDialog was not found in the shipped renderer');
  const end = rendererSrc.indexOf('function makePluginSettingsPanel(', start);
  assert.ok(end > start, 'the end of renderPluginsDialog was not found');
  const body = rendererSrc.slice(start, end);
  assert.match(body, /plugin-row-actions/, 'ENTER: the slice captured the row-actions wrapper');
  // eslint-disable-next-line no-new-func
  return new Function(...FREE, `${body}; return renderPluginsDialog;`);
}

async function renderRow(plugin) {
  const pluginsList = el('div');
  const settingsToggle = el('button');
  const fn = extractRenderPluginsDialog()(
    pluginsList,
    {
      api: { pluginInvoke: async () => ({ ok: true, plugins: [plugin], problems: [], shadowed: [] }) },
      __CLODEX_WEB__: false,
    },
    { createElement: el },
    (s) => `From github.com/${s.repo}`,
    { settingsSectionOwners: () => [plugin.id] },
    (p, rowActions) => { rowActions.appendChild(settingsToggle); return el('div'); },
    async () => {},
    () => {}, () => {}, () => {}, null, () => {}, () => true,
  );
  const got = await fn();
  assert.strictEqual(got.length, 1, 'ENTER: the fixture plugin reached the row loop');
  const row = pluginsList.children[0];
  assert.strictEqual(row.className, 'plugin-row', 'ENTER: the row is the first node in the list');
  return { row, settingsToggle };
}

const FIXTURE = {
  id: 'demo', name: 'Demo', version: '1.2.0', enabled: true,
  description: 'A long description that the dialog clamps to two lines and offers in full as a tooltip.',
  linkedFrom: '/Users/someone/very/long/path/to/a/checkout/clodex-demo-plugin',
  source: { repo: 'owner/demo', ref: 'main' },
};

function notes(row) {
  const body = row.children.find((c) => c.className === 'plugin-row-body');
  assert.ok(body, 'ENTER: the row has a body');
  return body.children;
}

test('the description node is clamped by class and carries the full text as its tooltip', async () => {
  const { row } = await renderRow(FIXTURE);
  const d = notes(row).find((c) => c.className === 'plugin-row-note plugin-row-desc');
  assert.ok(d, 'the description node must carry plugin-row-desc, or the clamp rule never applies');
  assert.strictEqual(d.textContent, FIXTURE.description);
  assert.strictEqual(d.title, FIXTURE.description,
    'clamping without a tooltip destroys information — the full text must be a hover away');
});

test('the registration path is one line and its tooltip is the untruncated path', async () => {
  const { row } = await renderRow(FIXTURE);
  const l = notes(row).find((c) => c.className === 'plugin-row-note plugin-row-path');
  assert.ok(l, 'the path node must carry plugin-row-path');
  assert.strictEqual(l.textContent, `Registered from ${FIXTURE.linkedFrom}`);
  assert.strictEqual(l.title, FIXTURE.linkedFrom,
    'the tooltip is the path itself: the ellipsis eats the left of it on screen');
});

test('the source line is one line and its tooltip is the whole sentence', async () => {
  const { row } = await renderRow(FIXTURE);
  const s = notes(row).find((c) => c.className === 'plugin-row-note plugin-row-src');
  assert.ok(s, 'the source node must carry plugin-row-src');
  assert.strictEqual(s.title, s.textContent,
    'an ellipsised line whose tooltip is not the full line shows the operator nothing new');
  assert.strictEqual(s.textContent, 'From github.com/owner/demo');
});

test('every row button lands in the actions column, none directly on the row', async () => {
  const { row, settingsToggle } = await renderRow({ ...FIXTURE, quarantined: true, failCount: 2 });
  const actions = row.children.find((c) => c.className === 'plugin-row-actions');
  assert.ok(actions, 'the row must build a .plugin-row-actions wrapper');
  const labels = actions.children.map((b) => b.textContent);
  assert.deepStrictEqual(labels, ['Retry', 'Unregister', 'Update…', 'Remove', ''],
    'all five buttons belong to the wrapper — the last is the Settings toggle, appended by '
    + 'makePluginSettingsPanel, which must be handed the wrapper and not the row');
  assert.ok(actions.children.includes(settingsToggle),
    'the settings toggle is the one button built elsewhere; it must still reach the column');
  assert.deepStrictEqual(
    row.children.map((c) => c.className),
    ['', 'plugin-row-body', 'plugin-row-actions'],
    'the row itself holds the checkbox, the body and the wrapper — a button appended straight '
    + 'to the row escapes the column layout and stretches it',
  );
});

test('a warning note keeps the unclamped class', async () => {
  const { row } = await renderRow({ ...FIXTURE, quarantined: true, failCount: 2, lastError: 'boom' });
  const w = notes(row).find((c) => c.className === 'plugin-row-note warn');
  assert.ok(w, 'the quarantine note must stay plain plugin-row-note warn');
  assert.match(w.textContent, /activate\(\) threw on 2 consecutive launches — boom/);
  assert.strictEqual(w.title, '', 'a note that is never clamped needs no tooltip');
});
