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
    querySelector: (sel) => (e.q[sel] = e.q[sel] || el()),
    q: {},
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
      listMcpServers: async () => [], discoverMcpServers: async () => [],
      onRequestOpenSkillsDrawer: (cb) => { opens.skills = cb; },
      onRequestOpenAgentsDrawer: (cb) => { opens.agents = cb; },
      onRequestOpenExecDrawer: (cb) => { opens.exec = cb; },
      onRequestOpenMcpDrawer: (cb) => { opens.mcp = cb; },
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
  { kind: 'mcp', input: 'mcp-name', save: 'mcp-save', api: ['saveMcpServer', 'removeMcpServer', 'getMcpServer', 'listMcpServers'] },
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
  { kind: 'mcp', btn: 'mcp-delete', remove: 'removeMcpServer', get: 'getMcpServer', open: 'x' },
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

test('the drawer name regex is the leaf MCP_NAME_RE literal', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { MCP_NAME_RE } = require('../mcp-plan');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'library-drawers.js'), 'utf8');
  const m = /const MCP_NAME_RE = (\/.+\/[a-z]*);\n/.exec(src);
  assert.ok(m, 'ENTER: library-drawers.js declares MCP_NAME_RE as a literal');
  assert.strictEqual(m[1], String(MCP_NAME_RE));
});

async function mcpEditorRig(over = {}) {
  const saved = [];
  const r = await rig({
    saveMcpServer: async (n, entry) => { saved.push([n, entry]); return { ok: true }; },
    ...over,
  });
  await r.opens.mcp(':new');
  await flush();
  for (const p of ['claude', 'codex', 'muse']) r.byId(`mcp-platform-${p}`).checked = true;
  return { ...r, saved };
}

test('MCP editor: a stdio form saves the entry its fields describe, and an unticked platform narrows the list', async () => {
  const r = await mcpEditorRig();
  try {
    r.byId('mcp-name').value = 'jira';
    r.byId('mcp-type').value = 'stdio';
    r.byId('mcp-command').value = 'npx';
    r.byId('mcp-args').value = '-y\n\njira-mcp\n';
    r.byId('mcp-env').value = 'JIRA_TOKEN=${JIRA_TOKEN}\nnot a pair';
    r.byId('mcp-description').value = 'Issues';
    r.byId('mcp-tags').value = 'work, , tickets';
    r.byId('mcp-platform-muse').checked = false;
    await r.byId('mcp-save').fire('click');
    await flush();
    assert.deepStrictEqual(r.saved, [['jira', {
      type: 'stdio', command: 'npx', args: ['-y', 'jira-mcp'], env: { JIRA_TOKEN: '${JIRA_TOKEN}' },
      description: 'Issues', tags: ['work', 'tickets'], platforms: ['claude', 'codex'],
    }]]);
  } finally { r.restore(); }
});

test('MCP editor: an http form with every platform ticked omits platforms', async () => {
  const r = await mcpEditorRig();
  try {
    r.byId('mcp-name').value = 'docs';
    r.byId('mcp-type').value = 'http';
    r.byId('mcp-url').value = 'https://docs/mcp';
    r.byId('mcp-headers').value = 'Authorization: Bearer ${DOCS_TOKEN}';
    await r.byId('mcp-save').fire('click');
    await flush();
    assert.deepStrictEqual(r.saved, [['docs', {
      type: 'http', url: 'https://docs/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    }]]);
  } finally { r.restore(); }
});

test('MCP editor: the deny-tools textarea saves an array from lines or commas, and blank leaves the key absent', async () => {
  const r = await mcpEditorRig();
  try {
    r.byId('mcp-name').value = 'atlassian';
    r.byId('mcp-type').value = 'http';
    r.byId('mcp-url').value = 'https://mcp.atlassian.com/v2/mcp';
    r.byId('mcp-deny-tools').value = 'createJiraIssue, editJiraIssue\n\n transitionJiraIssue \n';
    await r.byId('mcp-save').fire('click');
    await flush();
    r.byId('mcp-name').value = 'docs';
    r.byId('mcp-url').value = 'https://docs/mcp';
    r.byId('mcp-deny-tools').value = ' \n , ';
    await r.byId('mcp-save').fire('click');
    await flush();
    assert.deepStrictEqual(r.saved, [
      ['atlassian', { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', denyTools: ['createJiraIssue', 'editJiraIssue', 'transitionJiraIssue'] }],
      ['docs', { type: 'http', url: 'https://docs/mcp' }],
    ]);
  } finally { r.restore(); }
});

test('MCP editor: an entry opened with denyTools fills the textarea, and clearing it drops the key on save; the row says read-only', async () => {
  const saved = [];
  const r = await rig({
    saveMcpServer: async (n, entry) => { saved.push([n, entry]); return { ok: true }; },
    getMcpServer: async () => JSON.stringify({ type: 'http', url: 'https://a/mcp', denyTools: ['createJiraIssue', 'editJiraIssue'] }),
    listMcpServers: async () => [{ name: 'atlassian', type: 'http', entry: { type: 'http', url: 'https://a/mcp', denyTools: ['createJiraIssue', 'editJiraIssue'] }, secrets: [] }],
  });
  try {
    const plain = global.document.createElement;
    global.document.createElement = () => {
      const x = plain();
      let t = '';
      Object.defineProperty(x, 'textContent', { get: () => t, set(v) { t = String(v); x.innerHTML = t; } });
      return x;
    };
    await r.opens.mcp('atlassian');
    await flush();
    assert.strictEqual(r.byId('mcp-deny-tools').value, 'createJiraIssue\neditJiraIssue');
    const listed = r.byId('mcp-list').children;
    assert.strictEqual(listed.length, 1, 'ENTER: the library row rendered');
    assert.match(listed[0].innerHTML, /https:\/\/a\/mcp · read-only: 2 tools denied<\/div>/);
    for (const p of ['claude', 'codex', 'muse']) r.byId(`mcp-platform-${p}`).checked = true;
    r.byId('mcp-deny-tools').value = '';
    await r.byId('mcp-save').fire('click');
    await flush();
    assert.deepStrictEqual(saved, [['atlassian', { type: 'http', url: 'https://a/mcp' }]]);
  } finally { r.restore(); }
});

test('MCP editor: a validation error from main shows inline, not as an alert, and the editor stays open', async () => {
  let closed = 0;
  const r = await mcpEditorRig({
    saveMcpServer: async () => ({ ok: false, error: 'invalid MCP server jira: stdio needs a command string' }),
  });
  try {
    r.byId('mcp-editor').classList.add = (c) => { if (c === 'hidden') closed++; };
    r.byId('mcp-name').value = 'jira';
    r.byId('mcp-type').value = 'stdio';
    await r.byId('mcp-save').fire('click');
    await flush();
    assert.strictEqual(r.byId('mcp-error').textContent, 'invalid MCP server jira: stdio needs a command string');
    assert.deepStrictEqual(r.alerts, []);
    assert.strictEqual(closed, 0);
  } finally { r.restore(); }
});

test('MCP editor: a name the leaf regex refuses never reaches main', async () => {
  const r = await mcpEditorRig();
  try {
    for (const bad of ['a__b', 'a.b', '-x', '']) {
      r.byId('mcp-name').value = bad;
      await r.byId('mcp-save').fire('click');
      await flush();
      assert.strictEqual(r.byId('mcp-name').style.borderColor, '#e94560', `${bad} is refused`);
      assert.match(r.byId('mcp-error').textContent, /^Name: /);
    }
    assert.deepStrictEqual(r.saved, []);
  } finally { r.restore(); }
});

test('MCP discover: candidates group by source, an in-library one has no Import, and Import sends the normalised entry', async () => {
  const JIRA = { type: 'stdio', command: 'jira-mcp', env: { JIRA_TOKEN: '${JIRA_TOKEN}' } };
  const imported = [];
  const r = await rig({
    discoverMcpServers: async () => [
      { source: 'claude:user /h/.claude.json', name: 'jira', entry: JIRA, secrets: ['JIRA_TOKEN'], inLibrary: false },
      { source: 'claude:project /p/.mcp.json', name: 'docs', entry: { type: 'http', url: 'https://d' }, secrets: [], inLibrary: true },
    ],
    importMcpServer: async (n, entry) => { imported.push([n, entry]); return { ok: true }; },
  });
  const plain = global.document.createElement;
  global.document.createElement = () => {
    const x = plain();
    let t = '';
    Object.defineProperty(x, 'textContent', {
      get: () => t,
      set(v) { t = String(v); x.innerHTML = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    });
    return x;
  };
  try {
    r.opens.mcp();
    await flush();
    const rows = r.byId('mcp-discover-list').children;
    assert.deepStrictEqual(rows.map((x) => x.textContent || x.className),
      ['/h/.claude.json — user', 'prompt-item mcp-candidate', '/p/.mcp.json', 'prompt-item mcp-candidate']);
    assert.match(rows[1].innerHTML, /needs \$\{JIRA_TOKEN\} — set them in <a href="#" data-action="prefs">Preferences ▸ Environment<\/a>/);
    assert.match(rows[1].innerHTML, /data-action="import"/);
    assert.match(rows[3].innerHTML, /in library/);
    assert.doesNotMatch(rows[3].innerHTML, /data-action="import"|needs /);
    await rows[1].querySelector('[data-action="import"]').fire('click');
    await flush();
    assert.deepStrictEqual(imported, [['jira', JIRA]]);
  } finally { r.restore(); }
});
