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

function expectedFilesystem(R, ud) {
  const denyRead = [
    `${R}/cli/contexts.json`, `${R}/teams/*/sandbox.json`, `${R}/boxes`, '/h/.clodex/cli/contexts.json',
    `${R}/run/*/mcp.json`, `${R}/sessions/*/run/mcp.json`, `${R}/peer-outbox/outbox-key`,
    `${R}/sessions/*/seat.json`, `${R}/sessions/*/.seat.json.tmp.*`, `${R}/sessions/*/client-token`, `${R}/accounts/*/.credentials.json`,
    '/h/.claude/.credentials.json', '/h/.claude.json',
    ...(ud ? ['/ud/remote.env', '/ud/ui-settings.json*', '/ud/env-scopes.json*', '/ud/sessions.json*', '/ud/wire-hold-entries.json', '/ud/env-override.env',
      '/ud/.ui-settings.json*', '/ud/.env-scopes.json*', '/ud/.sessions.json*', '/ud/.wire-hold-entries.json.tmp.*', '/ud/remote.env.tmp', '/ud/sandbox*/auth.env'] : []),
  ];
  const denyWrite = [
    '~/.claude', '~/.claude.json', '~/.zshrc', '~/.zprofile', '~/.zshenv', '~/.zlogin', '~/.zlogout', '~/.bashrc', '~/.bash_profile', '~/.bash_login', '~/.profile',
    '~/.gitconfig', '~/.config/git', '~/.config/fish', '~/.codex', '~/Library/LaunchAgents', '~/.ssh',
    `${R}/boxes`, `${R}/cli`, `${R}/run`, `${R}/sessions`, `${R}/teams`, '/Applications/Clodex.app',
    ...(ud ? ['/ud'] : []),
  ];
  return { filesystem: { allowWrite: ['/'], denyRead, denyWrite }, files: denyRead.map((p) => ({ path: p, mode: 'deny' })) };
}

test('buildCredentialSandbox: a userDataPath read-denies its token and secret stores and write-denies the whole dir', () => {
  const R = seededRoot();
  const g = buildCredentialSandbox({ registryDir: R, list: [], home: '/h', userDataPath: '/ud' });
  const want = expectedFilesystem(R, true);
  assert.deepStrictEqual(g.sandbox.filesystem, want.filesystem);
  assert.deepStrictEqual(g.sandbox.credentials, { files: want.files });
  const udRules = g.deny.filter((r) => r.includes('//ud'));
  assert.deepStrictEqual(udRules, [
    'Read(//ud/remote.env)', 'Edit(//ud/remote.env)',
    'Read(//ud/ui-settings.json*)', 'Edit(//ud/ui-settings.json*)',
    'Read(//ud/env-scopes.json*)', 'Edit(//ud/env-scopes.json*)',
    'Read(//ud/sessions.json*)', 'Edit(//ud/sessions.json*)',
    'Read(//ud/wire-hold-entries.json)', 'Edit(//ud/wire-hold-entries.json)',
    'Read(//ud/env-override.env)', 'Edit(//ud/env-override.env)',
    'Read(//ud/.ui-settings.json*)', 'Edit(//ud/.ui-settings.json*)',
    'Read(//ud/.env-scopes.json*)', 'Edit(//ud/.env-scopes.json*)',
    'Read(//ud/.sessions.json*)', 'Edit(//ud/.sessions.json*)',
    'Read(//ud/.wire-hold-entries.json.tmp.*)', 'Edit(//ud/.wire-hold-entries.json.tmp.*)',
    'Read(//ud/remote.env.tmp)', 'Edit(//ud/remote.env.tmp)',
    'Read(//ud/sandbox*/auth.env)', 'Edit(//ud/sandbox*/auth.env)',
    'Edit(//ud/**)',
  ]);
});

test('buildCredentialSandbox: without a userDataPath the output is unchanged', () => {
  const R = seededRoot();
  const g = buildCredentialSandbox({ registryDir: R, list: [], home: '/h' });
  const want = expectedFilesystem(R, false);
  assert.deepStrictEqual(g.sandbox.filesystem, want.filesystem);
  assert.deepStrictEqual(g.sandbox.credentials, { files: want.files });
  assert.strictEqual(g.deny.length, 65);
});

test('buildCredentialSandbox: a userData dir holding the registry keeps its file denies but drops the whole-dir write deny', () => {
  const R = seededRoot();
  const ud = path.dirname(R);
  const g = buildCredentialSandbox({ registryDir: R, list: [], home: '/h', userDataPath: ud });
  assert.strictEqual(g.sandbox.filesystem.denyWrite.includes(ud), false);
  assert.strictEqual(g.deny.includes(`Edit(/${ud}/**)`), false);
  assert.ok(g.sandbox.filesystem.denyRead.includes(path.join(ud, 'remote.env')));
  assert.ok(g.sandbox.filesystem.denyWrite.includes(path.join(ud, 'env-override.env')));
  assert.ok(g.sandbox.filesystem.denyWrite.includes(path.join(ud, 'remote.env')));
  for (const f of ['env-scopes.json*', '.env-scopes.json*', 'sessions.json*', '.sessions.json*', 'ui-settings.json*', '.ui-settings.json*']) {
    assert.ok(g.sandbox.filesystem.denyWrite.includes(path.join(ud, f)), f);
  }
  const same = buildCredentialSandbox({ registryDir: R, list: [], home: '/h', userDataPath: R });
  assert.strictEqual(same.sandbox.filesystem.denyWrite.includes(R), false);
});

test('setupClaudeHook hands the userData dir to the sandbox', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cli-hooks.js'), 'utf8');
  assert.ok(/buildCredentialSandbox\(\{[^}]*userDataPath: getUserDataPath \? getUserDataPath\(\) : null,/.test(src));
  const engine = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  const call = engine.slice(engine.indexOf('createCliHooks({'), engine.indexOf('\n});', engine.indexOf('createCliHooks({')));
  assert.ok(call.includes('getUserDataPath: () => userDataPath,'));
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
  assert.ok(/setupClaudeHook\([^;]*Array\.isArray\(protectCredentials\) \? protectCredentials : null, mcpSecretNames, mcpSel \? mcpSel\.applied\.denyRules : \[\], cwd \|\| null\);/.test(src));
  assert.ok(src.indexOf('const mcpSecretNames') < src.indexOf('setupClaudeHook(name,'));
});

test('buildCredentialSandbox: a cwd without a .git adds exactly the .git pointer and its config, config.worktree, commondir, hooks and info/attributes, plus the cwd\'s .codex and .claude, to the write deny', () => {
  const root = seededRoot();
  const without = buildCredentialSandbox({ registryDir: root, list: [], home: '/h' });
  const withCwd = buildCredentialSandbox({ registryDir: root, list: [], home: '/h', cwd: '/w' });
  assert.deepStrictEqual(
    withCwd.sandbox.filesystem.denyWrite.filter((p) => !without.sandbox.filesystem.denyWrite.includes(p)),
    ['/w/.git', '/w/.git/config', '/w/.git/config.worktree', '/w/.git/commondir', '/w/.git/hooks', '/w/.git/info/attributes', '/w/.codex', '/w/.claude']);
  assert.deepStrictEqual(withCwd.deny.filter((r) => !without.deny.includes(r)),
    ['Edit(//w/.git)', 'Edit(//w/.git/config)', 'Edit(//w/.git/config.worktree)', 'Edit(//w/.git/commondir)', 'Edit(//w/.git/hooks/**)', 'Edit(//w/.git/info/attributes)',
      'Edit(//w/.codex)', 'Edit(//w/.codex/**)', 'Edit(//w/.claude)', 'Edit(//w/.claude/**)']);
  assert.deepStrictEqual(without.sandbox.filesystem.denyWrite.filter((p) => p.includes('.git/')), []);
  assert.ok(without.sandbox.filesystem.denyWrite.length > 0, 'ENTER: the base denyWrite is populated');
  assert.deepStrictEqual(buildCredentialSandbox({ registryDir: root, list: [], home: '/h', cwd: 'rel' }).sandbox.filesystem.denyWrite,
    without.sandbox.filesystem.denyWrite);
});

test('setupClaudeHook hands the session cwd to the sandbox', () => {
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
    const s = JSON.parse(fs.readFileSync(
      h.setupClaudeHook('c1', null, null, [], [], [], null, null, [], false, null, [], [], [], '/w'), 'utf-8'));
    assert.ok(s.sandbox.filesystem.denyWrite.includes('/w/.git/config'));
    assert.ok(s.sandbox.filesystem.denyWrite.includes('/w/.git/hooks'));
    assert.ok(s.permissions.deny.includes('Edit(//w/.git/hooks/**)'));
  } finally {
    if (prior !== undefined) process.env.CLODEX_IN_SANDBOX = prior;
  }
});

test('buildCredentialSandbox: a cwd under a symlink denies the real .git paths', () => {
  const root = seededRoot();
  const real = path.join(root, 'projects', 'real');
  fs.mkdirSync(real);
  const link = path.join(root, 'projects', 'link');
  fs.symlinkSync(real, link);
  const realResolved = fs.realpathSync(real);
  const g = buildCredentialSandbox({ registryDir: root, list: [], home: '/h', cwd: link });
  assert.ok(g.sandbox.filesystem.denyWrite.includes(path.join(realResolved, '.git', 'config')));
  assert.ok(g.sandbox.filesystem.denyWrite.includes(path.join(realResolved, '.git', 'hooks')));
  assert.ok(!g.sandbox.filesystem.denyWrite.includes(path.join(link, '.git', 'config')));
});

function addedRepoDenies(root, cwd) {
  const without = buildCredentialSandbox({ registryDir: root, list: [], home: '/h' });
  const g = buildCredentialSandbox({ registryDir: root, list: [], home: '/h', cwd });
  const agentDirs = ['.codex', '.claude'].map((d) => path.join(fs.realpathSync(cwd), d));
  const isAgentDir = (s) => agentDirs.some((d) => s === d || s === `Edit(/${d})` || s === `Edit(/${d}/**)`);
  return {
    denyWrite: g.sandbox.filesystem.denyWrite.filter((p) => !without.sandbox.filesystem.denyWrite.includes(p) && !isAgentDir(p)),
    deny: g.deny.filter((r) => !without.deny.includes(r) && !isAgentDir(r)),
  };
}

test('buildCredentialSandbox: a linked-worktree cwd denies its own git dir and the main repository\'s', () => {
  const root = seededRoot();
  const repo = path.join(root, 'projects', 'main');
  const wt = path.join(root, 'projects', 'wt');
  const own = path.join(repo, '.git', 'worktrees', 'wt');
  fs.mkdirSync(path.join(own), { recursive: true });
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${own}\n\n`);
  fs.writeFileSync(path.join(own, 'commondir'), '../..\n');
  const R = fs.realpathSync(repo);
  const W = fs.realpathSync(wt);
  assert.deepStrictEqual(addedRepoDenies(root, wt), {
    denyWrite: [
      `${W}/.git`,
      `${R}/.git/worktrees/wt/config`, `${R}/.git/worktrees/wt/config.worktree`, `${R}/.git/worktrees/wt/commondir`,
      `${R}/.git/worktrees/wt/hooks`, `${R}/.git/worktrees/wt/info/attributes`,
      `${R}/.git/config`, `${R}/.git/config.worktree`, `${R}/.git/commondir`, `${R}/.git/hooks`, `${R}/.git/info/attributes`,
    ],
    deny: [
      `Edit(/${W}/.git)`,
      `Edit(/${R}/.git/worktrees/wt/config)`, `Edit(/${R}/.git/worktrees/wt/config.worktree)`, `Edit(/${R}/.git/worktrees/wt/commondir)`,
      `Edit(/${R}/.git/worktrees/wt/hooks/**)`, `Edit(/${R}/.git/worktrees/wt/info/attributes)`,
      `Edit(/${R}/.git/config)`, `Edit(/${R}/.git/config.worktree)`, `Edit(/${R}/.git/commondir)`, `Edit(/${R}/.git/hooks/**)`, `Edit(/${R}/.git/info/attributes)`,
    ],
  });
});

test('buildCredentialSandbox: a .git dir whose commondir points elsewhere denies both dirs, the relative gitdir resolved from the cwd', () => {
  const root = seededRoot();
  const cwd = path.join(root, 'projects', 'seat');
  const other = path.join(root, 'projects', 'elsewhere');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(cwd, '.git', 'commondir'), '../../elsewhere');
  const C = fs.realpathSync(cwd);
  const O = fs.realpathSync(other);
  assert.deepStrictEqual(addedRepoDenies(root, cwd).denyWrite, [
    `${C}/.git/config`, `${C}/.git/config.worktree`, `${C}/.git/commondir`, `${C}/.git/hooks`, `${C}/.git/info/attributes`,
    `${O}/config`, `${O}/config.worktree`, `${O}/commondir`, `${O}/hooks`, `${O}/info/attributes`,
  ]);
  const rel = path.join(root, 'projects', 'relwt');
  fs.mkdirSync(rel);
  fs.writeFileSync(path.join(rel, '.git'), 'gitdir: ../elsewhere\n');
  assert.deepStrictEqual(addedRepoDenies(root, rel).denyWrite, [
    `${fs.realpathSync(rel)}/.git`,
    `${O}/config`, `${O}/config.worktree`, `${O}/commondir`, `${O}/hooks`, `${O}/info/attributes`,
  ]);
});

const GIT_DENY_RELS = ['config', 'config.worktree', 'commondir', 'hooks', 'info/attributes'];

test('buildCredentialSandbox: a cwd below the repo top denies the repo\'s .git and nothing under the cwd', () => {
  const root = seededRoot();
  const repo = path.join(root, 'projects', 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'sub', 'deeper'), { recursive: true });
  const R = fs.realpathSync(repo);
  const got = addedRepoDenies(root, path.join(repo, 'sub', 'deeper'));
  assert.deepStrictEqual(got.denyWrite, GIT_DENY_RELS.map((r) => `${R}/.git/${r}`));
  assert.deepStrictEqual(got.denyWrite.filter((p) => p.startsWith(`${R}/sub`)), []);
});

test('buildCredentialSandbox: a cwd below a linked worktree denies the pointer, its git dir and the common dir', () => {
  const root = seededRoot();
  const repo = path.join(root, 'projects', 'main');
  const wt = path.join(root, 'projects', 'wt');
  const own = path.join(repo, '.git', 'worktrees', 'wt');
  fs.mkdirSync(own, { recursive: true });
  fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../main/.git/worktrees/wt\n');
  fs.writeFileSync(path.join(own, 'commondir'), '../..\n');
  const R = fs.realpathSync(repo);
  const W = fs.realpathSync(wt);
  assert.deepStrictEqual(addedRepoDenies(root, path.join(wt, 'sub')).denyWrite, [
    `${W}/.git`,
    ...GIT_DENY_RELS.map((r) => `${R}/.git/worktrees/wt/${r}`),
    ...GIT_DENY_RELS.map((r) => `${R}/.git/${r}`),
  ]);
});

test('buildCredentialSandbox: a .git symlink to a directory keeps its pointer deny and denies under the target', () => {
  const root = seededRoot();
  const cwd = path.join(root, 'projects', 'seat');
  const target = path.join(root, 'projects', 'gitstore');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, path.join(cwd, '.git'));
  const C = fs.realpathSync(cwd);
  const T = fs.realpathSync(target);
  const got = addedRepoDenies(root, cwd);
  assert.deepStrictEqual(got.denyWrite, [`${C}/.git`, ...GIT_DENY_RELS.map((r) => `${T}/${r}`)]);
  assert.ok(got.deny.includes(`Edit(/${C}/.git)`));
});

test('buildCredentialSandbox: the seat mirror, temp copy, client token and account dirs are read-denied in both layers', () => {
  const R = seededRoot();
  const g = buildCredentialSandbox({ registryDir: R, list: [], home: '/h' });
  const rows = [
    [`${R}/sessions/*/seat.json`, [`Read(/${R}/sessions/*/seat.json)`, `Edit(/${R}/sessions/*/seat.json)`]],
    [`${R}/sessions/*/.seat.json.tmp.*`, [`Read(/${R}/sessions/*/.seat.json.tmp.*)`, `Edit(/${R}/sessions/*/.seat.json.tmp.*)`]],
    [`${R}/sessions/*/client-token`, [`Read(/${R}/sessions/*/client-token)`, `Edit(/${R}/sessions/*/client-token)`]],
    [`${R}/accounts/*/.credentials.json`, [`Read(/${R}/accounts/*/.credentials.json)`, `Edit(/${R}/accounts/*/.credentials.json)`]],
    ['/h/.claude/.credentials.json', ['Read(//h/.claude/.credentials.json)', 'Edit(//h/.claude/.credentials.json)']],
    ['/h/.claude.json', ['Read(//h/.claude.json)', 'Edit(//h/.claude.json)']],
  ];
  for (const [p, rules] of rows) {
    assert.ok(g.sandbox.filesystem.denyRead.includes(p), `denyRead lists ${p}`);
    assert.ok(g.sandbox.credentials.files.some((f) => f.path === p && f.mode === 'deny'), `credentials.files lists ${p}`);
    for (const r of rules) assert.ok(g.deny.includes(r), `permissions deny ${r}`);
  }
});

test('buildCredentialSandbox: autorun files a later unsandboxed process runs are write-denied in both layers', () => {
  const R = seededRoot();
  const g = buildCredentialSandbox({ registryDir: R, list: [], home: '/h', cwd: '/w', codexHome: '/opt/codex-home/' });
  const rows = [
    ['~/.zlogin', ['Edit(~/.zlogin)', 'Edit(~/.zlogin/**)']],
    ['~/.zlogout', ['Edit(~/.zlogout)', 'Edit(~/.zlogout/**)']],
    ['~/.profile', ['Edit(~/.profile)', 'Edit(~/.profile/**)']],
    ['~/.bash_login', ['Edit(~/.bash_login)', 'Edit(~/.bash_login/**)']],
    ['~/.config/fish', ['Edit(~/.config/fish)', 'Edit(~/.config/fish/**)']],
    ['~/.codex', ['Edit(~/.codex)', 'Edit(~/.codex/**)']],
    ['/opt/codex-home', ['Edit(//opt/codex-home)', 'Edit(//opt/codex-home/**)']],
    ['/w/.codex', ['Edit(//w/.codex)', 'Edit(//w/.codex/**)']],
    ['/w/.claude', ['Edit(//w/.claude)', 'Edit(//w/.claude/**)']],
  ];
  for (const [p, rules] of rows) {
    assert.ok(g.sandbox.filesystem.denyWrite.includes(p), `denyWrite lists ${p}`);
    for (const r of rules) assert.ok(g.deny.includes(r), `permissions deny ${r}`);
  }
  const unset = buildCredentialSandbox({ registryDir: R, list: [], home: '/h' });
  assert.strictEqual(unset.sandbox.filesystem.denyWrite.includes('/opt/codex-home'), false);
});

test('setupClaudeHook hands CODEX_HOME to the sandbox', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cli-hooks.js'), 'utf8');
  assert.ok(/buildCredentialSandbox\(\{[^}]*codexHome: process\.env\.CODEX_HOME/.test(src));
});
