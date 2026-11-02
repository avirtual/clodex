'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_GROUPS = [
  { dir: '~/.aws', names: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] },
  { dir: '~/.config/gh', names: ['GITHUB_TOKEN', 'GH_TOKEN'] },
];

const HOME_WRITE_DENY = [
  '~/.claude', '~/.claude.json',
  '~/.zshrc', '~/.zprofile', '~/.zshenv', '~/.bashrc', '~/.bash_profile',
  '~/.gitconfig', '~/.config/git',
  '~/Library/LaunchAgents',
  '~/.ssh',
];

const APP_BUNDLE = '/Applications/Clodex.app';
const DATA_WRITE_OPEN = new Set(['projects']);
const GLOB_RE = /[*?[]/;
const USER_DATA_READ_DENY = ['remote.env', 'ui-settings.json*', 'env-scopes.json*', 'sessions.json*', 'wire-hold-entries.json', 'env-override.env',
  '.ui-settings.json*', '.env-scopes.json*', '.sessions.json*', '.wire-hold-entries.json.tmp.*', 'remote.env.tmp'];
const GIT_DIR_WRITE_DENY = [['config', false], ['config.worktree', false], ['commondir', false], ['hooks', true], [path.join('info', 'attributes'), false]];

function normalizeList(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue;
    let p = raw.trim();
    while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    if (!p.startsWith('/') && !p.startsWith('~/')) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function expandHome(p, home) {
  if (p === '~') return home;
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function t0ReadPaths(registryDir, home) {
  const out = [
    path.join(registryDir, 'cli', 'contexts.json'),
    path.join(registryDir, 'teams', '*', 'sandbox.json'),
    path.join(registryDir, 'boxes'),
  ];
  const ctlContexts = path.join(home, '.clodex', 'cli', 'contexts.json');
  if (!out.includes(ctlContexts)) out.push(ctlContexts);
  out.push(path.join(registryDir, 'run', '*', 'mcp.json'));
  out.push(path.join(registryDir, 'sessions', '*', 'run', 'mcp.json'));
  return out;
}

function dataWriteDeny(registryDir, fsImpl) {
  let entries;
  try { entries = fsImpl.readdirSync(registryDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => !DATA_WRITE_OPEN.has(e.name))
    .map((e) => ({ p: path.join(registryDir, e.name), dir: e.isSymbolicLink() ? undefined : e.isDirectory() }))
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
}

function realSocketPath(p, fsImpl) {
  try { return path.join(fsImpl.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; }
}

function realPathOr(p, fsImpl) {
  try { return fsImpl.realpathSync(p); } catch { return p; }
}

function readGitPointer(file, fsImpl) {
  try { return String(fsImpl.readFileSync(file, 'utf8')).replace(/[\r\n]+$/, ''); } catch { return null; }
}

function lstatOr(p, fsImpl) {
  try { return fsImpl.lstatSync(p); } catch { return null; }
}

function findDotGit(realCwd, fsImpl) {
  for (let dir = realCwd; ; dir = path.dirname(dir)) {
    const p = path.join(dir, '.git');
    const lst = lstatOr(p, fsImpl);
    if (lst) return { dotGit: p, lst };
    if (path.dirname(dir) === dir) return { dotGit: path.join(realCwd, '.git'), lst: null };
  }
}

function repoGitDirs(realCwd, fsImpl) {
  const { dotGit, lst } = findDotGit(realCwd, fsImpl);
  let gitDir = realPathOr(dotGit, fsImpl);
  let st = null;
  try { st = fsImpl.statSync(dotGit); } catch {}
  if (st && st.isFile()) {
    const m = /^gitdir: (.+)$/.exec(readGitPointer(dotGit, fsImpl) || '');
    if (m) gitDir = realPathOr(path.resolve(path.dirname(dotGit), m[1]), fsImpl);
  }
  const common = readGitPointer(path.join(gitDir, 'commondir'), fsImpl);
  const commonDir = common ? realPathOr(path.resolve(gitDir, common), fsImpl) : gitDir;
  const pointer = lst && lst.isDirectory() ? [] : [{ p: dotGit, dir: false }];
  return [...pointer, ...[...new Set([gitDir, commonDir])]
    .flatMap((dir) => GIT_DIR_WRITE_DENY.map(([rel, isDir]) => ({ p: path.join(dir, rel), dir: isDir })))];
}

function ruleAnchor(p) {
  return p.startsWith('~/') ? p : `/${p}`;
}

function rulesFor(tool, p, dir) {
  const anchor = ruleAnchor(p);
  if (GLOB_RE.test(p) || dir === false) return [`${tool}(${anchor})`];
  if (dir === true) return [`${tool}(${anchor}/**)`];
  return [`${tool}(${anchor})`, `${tool}(${anchor}/**)`];
}

function buildCredentialSandbox({ registryDir, list, seatSocket = null, home = os.homedir(), inBox = false, fsImpl = fs, mcpSecretNames = [], userDataPath = null, cwd = null }) {
  const listed = normalizeList(list);
  const t0 = t0ReadPaths(registryDir, home);
  const userDataFiles = userDataPath ? [...USER_DATA_READ_DENY, path.join('sandbox*', 'auth.env')].map((f) => path.join(userDataPath, f)) : [];
  const userDataWrite = userDataPath && registryDir !== userDataPath && !registryDir.startsWith(userDataPath + path.sep) ? [userDataPath] : [];
  const denyRead = [...new Set([...t0, ...listed.filter((p) => !t0.includes(p)), ...userDataFiles])];
  const dataEntries = dataWriteDeny(registryDir, fsImpl);
  const realCwd = typeof cwd === 'string' && path.isAbsolute(cwd) ? realPathOr(cwd, fsImpl) : null;
  const repoGit = realCwd ? repoGitDirs(realCwd, fsImpl) : [];
  const denyWrite = [...new Set([...HOME_WRITE_DENY, ...listed, ...dataEntries.map((e) => e.p), APP_BUNDLE, ...userDataWrite, ...repoGit.map((e) => e.p)])];

  const kindOf = new Map(dataEntries.map((e) => [e.p, e.dir]));
  kindOf.set(t0[0], false);
  kindOf.set(t0[2], true);
  kindOf.set(path.join(home, '.clodex', 'cli', 'contexts.json'), false);
  kindOf.set(APP_BUNDLE, true);
  for (const p of userDataFiles) kindOf.set(p, false);
  for (const p of userDataWrite) kindOf.set(p, true);
  for (const e of repoGit) kindOf.set(e.p, e.dir);

  const deny = [];
  for (const p of denyRead) {
    for (const tool of ['Read', 'Edit']) deny.push(...rulesFor(tool, p, kindOf.get(p)));
  }
  for (const p of denyWrite) deny.push(...rulesFor('Edit', p, kindOf.get(p)));

  const listedHome = new Set(listed.map((p) => expandHome(p, home)));
  const envNames = ENV_GROUPS
    .filter((g) => listedHome.has(expandHome(g.dir, home)))
    .flatMap((g) => g.names)
    .concat((Array.isArray(mcpSecretNames) ? mcpSecretNames : []).filter((n) => typeof n === 'string' && n))
    .filter((n, i, all) => all.indexOf(n) === i);

  const out = { deny: [...new Set(deny)], ask: [], sandbox: null };
  if (inBox) return out;
  const credentials = { files: denyRead.map((p) => ({ path: p, mode: 'deny' })) };
  if (envNames.length) credentials.envVars = envNames.map((name) => ({ name, mode: 'deny' }));
  out.sandbox = {
    enabled: true,
    allowUnsandboxedCommands: false,
    filesystem: { allowWrite: ['/'], denyRead, denyWrite },
    credentials,
  };
  if (seatSocket) out.sandbox.network = { allowUnixSockets: [realSocketPath(seatSocket, fsImpl)] };
  return out;
}

module.exports = { buildCredentialSandbox, HOME_WRITE_DENY, APP_BUNDLE };
