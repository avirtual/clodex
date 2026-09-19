'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkTmpRoot, mkTmpDirIn } = require('./lib/tmp-roots');

const SCRIPT = path.join(__dirname, '..', 'peering', 'clodex-deploy.sh');
const VER = 'v22.9.9';
const BASH = '/bin/bash';

function linkReal(bin, tools) {
  for (const tool of tools) {
    const dest = path.join(bin, tool);
    if (fs.existsSync(dest)) continue;
    const real = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (real) fs.symlinkSync(real, dest);
  }
}

function extractFn(name) {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const m = src.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(m, `ENTER: ${name}() was found in peering/clodex-deploy.sh`);
  return m[0];
}

function mkMirror(root, { corruptSum = false } = {}) {
  const mirror = mkTmpDirIn(root, 'mirror-');
  const stage = mkTmpDirIn(root, 'stage-');
  const pkg = path.join(stage, `node-${VER}-linux-x64`);
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'bin', 'node'),
    `#!/bin/sh\nif [ "$1" = "-p" ]; then echo ${VER.slice(1).split('.')[0]}; else echo ${VER}; fi\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(pkg, 'bin', 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(pkg, 'bin', 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const verDir = path.join(mirror, VER);
  fs.mkdirSync(verDir, { recursive: true });
  const tb = `node-${VER}-linux-x64.tar.xz`;
  execFileSync('tar', ['-cJf', path.join(verDir, tb), '-C', stage, `node-${VER}-linux-x64`]);

  const digest = corruptSum
    ? '0'.repeat(64)
    : execFileSync('shasum', ['-a', '256', tb], { cwd: verDir, encoding: 'utf8' }).split(/\s+/)[0];
  fs.writeFileSync(path.join(verDir, 'SHASUMS256.txt'), `${digest}  ${tb}\n`);
  fs.writeFileSync(path.join(mirror, 'index.json'),
    JSON.stringify([{ version: VER, lts: 'Jod' }, { version: 'v20.1.0', lts: false }]));
  return mirror;
}

function runEnsureNode(root, { mirror, nodeOnPath = null, version = VER, home = null } = {}) {
  if (!home) home = mkTmpDirIn(root, 'home-');
  const bin = mkTmpDirIn(root, 'pathbin-');
  linkReal(bin, ['curl', 'grep', 'cut', 'head', 'mktemp', 'rm', 'mkdir', 'tar', 'mv', 'ln', 'sha256sum', 'sed', 'cat']);
  if (!fs.existsSync(path.join(bin, 'sha256sum'))) {
    fs.writeFileSync(path.join(bin, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\n[ "$1" = "-m" ] && echo x86_64 || echo Linux\n', { mode: 0o755 });
  if (nodeOnPath) {
    fs.writeFileSync(path.join(bin, 'node'),
      `#!/bin/sh\nif [ "$1" = "-p" ]; then echo ${nodeOnPath}; else echo v${nodeOnPath}.0.0; fi\n`, { mode: 0o755 });
    fs.chmodSync(path.join(bin, 'node'), 0o755);
  }

  const program = [
    'set -uo pipefail',
    'IS_MAC=0',
    'fail() { echo "::fail $1 ${2:-}"; exit 1; }',
    extractFn('ensure_node'),
    'ensure_node',
    'echo "::after-ensure-node"',
  ].join('\n');

  const r = spawnSync(BASH, ['-c', program], {
    encoding: 'utf8',
    env: {
      HOME: home,
      PATH: bin,
      CLODEX_NODE_DIST_URL: `file://${mirror}`,
      ...(version === false ? {} : { CLODEX_NODE_VERSION: version }),
    },
  });
  return { ...r, home };
}

test('ensure_node: no node on PATH → installs from the mirror, symlinks, ::log line', () => {
  const root = mkTmpRoot('ensure-node-fresh-');
  const mirror = mkMirror(root);
  const r = runEnsureNode(root, { mirror });

  assert.strictEqual(r.status, 0, `ensure_node exited ${r.status}: ${r.stderr}`);
  assert.ok(r.stdout.includes('::after-ensure-node'), 'ENTER: ensure_node returned instead of failing');
  assert.ok(r.stdout.includes(`::log node ${VER} installed to ~/.local/node`),
    `the install marker is emitted verbatim; got: ${JSON.stringify(r.stdout)}`);
  for (const b of ['node', 'npm', 'npx']) {
    const link = path.join(r.home, '.local', 'bin', b);
    assert.strictEqual(fs.realpathSync(link), fs.realpathSync(path.join(r.home, '.local', 'node', 'bin', b)),
      `${b} is symlinked into ~/.local/bin`);
  }
  assert.strictEqual(
    execFileSync(path.join(r.home, '.local', 'bin', 'node'), { encoding: 'utf8' }).trim(), VER,
    'the installed node is the one the mirror served');
});

test('ensure_node: node >= 20 already on PATH → returns without downloading anything', () => {
  const root = mkTmpRoot('ensure-node-present-');
  const mirror = mkMirror(root);
  const r = runEnsureNode(root, { mirror, nodeOnPath: '22' });

  assert.strictEqual(r.status, 0, `ensure_node exited ${r.status}: ${r.stderr}`);
  assert.ok(r.stdout.includes('::after-ensure-node'), 'ENTER: ensure_node returned instead of failing');
  assert.strictEqual(r.stdout.trim(), '::after-ensure-node',
    `a satisfied box emits no marker at all; got: ${JSON.stringify(r.stdout)}`);
  assert.strictEqual(fs.existsSync(path.join(r.home, '.local', 'node')), false,
    '~/.local/node is absent — nothing was downloaded or unpacked');
});

test('ensure_node: a re-run adopts the user-local node it installed and never touches the mirror', () => {
  const root = mkTmpRoot('ensure-node-rerun-');
  const mirror = mkMirror(root);
  const first = runEnsureNode(root, { mirror });
  assert.strictEqual(first.status, 0, `the first run exited ${first.status}: ${first.stderr}`);
  assert.ok(first.stdout.includes(`::log node ${VER} installed to ~/.local/node`),
    'ENTER: the first run really installed');

  const second = runEnsureNode(root, {
    mirror: path.join(root, 'no-such-mirror'), home: first.home,
  });
  assert.strictEqual(second.status, 0, `the re-run exited ${second.status}: ${second.stdout} ${second.stderr}`);
  assert.strictEqual(second.stdout.trim(), '::after-ensure-node',
    `a re-run emits no install marker at all; got: ${JSON.stringify(second.stdout)}`);
});

test('ensure_node: checksum mismatch → ::fail preflight node-checksum-mismatch, nothing linked', () => {
  const root = mkTmpRoot('ensure-node-badsum-');
  const mirror = mkMirror(root, { corruptSum: true });
  const r = runEnsureNode(root, { mirror });

  assert.strictEqual(r.status, 1, 'a bad checksum exits 1');
  assert.ok(r.stdout.includes('::fail preflight node-checksum-mismatch'),
    `the mismatch marker is emitted verbatim; got: ${JSON.stringify(r.stdout)}`);
  assert.ok(!r.stdout.includes('::after-ensure-node'), 'ENTER: the fail stopped the script');
  assert.strictEqual(fs.existsSync(path.join(r.home, '.local', 'bin', 'node')), false,
    'nothing was symlinked into ~/.local/bin');
  assert.strictEqual(fs.existsSync(path.join(r.home, '.local', 'node')), false, '~/.local/node was not created');
});

test('ensure_node: an unsupported arch fails by name rather than guessing a tarball', () => {
  const root = mkTmpRoot('ensure-node-arch-');
  const mirror = mkMirror(root);
  const bin = mkTmpDirIn(root, 'archbin-');
  linkReal(bin, ['curl', 'grep', 'cut', 'head', 'mktemp', 'rm', 'mkdir', 'tar', 'mv', 'ln']);
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\n[ "$1" = "-m" ] && echo ppc64le || echo Linux\n', { mode: 0o755 });
  const program = [
    'set -uo pipefail', 'IS_MAC=0',
    'fail() { echo "::fail $1 ${2:-}"; exit 1; }',
    extractFn('ensure_node'), 'ensure_node', 'echo "::after-ensure-node"',
  ].join('\n');
  const r = spawnSync(BASH, ['-c', program], {
    encoding: 'utf8',
    env: { HOME: mkTmpDirIn(root, 'home-'), PATH: bin, CLODEX_NODE_DIST_URL: `file://${mirror}` },
  });
  assert.strictEqual(r.status, 1, 'an unsupported arch exits 1');
  assert.ok(r.stdout.includes('::fail preflight node-unsupported-arch-ppc64le'),
    `the arch marker names the arch; got: ${JSON.stringify(r.stdout)}`);
});

test('ensure_node: with no CLODEX_NODE_VERSION it picks the first v22.x out of index.json', () => {
  const root = mkTmpRoot('ensure-node-pick-');
  const mirror = mkMirror(root);
  fs.writeFileSync(path.join(mirror, 'index.json'),
    JSON.stringify([{ version: 'v23.5.0' }, { version: VER }, { version: 'v22.1.0' }]));
  const r = runEnsureNode(root, { mirror, version: false });
  assert.strictEqual(r.status, 0, `ensure_node exited ${r.status}: ${r.stderr}`);
  assert.ok(r.stdout.includes(`::log node ${VER} installed to ~/.local/node`),
    `the first v22.x entry was chosen; got: ${JSON.stringify(r.stdout)}`);
});

test('ensure_node: a mac with no node keeps the hard fail (never downloads a Linux tarball)', () => {
  const root = mkTmpRoot('ensure-node-mac-');
  const mirror = mkMirror(root);
  const bin = mkTmpDirIn(root, 'macbin-');
  const program = [
    'set -uo pipefail', 'IS_MAC=1',
    'fail() { echo "::fail $1 ${2:-}"; exit 1; }',
    extractFn('ensure_node'), 'ensure_node', 'echo "::after-ensure-node"',
  ].join('\n');
  const r = spawnSync(BASH, ['-c', program], {
    encoding: 'utf8',
    env: { HOME: mkTmpDirIn(root, 'home-'), PATH: bin, CLODEX_NODE_DIST_URL: `file://${mirror}` },
  });
  assert.strictEqual(r.status, 1, 'a mac with no node still exits 1');
  assert.ok(r.stdout.includes('::fail preflight node-not-found-install-node-20+-e.g.-brew-install-node'),
    `the mac marker points at brew; got: ${JSON.stringify(r.stdout)}`);
});

function extractRange(startRe, endRe) {
  const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n');
  const a = lines.findIndex((l) => startRe.test(l));
  assert.ok(a >= 0, `ENTER: the block start ${startRe} was found`);
  const b = lines.findIndex((l, i) => i > a && endRe.test(l));
  assert.ok(b > a, `ENTER: the block end ${endRe} was found after it`);
  return lines.slice(a, b + 1).join('\n');
}

function extractLingerBlock() {
  const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n');
  const a = lines.findIndex((l) => /^# enable-linger so the --user service runs/.test(l));
  assert.ok(a >= 0, 'ENTER: the linger block start was found');
  const b = lines.findIndex((l, i) => i > a && /^systemctl --user daemon-reload/.test(l));
  assert.ok(b > a, 'ENTER: the daemon-reload after it was found');
  const block = lines.slice(a, b).join('\n');
  assert.match(block, /loginctl enable-linger 2>\/dev\/null/, 'ENTER: the self-linger attempt is inside the block');
  assert.match(block, /need_sudo /, 'ENTER: the sudo arm is inside the block');
  return block;
}

function shimDir(root, prefix, shims) {
  const bin = mkTmpDirIn(root, prefix);
  const log = path.join(bin, 'argv.log');
  for (const [name, body] of Object.entries(shims)) {
    fs.writeFileSync(path.join(bin, name),
      `#!/bin/sh\nprintf '%s %s\\n' ${name} "$*" >> ${JSON.stringify(log)}\n${body}\n`, { mode: 0o755 });
  }
  linkReal(bin, ['grep', 'rm', 'mktemp', 'cat', 'sed']);
  return { bin, log };
}

test('sys-deps apt: a functional python3 venv+pip means NO need-sudo, and dpkg is never asked about them', () => {
  const root = mkTmpRoot('sysdeps-apt-');
  const { bin, log } = shimDir(root, 'aptbin-', {
    'apt-get': 'exit 0',
    dpkg: 'exit 0',
    sudo: 'exit 1',
    python3: 'exit 0',
  });

  const block = extractRange(/^step sys-deps$/, /^fi$/);
  const program = [
    'set -uo pipefail',
    'IS_MAC=0', 'WIRESCOPE_OFF=0', 'SUDO=""',
    'step() { echo "::step $1"; }',
    'ok() { echo "::ok $1"; }',
    'log() { echo "$*" >&2; }',
    'fail() { echo "::fail $1 ${2:-}"; exit 1; }',
    'need_sudo() { echo "::need-sudo $1"; exit 42; }',
    'can_sudo() { return 1; }',
    extractFn('py_present'),
    block,
  ].join('\n');

  const r = spawnSync(BASH, ['-c', program], { encoding: 'utf8', env: { HOME: mkTmpDirIn(root, 'home-'), PATH: bin } });
  assert.strictEqual(r.status, 0, `sys-deps exited ${r.status}: ${r.stdout} ${r.stderr}`);
  assert.ok(r.stdout.includes('::step sys-deps'), 'ENTER: the sys-deps block ran');
  assert.ok(r.stdout.includes('::ok sys-deps'), `sys-deps is satisfied; got: ${JSON.stringify(r.stdout)}`);
  assert.ok(!r.stdout.includes('::need-sudo'), 'no sudo is asked for when every check passes');

  const argv = fs.readFileSync(log, 'utf8');
  assert.match(argv, /^python3 -m venv --without-pip /m, 'venv presence was probed by running the module');
  assert.match(argv, /^python3 -m pip --version$/m, 'pip presence was probed by running the module');
  assert.ok(!/^dpkg .*python3-venv/m.test(argv), 'dpkg was NOT consulted about python3-venv');
  assert.ok(!/^dpkg .*python3-pip/m.test(argv), 'dpkg was NOT consulted about python3-pip');
  assert.match(argv, /^dpkg -s build-essential$/m, 'build-essential still goes through dpkg -s');
});

test('sys-deps apt: a python3 that cannot make a venv still reaches the need-sudo arm for it', () => {
  const root = mkTmpRoot('sysdeps-apt-novenv-');
  const { bin } = shimDir(root, 'aptbin-', {
    'apt-get': 'exit 0',
    dpkg: 'exit 0',
    sudo: 'exit 1',
    python3: 'case "$2" in venv) exit 1;; *) exit 0;; esac',
  });
  const block = extractRange(/^step sys-deps$/, /^fi$/);
  const program = [
    'set -uo pipefail', 'IS_MAC=0', 'WIRESCOPE_OFF=0', 'SUDO=""',
    'step() { echo "::step $1"; }', 'ok() { echo "::ok $1"; }', 'log() { echo "$*" >&2; }',
    'fail() { echo "::fail $1 ${2:-}"; exit 1; }',
    'need_sudo() { echo "::need-sudo $1"; shift; for c in "$@"; do echo "::sudo-cmd $c"; done; exit 42; }',
    'can_sudo() { return 1; }',
    extractFn('py_present'), block,
  ].join('\n');
  const r = spawnSync(BASH, ['-c', program], { encoding: 'utf8', env: { HOME: mkTmpDirIn(root, 'home-'), PATH: bin } });
  assert.strictEqual(r.status, 42, 'a genuinely missing venv exits with the need-sudo code');
  assert.match(r.stdout, /::sudo-cmd sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv/,
    `only the venv package is asked for; got: ${JSON.stringify(r.stdout)}`);
});

test('sys-deps apt: a venv module without ensurepip (the Debian split) still asks for python3-venv', () => {
  const root = mkTmpRoot('sysdeps-apt-noensurepip-');
  const { bin, log } = shimDir(root, 'aptbin-', {
    'apt-get': 'exit 0',
    dpkg: 'exit 0',
    sudo: 'exit 1',
    python3: `case "$1 $2" in "-c import ensurepip") exit 1;; esac
case "$2" in venv) exit 0;; esac
exit 0`,
  });
  const block = extractRange(/^step sys-deps$/, /^fi$/);
  const program = [
    'set -uo pipefail', 'IS_MAC=0', 'WIRESCOPE_OFF=0', 'SUDO=""',
    'step() { echo "::step $1"; }', 'ok() { echo "::ok $1"; }', 'log() { echo "$*" >&2; }',
    'fail() { echo "::fail $1 ${2:-}"; exit 1; }',
    'need_sudo() { echo "::need-sudo $1"; shift; for c in "$@"; do echo "::sudo-cmd $c"; done; exit 42; }',
    'can_sudo() { return 1; }',
    extractFn('py_present'), block,
  ].join('\n');
  const r = spawnSync(BASH, ['-c', program], { encoding: 'utf8', env: { HOME: mkTmpDirIn(root, 'home-'), PATH: bin } });
  assert.strictEqual(r.status, 42, 'a venv that cannot bootstrap pip still exits with the need-sudo code');
  assert.match(r.stdout, /::sudo-cmd sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv/,
    `python3-venv is asked for; got: ${JSON.stringify(r.stdout)}`);
  assert.match(fs.readFileSync(log, 'utf8'), /^python3 -c import ensurepip$/m,
    'the probe asked the interpreter about ensurepip, not just about venv');
});

test('linger: an argument-less enable-linger that works means no sudo is asked for', () => {
  const root = mkTmpRoot('linger-self-');
  const state = path.join(root, 'linger-state');
  const { bin, log } = shimDir(root, 'lingerbin-', {
    loginctl: `case "$1" in
  show-user) [ -f ${JSON.stringify(state)} ] && echo Linger=yes || echo Linger=no; exit 0;;
  enable-linger) [ $# -eq 1 ] && { : > ${JSON.stringify(state)}; exit 0; }; exit 1;;
esac
exit 0`,
    sudo: 'exit 1',
  });

  const block = extractLingerBlock();
  const program = [
    'set -uo pipefail', 'USER="tester"', 'SUDO=""',
    'fail() { echo "::fail $1 ${2:-}"; exit 1; }',
    'need_sudo() { echo "::need-sudo $1"; exit 42; }',
    'can_sudo() { return 1; }',
    block,
    'echo "::after-linger"',
  ].join('\n');

  const r = spawnSync(BASH, ['-c', program], { encoding: 'utf8', env: { HOME: mkTmpDirIn(root, 'home-'), PATH: bin } });
  assert.strictEqual(r.status, 0, `the linger block exited ${r.status}: ${r.stdout} ${r.stderr}`);
  assert.ok(r.stdout.includes('::after-linger'), 'ENTER: the linger block ran through');
  assert.ok(!r.stdout.includes('::need-sudo'), 'the self-linger succeeded, so no sudo is asked for');
  const argv = fs.readFileSync(log, 'utf8');
  assert.match(argv, /^loginctl enable-linger$/m, 'enable-linger was tried with NO argument first');
  assert.ok(!/^loginctl enable-linger tester$/m.test(argv), 'the username form was never needed');
});

test('linger: when the argument-less form does not take, the sudo arm still fires', () => {
  const root = mkTmpRoot('linger-fallback-');
  const { bin } = shimDir(root, 'lingerbin-', {
    loginctl: `case "$1" in
  show-user) echo Linger=no; exit 0;;
  enable-linger) exit 1;;
esac
exit 0`,
    sudo: 'exit 1',
  });
  const block = extractLingerBlock();
  const program = [
    'set -uo pipefail', 'USER="tester"', 'SUDO=""',
    'fail() { echo "::fail $1 ${2:-}"; exit 1; }',
    'need_sudo() { echo "::need-sudo $1"; shift; for c in "$@"; do echo "::sudo-cmd $c"; done; exit 42; }',
    'can_sudo() { return 1; }',
    block, 'echo "::after-linger"',
  ].join('\n');
  const r = spawnSync(BASH, ['-c', program], { encoding: 'utf8', env: { HOME: mkTmpDirIn(root, 'home-'), PATH: bin } });
  assert.strictEqual(r.status, 42, 'a linger that will not set without root still exits 42');
  assert.match(r.stdout, /::sudo-cmd sudo loginctl enable-linger tester/,
    `the exact sudo command is still offered; got: ${JSON.stringify(r.stdout)}`);
});
