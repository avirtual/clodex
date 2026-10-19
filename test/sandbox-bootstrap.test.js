'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { mkTmpRoot, mkTmpDirIn } = require('./lib/tmp-roots');
const { createSandbox, generateCompose, validateBootstrapForSave, DEFAULT_CONFIG, HEALTH_TIMEOUT_MS, SETUP_TIMEOUT_S } = require('../sandbox');

const TMP = mkTmpRoot('clx-sbboot-');
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const SECRET_MSG = (field, n) => `bootstrap.${field} line ${n} looks like a secret: put it in the box's env_file, not in a script`;

const VALIDATE_ROWS = [
  ['65 packages', { packages: Array.from({ length: 65 }, (_, i) => `pkg${i}`) }, 'bootstrap.packages lists 65 packages; the cap is 64'],
  ['Foo Bar', { packages: ['Foo Bar'] }, 'bootstrap.packages: "Foo Bar" is not a Debian package name'],
  ['libssl-dev', { packages: ['libssl-dev'] }, null],
  ['16385-byte setup', { setup: 'x'.repeat(16385) }, 'bootstrap.setup is 16385 bytes; the cap is 16384'],
  ['16384-byte start', { start: 'x'.repeat(16384) }, null],
  ['DB_PASSWORD=x', { setup: 'DB_PASSWORD=x\necho ok' }, SECRET_MSG('setup', 1)],
  ['export API_TOKEN', { start: 'echo hi\nexport API_TOKEN=abc123' }, SECRET_MSG('start', 2)],
  ['echo token', { setup: 'echo token' }, null],
  ['BEGIN RSA', { setup: 'cat <<EOF\n-----BEGIN RSA PRIVATE KEY-----\nEOF' }, SECRET_MSG('setup', 2)],
];

for (const [name, raw, error] of VALIDATE_ROWS) {
  test(`validateBootstrapForSave: ${name} → ${error ? 'refused' : 'accepted'}`, () => {
    const r = validateBootstrapForSave(raw, { writer: 'intent' });
    if (error) assert.deepStrictEqual(r, { error });
    else assert.strictEqual(r.error, undefined);
  });
}

function fakeChild(behavior = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (behavior.stdout) child.stdout.emit('data', behavior.stdout);
    child.emit('exit', behavior.code ?? 0);
  });
  return child;
}

function bootBox({ config = {}, spawnCalls = [], now } = {}) {
  const dir = mkTmpDirIn(TMP, 'box-');
  const written = [];
  let current = { ...config };
  const sb = createSandbox({
    registryDir: path.join(dir, 'reg'),
    getUserDataPath: () => path.join(dir, 'ud'),
    getUiSettings: () => ({ get: () => ({ peers: [] }), set: () => {} }),
    syncPeerManager: () => {},
    isPortInUse: () => Promise.resolve(false),
    isPackaged: () => false,
    repoRoot: '/repo',
    platform: 'darwin',
    detect: async () => ({ running: true, compose: true }),
    dockerIsLocal: async () => true,
    spawn: (_cmd, args) => { spawnCalls.push(args); return fakeChild(); },
    readBoxConfig: () => current,
    writeBoxConfig: (next) => { written.push(next); current = next; },
    log: { info() {}, warn() {}, error() {} },
    ...(now ? { now } : {}),
  });
  return { sb, written, dir };
}

const stripAt = (rows) => rows.map(({ at, ...rest }) => rest);

test('setConfig: an intent bootstrap save is written with a history row naming writer, seat, field and sha', () => {
  const { sb, written } = bootBox({ now: () => Date.UTC(2026, 9, 20, 1, 2, 3) });
  const r = sb.setConfig({ bootstrap: { packages: ['smbclient'], setup: '', start: '' } }, { writer: 'intent', seat: 'clodex' });
  assert.deepStrictEqual(r.bootstrap, { packages: ['smbclient'], setup: '', start: '' });
  assert.strictEqual(written.length, 1);
  assert.deepStrictEqual(written[0].bootstrapHistory,
    [{ at: '2026-10-20T01:02:03.000Z', writer: 'intent', seat: 'clodex', field: 'packages', sha: '5f7ca3fb23ef' }]);
});

test('setConfig: one row per changed field, an unchanged field gets none', () => {
  const { sb } = bootBox({ config: { bootstrap: { packages: ['smbclient'], setup: '', start: '' } } });
  const r = sb.setConfig({ bootstrap: { packages: ['smbclient'], setup: 'echo hi', start: '' } }, { writer: 'panel' });
  assert.deepStrictEqual(stripAt(r.bootstrapHistory), [{ writer: 'panel', seat: null, field: 'setup', sha: '56a79f3b1154' }]);
});

test('setConfig: 21 bootstrap writes keep the last 20 history rows', () => {
  const { sb, written } = bootBox();
  for (let i = 0; i < 21; i++) sb.setConfig({ bootstrap: { packages: [`pkg${i}`] } }, { writer: 'intent', seat: 'clodex' });
  const hist = written[written.length - 1].bootstrapHistory;
  assert.strictEqual(hist.length, 20);
  assert.strictEqual(hist[0].sha, crypto.createHash('sha256').update('pkg1').digest('hex').slice(0, 12));
  assert.strictEqual(hist[19].sha, crypto.createHash('sha256').update('pkg20').digest('hex').slice(0, 12));
});

test('setConfig: a refused bootstrap stores nothing; a caller cannot write bootstrapHistory directly', () => {
  const { sb, written } = bootBox({ config: { bootstrapHistory: [] } });
  assert.deepStrictEqual(sb.setConfig({ bootstrap: { setup: 'DB_PASSWORD=x' } }, { writer: 'panel' }),
    { ok: false, error: SECRET_MSG('setup', 1) });
  assert.deepStrictEqual(written, []);
  const r = sb.setConfig({ bootstrapHistory: [{ writer: 'forged' }] }, { writer: 'panel' });
  assert.deepStrictEqual(r.bootstrapHistory, []);
});

test('setConfig: a bootstrap save calls neither docker compose nor any spawn', async () => {
  const calls = [];
  const { sb } = bootBox({ spawnCalls: calls });
  await sb.setConfig({ bootstrap: { packages: ['smbclient'], start: 'mysqld_safe &' } }, { writer: 'intent', seat: 'clodex' });
  assert.deepStrictEqual(calls, []);
});

test('writeComposeFile: setup.sh for packages + setup is the exact script, start.sh absent', async () => {
  const { sb } = bootBox({ config: { bootstrap: { packages: ['smbclient'], setup: 'echo hi', start: '' } } });
  await sb.writeComposeFile();
  const dir = path.join(sb.stateDir(), 'bootstrap');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'setup.sh'), 'utf8'),
    '#!/bin/sh\nset -e\nexport DEBIAN_FRONTEND=noninteractive\napt-get update -qq\napt-get install -y -qq --no-install-recommends smbclient\necho hi\n');
  assert.strictEqual(fs.statSync(path.join(dir, 'setup.sh')).mode & 0o777, 0o644);
  assert.ok(!fs.existsSync(path.join(dir, 'start.sh')));
  assert.match(fs.readFileSync(sb.composePath(), 'utf8'), /:\/etc\/clodex\/bootstrap:ro"$/m);
});

test('writeComposeFile: an emptied bootstrap removes both scripts and the bind, and keeps the dir', async () => {
  const { sb } = bootBox({ config: { bootstrap: { packages: [], setup: 'echo hi', start: 'echo s' } } });
  await sb.writeComposeFile();
  const dir = path.join(sb.stateDir(), 'bootstrap');
  assert.ok(fs.existsSync(path.join(dir, 'start.sh')), 'ENTER: the scripts were written');
  sb.setConfig({ bootstrap: { packages: [], setup: '', start: '' } }, { writer: 'panel' });
  await sb.writeComposeFile();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.doesNotMatch(fs.readFileSync(sb.composePath(), 'utf8'), /etc\/clodex\/bootstrap/);
});

test('up: a symlink planted at bootstrap/setup.sh refuses the write and no compose file is written', async () => {
  const { sb, dir } = bootBox({ config: { bootstrap: { packages: ['smbclient'] } } });
  const bootDir = path.join(sb.stateDir(), 'bootstrap');
  fs.mkdirSync(bootDir, { recursive: true });
  const victim = path.join(dir, 'victim');
  fs.writeFileSync(victim, 'untouched');
  fs.symlinkSync(victim, path.join(bootDir, 'setup.sh'));
  const r = await sb.up();
  assert.deepStrictEqual(r, { ok: false, error: `compose write failed: bootstrap: ${path.join(bootDir, 'setup.sh')} is not a regular file` });
  assert.ok(!fs.existsSync(sb.composePath()));
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'untouched');
});

test('up: a symlinked bootstrap dir is refused', async () => {
  const { sb, dir } = bootBox({ config: { bootstrap: { setup: 'echo hi' } } });
  fs.mkdirSync(sb.stateDir(), { recursive: true });
  fs.mkdirSync(path.join(dir, 'elsewhere'));
  fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(sb.stateDir(), 'bootstrap'));
  const r = await sb.up();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /bootstrap: .* is not a directory$/);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'elsewhere')), []);
});

const COMPOSE_ARGS = {
  image: { kind: 'build', context: '/repo', dockerfile: 'docker/web/Dockerfile' },
  ports: { web: 7810, wirescope: 7811, wire: 7820 }, stateDir: '/h/.clodex/boxes/x', workDir: null, authEnvFile: null, hostname: 'team-x',
};

test('generateCompose: bootstrapDir adds exactly one :ro line after the codex bind; without it the bytes are the baseline', () => {
  const hash = (y) => crypto.createHash('sha256').update(y).digest('hex');
  assert.strictEqual(hash(generateCompose(COMPOSE_ARGS)), 'cd6120e59f69885356ef347d785d977d67589c138eb4f49aa80633dabf03aeda');
  assert.strictEqual(hash(generateCompose({ ...COMPOSE_ARGS, bootstrapDir: null })), 'cd6120e59f69885356ef347d785d977d67589c138eb4f49aa80633dabf03aeda');
  const base = generateCompose(COMPOSE_ARGS).split('\n');
  const withBoot = generateCompose({ ...COMPOSE_ARGS, bootstrapDir: '/h/.clodex/boxes/x/bootstrap' }).split('\n');
  const at = base.indexOf('      - "/h/.clodex/boxes/x/codex:/home/clodex/.codex"');
  assert.ok(at > 0, 'ENTER: the codex line is in the baseline');
  assert.deepStrictEqual(withBoot, [...base.slice(0, at + 1), '      - "/h/.clodex/boxes/x/bootstrap:/etc/clodex/bootstrap:ro"', ...base.slice(at + 1)]);
});

test('status: reads the setup and start records from the box data dir, degraded when failed exists', async () => {
  const { sb } = bootBox({ config: { bootstrap: { packages: ['smbclient', 'mariadb-server'], setup: '', start: 'mysqld_safe &' } } });
  const data = path.join(sb.stateDir(), 'data');
  fs.mkdirSync(path.join(data, '.clodex-setup'), { recursive: true });
  fs.mkdirSync(path.join(data, '.clodex-start'), { recursive: true });
  const failed = '{"sha":"abcdef0123456789","exit":3,"at":"2026-10-20T01:00:00Z","timedOut":false}\n';
  fs.writeFileSync(path.join(data, '.clodex-setup', 'last.json'), failed);
  fs.writeFileSync(path.join(data, '.clodex-setup', 'failed'), failed);
  fs.writeFileSync(path.join(data, '.clodex-start', 'last.json'), '{"pid":42,"at":"2026-10-20T01:00:05Z","exit":null}\n');
  const st = await sb.status();
  assert.deepStrictEqual(st.bootstrap, {
    configured: { packages: 2, setup: false, start: true },
    setup: { sha: 'abcdef0123456789', exit: 3, at: '2026-10-20T01:00:00Z', timedOut: false },
    start: { pid: 42, at: '2026-10-20T01:00:05Z', exit: null },
    degraded: true,
    noHooks: false,
  });
});

test('status: no records → null rows, not degraded', async () => {
  const { sb } = bootBox();
  const st = await sb.status();
  assert.deepStrictEqual(st.bootstrap, { configured: { packages: 0, setup: false, start: false }, setup: null, start: null, degraded: false, noHooks: false });
});

test('bootstrapApplyTarget: rebuild until the written compose carries the bind, then restart', async () => {
  const { sb } = bootBox({ config: { bootstrap: { start: 'echo s' } } });
  assert.strictEqual(sb.bootstrapApplyTarget(), 'rebuild');
  await sb.writeComposeFile();
  assert.strictEqual(sb.bootstrapApplyTarget(), 'restart');
});

test('restart: rewrites the scripts when bound, then compose restart of the box service', async () => {
  const calls = [];
  const { sb } = bootBox({ spawnCalls: calls, config: { bootstrap: { start: 'echo one' } } });
  await sb.writeComposeFile();
  sb.setConfig({ bootstrap: { start: 'echo two' } }, { writer: 'intent', seat: 'clodex' });
  const r = await sb.restart();
  assert.deepStrictEqual(r, { ok: true });
  const sub = calls.filter((a) => a.includes('-f')).map((a) => a.slice(a.indexOf('-f') + 2));
  assert.deepStrictEqual(sub, [['restart', 'clodex']]);
  assert.strictEqual(fs.readFileSync(path.join(sb.stateDir(), 'bootstrap', 'start.sh'), 'utf8'), '#!/bin/sh\necho two');
});

test('DEFAULT_CONFIG carries an empty bootstrap and history', () => {
  assert.deepStrictEqual(DEFAULT_CONFIG.bootstrap, { packages: [], setup: '', start: '' });
  assert.deepStrictEqual(DEFAULT_CONFIG.bootstrapHistory, []);
});

test('generateCompose: noHooks adds exactly one env line after the environment block; without it the bytes are the baseline', () => {
  const hash = (y) => crypto.createHash('sha256').update(y).digest('hex');
  assert.strictEqual(hash(generateCompose({ ...COMPOSE_ARGS, noHooks: false })), 'cd6120e59f69885356ef347d785d977d67589c138eb4f49aa80633dabf03aeda');
  const base = generateCompose(COMPOSE_ARGS).split('\n');
  const withNoHooks = generateCompose({ ...COMPOSE_ARGS, noHooks: true }).split('\n');
  const at = base.indexOf('      XDG_DATA_HOME: /home/clodex/.local/share');
  assert.ok(at > 0, 'ENTER: the XDG_DATA_HOME line is in the baseline');
  assert.deepStrictEqual(withNoHooks, [...base.slice(0, at + 1), '      CLODEX_NO_HOOKS: "1"', ...base.slice(at + 1)]);
});

test('status: bootstrap.noHooks reads the written compose.yaml', async () => {
  const { sb } = bootBox();
  fs.mkdirSync(path.dirname(sb.composePath()), { recursive: true });
  fs.writeFileSync(sb.composePath(), 'services:\n  clodex:\n    environment:\n      CLODEX_NO_HOOKS: "1"\n    volumes:\n');
  assert.strictEqual((await sb.status()).bootstrap.noHooks, true);
  fs.writeFileSync(sb.composePath(), 'services:\n  clodex:\n    environment:\n      XDG_DATA_HOME: /x\n');
  assert.strictEqual((await sb.status()).bootstrap.noHooks, false);
});

test('up({ noHooks: true }) writes CLODEX_NO_HOOKS into that compose; the next plain up drops it', async () => {
  const { sb } = bootBox();
  await sb.up({ noHooks: true });
  assert.match(fs.readFileSync(sb.composePath(), 'utf8'), /\n {6}CLODEX_NO_HOOKS: "1"\n/);
  await sb.up();
  assert.doesNotMatch(fs.readFileSync(sb.composePath(), 'utf8'), /CLODEX_NO_HOOKS/);
});

test('bootstrapLog: returns the last 64 KB of last.log, truncated on a 65 KB file', () => {
  const { sb } = bootBox();
  assert.deepStrictEqual(sb.bootstrapLog(), { text: '', truncated: false });
  const dir = path.join(sb.stateDir(), 'data', '.clodex-setup');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'last.log'), `${'a'.repeat(1024)}${'b'.repeat(65536)}`);
  const r = sb.bootstrapLog();
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.text, 'b'.repeat(65536));
  fs.writeFileSync(path.join(dir, 'last.log'), 'apt-get ok\n');
  assert.deepStrictEqual(sb.bootstrapLog(), { text: 'apt-get ok\n', truncated: false });
});

test('SETUP_TIMEOUT_S is the default clodex-hooks.sh uses for CLODEX_SETUP_TIMEOUT', () => {
  const hooks = fs.readFileSync(path.join(__dirname, '..', 'docker', 'web', 'clodex-hooks.sh'), 'utf8');
  assert.match(hooks, /_ch_timeout=\$\{CLODEX_SETUP_TIMEOUT:-600\}/);
  assert.deepStrictEqual([SETUP_TIMEOUT_S, HEALTH_TIMEOUT_MS], [600, 180000]);
});

test('a port apply keeps the Start-without-hooks line; the next plain up drops it', async () => {
  const { sb } = bootBox();
  await sb.up({ noHooks: true });
  assert.strictEqual((await sb.status()).bootstrap.noHooks, true, 'ENTER: the no-hooks start wrote the line');
  await sb.setConfig({ ports: [{ container: 18080, host: 18080, proto: 'tcp', allInterfaces: false }] }, { writer: 'panel' });
  await sb.applyPorts();
  assert.match(fs.readFileSync(sb.composePath(), 'utf8'), /18080/, 'ENTER: the port apply rewrote the compose');
  assert.strictEqual((await sb.status()).bootstrap.noHooks, true);
  await sb.up();
  assert.strictEqual((await sb.status()).bootstrap.noHooks, false);
});
