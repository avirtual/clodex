const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'setup.sh');

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function stub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function fixture({ nodeVersion = 'v22.3.0', xcode = true, probe = true } = {}) {
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
  stub(path.join(root, 'node_modules', '.bin'), 'electron', probe ? 'exit 0' : 'echo "NODE_MODULE_VERSION mismatch" >&2; exit 1');
  stub(bin, 'uname', '[ "$1" = "-m" ] && echo arm64 || echo Darwin');
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

test('setup: Node 18 stops with the Node 20+ sentence', () => {
  const r = run(fixture({ nodeVersion: 'v18.19.0' }), ['--check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /Node v18\.19\.0 is too old — install Node 20\+ with `brew install node` or nvm/);
});

test('setup: --check with a failing probe names the node-pty fix', () => {
  const r = run(fixture({ probe: false }), ['--check']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.err.trim(),
    'setup: node-pty does not load under Electron — rerun `npm run setup --force`.');
  assert.doesNotMatch(r.err, /stub must not run/);
});

test('setup: --check --quiet prints nothing and exits 0 when everything is in place', () => {
  const r = run(fixture(), ['--check', '--quiet']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, '');
  assert.strictEqual(r.err, '');
});

test('setup: --check --quiet prints only the failing sentence', () => {
  const r = run(fixture({ probe: false }), ['--check', '--quiet']);
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
