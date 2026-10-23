'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createCliHooks } = require('../cli-hooks');
const { pathFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

test('writeMcpConfig: one clodex server under the hooks interpreter, mode 0600, no seat env', () => {
  const root = mkTmpRoot('clodex-hooks-');
  const prev = process.env.CLODEX_INTENT_CRED;
  process.env.CLODEX_INTENT_CRED = 'sentinel-cred-7f3a';
  try {
    const h = createCliHooks({
      REGISTRY_DIR: root,
      memoryStore: { list: () => [] },
      getUiSettings: () => ({ get: () => ({}) }),
      nodeInterp: '/opt/app/Clodex',
    });
    const out = h.writeMcpConfig('seat1');
    assert.strictEqual(out, pathFor(root, 'seat1', 'mcpConfig'));
    assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600);
    const raw = fs.readFileSync(out, 'utf8');
    assert.ok(!raw.includes('sentinel-cred-7f3a'));
    assert.ok(!raw.includes('CLODEX_INTENT_CRED'));
    const cfg = JSON.parse(raw);
    assert.deepStrictEqual(Object.keys(cfg), ['mcpServers']);
    assert.deepStrictEqual(Object.keys(cfg.mcpServers), ['clodex']);
    const s = cfg.mcpServers.clodex;
    assert.strictEqual(s.command, '/opt/app/Clodex');
    assert.strictEqual(s.args.length, 1);
    assert.ok(s.args[0].endsWith(path.join('cli', 'bin', 'clodex-mcp.js')));
    assert.ok(path.isAbsolute(s.args[0]));
    assert.ok(fs.existsSync(s.args[0]));
    assert.deepStrictEqual(s.env, { ELECTRON_RUN_AS_NODE: '1' });
  } finally {
    if (prev === undefined) delete process.env.CLODEX_INTENT_CRED;
    else process.env.CLODEX_INTENT_CRED = prev;
  }
});

test('session-manager samples the user MCP flags before the plan and its push', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const mcp = src.indexOf('const userMcp = args.some((a) => /^--mcp-config(=|$)/.test(a));');
  const strict = src.indexOf('const userStrict = args.some((a) => /^--strict-mcp-config(=|$)/.test(a));');
  const plan = src.indexOf('const plan = mcpArgvPlan(');
  const push = src.indexOf('args.push(...plan.push);');
  assert.ok(mcp > 0 && strict > 0);
  assert.ok(plan > mcp && plan > strict);
  assert.ok(push > plan);
  assert.strictEqual(src.split('/^--mcp-config(=|$)/').length, 2);
  assert.strictEqual(src.split('/^--strict-mcp-config(=|$)/').length, 2);
  const block = src.slice(mcp, src.indexOf('const userPluginDir', mcp));
  assert.ok(block.includes('writeMcpConfig(name, mcpSel.servers);'));
  assert.ok(block.includes("mcpPath: pathFor(REGISTRY_DIR, name, 'mcpConfig')"));
});

test('writeMcpConfig: library servers sit beside clodex, and clodex wins a clash', () => {
  const root = mkTmpRoot('clodex-hooks-');
  const h = createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({}) }),
    nodeInterp: '/opt/app/Clodex',
  });
  const jira = { type: 'stdio', command: 'npx', args: ['jira'], env: { JIRA_TOKEN: 't' } };
  const out = h.writeMcpConfig('seat2', { jira, clodex: { command: '/evil' } });
  assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600);
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual(Object.keys(cfg.mcpServers).sort(), ['clodex', 'jira']);
  assert.deepStrictEqual(cfg.mcpServers.jira, jira);
  assert.strictEqual(cfg.mcpServers.clodex.command, '/opt/app/Clodex');
});
