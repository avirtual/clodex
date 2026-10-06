'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createCliHooks } = require('../cli-hooks');
const { pathFor } = require('../clodex-paths');
const { mcpArgvPlan } = require('../proxy-util');
const { mkTmpRoot } = require('./lib/tmp-roots');

const P = '/run/seat/mcp.json';
const N_USER_MCP = "MCP: the clodex MCP tools are not available to this session — the seat's extra args carry their own --mcp-config.";
const N_USER_STRICT = "MCP: the clodex MCP tools are not available to this session — the seat's extra args carry --strict-mcp-config with no config, which is the empty set.";
const N_UNROUTED = 'MCP: all MCP servers disabled for this session (--strict-mcp-config) — this session is not routed through wirescope, so Clodex could not remove only the claude_design MCP server; to keep your other MCP servers, route the session through wirescope or turn off Settings ▸ Disable claude_design MCP. The clodex MCP tools stay available.';
const N_NO_STRIP = 'MCP: all MCP servers disabled for this session (--strict-mcp-config) — the wirescope this session uses is not configured to strip claude_design, so Clodex could not remove only that MCP server; to keep your other MCP servers, set STRIP_MCP_SERVERS=claude_design on that wirescope or turn off Settings ▸ Disable claude_design MCP. The clodex MCP tools stay available.';
const N_PROBE = 'MCP: all MCP servers disabled for this session (--strict-mcp-config) — wirescope did not answer when the session started; restart the session to retry, or turn off Settings ▸ Disable claude_design MCP. The clodex MCP tools stay available.';

const OURS = { push: ['--mcp-config', P], notice: null, writeConfig: true };
const USER_MCP = { push: [], notice: N_USER_MCP, writeConfig: false };
const USER_STRICT = { push: [], notice: N_USER_STRICT, writeConfig: false };
const STRICT_OURS = (notice) => ({ push: ['--strict-mcp-config', '--mcp-config', P], notice, writeConfig: true });

const ROWS = [
  [0, 0, null, 0, OURS],
  [0, 0, null, 1, OURS],
  [0, 0, 'unrouted', 0, OURS],
  [0, 0, 'unrouted', 1, STRICT_OURS(N_UNROUTED)],
  [0, 0, 'wire-no-strip', 0, OURS],
  [0, 0, 'wire-no-strip', 1, STRICT_OURS(N_NO_STRIP)],
  [0, 0, 'probe-failed', 0, OURS],
  [0, 0, 'probe-failed', 1, STRICT_OURS(N_PROBE)],
  [0, 1, null, 0, USER_STRICT],
  [0, 1, null, 1, USER_STRICT],
  [0, 1, 'unrouted', 0, USER_STRICT],
  [0, 1, 'unrouted', 1, USER_STRICT],
  [0, 1, 'wire-no-strip', 0, USER_STRICT],
  [0, 1, 'wire-no-strip', 1, USER_STRICT],
  [0, 1, 'probe-failed', 0, USER_STRICT],
  [0, 1, 'probe-failed', 1, USER_STRICT],
  [1, 0, null, 0, USER_MCP],
  [1, 0, null, 1, USER_MCP],
  [1, 0, 'unrouted', 0, USER_MCP],
  [1, 0, 'unrouted', 1, USER_MCP],
  [1, 0, 'wire-no-strip', 0, USER_MCP],
  [1, 0, 'wire-no-strip', 1, USER_MCP],
  [1, 0, 'probe-failed', 0, USER_MCP],
  [1, 0, 'probe-failed', 1, USER_MCP],
  [1, 1, null, 0, USER_MCP],
  [1, 1, null, 1, USER_MCP],
  [1, 1, 'unrouted', 0, USER_MCP],
  [1, 1, 'unrouted', 1, USER_MCP],
  [1, 1, 'wire-no-strip', 0, USER_MCP],
  [1, 1, 'wire-no-strip', 1, USER_MCP],
  [1, 1, 'probe-failed', 0, USER_MCP],
  [1, 1, 'probe-failed', 1, USER_MCP],
];

test('mcpArgvPlan: the 32-row matrix of user flags × reason × claude_design setting', () => {
  assert.strictEqual(ROWS.length, 32);
  for (const [userMcp, userStrict, reason, disableDesign, expected] of ROWS) {
    const got = mcpArgvPlan({ userMcp: !!userMcp, userStrict: !!userStrict, disableDesign: !!disableDesign, reason, mcpPath: P });
    assert.deepStrictEqual(got, expected, JSON.stringify({ userMcp, userStrict, reason, disableDesign }));
  }
});

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
  assert.ok(block.includes('if (plan.writeConfig) writeMcpConfig(name);'));
  assert.ok(block.includes("mcpPath: pathFor(REGISTRY_DIR, name, 'mcpConfig')"));
});
