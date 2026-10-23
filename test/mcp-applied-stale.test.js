'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { claudeMcpServers } = require('../mcp-plan');

const JIRA = { type: 'stdio', command: 'jira-mcp', env: { JIRA_TOKEN: '${JIRA_TOKEN}' } };
const DOCS = { type: 'http', url: 'https://docs/mcp' };

function door(record, library) {
  const { registerIpcHandlers } = require('../ipc-handlers');
  const handlers = {};
  const stub = () => () => {};
  const deps = new Proxy({
    handle: (ch, fn) => { handlers[ch] = fn; }, on: () => {},
    persistence: { get: (n) => (n === record.name ? record : null) },
    mcpLibrary: { list: () => Object.entries(library).map(([name, entry]) => ({ name, entry })) },
  }, { get(t, k) { return k in t ? t[k] : stub(); } });
  registerIpcHandlers(deps);
  assert.strictEqual(typeof handlers['mcp:appliedStale'], 'function', 'ENTER: the door is registered');
  return (name) => handlers['mcp:appliedStale']({}, name);
}

function appliedFor(library, selected) {
  const lib = Object.entries(library).map(([name, entry]) => ({ name, entry }));
  return claudeMcpServers({ selected, library: lib, env: { JIRA_TOKEN: 'hunter2' } }).applied;
}

test('mcp:appliedStale: an unchanged library entry is fresh', () => {
  const lib = { jira: JIRA, docs: DOCS };
  const applied = appliedFor(lib, ['jira', 'docs']);
  assert.deepStrictEqual(applied.names, ['docs', 'jira'], 'ENTER: both servers were applied at spawn');
  const ask = door({ name: 's', mcpServers: ['jira', 'docs'], mcpApplied: applied }, lib);
  assert.deepStrictEqual(ask('s'), { ok: true, servers: ['jira', 'docs'], unmanaged: false, stale: false });
});

test('mcp:appliedStale: an edited or deleted library entry since spawn reads stale', () => {
  const applied = appliedFor({ jira: JIRA, docs: DOCS }, ['jira', 'docs']);
  const edited = door({ name: 's', mcpServers: ['jira', 'docs'], mcpApplied: applied },
    { jira: { ...JIRA, args: ['--verbose'] }, docs: DOCS });
  assert.strictEqual(edited('s').stale, true, 'an edited definition is not what the seat loaded');
  const gone = door({ name: 's', mcpServers: ['jira', 'docs'], mcpApplied: applied }, { jira: JIRA });
  assert.strictEqual(gone('s').stale, true, 'a deleted entry is not what the seat loaded');
});

test('mcp:appliedStale: an unmanaged record with nothing applied, and an unknown seat', () => {
  const ask = door({ name: 'u', mcpUnmanaged: true }, {});
  assert.deepStrictEqual(ask('u'), { ok: true, servers: [], unmanaged: true, stale: false });
  assert.deepStrictEqual(ask('nope'), { ok: false, error: 'Session not found' });
});
