'use strict';

// What a Manage Plugins row SHOWS, over the extracted row builder: the
// "Update available" line (t741) and the origin glyph before the name (t758).
//
// The row builder is EXTRACTED from the shipped renderer.js and RUN against
// stubs, the idiom test/plugins-dialog-fits.test.js established: renderer.js
// cannot be required (DOM-bound, window.api at load), and a source-shape scan
// for the sentence passes over text written onto a node that is never appended.
//
// The stub dispatches BY METHOD, which is the point: `plugins.status` supplies
// the row and `plugins.updatesAvailable` supplies the badge, so a build that
// badged from the status reply — or from the catalog's `upToDate` flag, which is
// false for every installed plugin whenever the library repo moves — cannot
// reach these expectations.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf-8');
const { pluginOrigin } = require('../renderer/lib/plugin-origin');

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

const FREE = ['pluginsList', 'window', 'document', 'sourceLine', 'pluginBar',
  'makePluginSettingsPanel', 'renderPluginsDialog', 'showPluginsRegisterNote',
  'openPluginsSourceUpdate', 'showToast', 'pluginsSourceTarget',
  'closePluginsSourceSection', 'confirm', 'pluginOrigin'];

function extractRenderPluginsDialog() {
  const start = rendererSrc.indexOf('async function renderPluginsDialog() {');
  assert.ok(start >= 0, 'renderPluginsDialog was not found in the shipped renderer');
  const end = rendererSrc.indexOf('function makePluginSettingsPanel(', start);
  assert.ok(end > start, 'the end of renderPluginsDialog was not found');
  const body = rendererSrc.slice(start, end);
  assert.match(body, /plugins\.updatesAvailable/, 'ENTER: the slice captured the update read');
  // eslint-disable-next-line no-new-func
  return new Function(...FREE, `${body}; return renderPluginsDialog;`);
}

// `plugins` is what plugins.status answers with; `updates` is what
// plugins.updatesAvailable answers with. `asked` records the methods called.
async function renderRows(plugins, updates, asked = []) {
  const pluginsList = el('div');
  const fn = extractRenderPluginsDialog()(
    pluginsList,
    {
      api: {
        pluginInvoke: async (_id, method) => {
          asked.push(method);
          if (method === 'plugins.status') return { ok: true, plugins, problems: [], shadowed: [] };
          if (method === 'plugins.updatesAvailable') return { ok: true, updates };
          return { ok: true };
        },
      },
      __CLODEX_WEB__: false,
    },
    { createElement: el },
    (s) => `From github.com/${s.repo}`,
    { settingsSectionOwners: () => [] },
    () => el('div'),
    async () => {},
    () => {}, () => {}, () => {}, null, () => {}, () => true,
    pluginOrigin,
  );
  const got = await fn();
  assert.strictEqual(got.length, plugins.length,
    'ENTER: every fixture plugin reached the row loop, so an absent badge below is a verdict and not a missing row');
  return pluginsList.children;
}

function badgeOf(row) {
  const body = row.children.find((c) => c.className === 'plugin-row-body');
  assert.ok(body, 'ENTER: the row has a body to hold the note');
  return body.children.find((c) => /plugin-row-update/.test(c.className)) || null;
}

const INSTALLED = { id: 'demo', name: 'Demo', version: '1.1.0', enabled: true, source: { repo: 'avirtual/clodex-plugins', ref: null } };

test('only the plugin named in the confirmed list is badged', () => {
  // The whole ticket in one subject. Both rows are installed from the same
  // library repo, so the cheap `upToDate` flag would be false for both; the
  // checker confirmed only `demo`, and only `demo` may say so.
  const other = { ...INSTALLED, id: 'quiet', name: 'Quiet', version: '3.0.0' };
  return renderRows([INSTALLED, other], [{ id: 'demo', from: 'aaaaaaa', to: 'bbbbbbb', version: '1.2.0' }])
    .then((rows) => {
      assert.strictEqual(badgeOf(rows[0]).textContent, 'Update available (1.1.0 → 1.2.0)');
      assert.strictEqual(badgeOf(rows[1]), null, 'an unconfirmed row must carry no badge at all');
    });
});

test('an empty confirmed list badges nothing', async () => {
  const rows = await renderRows([INSTALLED], []);
  assert.strictEqual(badgeOf(rows[0]), null);
});

test('a version-less side falls back to the bare sentence instead of printing undefined', async () => {
  // Both directions: the manifest the checker fetched may have no version, and
  // so may the copy on disk. `Update available (1.1.0 → undefined)` is the
  // failure this covers.
  const noNew = await renderRows([INSTALLED], [{ id: 'demo', from: 'a', to: 'b', version: null }]);
  assert.strictEqual(badgeOf(noNew[0]).textContent, 'Update available');
  const noOld = await renderRows([{ ...INSTALLED, version: null }], [{ id: 'demo', from: 'a', to: 'b', version: '1.2.0' }]);
  assert.strictEqual(badgeOf(noOld[0]).textContent, 'Update available');
});

test('a refusal from the update read leaves the dialog rendering, unbadged', async () => {
  // plugins.updatesAvailable answers `{ ok: true, updates: [] }` when there is no
  // watcher at all, but the reply is still a value the dialog must not trust
  // blindly: an ok:false, or a missing array, must not throw out of the row loop
  // and leave the operator with an empty dialog.
  const pluginsList = el('div');
  const fn = extractRenderPluginsDialog()(
    pluginsList,
    {
      api: {
        pluginInvoke: async (_id, method) => (method === 'plugins.status'
          ? { ok: true, plugins: [INSTALLED], problems: [], shadowed: [] }
          : { ok: false, error: 'no such plugin method' }),
      },
      __CLODEX_WEB__: false,
    },
    { createElement: el },
    (s) => `From github.com/${s.repo}`,
    { settingsSectionOwners: () => [] },
    () => el('div'),
    async () => {}, () => {}, () => {}, () => {}, null, () => {}, () => true,
    pluginOrigin,
  );
  const got = await fn();
  assert.strictEqual(got.length, 1, 'the row survived the refusal');
  assert.strictEqual(badgeOf(pluginsList.children[0]), null);
});

test('the badge is read BEFORE the rows are built, from its own host method', async () => {
  // Two things at once: the dialog asks `plugins.updatesAvailable` (not the
  // catalog, whose fetch would put a network round trip on every dialog paint),
  // and it asks once for the whole list rather than once per row.
  const asked = [];
  await renderRows([INSTALLED, { ...INSTALLED, id: 'two' }], [], asked);
  assert.deepStrictEqual(asked, ['plugins.status', 'plugins.updatesAvailable'],
    'one read for the whole dialog, and no libraryCatalog fetch on the paint path');
});

const CORE = { id: 'core-demo', name: 'Core Demo', root: 'core', enabled: true };
const REMOTE = { id: 'remote-demo', name: 'Remote Demo', enabled: true, source: { repo: 'someone/theirs', ref: null } };
const LOCAL = { id: 'local-demo', name: 'Local Demo', enabled: true, linkedFrom: '/Users/someone/src/demo' };

function originOf(row) {
  const body = row.children.find((c) => c.className === 'plugin-row-body');
  assert.ok(body, 'ENTER: the row has a body');
  const nameEl = body.children.find((c) => c.className === 'plugin-row-name');
  assert.ok(nameEl, 'ENTER: the row has a name node to carry the glyph');
  return nameEl.children.find((c) => c.className === 'plugin-row-origin') || null;
}

test('each row carries its origin glyph and the label as a tooltip', async () => {
  const rows = await renderRows([CORE, INSTALLED, REMOTE, LOCAL], []);
  const got = [...rows].map((r) => {
    const o = originOf(r);
    assert.ok(o, 'every row must carry a .plugin-row-origin span, or the operator sees no difference at all');
    return [o.textContent, o.title];
  });
  assert.deepStrictEqual(got, [
    ['◆', 'Built in'],
    ['▣', 'From the clodex-plugins library'],
    ['↗', 'From github.com/someone/theirs'],
    ['▪', 'Local, registered from /Users/someone/src/demo'],
  ], 'the four origins must reach the row as four different glyphs');
});

test('the glyph is the first thing in the name node, ahead of the name', async () => {
  const rows = await renderRows([REMOTE], []);
  const body = rows[0].children.find((c) => c.className === 'plugin-row-body');
  const nameEl = body.children.find((c) => c.className === 'plugin-row-name');
  assert.strictEqual(nameEl.children[0].className, 'plugin-row-origin',
    'a glyph appended after the name column reads as a suffix and breaks the fixed-width alignment');
  assert.strictEqual(nameEl.children[1].textContent, 'Remote Demo',
    'the name still has to be on the row beside the glyph');
});
