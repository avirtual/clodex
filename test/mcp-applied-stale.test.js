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

test('mcp:appliedStale: a selected name absent from the library is not loadable, so it never counts as applied', () => {
  assert.deepStrictEqual(
    door({ name: 's', type: 'claude', mcpServers: ['jira', 'docs'], mcpApplied: appliedFor({ jira: JIRA }, ['jira']) }, { jira: JIRA })('s'),
    { ok: true, servers: ['jira', 'docs'], unmanaged: false, stale: false });
});

test('mcp:appliedStale: a denyTools entry is fresh as spawned and stale once its deny list changes', () => {
  const lib = { docs: { ...DOCS, denyTools: ['write'] } };
  const applied = appliedFor(lib, ['docs']);
  assert.deepStrictEqual(applied.denied, { docs: ['write'] }, 'ENTER: the deny list was applied at spawn');
  assert.strictEqual(door({ name: 's', type: 'claude', mcpServers: ['docs'], mcpApplied: applied }, lib)('s').stale, false);
  const edited = door({ name: 's', type: 'claude', mcpServers: ['docs'], mcpApplied: applied }, { docs: { ...DOCS, denyTools: ['write', 'delete'] } });
  assert.strictEqual(edited('s').stale, true);
});

test('mcp:appliedStale: an unmanaged record with nothing applied, and an unknown seat', () => {
  const ask = door({ name: 'u', mcpUnmanaged: true }, {});
  assert.deepStrictEqual(ask('u'), { ok: true, servers: [], unmanaged: true, stale: false });
  assert.deepStrictEqual(ask('nope'), { ok: false, error: 'Session not found' });
});

test('mcp:appliedStale: a selection saved without a restart, or a server skipped at spawn, reads stale', () => {
  const lib = { jira: JIRA, docs: DOCS };
  const applied = appliedFor(lib, ['docs']);
  assert.deepStrictEqual(applied.names, ['docs'], 'ENTER: only docs was applied');
  const ask = door({ name: 's', type: 'claude', mcpServers: ['jira', 'docs'], mcpApplied: applied }, lib);
  assert.strictEqual(ask('s').stale, true);
  const none = door({ name: 'n', type: 'claude', mcpServers: ['jira'] }, lib);
  assert.strictEqual(none('n').stale, true, 'selected with nothing applied');
});

test('mcp:appliedStale: an array of names answers each seat from one library read', () => {
  let reads = 0;
  const { registerIpcHandlers } = require('../ipc-handlers');
  const handlers = {};
  const records = { a: { name: 'a' }, b: { name: 'b', mcpUnmanaged: true } };
  const deps = new Proxy({
    handle: (ch, fn) => { handlers[ch] = fn; }, on: () => {},
    persistence: { get: (n) => records[n] || null },
    mcpLibrary: { list: () => { reads++; return []; } },
  }, { get(t, k) { return k in t ? t[k] : () => () => {}; } });
  registerIpcHandlers(deps);
  assert.deepStrictEqual(handlers['mcp:appliedStale']({}, ['a', 'b', 'gone']), {
    a: { ok: true, servers: [], unmanaged: false, stale: false },
    b: { ok: true, servers: [], unmanaged: true, stale: false },
    gone: { ok: false, error: 'Session not found' },
  });
  assert.strictEqual(reads, 1);
});

test('mcp:appliedStale: a Codex seat with a selection it never applied reads stale', () => {
  const lib = { jira: JIRA };
  assert.strictEqual(door({ name: 'c', type: 'codex', mcpServers: ['jira'] }, lib)('c').stale, true);
  const applied = { ...appliedFor(lib, ['jira']), residue: ['cua_repl'] };
  assert.strictEqual(door({ name: 'c', type: 'codex', mcpServers: ['jira'], mcpApplied: applied }, lib)('c').stale, false);
});

test('mcp:appliedStale: a server Codex cannot express is not loadable there, so selecting it does not read stale forever', () => {
  const lib = { jira: JIRA, old: { type: 'sse', url: 'https://s/sse' } };
  const applied = { ...appliedFor({ jira: JIRA }, ['jira']), residue: [] };
  assert.deepStrictEqual(applied.names, ['jira'], 'ENTER: only jira was applied');
  assert.strictEqual(door({ name: 'c', type: 'codex', mcpServers: ['jira', 'old'], mcpApplied: applied }, lib)('c').stale, false);
});

test('mcp:appliedStale: a selected name no longer in the library is not loadable, so it does not read stale', () => {
  const applied = appliedFor({ jira: JIRA }, ['jira']);
  assert.deepStrictEqual(applied.names, ['jira'], 'ENTER: jira was applied');
  assert.strictEqual(door({ name: 'g', type: 'claude', mcpServers: ['jira', 'gone'], mcpApplied: applied }, { jira: JIRA })('g').stale, false);
});

test('mcp:appliedStale: a selection Clodex never applies — unmanaged Claude, a server not on claude — is not stale', () => {
  const lib = { jira: JIRA, codexOnly: { ...DOCS, platforms: ['codex'] } };
  assert.strictEqual(door({ name: 'u', type: 'claude', mcpUnmanaged: true, mcpServers: ['jira'] }, lib)('u').stale, false);
  const applied = appliedFor(lib, ['jira', 'codexOnly']);
  assert.deepStrictEqual(applied.names, ['jira'], 'ENTER: the codex-only server was skipped at spawn');
  assert.strictEqual(door({ name: 'p', type: 'claude', mcpServers: ['jira', 'codexOnly'], mcpApplied: applied }, lib)('p').stale, false);
});

test('mcp:appliedStale: a muse seat reads stale once a selected library entry changes, and an sse entry is never loadable there', () => {
  const lib = { jira: JIRA, old: { type: 'sse', url: 'https://s/sse' } };
  const applied = appliedFor({ jira: JIRA }, ['jira']);
  assert.deepStrictEqual(applied.names, ['jira'], 'ENTER: only jira was applied');
  const rec = { name: 'm', type: 'muse', mcpServers: ['jira', 'old'], mcpApplied: applied };
  assert.strictEqual(door(rec, lib)('m').stale, false);
  assert.strictEqual(door(rec, { ...lib, jira: { ...JIRA, command: 'jira-mcp-2' } })('m').stale, true);
  assert.strictEqual(door({ name: 'm', type: 'muse', mcpServers: ['jira'] }, lib)('m').stale, true);
});

test('mcp:appliedStale: a Codex seat spawned with an empty selection carries an empty applied record and reads fresh', () => {
  const applied = { ...appliedFor({}, []), residue: [] };
  assert.deepStrictEqual(applied.names, [], 'ENTER: nothing applied');
  assert.strictEqual(door({ name: 'c', type: 'codex', mcpApplied: applied }, { jira: JIRA })('c').stale, false);
});
