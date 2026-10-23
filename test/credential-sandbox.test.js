'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createCliHooks } = require('../cli-hooks');
const { buildCredentialSandbox } = require('../credential-sandbox');
const { mkTmpRoot } = require('./lib/tmp-roots');

function seededRoot() {
  const root = mkTmpRoot('clx-credsb-');
  for (const d of ['projects', 'teams', 'cli', 'boxes', 'sessions', 'run']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

test('buildCredentialSandbox: every seat\'s resolved MCP file is read-denied, both layouts', () => {
  const root = seededRoot();
  const g = buildCredentialSandbox({ registryDir: root, list: [], home: '/h' });
  const runGlob = path.join(root, 'run', '*', 'mcp.json');
  const seatGlob = path.join(root, 'sessions', '*', 'run', 'mcp.json');
  for (const p of [runGlob, seatGlob]) {
    assert.ok(g.sandbox.filesystem.denyRead.includes(p), `denyRead lists ${p}`);
    assert.ok(g.sandbox.credentials.files.some((f) => f.path === p && f.mode === 'deny'), `credentials.files lists ${p}`);
    assert.ok(g.deny.includes(`Read(/${p})`), `permissions deny Read(/${p})`);
    assert.ok(g.deny.includes(`Edit(/${p})`), `permissions deny Edit(/${p})`);
  }
  const inBox = buildCredentialSandbox({ registryDir: root, list: [], home: '/h', inBox: true });
  assert.ok(inBox.deny.includes(`Read(/${runGlob})`), 'the file-tool deny survives inside a box');
});

test('buildCredentialSandbox: the selection\'s ${NAME}s join the env deny, deduped with the group names', () => {
  const root = seededRoot();
  const g = buildCredentialSandbox({ registryDir: root, list: ['~/.config/gh'], home: '/h', mcpSecretNames: ['JIRA_TOKEN', 'GH_TOKEN', '', 7] });
  assert.deepStrictEqual(g.sandbox.credentials.envVars, [
    { name: 'GITHUB_TOKEN', mode: 'deny' },
    { name: 'GH_TOKEN', mode: 'deny' },
    { name: 'JIRA_TOKEN', mode: 'deny' },
  ]);
  const none = buildCredentialSandbox({ registryDir: root, list: [], home: '/h' });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(none.sandbox.credentials, 'envVars'), false);
});

test('setupClaudeHook hands mcpSecretNames to the sandbox only for a protected seat', () => {
  const root = seededRoot();
  const h = createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
  const prior = process.env.CLODEX_IN_SANDBOX;
  delete process.env.CLODEX_IN_SANDBOX;
  try {
    const at = (name, protect) => JSON.parse(fs.readFileSync(
      h.setupClaudeHook(name, null, null, [], [], [], null, null, [], false, null, protect, ['JIRA_TOKEN']), 'utf-8'));
    assert.deepStrictEqual(at('p1', []).sandbox.credentials.envVars, [{ name: 'JIRA_TOKEN', mode: 'deny' }]);
    assert.strictEqual(at('p2', null).sandbox, undefined);
  } finally {
    if (prior !== undefined) process.env.CLODEX_IN_SANDBOX = prior;
  }
});

test('session-manager derives mcpSecretNames from the applied selection and passes it to setupClaudeHook', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  assert.ok(src.includes('mcpLib.filter((r) => mcpSel.applied.names.includes(r.name)).flatMap((r) => secretRefs(r.entry))'));
  assert.ok(/setupClaudeHook\([^;]*Array\.isArray\(protectCredentials\) \? protectCredentials : null, mcpSecretNames\);/.test(src));
  assert.ok(src.indexOf('const mcpSecretNames') < src.indexOf('setupClaudeHook(name,'));
});
