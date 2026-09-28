'use strict';

const test = require('node:test');
const assert = require('node:assert');

function el() {
  const listeners = {};
  const e = {
    className: '', style: {}, value: '', children: [], dataset: {}, readOnly: false, disabled: false,
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild(c) { e.children.push(c); return c; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, ev = { stopPropagation() {} }) { return Promise.all((listeners[type] || []).map((fn) => fn(ev))); },
    focus() {},
    querySelector: () => el(),
    querySelectorAll: () => [],
    innerHTML: '', textContent: '',
  };
  return e;
}

const flush = () => new Promise((r) => setImmediate(r));

function caseInsensitiveStore(seed) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    m,
    save: async (n, body) => { m.set(n.toLowerCase(), body); return { ok: true }; },
    remove: async (n) => { m.delete(n.toLowerCase()); return { ok: true }; },
    get: async (n) => m.get(n.toLowerCase()),
    list: async () => [...m.keys()].map((name) => ({ name, description: '', meta: {} })),
  };
}

async function rig(apiOver = {}) {
  const nodes = new Map();
  const byId = (id) => { if (!nodes.has(id)) nodes.set(id, el()); return nodes.get(id); };
  const opens = {};
  const alerts = [];
  const had = { d: global.document, w: global.window, a: global.alert, c: global.confirm };
  global.document = { getElementById: byId, createElement: el, addEventListener() {} };
  global.alert = (m) => alerts.push(String(m));
  global.confirm = () => true;
  global.window = {
    api: {
      listAgents: async () => [], listSkillLib: async () => [], listPrompts: async () => [],
      listExecCommands: async () => [], listTemplates: async () => [],
      onRequestOpenSkillsDrawer: (cb) => { opens.skills = cb; },
      onRequestOpenAgentsDrawer: (cb) => { opens.agents = cb; },
      onRequestOpenExecDrawer: (cb) => { opens.exec = cb; },
      onRequestOpenPromptsDrawer: (cb) => { opens.prompts = cb; },
      onRequestOpenTemplatesDrawer() {},
      ...apiOver,
    },
  };
  delete require.cache[require.resolve('../renderer/library-drawers')];
  const { initLibraryDrawers } = require('../renderer/library-drawers');
  initLibraryDrawers({
    getActiveSession: () => null, setAgentLibCache() {}, setSkillLibCache() {},
    openTemplateEditor() {}, bundleSectionsOf: () => [], refreshPluginCatalog: async () => {},
  });
  const restore = () => { global.document = had.d; global.window = had.w; global.alert = had.a; global.confirm = had.c; };
  return { byId, opens, alerts, restore };
}

const KINDS = [
  { kind: 'agents', input: 'agent-name', save: 'agent-save', api: ['saveAgent', 'removeAgent', 'getAgent', 'listAgents'] },
  { kind: 'skills', input: 'skill-name', save: 'skill-save', api: ['saveSkillLib', 'removeSkillLib', 'getSkillLib', 'listSkillLib'] },
  { kind: 'exec', input: 'exec-name', save: 'exec-save', api: ['saveExecCommand', 'removeExecCommand', 'getExecCommand', 'listExecCommands'] },
];

for (const k of KINDS) {
  test(`renaming a library ${k.kind} entry only by letter case keeps it — the old name is not removed after the save wrote the same file`, async () => {
    const store = caseInsensitiveStore({ Foo: 'body' });
    const [save, remove, get, list] = k.api;
    const r = await rig({ [save]: store.save, [remove]: store.remove, [get]: store.get, [list]: store.list });
    try {
      r.opens[k.kind]('Foo');
      await flush();
      assert.strictEqual(store.m.get('foo'), 'body', 'ENTER: the seeded entry is in the store');
      r.byId(k.input).value = 'foo';
      await r.byId(k.save).fire('click');
      await flush();
      assert.ok(store.m.has('foo'), 'the case-only rename must not delete the file it just wrote');
    } finally { r.restore(); }
  });
}

const DELETES = [
  { kind: 'agents', btn: 'agent-delete', remove: 'removeAgent', get: 'getAgent', open: 'x' },
  { kind: 'skills', btn: 'skill-delete', remove: 'removeSkillLib', get: 'getSkillLib', open: 'x' },
  { kind: 'exec', btn: 'exec-delete', remove: 'removeExecCommand', get: 'getExecCommand', open: 'x' },
  { kind: 'prompts', btn: 'prompt-delete', remove: 'removePrompt', open: { kind: 'append', name: 'x' } },
];

for (const d of DELETES) {
  test(`deleting a library ${d.kind} entry the main process refuses tells the user and keeps the editor open`, async () => {
    let closed = 0;
    const over = { [d.remove]: async () => ({ ok: false, error: 'invalid name: x' }) };
    if (d.get) over[d.get] = async () => 'body';
    if (d.kind === 'prompts') over.listPrompts = async () => [{ kind: 'append', name: 'x', body: 'b' }];
    const r = await rig(over);
    try {
      await r.opens[d.kind](d.open);
      await flush();
      const editor = r.byId(d.kind === 'prompts' ? 'prompt-editor' : d.btn.replace('-delete', '-editor'));
      editor.classList.add = (c) => { if (c === 'hidden') closed++; };
      await r.byId(d.btn).fire('click');
      await flush();
      assert.strictEqual(r.alerts.length, 1, `one alert; got ${JSON.stringify(r.alerts)}`);
      assert.match(r.alerts[0], /invalid name/);
      assert.strictEqual(closed, 0, 'the editor stays open');
    } finally { r.restore(); }
  });
}

test('opening the prompt editor resets the invalid-name border a previous failed save left', async () => {
  const r = await rig();
  try {
    await r.opens.prompts(':new');
    r.byId('prompt-name').value = 'a b';
    r.byId('prompt-body').value = 'x';
    await r.byId('prompt-save').fire('click');
    assert.strictEqual(r.byId('prompt-name').style.borderColor, '#e94560', 'ENTER: the failed save painted the border');
    await r.byId('prompts-new').fire('click');
    assert.strictEqual(r.byId('prompt-name').style.borderColor, '');
    r.byId('prompt-name').value = 'a b';
    r.byId('prompt-body').value = 'x';
    await r.byId('prompt-save').fire('click');
    assert.strictEqual(r.byId('prompt-name').style.borderColor, '#e94560', 'ENTER: painted again');
    await r.byId('prompt-name').fire('input');
    assert.strictEqual(r.byId('prompt-name').style.borderColor, '', 'typing clears it');
  } finally { r.restore(); }
});

for (const k of KINDS) {
  test(`a ${k.kind} rename whose old-name removal is refused says so`, async () => {
    const store = caseInsensitiveStore({ Foo: 'body' });
    const [save, remove, get, list] = k.api;
    const r = await rig({ [save]: store.save, [remove]: async () => ({ ok: false, error: 'locked' }), [get]: store.get, [list]: store.list });
    try {
      r.opens[k.kind]('Foo');
      await flush();
      r.byId(k.input).value = 'Bar';
      await r.byId(k.save).fire('click');
      await flush();
      assert.ok(store.m.has('bar'), 'ENTER: the save under the new name landed');
      assert.strictEqual(r.alerts.length, 1, `one alert; got ${JSON.stringify(r.alerts)}`);
      assert.match(r.alerts[0], /locked/);
    } finally { r.restore(); }
  });
}
