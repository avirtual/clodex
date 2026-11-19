'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createClodentTools } = require('../clodent-tools');
const { registerIpcHandlers } = require('../ipc-handlers');
const { createCliHooks } = require('../cli-hooks');
const { toolListFor } = require('../renderer/lib/checklists');
const { unlistedOf, mergeLists } = require('../plugin-api');

const BUILTIN = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
const tool = (name, kind = 'read') => ({ name, kind, description: `<b>${name}</b>`, input_schema: { type: 'object' } });
const line = (doc) => `${JSON.stringify(doc)}\n`;
const V091 = line({ v: 1, version: '0.9.1', tools: BUILTIN.map((n) => tool(n)) });

function fakeClodent({ stdout = '', stderr = '', exit = 0, hang = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodent-list-tools-'));
  fs.writeFileSync(path.join(dir, 'out.txt'), stdout);
  fs.writeFileSync(path.join(dir, 'err.txt'), stderr);
  const bin = path.join(dir, 'clodent');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'echo x >> "${0%/*}/calls"',
    hang ? 'exec /bin/sleep 30' : '',
    '/bin/cat "${0%/*}/out.txt"',
    '/bin/cat "${0%/*}/err.txt" >&2',
    `exit ${exit}`,
  ].join('\n'), { mode: 0o755 });
  const logs = [];
  const tools = createClodentTools({ env: { PATH: dir }, log: { info: (tag, msg) => logs.push(`${tag}: ${msg}`) }, timeoutMs: 150 });
  const calls = () => { try { return fs.readFileSync(path.join(dir, 'calls'), 'utf-8').split('\n').filter(Boolean).length; } catch { return 0; } };
  return { dir, bin, tools, logs, calls };
}

test('clodent 0.9.1: the --list-tools line gives the eight built-ins in order, with their kinds', async () => {
  const f = fakeClodent({ stdout: V091 });
  const r = await f.tools.list();
  assert.deepStrictEqual(r.names, ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
  assert.deepStrictEqual([r.source, r.reason, r.tools[0]], ['clodent', null, { name: 'Read', kind: 'read' }]);
  assert.deepStrictEqual(f.logs, []);
});

test('clodent 0.9.0: exit 2 with the unknown-option message gives the built-in list and one log line', async () => {
  const f = fakeClodent({ stderr: 'clodent: unknown option: --list-tools\n', exit: 2 });
  const r = await f.tools.list();
  assert.deepStrictEqual([r.source, r.names], ['builtin', BUILTIN]);
  assert.deepStrictEqual(f.logs, [`clodent: ${f.bin} --list-tools: using the built-in tool list (exit 2 (clodent 0.9.0 or older))`]);
  await f.tools.list();
  assert.strictEqual(f.logs.length, 1, 'a second seat does not log again');
});

const many = (n) => Array.from({ length: n }, (_, i) => tool(`T${i}`));
const FALLBACKS = [
  ['timeout', { hang: true }, 'timeout after 150ms'],
  ['garbage', { stdout: 'not json\n' }, 'unparsable output'],
  ['two lines', { stdout: `${V091}${V091}` }, 'output is not one line'],
  ['other non-zero exit', { stdout: V091, exit: 1 }, 'exit 1'],
  ['v:2', { stdout: line({ v: 2, tools: [tool('Read')] }) }, 'unsupported v 2'],
  ['a name with a space', { stdout: line({ v: 1, tools: [tool('Read'), tool('Web Fetch')] }) }, 'invalid tool name "Web Fetch"'],
  ['a name with a quote', { stdout: line({ v: 1, tools: [tool('Re"ad')] }) }, 'invalid tool name "Re\\"ad"'],
  ['a duplicate', { stdout: line({ v: 1, tools: [tool('Read'), tool('Bash'), tool('Read')] }) }, 'duplicate tool name Read'],
  ['65 tools', { stdout: line({ v: 1, tools: many(65) }) }, '65 tools, over 64'],
  ['an empty array', { stdout: line({ v: 1, tools: [] }) }, 'tools is not a non-empty array'],
];
for (const [label, fake, reason] of FALLBACKS) {
  test(`fallback: ${label} gives the built-in list, reason "${reason}"`, async () => {
    const f = fakeClodent(fake);
    const r = await f.tools.list();
    assert.deepStrictEqual([r.source, r.reason, r.names], ['builtin', reason, BUILTIN]);
    assert.strictEqual(f.logs.length, 1);
  });
}

test('64 tools is accepted', async () => {
  const f = fakeClodent({ stdout: line({ v: 1, tools: many(64) }) });
  assert.strictEqual((await f.tools.list()).names.length, 64);
});

test('not on PATH: the built-in list, reason "not on PATH"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodent-list-tools-empty-'));
  const r = await createClodentTools({ env: { PATH: dir } }).list();
  assert.deepStrictEqual([r.source, r.reason, r.names], ['builtin', 'not on PATH', BUILTIN]);
});

test('mcp__ names are dropped; an unknown kind is kept as given', async () => {
  const f = fakeClodent({ stdout: line({ v: 1, tools: [tool('Read'), tool('mcp__x'), tool('Zap', 'teleport')] }) });
  const r = await f.tools.list();
  assert.deepStrictEqual(r.tools, [{ name: 'Read', kind: 'read' }, { name: 'Zap', kind: 'teleport' }]);
});

test('cache: two seats ask once; a changed mtime asks again', async () => {
  const f = fakeClodent({ stdout: V091 });
  await Promise.all([f.tools.list(), f.tools.list()]);
  await f.tools.list();
  assert.strictEqual(f.calls(), 1);
  fs.utimesSync(f.bin, new Date(2001, 0, 1), new Date(2001, 0, 1));
  await f.tools.list();
  assert.strictEqual(f.calls(), 2);
});

test('peek: null until the answer lands, then the learned list without a second ask', async () => {
  const f = fakeClodent({ stdout: V091 });
  assert.strictEqual(f.tools.peek(), null);
  await f.tools.list();
  assert.deepStrictEqual(f.tools.peek().names, BUILTIN);
  assert.strictEqual(f.calls(), 1);
});

function settingsGet(peekClodentTools) {
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    uiSettings: { get: () => ({}), set: () => ({}) },
    agentDefaults: { getDefaultDeny: () => [], getDefaultSkillDeny: () => [], getDefaultBuiltinDeny: () => [] },
    syncRemoteServer: () => {},
    manager: { _broadcast: () => {} },
    log: { info() {}, error() {} },
    peekClodentTools,
  });
  return handlers.get('settings:get');
}

test('checklist: an unknown ninth tool appears for a clodent seat; Claude, codex and muse lists are unchanged', async () => {
  const f = fakeClodent({ stdout: line({ v: 1, tools: [...BUILTIN, 'Frobnicate'].map((n) => tool(n)) }) });
  await f.tools.list();
  const learned = settingsGet(() => f.tools.peek())({});
  const stock = settingsGet(undefined)({});
  assert.deepStrictEqual(toolListFor(learned, 'clodent'), ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Frobnicate']);
  assert.deepStrictEqual(toolListFor(stock, 'clodent'), BUILTIN);
  assert.deepStrictEqual({ ...learned.toolsByType, clodent: null }, { ...stock.toolsByType, clodent: null });
  assert.deepStrictEqual(settingsGet(() => null)({}).toolsByType, stock.toolsByType, 'no answer yet: the built-in list');
});

test('unticking the ninth tool writes its deny rule; a saved unticked name the list dropped survives a save and denies nothing', () => {
  const names = [...BUILTIN, 'Frobnicate'];
  const persisted = ['OldGone', 'Bash'];
  const collected = ['Frobnicate'];
  const saved = mergeLists(collected, unlistedOf(persisted, names));
  assert.deepStrictEqual(saved, ['Frobnicate', 'OldGone']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodent-list-tools-hooks-'));
  const h = createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
  const s = JSON.parse(fs.readFileSync(h.setupClaudeHook('cd1', null, null, [], saved, [], null, null, [], false, null, null, [], [], '/w', null, null, null, names), 'utf-8'));
  assert.deepStrictEqual(s.permissions.deny, ['Frobnicate']);
  const claude = JSON.parse(fs.readFileSync(h.setupClaudeHook('cl1', null, null, [], saved, [], null, null, [], false, null, null, [], [], '/w', null, null, null, null), 'utf-8'));
  assert.strictEqual(claude.permissions, undefined, 'a Claude seat still filters by the Claude catalog');
});
