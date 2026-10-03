const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'setup.sh');
const PROBE_SENTENCE = 'setup: node-pty cannot spawn a shell under Electron — run `npm run setup -- --force` '
  + '(reinstalls and re-marks spawn-helper executable); if it persists, `xattr -cr node_modules/node-pty`.';

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function stub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function fixture({ nodeVersion = 'v22.12.0', xcode = true, probeExit = 0, os = 'Darwin' } = {}) {
  const root = mkTmpRoot('clodex-setup-');
  roots.push(root);
  const bin = path.join(root, 'stubs');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'electron'), { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'setup.sh'));
  fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'package.json'),
    '{\n  "name": "electron",\n  "version": "43.0.0"\n}\n');
  stub(path.join(root, 'node_modules', '.bin'), 'electron', `echo "posix_spawnp failed." >&2; exit ${probeExit}`);
  stub(bin, 'uname', `[ "$1" = "-m" ] && echo arm64 || echo ${os}`);
  stub(bin, 'xcode-select', xcode ? 'echo /Library/Developer/CommandLineTools' : 'exit 2');
  stub(bin, 'node', `echo ${nodeVersion}`);
  stub(bin, 'npm', 'echo "npm stub must not run in --check" >&2; exit 99');
  stub(bin, 'npx', 'echo "npx stub must not run in --check" >&2; exit 99');
  stub(bin, 'claude', 'exit 0');
  stub(bin, 'codex', 'exit 0');
  return { root, bin };
}

function run(fx, args) {
  const r = spawnSync('bash', [path.join(fx.root, 'scripts', 'setup.sh'), ...args], {
    encoding: 'utf-8',
    env: { PATH: `${fx.bin}:/usr/bin:/bin`, HOME: fx.root },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('setup: Xcode Command Line Tools missing stops with the install sentence', () => {
  const r = run(fixture({ xcode: false }), ['--check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /Xcode Command Line Tools are missing — run `xcode-select --install`/);
});

test('setup: Node 18 stops with the Node 22.12+ sentence', () => {
  const r = run(fixture({ nodeVersion: 'v18.19.0' }), ['--check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /Node v18\.19\.0 is too old — install Node 22\.12\+ with `brew install node` or nvm/);
});

test('setup: Node 22.11 is below the Electron floor, 23.0 is above it', () => {
  const old = run(fixture({ nodeVersion: 'v22.11.0' }), ['--check']);
  assert.strictEqual(old.code, 1);
  assert.match(old.err, /Node v22\.11\.0 is too old/);
  const newer = run(fixture({ nodeVersion: 'v23.0.0' }), ['--check', '--quiet']);
  assert.strictEqual(newer.code, 0, newer.err);
});

test('setup: off macOS the prestart check passes silently so `npm start` still runs', () => {
  const r = run(fixture({ os: 'Linux', xcode: false }), ['--check', '--quiet']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out, '');
  assert.strictEqual(r.err, '');
});

test('setup: off macOS a full setup stops with the headless sentence', () => {
  const r = run(fixture({ os: 'Linux' }), []);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.err.trim(),
    'setup: the Clodex desktop app needs macOS; on Linux use the headless engine, see docs/how-to.md.');
});

test('setup: --check with a failing probe names the node-pty fix', () => {
  const r = run(fixture({ probeExit: 1 }), ['--check']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.err.trim(), PROBE_SENTENCE);
  assert.doesNotMatch(r.err, /stub must not run/);
});

test('setup: a probe that hits its spawn timeout gets the same sentence', () => {
  const r = run(fixture({ probeExit: 2 }), ['--check']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.err.trim(), PROBE_SENTENCE);
});

test('setup: a failing npm install ends in one setup sentence', () => {
  const r = run(fixture(), []);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /setup: npm install failed — fix the error above, then rerun `npm run setup -- --force`\.\n?$/);
});

test('setup: --check --quiet prints nothing and exits 0 when everything is in place', () => {
  const r = run(fixture(), ['--check', '--quiet']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, '');
  assert.strictEqual(r.err, '');
});

test('setup: --check --quiet prints only the failing sentence', () => {
  const r = run(fixture({ probeExit: 1 }), ['--check', '--quiet']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.out, '');
  assert.strictEqual(r.err.trim().split('\n').length, 1);
});

test('setup: package.json wires setup, prestart and predev', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  assert.strictEqual(scripts.setup, 'bash scripts/setup.sh');
  assert.strictEqual(scripts.prestart, 'bash scripts/setup.sh --check --quiet');
  assert.strictEqual(scripts.predev, 'bash scripts/setup.sh --check --quiet');
  assert.ok(!scripts['predist:mac'] && !scripts.predist && !scripts.prerelease,
    'the release path must not run the dev-clone check');
});
