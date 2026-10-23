'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');

function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false, children: [], dataset: {}, style: {},
    appendChild(c) { e.children.push(c); return c; },
    querySelectorAll(sel) {
      assert.strictEqual(sel, 'input[type="checkbox"]:checked', 'ENTER: the selector collectMcpChecklist passes');
      return e.children.flatMap((row) => row.children || []).filter((c) => c.type === 'checkbox' && c.checked);
    },
  };
  let html = '';
  Object.defineProperty(e, 'innerHTML', {
    get: () => html,
    set(v) { html = v == null ? '' : String(v); if (html === '') e.children = []; },
  });
  let text = '';
  Object.defineProperty(e, 'textContent', {
    get: () => text,
    set(v) { text = v == null ? '' : String(v); html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  });
  return e;
}

function withDom(fn) {
  const had = global.document;
  global.document = { createElement: el, addEventListener() {} };
  try { return fn(); } finally { global.document = had; }
}

const checklists = withDom(() => require('../renderer/lib/checklists'));

function drawChecklist(lib, enabled, opts) {
  return withDom(() => {
    const box = el('div');
    checklists.setMcpLibCache(lib);
    checklists.renderMcpChecklist(box, new Set(enabled), opts);
    return box;
  });
}

const rowText = (box) => box.children.map((row) => row.children[1].innerHTML);

test('MCP checklist: readiness and platform badges, clodex never listed, and collect returns the ticks', () => {
  const box = drawChecklist([
    { name: 'clodex', description: 'should not show' },
    { name: 'docs', description: 'Docs', entry: { type: 'http', url: 'https://d' } },
    { name: 'jira', description: 'Issues', entry: { platforms: ['claude'] } },
  ], ['docs'], { cli: 'codex', readiness: { jira: { ok: false, missing: ['JIRA_TOKEN', 'JIRA_URL'] }, docs: { ok: true, missing: [] } } });
  assert.deepStrictEqual(rowText(box), [
    '<strong>docs</strong> — Docs',
    '<strong>jira</strong> — Issues <span class="auto-flag mcp-badge">not on codex</span> <span class="auto-flag mcp-badge">needs JIRA_TOKEN, JIRA_URL</span>',
  ]);
  assert.deepStrictEqual(box.children.map((row) => row.children[0].value), ['docs', 'jira']);
  assert.deepStrictEqual(checklists.collectMcpChecklist(box), ['docs']);
});

test('MCP checklist: a platform that includes the seat CLI draws no platform badge', () => {
  const box = drawChecklist([{ name: 'jira', entry: { platforms: ['claude'] } }], [], { cli: 'claude', readiness: {} });
  assert.deepStrictEqual(rowText(box), ['<strong>jira</strong>']);
});

test('MCP checklist: an empty library says where to add one', () => {
  const box = drawChecklist([], [], {});
  assert.match(box.innerHTML, /No MCP servers in library — add or import some via Library ▸ MCP Servers/);
});

function hoverCard(dataset) {
  const saved = { document: global.document, window: global.window };
  const card = { style: {}, hidden: true, innerHTML: '', offsetWidth: 0, offsetHeight: 0 };
  global.document = {
    createElement: (tag) => (tag === 'div' && card.id ? {
      set textContent(v) { this.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    } : card),
    body: { appendChild() {} },
    addEventListener() {},
  };
  global.window = { innerWidth: 1000, innerHeight: 800 };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const listeners = {};
    delete require.cache[require.resolve('../renderer/session-hovercard')];
    const { initSessionHovercard } = require('../renderer/session-hovercard');
    initSessionHovercard({
      sessionList: { addEventListener: (ev, fn) => { listeners[ev] = fn; } },
      proxyState: new Map(), ctxPct: new Map(), ctxTokens: new Map(),
      proxyPollMs: 1000, typeGlyph: () => 'C',
    });
    const item = {
      dataset: { name: 'seat', type: 'claude', cwd: '/w', ...dataset },
      isConnected: true,
      querySelector: () => null,
      getBoundingClientRect: () => ({ right: 10, top: 10 }),
    };
    listeners.mouseover({ target: { closest: (sel) => (sel === '.session-item' ? item : null) } });
    mock.timers.tick(1000);
    assert.strictEqual(card.hidden, false, 'ENTER: the hovercard was shown');
    const html = card.innerHTML;
    listeners.mouseout({ relatedTarget: null });
    return html;
  } finally {
    mock.timers.reset();
    global.document = saved.document;
    global.window = saved.window;
  }
}

const mcpRow = (html) => (/<span class="hc-k">mcp<\/span><span class="hc-v">([^<]*)<\/span>/.exec(html) || [])[1];

test('hovercard mcp row: the selection, unmanaged, and changed since spawn', () => {
  assert.match(hoverCard({}), /<span class="hc-k">effort<\/span>/, 'ENTER: the stat rows render');
  assert.strictEqual(mcpRow(hoverCard({})), undefined, 'no selection, no row');
  assert.strictEqual(mcpRow(hoverCard({ mcp: 'jira, docs' })), 'jira, docs');
  assert.strictEqual(mcpRow(hoverCard({ mcp: 'jira', mcpStale: '1' })), 'jira · changed since spawn');
  assert.strictEqual(mcpRow(hoverCard({ mcpUnmanaged: '1' })), 'unmanaged');
});

function fakeEl(classes = []) {
  const set = new Set(classes);
  return {
    dataset: {}, style: {}, textContent: '', offsetWidth: 320, offsetHeight: 240, isConnected: true, children: [],
    classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) },
    getBoundingClientRect: () => ({ left: 100, top: 400, width: 40, height: 16 }),
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html || ''; },
    addEventListener() {}, contains: () => false,
  };
}

async function popoverBody(data, type = 'claude') {
  const prev = { document: global.document, window: global.window };
  const ids = ['ctx-popover', 'ctx-popover-name', 'ctx-popover-body', 'ctx-popover-close'];
  const els = new Map(ids.map((id) => [id, fakeEl(id === 'ctx-popover' ? ['hidden'] : [])]));
  global.document = {
    getElementById: (id) => els.get(id) || null,
    createElement: () => ({
      set textContent(v) { this._t = String(v); },
      get innerHTML() { return String(this._t == null ? '' : this._t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    }),
    querySelector: () => null,
    addEventListener() {},
    documentElement: {},
  };
  global.window = { innerWidth: 1200, innerHeight: 800, api: {} };
  try {
    const { createPopoverGroup } = require('../renderer/lib/popover-group');
    const { initContextPopover } = require('../renderer/popovers/context-popover');
    const { openContextPopover } = initContextPopover({
      popoverApi: () => ({ ctx: async () => ({ ok: true, data }) }),
      ctxCatLabel: (c) => c,
      openReportPanel() {}, openToolsPopover() {}, openSkillsPopover() {},
      proxyState: new Map([['seat-1', { payload: { queries: ['ctx'] } }]]),
      sessionTypeOf: () => type,
      barPopovers: createPopoverGroup(),
    });
    await openContextPopover('seat-1', fakeEl());
    return els.get('ctx-popover-body').innerHTML;
  } finally { global.document = prev.document; global.window = prev.window; }
}

const AGENT = {
  line: 'main',
  composition: { total_tokens: 4000, basis: 'exact', by_category: [{ category: 'tools', tokens: 3000, pct: 75 }] },
  tools: { count: 3, est_tokens: 3000, per_tool: [
    { name: 'mcp__clodex__dm', est_tokens: 1000, used: 1 },
    { name: 'mcp__jira__search', est_tokens: 1000, used: 1 },
    { name: 'mcp__rogue__x', est_tokens: 1000, used: 0 },
  ] },
};

const note = (body, server) => {
  const m = new RegExp(`<span class="ctx-cat">${server}</span>.*?</div>(?:<div class="ctx-util-conf">([^<]*)</div>)?</div>`).exec(body);
  assert.ok(m, `ENTER: a row for ${server} rendered`);
  return m[1];
};

test('context popover: built-in, library-selected and leak rows, built-in listed apart from the library', async () => {
  const body = await popoverBody({ agents: [AGENT], clodex_mcp: { managed: true, selected: ['jira'], applied: null, leaks: ['rogue'] } });
  assert.strictEqual(note(body, 'clodex'), 'built-in');
  assert.strictEqual(note(body, 'jira'), 'library · selected');
  assert.strictEqual(note(body, 'rogue'),
    '⚠ not in this seat&#39;s selection — reached the CLI outside Clodex (own --mcp-config in Extra args, a CLI plugin, or a CLI build that ignores --strict-mcp-config)');
  assert.ok(body.indexOf('<div class="ctx-util-group">Built-in</div>') < body.indexOf('<span class="ctx-cat">clodex</span>'));
  assert.ok(body.indexOf('<span class="ctx-cat">clodex</span>') < body.indexOf('<div class="ctx-util-group">Library</div>'));
  assert.ok(body.indexOf('<div class="ctx-util-group">Library</div>') < body.indexOf('<span class="ctx-cat">jira</span>'));
  assert.ok(body.indexOf('<span class="ctx-cat">jira</span>') < body.indexOf('<div class="ctx-util-group">Outside selection</div>'));
  assert.ok(body.indexOf('<div class="ctx-util-group">Outside selection</div>') < body.indexOf('<span class="ctx-cat">rogue</span>'));
  assert.match(body, /Claude: partially managed — CLI plugins unverified/);
  assert.doesNotMatch(body, /unmanaged:/);
});

test('context popover: a selected server with a deny list says how many tools are denied, from the record\'s applied set', async () => {
  const mcp = { managed: true, selected: ['jira'], applied: { names: ['jira'], digest: 'd', denyRules: [], denied: { jira: ['createJiraIssue', 'editJiraIssue'] } }, leaks: ['rogue'] };
  assert.strictEqual(note(await popoverBody({ agents: [AGENT], clodex_mcp: mcp }), 'jira'), 'library · selected · 2 tools denied');
  assert.strictEqual(note(await popoverBody({ agents: [AGENT], clodex_mcp: mcp }, 'codex'), 'jira'),
    'library · selected · 2 tools denied (deny list not enforced on this CLI)');
  const one = { ...mcp, applied: { ...mcp.applied, denied: { jira: ['createJiraIssue'] } } };
  assert.strictEqual(note(await popoverBody({ agents: [AGENT], clodex_mcp: one }), 'jira'), 'library · selected · 1 tool denied');
});

test('context popover: an unmanaged seat carries the header line, and a Codex seat says the selection is not applied', async () => {
  const body = await popoverBody({ agents: [AGENT], clodex_mcp: { managed: false, selected: [], applied: null, leaks: ['jira', 'rogue'] } }, 'codex');
  assert.match(body, /unmanaged: this seat's Extra args carry its own MCP config/);
  assert.match(body, /Codex: selection not applied on this CLI yet/);
});

test('context popover: a payload without clodex_mcp renders the rows bare, as before', async () => {
  const body = await popoverBody({ agents: [AGENT] });
  assert.strictEqual(note(body, 'jira'), undefined, 'ENTER: the jira row rendered with no note');
  assert.doesNotMatch(body, /built-in|ctx-util-group">Built-in|partially managed/);
});
