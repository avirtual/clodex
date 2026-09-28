const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const sliceFn = (name, prefix = 'function') => {
  const start = src.indexOf(`${prefix} ${name}(`);
  assert.ok(start > 0, `ENTER: ${name} was located`);
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
};

async function runInitSidebarView(res) {
  const sets = [];
  let awaited = false;
  const ctx = {
    sidebarView: { group: 'none', sort: 'recent', status: 'all', activity: 'any', search: '' },
    sbGroup: null, sbSort: null, sbStatus: null, sbActivity: null, sbSearch: null,
    applyFilterFolded() {}, refreshSidebarMeta: async () => {}, setInterval() {},
    window: { api: {
      getSidebarView: async () => { awaited = true; return res; },
      setSidebarView: (patch) => { sets.push(patch); },
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('initSidebarView', 'async function'), ctx);
  await ctx.initSidebarView();
  assert.ok(awaited, 'ENTER: getSidebarView was awaited');
  return { sets: JSON.parse(JSON.stringify(sets)), view: ctx.sidebarView };
}

test('a workspace with no stored view gets the statusMigrated marker once', async () => {
  const { sets } = await runInitSidebarView({ ok: true, view: null });
  assert.deepStrictEqual(sets, [{ statusMigrated: true }]);
});

test('an unmigrated stored active status is still reset to all with the marker', async () => {
  const { sets, view } = await runInitSidebarView({ ok: true, view: { status: 'active' } });
  assert.deepStrictEqual(sets, [{ status: 'all', statusMigrated: true }]);
  assert.strictEqual(view.status, 'all');
});

test('a migrated stored view writes nothing', async () => {
  const { sets, view } = await runInitSidebarView({ ok: true, view: { status: 'active', statusMigrated: true } });
  assert.deepStrictEqual(sets, []);
  assert.strictEqual(view.status, 'active');
});

test('peers Save expands a collapsed invalid row so its error shows', async () => {
  const anchor = "document.getElementById('btn-peers-save').addEventListener('click', ";
  const start = src.indexOf(anchor);
  assert.ok(start > 0, 'ENTER: the handler text was located by btn-peers-save');
  const body = src.slice(start + anchor.length, src.indexOf('\n});\n', start) + 2);
  const removed = [];
  let fetched = false;
  const row = { parentElement: { classList: { remove: (c) => removed.push(c) } } };
  const ctx = {
    collectPeers: () => ({ ok: false, error: 'bad port', row }),
    boxPeerIds: async () => new Set(),
    closePeersDialog() {},
    window: { api: { getSettings: async () => { fetched = true; return {}; }, setSettings: async () => {} } },
  };
  vm.createContext(ctx);
  const handler = vm.runInContext(`(${body})`, ctx);
  await handler();
  assert.deepStrictEqual(removed, ['collapsed']);
  assert.strictEqual(fetched, false, 'an invalid row still keeps the dialog from saving');
  ctx.collectPeers = () => ({ ok: false, error: 'bad port', row: { parentElement: null } });
  await handler();
});

test('Settings lists a threshold override for a family with no shipped row', () => {
  const prefsCtxModels = { textContent: '' };
  const ctx = { prefsCtxNudge: null, prefsCtxEscalate: null, prefsCtxModels };
  vm.createContext(ctx);
  vm.runInContext(sliceFn('setCtxThresholds'), ctx);
  ctx.setCtxThresholds({
    ctxThresholdDefaults: { default: { nudge: 1, escalate: 2 }, models: [{ family: 'fable', nudge: 100, escalate: 200 }] },
    ctxReminderThresholds: { default: { nudge: 5, escalate: 6 }, opus: { nudge: 300, escalate: 400 } },
  });
  const text = prefsCtxModels.textContent;
  assert.match(text, /fable: 100 \/ 200(?! \(your override\))/, 'ENTER: the shipped row is present');
  assert.match(text, /opus: 300 \/ 400 \(your override\)/);
  assert.doesNotMatch(text, /default:/);
  assert.ok(text.indexOf('fable') < text.indexOf('opus'), 'shipped rows come first');
});
