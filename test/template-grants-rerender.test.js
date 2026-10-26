'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { capsFor, isAgentType } = require('../cli-adapters');
const { unlistedOf, mergeLists } = require('../plugin-api');
const { initChecklistPopovers } = require('../renderer/popovers/checklist-popovers');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

function extract(re, what) {
  const m = re.exec(rendererSrc);
  assert.ok(m, `ENTER: ${what} was not found in renderer.js`);
  return m[1];
}

function slice(fromNeedle, toNeedle, what) {
  const a = rendererSrc.indexOf(fromNeedle);
  assert.ok(a > 0, `ENTER: ${what} starts at ${fromNeedle}`);
  const b = rendererSrc.indexOf(toNeedle, a + fromNeedle.length);
  assert.ok(b > a, `ENTER: ${what} ends at ${toNeedle}`);
  return rendererSrc.slice(a, b + toNeedle.length);
}

const PERSISTED_OR_FN = extract(/\n(function persistedOr\([\s\S]*?\n\})\n/, 'persistedOr');
const CURRENT_OR_FN = extract(/\n(function currentOr\([\s\S]*?\n\})\n/, 'currentOr');
const FORM_PERSISTED_OF_FN = extract(/\n(function formPersistedOf\([\s\S]*?\n\})\n/, 'formPersistedOf');
const FORM_CARRY_FN = extract(/\n(function formCarry\([\s\S]*?\n\})\n/, 'formCarry');
const POPULATE_FN = extract(/\n(function populateChecklistsFromCatalogs\([\s\S]*?\n\})\n/, 'populateChecklistsFromCatalogs');
const HOST_FN = extract(/\n(function populateHostCatalogs\([\s\S]*?\n\})\n/, 'populateHostCatalogs');
const CWD_FN = extract(/\n(function redrawGatesForCwd\([\s\S]*?\n\})\n/, 'redrawGatesForCwd');
const APPLY_FN = extract(/\n(function applyModeFields\([\s\S]*?\n\})\n/, 'applyModeFields');
const SET_MODE_FN = extract(/\n(function setModeSelect\([\s\S]*?\n\})\n/, 'setModeSelect');
const SELECT_WIRING = extract(/\n(if \(inputMode\) \{\n  inputMode\.addEventListener[\s\S]*?\n\})\n/, "the mode select's change listener");
const TYPE_REFRESH = extract(/\n(  if \(!skipAsyncRefresh\) \{\n    if \(caps\.skillRoster\)[\s\S]*?\n  \}\n  if \(agentType && !skipAsyncRefresh\) \{[^\n]*\})\n/, "applyTypeDefaults' checklist refresh");
const TEMPLATE_HANDLER = slice("inputTemplate.addEventListener('change'", '\n});\n', 'the template picker');

const TEMPLATE = { disabledTools: ['Agent'], denyBuiltins: ['Explore'], execCommands: ['x'] };
const TOOL_DENY = ['Bash'];
const BUILTIN_DENY = ['Plan'];
const DRAWN = {
  disabledTools: ['Agent', 'Bash', 'Read'],
  denyBuiltins: ['Explore', 'Plan', 'general-purpose'],
  execCommands: ['x', 'y'],
  mcpServers: ['m1'],
};

function loadedTemplate() {
  return {
    execCommands: TEMPLATE.execCommands.slice(),
    mcpServers: undefined,
    denyBuiltins: TEMPLATE.denyBuiltins.slice(),
    disabledTools: TEMPLATE.disabledTools.slice(),
  };
}

function formEnv(formPersisted, { mode = 'optimized', type = 'claude', templates = [] } = {}) {
  const sets = {};
  const noop = () => {};
  let api = null;
  const drawn = {};
  const draw = (key) => (s) => { sets[key] = s; drawn[key] = DRAWN[key]; api.rendered()[key] = DRAWN[key]; };
  const modeListeners = [];
  let templateListener = null;
  const locked = {};
  const lockedRows = (key) => (drawn[key] || []).filter((id) => (locked[key] || []).includes(id));
  const listOf = (key) => ({ key, querySelectorAll: () => lockedRows(key).map((value) => ({ value })) });
  const ticked = (list) => (drawn[list.key] || []).filter((id) => !lockedRows(list.key).includes(id)).filter((id) => (sets[list.key] || new Set()).has(id));
  const env = {
    unlistedOf, mergeLists, capsFor, isAgentType,
    inputTemplate: { value: '', addEventListener: (_ev, fn) => { templateListener = fn; } },
    window: { api: { listTemplates: async () => templates } },
    cwdFromTemplate: async () => ({ cwd: '/proj' }), showToast: noop,
    inputCwd: { value: '' }, inputModel: { value: '' }, inputArgs: { value: '' }, inputEffort: null,
    splitModelArg: () => ({ model: '', rest: [] }), formatArgs: () => '', fillEffort: noop,
    argsHint: {}, ARGS_HINTS: {}, applyTypeDefaults: noop, inputStreamIo: null,
    collectToolChecklist: ticked, collectBuiltinChecklist: ticked,
    collectExecChecklist: ticked, collectMcpChecklist: ticked,
    inputExecList: listOf('execCommands'), inputMcpList: listOf('mcpServers'),
    inputMode: { value: mode, querySelector: () => null, addEventListener: (_ev, fn) => modeListeners.push(fn) },
    inputType: { value: type },
    modeHint: null, advancedSection: null, MODE_HINTS: {},
    setAgentLibCache: noop, renderAgentChecklist: noop, setSkillLibCache: noop,
    renderInjectChecklist: noop, resetNewSessionSkillCollector: noop, renderSkillChecklist: noop,
    modeSkillDenySet: () => new Set(), setClaudeToolsCache: noop,
    renderToolChecklist: (_el, s) => { sets.disabledTools = s; sets.toolsSync = s; drawn.disabledTools = DRAWN.disabledTools; return DRAWN.disabledTools; },
    renderBuiltinChecklist: (_el, s) => { sets.denyBuiltins = s; drawn.denyBuiltins = DRAWN.denyBuiltins; return DRAWN.denyBuiltins; },
    modeToolDenySet: () => new Set(TOOL_DENY),
    modeBuiltinDenySet: () => new Set(BUILTIN_DENY),
    getDefaultToolDenyCache: () => TOOL_DENY,
    getDefaultSkillDenyCache: () => [],
    getDefaultBuiltinDenyCache: () => BUILTIN_DENY,
    refreshNewSessionTools: draw('disabledTools'),
    refreshNewSessionExecCommands: (s = new Set()) => draw('execCommands')(s),
    refreshNewSessionMcpServers: (s = new Set()) => draw('mcpServers')(s),
    refreshNewSessionSkills: noop, refreshNewSessionInjectSkills: noop,
    refreshNewSessionPlugins: () => Promise.resolve(), refreshNewSessionIntents: noop,
    setPromptLibCache: noop, libraryPromptCache: (p) => p, fillSystemPromptSelect: noop,
    newSessionSeat: () => ({ plugins: [] }), newSessionAppendOpened: [], renderAppendChecklist: noop,
    setProxyControls: noop, newSessionIsAgent: () => true, labelProxyDefault: noop,
    dialogMode: 'create', newSessionSkillDenyList: () => [],
    setDefaultToolDenyCache: noop, setDefaultSkillDenyCache: noop, setDefaultBuiltinDenyCache: noop,
    inputAgentsList: {}, inputInjectSkillsList: {}, inputSkillsList: {}, inputToolsList: listOf('disabledTools'),
    inputBuiltinsList: listOf('denyBuiltins'), inputSystemPrompt: {}, inputAppendList: {},
    inputProxyMode: {}, inputProxyUrl: {}, inputStripLevel: null, inputAutoCompact: null, inputNoWire: null,
  };
  const names = Object.keys(env);
  api = new Function(...names, 'formPersistedInit', `let formPersisted = formPersistedInit;
    let formRendered = {};
    ${PERSISTED_OR_FN}\n${CURRENT_OR_FN}\n${FORM_PERSISTED_OF_FN}\n${FORM_CARRY_FN}\n${POPULATE_FN}\n${HOST_FN}\n${CWD_FN}\n${APPLY_FN}\n${SET_MODE_FN}\n${SELECT_WIRING}\n${TEMPLATE_HANDLER}
    return {
      populate: (cat) => populateChecklistsFromCatalogs(cat),
      host: () => populateHostCatalogs({}, []),
      cwd: () => redrawGatesForCwd(),
      applyMode: (mode, opts) => applyModeFields(mode, opts),
      typeRefresh: () => { const skipAsyncRefresh = false; const caps = capsFor(inputType.value); const agentType = true; ${TYPE_REFRESH} },
      carry: (key, checked) => formCarry(key, checked),
      persisted: () => formPersisted,
      rendered: () => formRendered,
    };`)(...names.map((n) => env[n]), formPersisted);
  const collected = (key) => api.carry(key, ticked({ key }));
  const selectMode = (m) => { env.inputMode.value = m; for (const fn of modeListeners) fn(); };
  const loadTemplate = async (id) => { env.inputTemplate.value = id; await templateListener(); };
  const untick = (key, id) => { assert.ok(sets[key].delete(id), `ENTER: ${id} was drawn in ${key}`); };
  const lock = (key, id) => { locked[key] = [...(locked[key] || []), id]; };
  return { api, env, sets, lock, get formRendered() { return api.rendered(); }, collected, selectMode, loadTemplate, untick };
}

test('t1956: a placement switch after a template load keeps its tools, built-ins and exec grants', () => {
  const f = formEnv(loadedTemplate());
  f.api.populate({ agents: [], skills: [], claudeTools: [] });
  assert.ok(f.sets.disabledTools && f.sets.denyBuiltins && f.sets.execCommands, 'ENTER: all three lists were redrawn');
  assert.deepStrictEqual(f.collected('disabledTools'), ['Agent']);
  assert.deepStrictEqual(f.collected('denyBuiltins'), ['Explore']);
  assert.deepStrictEqual(f.collected('execCommands'), ['x']);
});

test('t1956: switching placement back to host after a template load keeps all three lists', () => {
  const f = formEnv({ ...loadedTemplate(), mcpServers: ['m1'] }, { mode: 'custom' });
  f.api.populate({ agents: [], skills: [], claudeTools: [] });
  f.api.host();
  assert.ok(f.sets.disabledTools && f.sets.denyBuiltins && f.sets.execCommands && f.sets.mcpServers,
    'ENTER: the host fill redrew tools, built-ins, exec and MCP');
  assert.deepStrictEqual(f.collected('disabledTools'), ['Agent']);
  assert.deepStrictEqual(f.collected('denyBuiltins'), ['Explore']);
  assert.deepStrictEqual(f.collected('execCommands'), ['x']);
  assert.deepStrictEqual(f.collected('mcpServers'), ['m1']);
  assert.deepStrictEqual([...f.sets.toolsSync], ['Agent'], 'the synchronous tool draw, before the async refresh lands');
});

test('t1956: a cwd change in the New Session dialog after a template load keeps its disabled tools', () => {
  const f = formEnv(loadedTemplate(), { mode: 'custom' });
  f.api.cwd();
  assert.ok(f.sets.disabledTools, 'ENTER: the cwd change redrew the tool list');
  assert.deepStrictEqual(f.collected('disabledTools'), ['Agent']);
});

test('t1956: the host fill on a blank form still draws the mode defaults', () => {
  const f = formEnv({});
  f.api.host();
  assert.deepStrictEqual([...f.sets.disabledTools], TOOL_DENY);
  assert.deepStrictEqual([...f.sets.denyBuiltins], BUILTIN_DENY);
  assert.deepStrictEqual([...f.sets.execCommands], []);
  assert.deepStrictEqual([...f.sets.mcpServers], []);
});

test('t1956: a placement switch on a blank form still draws the mode defaults', () => {
  const f = formEnv({});
  f.api.populate({ agents: [], skills: [], claudeTools: [] });
  assert.deepStrictEqual([...f.sets.disabledTools], TOOL_DENY);
  assert.deepStrictEqual([...f.sets.denyBuiltins], BUILTIN_DENY);
  assert.deepStrictEqual([...f.sets.execCommands], []);
});

test('t1956: a type-change applyModeFields after a template load keeps its tools and built-ins', () => {
  const fresh = formEnv(loadedTemplate());
  fresh.api.applyMode('optimized', { catalogsFresh: true });
  assert.ok(fresh.sets.denyBuiltins, 'ENTER: the built-in list was redrawn');
  assert.deepStrictEqual(fresh.collected('denyBuiltins'), ['Explore']);

  const full = formEnv(loadedTemplate());
  full.api.applyMode('optimized');
  assert.ok(full.sets.disabledTools, 'ENTER: the tool list was redrawn');
  assert.deepStrictEqual(full.collected('disabledTools'), ['Agent']);
  assert.deepStrictEqual(full.collected('denyBuiltins'), ['Explore']);
});

test("t1956: applyTypeDefaults' refresh after a template load keeps its tools and exec grants", () => {
  const f = formEnv(loadedTemplate());
  f.api.typeRefresh();
  assert.ok(f.sets.disabledTools && f.sets.execCommands && f.sets.mcpServers, 'ENTER: tools, exec and MCP were redrawn');
  assert.deepStrictEqual(f.collected('disabledTools'), ['Agent']);
  assert.deepStrictEqual(f.collected('execCommands'), ['x']);
  assert.deepStrictEqual(f.collected('mcpServers'), []);
});

test("t1956: an explicit mode select resets tools and built-ins to the mode's defaults and keeps exec", () => {
  const f = formEnv(loadedTemplate(), { mode: 'custom' });
  f.selectMode('optimized');
  assert.ok(f.sets.disabledTools && f.sets.denyBuiltins, 'ENTER: the mode redrew both lists');
  assert.deepStrictEqual(f.collected('denyBuiltins'), BUILTIN_DENY);
  assert.deepStrictEqual(f.collected('disabledTools'), TOOL_DENY);
  f.formRendered.execCommands = ['y'];
  assert.deepStrictEqual(f.api.carry('execCommands', []), ['x']);
  assert.deepStrictEqual(Object.keys(f.api.persisted()).sort(), ['execCommands', 'mcpServers']);
});

const GRANT_TEMPLATE = {
  id: 'T', name: 'T', type: 'claude',
  execCommands: ['x'], mcpServers: [], denyBuiltins: ['Explore'], disabledTools: ['Agent'],
};

async function loadedForm(template = GRANT_TEMPLATE) {
  const f = formEnv({}, { mode: 'custom', templates: [template] });
  f.api.host();
  assert.deepStrictEqual([...f.sets.execCommands], [], 'ENTER: the dialog opened with x unticked');
  await f.loadTemplate(template.id);
  return f;
}

test('t1961: the first draw after a template load ticks its exec grant over the form it replaced', async () => {
  const f = await loadedForm();
  assert.deepStrictEqual(f.collected('execCommands'), ['x']);
  assert.deepStrictEqual(f.collected('disabledTools'), ['Agent']);
});

test('t1961: a type change after a template load keeps the exec grant the operator unticked off', async () => {
  const f = await loadedForm();
  f.untick('execCommands', 'x');
  f.api.typeRefresh();
  assert.deepStrictEqual(f.collected('execCommands'), []);
});

test('t1961: a placement round-trip after a template load keeps the exec grant the operator unticked off', async () => {
  const f = await loadedForm();
  f.untick('execCommands', 'x');
  f.api.populate({ agents: [], skills: [], claudeTools: [] });
  f.api.host();
  assert.deepStrictEqual(f.collected('execCommands'), []);
});

test('t1961: a cwd change after a template load keeps the tool the operator re-enabled', async () => {
  const f = await loadedForm();
  f.untick('disabledTools', 'Agent');
  f.api.cwd();
  assert.deepStrictEqual(f.collected('disabledTools'), []);
});

test('t1961: a type change after a template load still carries an exec grant the list could not draw', async () => {
  const f = await loadedForm({ ...GRANT_TEMPLATE, execCommands: ['x', 'ghost'] });
  f.untick('execCommands', 'x');
  f.api.typeRefresh();
  assert.deepStrictEqual([...f.sets.execCommands], ['ghost']);
});

for (const [what, redraw] of [['cwd change', (f) => f.api.cwd()], ['placement switch', (f) => f.api.populate({ agents: [], skills: [], claudeTools: [] })]]) {
  test(`t1961: a ${what} after a template load keeps a template-denied tool drawn on a locked row`, async () => {
    const f = await loadedForm();
    f.lock('disabledTools', 'Agent');
    assert.ok(!f.env.collectToolChecklist(f.env.inputToolsList).includes('Agent'), 'ENTER: the locked Agent row is not collected');
    redraw(f);
    assert.ok(f.sets.disabledTools.has('Agent'), `the ${what} redraw still denies Agent`);
  });
}

test('t1961: a type change after loading a template whose CLI drew no tool list draws its saved tools', async () => {
  const f = await loadedForm({ ...GRANT_TEMPLATE, type: 'codex' });
  f.env.inputType.value = 'claude';
  f.api.typeRefresh();
  assert.deepStrictEqual(f.collected('disabledTools'), ['Agent']);
});

test('t1956: choosing "(none)" after a template empties formPersisted', async () => {
  let listener = null;
  const inputTemplate = { value: '', addEventListener: (_ev, fn) => { listener = fn; } };
  const formRendered = { disabledTools: [], denyBuiltins: [], execCommands: [] };
  const api = new Function('inputTemplate', 'formRendered', 'unlistedOf', 'mergeLists', 'window',
    `let formPersisted = { disabledTools: ['Agent'], denyBuiltins: ['Explore'], execCommands: ['x'] };
    ${FORM_CARRY_FN}\n${TEMPLATE_HANDLER}
    return { persisted: () => formPersisted, carry: (k, c) => formCarry(k, c) };`)(
    inputTemplate, formRendered, unlistedOf, mergeLists,
    { api: { listTemplates: async () => { throw new Error('a "(none)" pick must not list templates'); } } });
  assert.ok(listener, 'ENTER: the template handler registered');
  await listener();
  assert.deepStrictEqual(api.persisted(), {});
  for (const key of ['disabledTools', 'denyBuiltins', 'execCommands']) {
    assert.deepStrictEqual(api.carry(key, []), [], `${key} carries nothing from the old template`);
  }
});

function makeEl(tag = 'div') {
  const classes = new Set();
  const handlers = new Map();
  const el = {
    tagName: tag, dataset: {}, style: {}, value: '', type: '', checked: false, disabled: false,
    textContent: '', children: [], isConnected: true, offsetWidth: 300, offsetHeight: 200,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    set innerHTML(v) { el._html = v; if (v === '') el.children = []; },
    get innerHTML() { return el._html || ''; },
    appendChild: (c) => { el.children.push(c); return c; },
    contains: () => false,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 20, bottom: 30 }),
    addEventListener: (t, fn) => { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(fn); },
    fire: async (t, ev = {}) => { for (const fn of handlers.get(t) || []) await fn(ev); },
    querySelector: () => null,
    querySelectorAll: (sel) => {
      const boxes = el.children.flatMap((row) => row.children || []).filter((c) => c.type === 'checkbox');
      if (sel === 'input[type="checkbox"]:not(:checked)') return boxes.filter((c) => !c.checked);
      if (sel === 'input[type="checkbox"]:not(:checked):not(:disabled)') return boxes.filter((c) => !c.checked && !c.disabled);
      if (sel === 'input[type="checkbox"]:checked') return boxes.filter((c) => c.checked);
      return [];
    },
  };
  return el;
}

function popoverHarness(api) {
  const prev = { doc: global.document, win: global.window, css: global.CSS, alert: global.alert, confirm: global.confirm };
  const els = new Map();
  const get = (id) => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); };
  global.document = { getElementById: get, createElement: (t) => makeEl(t), addEventListener() {}, querySelector: () => null };
  global.CSS = { escape: (s) => s };
  global.alert = () => {};
  global.confirm = () => true;
  const calls = [];
  global.window = { innerWidth: 1200, innerHeight: 800, api: api(calls) };
  const popovers = initChecklistPopovers({
    sessionList: { querySelector: () => null },
    rowSnapshot: () => ({}), rebuildLiveRow() {}, switchSession() {}, refreshSidebarMeta() {},
    getSessionType: () => 'claude',
  });
  return {
    popovers, els, calls,
    restore() {
      global.document = prev.doc; global.window = prev.win; global.CSS = prev.css;
      global.alert = prev.alert; global.confirm = prev.confirm;
    },
  };
}

test('t1956: the Tools popover Apply keeps a disabled tool its list did not draw', async () => {
  const h = popoverHarness((calls) => ({
    getSettings: async () => ({ claudeTools: ['Bash', 'Read'] }),
    getSessionArgs: async () => ({ ok: true, disabledTools: ['Agent', 'Bash'], effectiveTools: {} }),
    setSessionTools: async (name, tools) => { calls.push([name, tools]); return { ok: true }; },
  }));
  try {
    await h.popovers.openToolsPopover('seat', null);
    assert.strictEqual(h.els.get('popover-tools-list').children.length, 2, 'ENTER: both catalog rows drew');
    await h.els.get('tools-popover-apply').fire('click');
    assert.deepStrictEqual(h.calls, [['seat', ['Bash', 'Agent']]]);
  } finally { h.restore(); }
});

test('t1956: the Agents popover Apply keeps a denied built-in its list did not draw', async () => {
  const h = popoverHarness((calls) => ({
    getAgentCatalog: async () => ({ ok: true, agents: [], enabled: [], denyBuiltins: ['Explore', 'retired-builtin'] }),
    pluginCatalog: async () => [],
    setSessionAgents: async (name, agents, deny) => { calls.push([name, deny]); return { ok: true }; },
  }));
  try {
    await h.popovers.openAgentsPopover('seat', null);
    assert.ok(h.els.get('popover-builtins-list').children.length > 0, 'ENTER: the built-in rows drew');
    await h.els.get('agents-popover-apply').fire('click');
    assert.deepStrictEqual(h.calls, [['seat', ['Explore', 'retired-builtin']]]);
  } finally { h.restore(); }
});
