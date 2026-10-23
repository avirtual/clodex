'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createEngine } = require('../engine');
const { ProxyClient } = require('../wirescope-proxy');
const { mkTmpRoot } = require('./lib/tmp-roots');

function rig(record) {
  const tmp = mkTmpRoot('clx-mcp-ctx-');
  const warns = [];
  const engine = createEngine({
    userDataPath: tmp,
    seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn: (tag, msg) => warns.push([tag, msg]), error() {} },
  });
  const name = record.name;
  engine.stores.persistence.upsert(record);
  engine.manager.sessions.set(name, { name, proxyBase: 'http://127.0.0.1:7999' });
  engine.proxyPoller.snapshot = () => ({ linked: true, sessionId: 'sid-1' });
  return { engine, name, warns };
}

const ROSTER = {
  agents: [{
    line: 'main',
    tools: { per_tool: [
      { name: 'mcp__clodex__dm' }, { name: 'mcp__jira__x' }, { name: 'Read' },
    ] },
  }],
};

async function fetchTwice(r) {
  const orig = ProxyClient._getJson;
  ProxyClient._getJson = async () => ({ status: 200, json: JSON.parse(JSON.stringify(ROSTER)) });
  try {
    const a = await r.engine.fetchProxyContext(r.name, {});
    const b = await r.engine.fetchProxyContext(r.name, {});
    return [a, b];
  } finally {
    ProxyClient._getJson = orig;
    r.engine.manager.sessions.delete(r.name);
  }
}

test('a roster server outside an empty selection is a leak, and its warn fires once across two fetches', async () => {
  const r = rig({ name: 'leaky', type: 'claude', cwd: '/tmp' });
  const [a, b] = await fetchTwice(r);
  assert.strictEqual(a.ok, true, 'ENTER: the fetch reached the proxy stub');
  assert.deepStrictEqual(a.data.clodex_mcp, { managed: true, selected: [], applied: null, leaks: ['jira'] });
  assert.deepStrictEqual(b.data.clodex_mcp.leaks, ['jira']);
  assert.deepStrictEqual(r.warns.filter(([tag]) => tag === 'mcp').map(([, m]) => m),
    ["leaky: MCP server jira is on the roster but not in the seat's selection"]);
});

test('a selected server is not a leak, and an unmanaged record reads managed:false', async () => {
  const applied = { names: ['jira'], digest: 'd1' };
  const r = rig({ name: 'picked', type: 'claude', cwd: '/tmp', mcpServers: ['jira'], mcpApplied: applied, mcpUnmanaged: true });
  const [a] = await fetchTwice(r);
  assert.deepStrictEqual(a.data.clodex_mcp, { managed: false, selected: ['jira'], applied, leaks: [] });
  assert.deepStrictEqual(r.warns.filter(([tag]) => tag === 'mcp'), []);
});

after(() => { setImmediate(() => process.exit(0)); });
