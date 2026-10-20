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

function ruleAnchor(p) {
  return p.startsWith('~/') ? p : `/${p}`;
}

function rulesFor(tool, p, dir) {
  const anchor = ruleAnchor(p);
  if (GLOB_RE.test(p) || dir === false) return [`${tool}(${anchor})`];
  if (dir === true) return [`${tool}(${anchor}/**)`];
  return [`${tool}(${anchor})`, `${tool}(${anchor}/**)`];
}

function buildCredentialSandbox({ registryDir, list, seatSocket = null, home = os.homedir(), inBox = false, fsImpl = fs }) {
  const listed = normalizeList(list);
  const t0 = t0ReadPaths(registryDir, home);
  const denyRead = [...t0, ...listed.filter((p) => !t0.includes(p))];
  const dataEntries = dataWriteDeny(registryDir, fsImpl);
  const denyWrite = [...new Set([...HOME_WRITE_DENY, ...listed, ...dataEntries.map((e) => e.p), APP_BUNDLE])];

  const kindOf = new Map(dataEntries.map((e) => [e.p, e.dir]));
  kindOf.set(t0[0], false);
  kindOf.set(t0[2], true);
  if (t0[3]) kindOf.set(t0[3], false);
  kindOf.set(APP_BUNDLE, true);

  const deny = [];
  for (const p of denyRead) {
    for (const tool of ['Read', 'Edit']) deny.push(...rulesFor(tool, p, kindOf.get(p)));
  }
  for (const p of denyWrite) deny.push(...rulesFor('Edit', p, kindOf.get(p)));

  const listedHome = new Set(listed.map((p) => expandHome(p, home)));
  const envNames = ENV_GROUPS
    .filter((g) => listedHome.has(expandHome(g.dir, home)))
    .flatMap((g) => g.names);

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
