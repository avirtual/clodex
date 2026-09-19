'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const MCP_AGENT = {
  line: 'main',
  composition: { total_tokens: 40000, basis: 'exact', by_category: [{ category: 'tools', tokens: 30000, pct: 75 }] },
  tools: {
    count: 3,
    est_tokens: 30000,
    per_tool: [
      { name: 'mcp__linear__create_issue', est_tokens: 12000, used: 0 },
      { name: 'mcp__linear__search', est_tokens: 11000, used: 0 },
      { name: 'Read', est_tokens: 7000, used: 4 },
    ],
  },
};

function fakeEl(classes = []) {
  const set = new Set(classes);
  const el = {
    dataset: {}, style: {}, textContent: '', offsetWidth: 320, offsetHeight: 240,
    isConnected: true, children: [],
    classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) },
    getBoundingClientRect: () => ({ left: 100, top: 400, width: 40, height: 16 }),
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html || ''; },
    addEventListener() {}, contains: () => false,
  };
  return el;
}

function harness({ payload, payloads, ctxImpl }) {
  const prev = { document: global.document, window: global.window };
  const ids = ['ctx-popover', 'ctx-popover-name', 'ctx-popover-body', 'ctx-popover-close'];
  const els = new Map(ids.map((id) => [id, fakeEl(id === 'ctx-popover' ? ['hidden'] : [])]));

  const sub = new Map([['ctx-util-col', fakeEl()], ['ctx-links', fakeEl()]]);
  global.document = {
    getElementById: (id) => {
      if (els.has(id)) return els.get(id);
      if (sub.has(id)) {
        return els.get('ctx-popover-body').innerHTML.includes(`id="${id}"`) ? sub.get(id) : null;
      }
      throw new Error(`fakeDocument: unhandled id ${id}`);
    },
    createElement: () => ({
      set textContent(v) { this._t = String(v); },
      get innerHTML() {
        return String(this._t == null ? '' : this._t)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      },
    }),
    querySelector: () => null,
    addEventListener() {},
    documentElement: {},
  };
  global.window = { innerWidth: 1200, innerHeight: 800, api: {} };

  const { createPopoverGroup } = require('../renderer/lib/popover-group');
  const { initContextPopover } = require('../renderer/popovers/context-popover');
  const calls = [];
  const state = payloads
    ? new Map(Object.entries(payloads).map(([n, p]) => [n, { payload: p }]))
    : new Map([['seat-1', { payload }]]);
  const { openContextPopover } = initContextPopover({
    popoverApi: (name) => ({ ctx: (a) => { calls.push({ ...a, name }); return ctxImpl(a, name); } }),
    ctxCatLabel: (c) => c,
    openReportPanel() {}, openToolsPopover() {}, openSkillsPopover() {},
    proxyState: state,
    sessionTypeOf: () => 'claude',
    barPopovers: createPopoverGroup(),
  });

  return {
    open: (name = 'seat-1') => openContextPopover(name, fakeEl()),
    calls,
    body: () => els.get('ctx-popover-body').innerHTML,
    col: () => sub.get('ctx-util-col').innerHTML,
    restore() { global.document = prev.document; global.window = prev.window; },
  };
}

const okCtx = (agents) => async () => ({ ok: true, data: { agents } });

test('a peer payload (no capabilities) still renders the MCP column from the plain read', async () => {
  const h = harness({ payload: { queries: ['ctx'] }, ctxImpl: okCtx([MCP_AGENT]) });
  try {
    await h.open();
    assert.strictEqual(h.calls.length, 1,
      'ENTER: a caps-less payload must make exactly ONE fetch — the scan is not advertised, so asking for it would be the bug in the other direction');
    assert.deepStrictEqual(h.calls[0], { utilization: false, name: 'seat-1' }, 'ENTER: and that fetch is the plain read');
    const body = h.body();
    assert.match(body, /MCP servers/,
      'peerProxyView forwards no capabilities, so wantUtil is false for EVERY peer — yet the owner side answers with tools.per_tool, so the MCP block must render without any scan');
    assert.match(body, /linear/, 'and it must name the server the payload actually carried');
    assert.match(body, /ctx-cols/, 'rendered as the second column, not appended under the first');
  } finally { h.restore(); }
});

test('a proxy advertising neither scan flag renders the column too', async () => {
  const h = harness({ payload: { capabilities: { context_composition: true } }, ctxImpl: okCtx([MCP_AGENT]) });
  try {
    await h.open();
    assert.strictEqual(h.calls.length, 1, 'ENTER: no scan flag advertised means no scan fetch');
    assert.match(h.body(), /MCP servers/,
      'a composition-only proxy carries tools.per_tool on the plain read as well — the column is free and must not be gated on a scan it will never advertise');
  } finally { h.restore(); }
});

test('with the scan advertised the plain column paints first, under the scanning note', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({
    payload: { capabilities: { context_utilization: true } },
    ctxImpl: async (a) => {
      if (a.utilization) { await gate; return { ok: true, data: { agents: [MCP_AGENT] } }; }
      return { ok: true, data: { agents: [MCP_AGENT] } };
    },
  });
  try {
    const run = h.open();
    await new Promise((r) => setImmediate(r));
    const midflight = h.body();
    assert.match(midflight, /MCP servers/,
      'the 13ms read already paid for this block — it must be on screen while the 20.1s scan runs, not withheld until the scan lands');
    assert.match(midflight, /utilization: scanning…/, 'with the pending scan announced below it');
    release();
    await run;
    assert.strictEqual(h.calls.length, 2, 'ENTER: both fetches must have been made');
  } finally { h.restore(); }
});

test('a failed scan keeps the plain column and names the error', async () => {
  const h = harness({
    payload: { capabilities: { context_utilization: true } },
    ctxImpl: async (a) => (a.utilization
      ? { ok: false, error: 'proxy /_context utilization scan timed out after 20000ms' }
      : { ok: true, data: { agents: [MCP_AGENT] } }),
  });
  try {
    await h.open();
    assert.strictEqual(h.calls.length, 2, 'ENTER: the scan must have been attempted');
    const col = h.col();
    assert.match(col, /utilization unavailable/, 'the failure is reported');
    assert.match(col, /scan timed out after 20000ms/, 'naming what actually failed');
    assert.match(col, /MCP servers/,
      'and the scan-free half survives it: a timeout costs only what the scan would have ADDED');
    assert.match(h.body(), /ctx-line-head/, 'the composition column is untouched by the scan failure');
  } finally { h.restore(); }
});

test('a second click while a fetch is pending does not issue another pair', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({
    payload: { queries: ['ctx'] },
    ctxImpl: async () => { await gate; return { ok: true, data: { agents: [MCP_AGENT] } }; },
  });
  try {
    const a = h.open();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.calls.length, 1, 'ENTER: the first click must have started a fetch');
    const b = h.open();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.calls.length, 1,
      're-clicking the same session must join the in-flight run — the scan is a 20.1s disk walk and toggling the popover must not stack them');
    release();
    await Promise.all([a, b]);
    assert.match(h.body(), /MCP servers/, 'and the pending run still paints');

    await h.open();
    assert.strictEqual(h.calls.length, 2,
      'once settled the guard must have cleared, or the popover is wedged for the life of the window');
  } finally { h.restore(); }
});

test('a re-click for a session whose fetch is pending repaints Loading… when the body shows another session', async () => {
  let releaseA;
  const gateA = new Promise((r) => { releaseA = r; });
  const B_AGENT = {
    line: 'main',
    composition: { total_tokens: 900, basis: 'exact', by_category: [{ category: 'bees-marker', tokens: 900, pct: 100 }] },
    tools: { count: 1, est_tokens: 900, per_tool: [{ name: 'mcp__bees__sting', est_tokens: 900, used: 0 }] },
  };
  const h = harness({
    payloads: { A: { capabilities: { context_utilization: true } }, B: { queries: ['ctx'] } },
    ctxImpl: async (a, name) => {
      if (name !== 'A') return { ok: true, data: { agents: [B_AGENT] } };
      if (a.utilization) { await gateA; return { ok: true, data: { agents: [MCP_AGENT] } }; }
      return { ok: true, data: { agents: [MCP_AGENT] } };
    },
  });
  try {
    const a = h.open('A');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.calls.length, 2,
      'ENTER: A advertises the scan, so its plain read must have landed and the 20.1s scan must be the call left in flight — the only path where a repaint can strand a result');

    await h.open('B');
    assert.match(h.body(), /bees-marker/, 'ENTER: B must really be on screen — otherwise the re-click has nothing wrong to inherit');

    const a2 = h.open('A');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.calls.length, 3,
      'the joined click must NOT issue a fourth fetch: A is still pending and B made the third');
    assert.doesNotMatch(h.body(), /bees-marker/,
      "a joined click that returns without repainting leaves B's tokens on screen under A's name — a wrong number attributed to the wrong seat");
    assert.match(h.body(), /Loading…/, 'the body is reset to the pending note until A\'s own result lands');

    releaseA();
    await Promise.all([a, a2]);
    const body = h.body();
    assert.doesNotMatch(body, /Loading…/,
      'the repaint destroyed #ctx-util-col, so a scan result that gives up on a missing column strands the popover on Loading… for good — a control hidden by a slow proxy');
    assert.match(body, /ctx-line-head/, "A's composition must be back: the 13ms read already paid for it");
    assert.match(body, /MCP servers/, "and A's own result still paints when it arrives");
    assert.match(body, /linear/, 'with A\'s data, not B\'s');
    assert.match(body, /ctx-links/, 'with the links row re-emitted, or Manage tools / skills / Full report stay unreachable');
  } finally { h.restore(); }
});
