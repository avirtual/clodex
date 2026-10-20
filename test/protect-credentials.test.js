'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCliHooks } = require('../cli-hooks');
const { buildCredentialSandbox } = require('../credential-sandbox');
const { mkTmpRoot } = require('./lib/tmp-roots');

const HOME = os.homedir();

function hooksAt(root) {
  return createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
}

function seededRoot() {
  const root = mkTmpRoot('clx-protect-');
  for (const d of ['projects', 'teams', 'cli', 'boxes', 'sessions']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'setup.json'), '{}');
  return root;
}

function settingsFor(root, name, protectCredentials, extraDenyRules = ['Bash(rm:*)']) {
  const args = [name, null, null, [], [], [], null, null, extraDenyRules, false, null];
  if (protectCredentials !== undefined) args.push(protectCredentials);
  return JSON.parse(fs.readFileSync(hooksAt(root).setupClaudeHook(...args), 'utf-8'));
}

function withBoxEnv(value, fn) {
  const prior = process.env.CLODEX_IN_SANDBOX;
  if (value === undefined) delete process.env.CLODEX_IN_SANDBOX;
  else process.env.CLODEX_IN_SANDBOX = value;
  try { return fn(); } finally {
    if (prior === undefined) delete process.env.CLODEX_IN_SANDBOX;
    else process.env.CLODEX_IN_SANDBOX = prior;
  }
}

test('protectCredentials null: settings are those of a call without the parameter', () => {
  withBoxEnv(undefined, () => {
    const root = seededRoot();
    const omitted = settingsFor(root, 'seat-a', undefined);
    const explicit = settingsFor(root, 'seat-a', null);
    assert.deepStrictEqual(explicit, omitted);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(explicit, 'sandbox'), false);
    assert.deepStrictEqual(explicit.permissions, { deny: ['Bash(rm:*)'] });
  });
});

test('protectCredentials [~/.aws]: sandbox block, env scrub, file-tool denies', () => {
  withBoxEnv(undefined, () => {
    const root = seededRoot();
    const s = settingsFor(root, 'seat-b', ['~/.aws']);
    const t0 = [
      path.join(root, 'cli', 'contexts.json'),
      path.join(root, 'teams', '*', 'sandbox.json'),
      path.join(root, 'boxes'),
    ];
    assert.strictEqual(s.sandbox.enabled, true);
    assert.strictEqual(s.sandbox.allowUnsandboxedCommands, false);
    assert.deepStrictEqual(s.sandbox.filesystem.allowWrite, ['/']);
    assert.deepStrictEqual(s.sandbox.network, { allowUnixSockets: [path.join(fs.realpathSync(path.join(root, 'run', 'seat-b')), 'intent.sock')] });
    const denyRead = s.sandbox.filesystem.denyRead;
    for (const p of [...t0, path.join(HOME, '.clodex', 'cli', 'contexts.json'), '~/.aws']) {
      assert.ok(denyRead.includes(p), `denyRead lists ${p}`);
    }
    const denyWrite = s.sandbox.filesystem.denyWrite;
    for (const p of ['~/.aws', '~/.claude', '~/.claude.json', '~/.ssh', '~/.zshrc', '~/.gitconfig', '~/.config/git', '~/Library/LaunchAgents', '/Applications/Clodex.app',
      path.join(root, 'teams'), path.join(root, 'cli'), path.join(root, 'boxes'), path.join(root, 'sessions'), path.join(root, 'setup.json')]) {
      assert.ok(denyWrite.includes(p), `denyWrite lists ${p}`);
    }
    assert.ok(!denyWrite.includes(path.join(root, 'projects')), 'the project artifact dir stays writable');
    assert.deepStrictEqual(s.sandbox.credentials.files, denyRead.map((p) => ({ path: p, mode: 'deny' })));
    assert.deepStrictEqual(s.sandbox.credentials.envVars, [
      { name: 'AWS_ACCESS_KEY_ID', mode: 'deny' },
      { name: 'AWS_SECRET_ACCESS_KEY', mode: 'deny' },
      { name: 'AWS_SESSION_TOKEN', mode: 'deny' },
    ]);
    const deny = s.permissions.deny;
    assert.strictEqual(deny[0], 'Bash(rm:*)', 'the existing deny rules come first, unchanged');
    for (const r of ['Read(~/.aws/**)', 'Edit(~/.aws/**)', `Read(/${t0[0]})`, `Edit(/${t0[0]})`,
      `Read(/${t0[1]})`, `Read(/${t0[2]}/**)`, 'Edit(~/.claude/**)', 'Edit(~/.ssh/**)', `Edit(/${path.join(root, 'teams')}/**)`,
      `Edit(/${path.join(root, 'setup.json')})`]) {
      assert.ok(deny.includes(r), `permissions.deny has ${r}`);
    }
    assert.ok(!deny.some((r) => r.startsWith('Write(')), 'Write path rules are never consulted by the CLI');
    assert.ok(!deny.some((r) => r.includes(path.join(root, 'projects'))));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s.permissions, 'ask'), false);
    assert.deepStrictEqual(buildCredentialSandbox({ registryDir: root, list: ['~/.aws'], home: HOME }).ask, []);
  });
});

test('protectCredentials []: the T0 paths alone, no env scrub', () => {
  withBoxEnv(undefined, () => {
    const root = seededRoot();
    const s = settingsFor(root, 'seat-c', []);
    assert.ok(s.sandbox.enabled);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s.permissions, 'ask'), false);
    assert.deepStrictEqual(buildCredentialSandbox({ registryDir: root, list: [], home: HOME }).ask, []);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s.sandbox.credentials, 'envVars'), false);
  });
});

test('protectCredentials ~/.config/gh scrubs the GitHub token names', () => {
  const g = buildCredentialSandbox({ registryDir: seededRoot(), list: ['~/.config/gh/'], home: '/h' });
  assert.deepStrictEqual(g.sandbox.credentials.envVars, [
    { name: 'GITHUB_TOKEN', mode: 'deny' },
    { name: 'GH_TOKEN', mode: 'deny' },
  ]);
  assert.ok(g.sandbox.filesystem.denyRead.includes('~/.config/gh'));
});

test('protectCredentials inside a sandbox box: no sandbox block, file-tool denies stay', () => {
  withBoxEnv('1', () => {
    const s = settingsFor(seededRoot(), 'seat-d', ['~/.aws']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s, 'sandbox'), false);
    assert.ok(s.permissions.deny.includes('Read(~/.aws/**)'));
    assert.ok(s.permissions.deny.includes('Edit(~/.claude/**)'));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s.permissions, 'ask'), false);
    assert.deepStrictEqual(buildCredentialSandbox({ registryDir: seededRoot(), list: ['~/.aws'], home: HOME }).ask, []);
  });
});

test('protectCredentials drops entries that are neither absolute nor home-anchored', () => {
  const g = buildCredentialSandbox({ registryDir: seededRoot(), list: ['.env', '~', '~bob/x', 'rel/dir', '/abs/k', '~/.kube'], home: '/h' });
  const listed = g.sandbox.filesystem.denyRead.slice(-2);
  assert.deepStrictEqual(listed, ['/abs/k', '~/.kube']);
  assert.ok(!g.deny.some((r) => r.includes('.env') || r.includes('(/~') || r.includes('rel/dir')));
});

test('a symlinked data-dir child gets both the exact and the subtree Edit rule', () => {
  const root = seededRoot();
  fs.symlinkSync(path.join(root, 'teams'), path.join(root, 'linked'));
  const g = buildCredentialSandbox({ registryDir: root, list: [], home: '/h' });
  assert.ok(g.deny.includes(`Edit(/${path.join(root, 'linked')})`));
  assert.ok(g.deny.includes(`Edit(/${path.join(root, 'linked')}/**)`));
});
