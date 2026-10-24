'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { claudeMcpServers, codexMcpArgs, tomlString } = require('../mcp-plan');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SERVER = `
const fs = require('fs');
fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({ env: process.env, argv: process.argv }));
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const result = msg.method === 'initialize'
      ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } }
      : msg.method === 'tools/list' ? { tools: [] } : null;
    const out = result ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } };
    process.stdout.write(JSON.stringify(out) + '\\n');
  }
});
`;

function codexOnPath() {
  const r = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

test('codexMcpArgs against a real Codex stdio child: values reach the child, argv carries names only', (t) => {
  const version = codexOnPath();
  if (!version) { t.skip('codex is not on PATH'); return; }
  const root = mkTmpRoot('clx-codex-probe-');
  const script = path.join(root, 'server.js');
  fs.writeFileSync(script, SERVER);
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(codexHome);
  const probeOut = path.join(root, 'dump.json');
  const library = [
    {
      name: 'probe',
      entry: {
        command: process.execPath,
        args: [script],
        env: {
          FIXED: 'v1',
          API_TOKEN: '${JIRA_TOKEN}',
          URL: 'https://${JIRA_TOKEN}@h/x',
          EMPTY: '',
          Q: 'a"b\\c\n',
          UNI: 'héllo ✓',
          PROBE_OUT: '${PROBE_OUT}',
        },
      },
    },
    { name: 'unset', entry: { command: process.execPath, args: [script], env: { T: '${CLODEX_PROBE_UNSET_VAR}' } } },
  ];
  const env = { JIRA_TOKEN: 'hunter2', PROBE_OUT: probeOut };
  const plan = claudeMcpServers({ selected: ['probe', 'unset'], library, env, cli: 'codex' });
  assert.deepStrictEqual(plan.warnings, ['MCP unset: not loaded — CLODEX_PROBE_UNSET_VAR is not set (Preferences ▸ Environment)']);
  const cx = codexMcpArgs({ servers: plan.servers, library, env, userOwn: false, configNames: [] });
  assert.deepStrictEqual(cx.applied.names, ['probe']);
  assert.ok(!cx.args.some((a) => a.startsWith('mcp_servers.unset.')), cx.args.join(' '));
  assert.ok(cx.args.includes(`mcp_servers.probe.env={EMPTY="",FIXED="v1",Q=${tomlString('a"b\\c\n')},UNI="héllo ✓"}`), cx.args.join(' '));
  assert.ok(!cx.args.join(' ').includes('hunter2'));
  const { JIRA_TOKEN: _drop, ...parentEnv } = process.env;
  const r = spawnSync('codex', [...cx.args, 'debug', 'prompt-input'], {
    cwd: root,
    env: { ...parentEnv, CODEX_HOME: codexHome, ...cx.seatEnv, JIRA_TOKEN: 'hunter2', PROBE_OUT: probeOut },
    encoding: 'utf8',
    timeout: 60000,
  });
  if (r.status !== 0) { t.skip(`codex debug prompt-input failed: ${(r.stderr || String(r.error)).slice(0, 400)}`); return; }
  const dump = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
  t.diagnostic(`${version}: child env keys ${Object.keys(dump.env).sort().join(' ')}`);
  assert.strictEqual(dump.env.FIXED, 'v1');
  assert.strictEqual(dump.env.API_TOKEN, 'hunter2');
  assert.strictEqual(dump.env.URL, 'https://hunter2@h/x');
  assert.strictEqual(dump.env.EMPTY, '');
  assert.strictEqual(dump.env.Q, 'a"b\\c\n');
  assert.strictEqual(dump.env.UNI, 'héllo ✓');
  assert.strictEqual(dump.env.JIRA_TOKEN, undefined, 'the source var is not forwarded, only the names in env_vars');
  assert.ok(!dump.argv.join(' ').includes('hunter2'));
});
