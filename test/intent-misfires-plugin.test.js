'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');
const { MISFIRE_KINDS } = require('../stores');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ENGINE_PATH = require.resolve('../plugins/intent-misfires/engine');
const MANIFEST = require('../plugins/intent-misfires/manifest.json');

const rec = (over) => ({
  ts: 1700000000000, agent: 'lead', kind: 'bounce', intent: 'task', sub: 'start', detail: 'error: no ticket t9',
  turnBytes: 300, ctxTokens: 90000, sinceCompact: null, ...over,
});

function boot({ lines, live = [], saved = [] } = {}) {
  const dir = mkTmpRoot('clodex-mf-data-');
  const file = path.join(dir, 'intent-misfires.jsonl');
  if (lines !== undefined) fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const sessions = new Map(live.map((s) => [s.name, s]));
  const calls = { listAll: 0, saved: [] };
  const manager = {
    sessions,
    list: () => { calls.listAll += 1; return [...sessions.values()]; },
    listForWorkspace: (wsId) => [...sessions.values()].filter((s) => s.workspaceId === wsId),
    savedForWorkspace: (wsId) => { calls.saved.push(wsId); return saved.filter((e) => e.workspaceId === wsId); },
    _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null,
  };
  const host = createPluginHostEngine({
    manager,
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
    libraryKinds: {},
  });
  delete require.cache[ENGINE_PATH];
  host.register('intent-misfires', require(ENGINE_PATH), { hostApi: HOST_API_VERSION });
  return { host, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const LIVE = [
  { name: 'lead', type: 'claude', cwd: '/r', workspaceId: 'ws-1' },
  { name: 'stranger', type: 'claude', cwd: '/x', workspaceId: 'ws-2' },
];
const SAVED = [
  { name: 'hand', type: 'claude', cwd: '/r', workspaceId: 'ws-1' },
];
const LINES = [
  rec({ ts: 1 }),
  rec({ ts: 2, agent: 'hand', kind: 'schema', intent: 'exec', sub: 'run-tests', detail: 'run-tests: tree required' }),
  rec({ ts: 3, kind: 'unclosed-body', intent: 'dm', sub: undefined, detail: '[agent:dm] not closed' }),
  rec({ ts: 4, agent: 'stranger' }),
  rec({ ts: 5, kind: 'invented' }),
  'not json',
];

test('intent-misfires: kinds mirror the core set; disabled by default', () => {
  assert.deepStrictEqual([...require(ENGINE_PATH).KINDS], [...MISFIRE_KINDS]);
  assert.strictEqual(MANIFEST.enabledByDefault, false);
});

test('intent-misfires: list is workspace-scoped, newest first, with per-seat kind counts, never via listAll', async () => {
  const { host, calls, cleanup } = boot({ lines: LINES, live: LIVE, saved: SAVED });
  try {
    const res = await host.dispatch('intent-misfires', 'list', [{ workspaceId: 'ws-1' }], 'desktop');
    assert.deepStrictEqual(res.rows.map((r) => r.ts), [3, 2, 1]);
    assert.deepStrictEqual(res.rows[0], {
      ts: 3, agent: 'lead', kind: 'unclosed-body', intent: 'dm', sub: null, detail: '[agent:dm] not closed',
      turnBytes: 300, ctxTokens: 90000, sinceCompact: null,
    });
    assert.deepStrictEqual(res.counts, { lead: { bounce: 1, 'unclosed-body': 1 }, hand: { schema: 1 } });
    assert.deepStrictEqual(res.kinds, [...MISFIRE_KINDS]);
    assert.deepStrictEqual(calls.saved, ['ws-1']);
    assert.strictEqual(calls.listAll, 0);
  } finally { cleanup(); }
});

test('intent-misfires: agent and kind filters narrow the rows, not the counts', async () => {
  const { host, cleanup } = boot({ lines: LINES, live: LIVE, saved: SAVED });
  try {
    const byAgent = await host.dispatch('intent-misfires', 'list', [{ workspaceId: 'ws-1', agent: 'lead' }], 'desktop');
    assert.deepStrictEqual(byAgent.rows.map((r) => r.ts), [3, 1]);
    const byKind = await host.dispatch('intent-misfires', 'list', [{ workspaceId: 'ws-1', kind: 'schema' }], 'desktop');
    assert.deepStrictEqual(byKind.rows.map((r) => r.ts), [2]);
    assert.deepStrictEqual(byKind.counts, { lead: { bounce: 1, 'unclosed-body': 1 }, hand: { schema: 1 } });
    const both = await host.dispatch('intent-misfires', 'list', [{ workspaceId: 'ws-1', agent: 'hand', kind: 'bounce' }], 'desktop');
    assert.deepStrictEqual(both.rows, []);
    const capped = await host.dispatch('intent-misfires', 'list', [{ workspaceId: 'ws-1', limit: 1 }], 'desktop');
    assert.deepStrictEqual(capped.rows.map((r) => r.ts), [3]);
  } finally { cleanup(); }
});

test('intent-misfires: bad filters and a missing workspace are refused; a missing file is empty', async () => {
  const { host, cleanup } = boot({ live: LIVE });
  try {
    assert.deepStrictEqual(await host.dispatch('intent-misfires', 'list', [{}], 'desktop'),
      { ok: false, error: 'a workspace id is required' });
    assert.deepStrictEqual(await host.dispatch('intent-misfires', 'list', [{ workspaceId: 'ws-1', agent: '..' }], 'desktop'),
      { ok: false, error: 'the agent filter is not a valid seat name' });
    const badKind = await host.dispatch('intent-misfires', 'list', [{ workspaceId: 'ws-1', kind: 'invented' }], 'desktop');
    assert.strictEqual(badKind.ok, false);
    assert.deepStrictEqual(await host.dispatch('intent-misfires', 'list', [{ workspaceId: 'ws-1' }], 'desktop'),
      { ok: true, rows: [], counts: {}, kinds: [...MISFIRE_KINDS] });
  } finally { cleanup(); }
});
