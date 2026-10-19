'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot, mkTmpDirIn } = require('./lib/tmp-roots');
const {
  createSandbox, createSandboxManager, generateCompose, validateLimitsForSave, normalizePlatform, probeDockerFigures,
} = require('../sandbox');

const TMP = mkTmpRoot('clx-sblimits-');
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const GIB = 1024 * 1024 * 1024;
const DEV_IMAGE = { kind: 'build', context: '/repo', dockerfile: 'docker/web/Dockerfile' };
const COMPOSE_ARGS = { image: DEV_IMAGE, ports: { web: 7810, wirescope: 7811, wire: 7820 }, stateDir: '/h/.clodex/boxes/x', workDir: null, authEnvFile: null, hostname: 'team-x' };
const OPERATOR_ONLY = 'limits and platform are operator settings: change them in the Sandbox panel';

function fakeChild({ code = 0, stdout = '', stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('exit', code);
  });
  return child;
}

function fileBox({ figures, config = {} } = {}) {
  const dir = mkTmpDirIn(TMP, 'box-');
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, `${JSON.stringify(config)}\n`);
  const sb = createSandbox({
    registryDir: dir, getUserDataPath: () => dir,
    spawn: () => fakeChild(),
    readBoxConfig: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    writeBoxConfig: (next) => { fs.writeFileSync(file, `${JSON.stringify(next)}\n`); },
    getFigures: () => figures || { ncpu: null, memTotal: null },
  });
  return { sb, file };
}

test('setConfig: limits or platform from the intent writer is refused first and writes nothing', () => {
  const { sb, file } = fileBox({ config: { ref: 'master' } });
  const before = fs.readFileSync(file);
  assert.deepStrictEqual(sb.setConfig({ limits: { cpus: 2 } }), { ok: false, error: OPERATOR_ONLY });
  assert.deepStrictEqual(sb.setConfig({ platform: 'linux/amd64' }, { writer: 'intent' }), { ok: false, error: OPERATOR_ONLY });
  assert.deepStrictEqual(sb.setConfig({ ref: 'bad ref with spaces', limits: { cpus: 0.1 } }), { ok: false, error: OPERATOR_ONLY });
  assert.ok(fs.readFileSync(file).equals(before), 'the config file is byte-identical');
});

test('setConfig: the panel writer validates and writes limits and platform', () => {
  const { sb, file } = fileBox({ figures: { ncpu: 12, memTotal: 16 * GIB } });
  const r = sb.setConfig({ limits: { cpus: '2', memory: '4G', pids: '512', shmSize: '' }, platform: 'linux/amd64' }, { writer: 'panel' });
  assert.deepStrictEqual(r.limits, { cpus: 2, memory: '4g', pids: 512, shmSize: null });
  assert.strictEqual(r.platform, 'linux/amd64');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(saved.limits, { cpus: 2, memory: '4g', pids: 512, shmSize: null });
  assert.strictEqual(saved.platform, 'linux/amd64');
  assert.deepStrictEqual(sb.setConfig({ limits: { cpus: 13 } }, { writer: 'panel' }),
    { ok: false, error: 'limits.cpus must be between 0.25 and 12 (the Docker VM has 12 cores)' });
});

const FIG = { ncpu: 12, memTotal: 16 * GIB };
const LIMIT_ROWS = [
  ['cpus 0.1', { cpus: 0.1 }, FIG, { error: 'limits.cpus must be between 0.25 and 12 (the Docker VM has 12 cores)' }],
  ['cpus 13 of 12', { cpus: 13 }, FIG, { error: 'limits.cpus must be between 0.25 and 12 (the Docker VM has 12 cores)' }],
  ['cpus 13, figures unknown', { cpus: 13 }, null, { limits: { cpus: 13, memory: null, pids: null, shmSize: null } }],
  ['memory 256m', { memory: '256m' }, FIG, { error: 'limits.memory must be between 512m and 16g (the Docker VM has 16 GiB)' }],
  ['memory 20g of 16 GiB', { memory: '20g' }, FIG, { error: 'limits.memory must be between 512m and 16g (the Docker VM has 16 GiB)' }],
  ['memory 20g, memTotal null', { memory: '20g' }, { ncpu: 12, memTotal: null }, { limits: { cpus: null, memory: '20g', pids: null, shmSize: null } }],
  ['memory 256m, memTotal null', { memory: '256m' }, { ncpu: null, memTotal: null }, { error: 'limits.memory must be a size of at least 512m (like 512m or 4g)' }],
  ['memory 4 GB', { memory: '4 GB' }, FIG, { error: 'limits.memory must be between 512m and 16g (the Docker VM has 16 GiB)' }],
  ['pids 10', { pids: 10 }, FIG, { error: 'limits.pids must be a whole number of at least 64' }],
  ['pids 64.5', { pids: 64.5 }, FIG, { error: 'limits.pids must be a whole number of at least 64' }],
  ['shmSize 64m', { shmSize: '64m' }, FIG, { limits: { cpus: null, memory: null, pids: null, shmSize: '64m' } }],
  ['shmSize 0m', { shmSize: '0m' }, FIG, { error: 'limits.shmSize must be a size of at least 1m (like 64m or 1g)' }],
  ['all set', { cpus: 2, memory: '4g', pids: 512, shmSize: '1g' }, FIG, { limits: { cpus: 2, memory: '4g', pids: 512, shmSize: '1g' } }],
  ['not an object', 'lots', FIG, { error: 'limits must be an object with cpus, memory, pids and shmSize.' }],
];
for (const [name, raw, figures, want] of LIMIT_ROWS) {
  test(`validateLimitsForSave: ${name}`, () => {
    assert.deepStrictEqual(validateLimitsForSave(raw, { figures }), want);
  });
}

test('normalizePlatform: two linux platforms, empty is the host, anything else refused', () => {
  assert.deepStrictEqual(normalizePlatform('linux/amd64'), { platform: 'linux/amd64' });
  assert.deepStrictEqual(normalizePlatform('linux/arm64'), { platform: 'linux/arm64' });
  assert.deepStrictEqual(normalizePlatform(''), { platform: null });
  assert.deepStrictEqual(normalizePlatform(null), { platform: null });
  assert.deepStrictEqual(normalizePlatform('windows/amd64'),
    { error: "platform must be linux/amd64 or linux/arm64, or empty for the host's architecture" });
});

test('generateCompose: limits emit the deploy block and shm_size on the box service', () => {
  const yaml = generateCompose({ ...COMPOSE_ARGS, limits: { cpus: 2, memory: '4g', pids: 512, shmSize: '1g' } });
  assert.ok(yaml.includes([
    '    restart: always',
    '    deploy:',
    '      resources:',
    '        limits:',
    '          cpus: "2"',
    '          memory: 4g',
    '          pids: 512',
    '    shm_size: 1g',
    '    healthcheck:',
  ].join('\n')), yaml);
  const partial = generateCompose({ ...COMPOSE_ARGS, limits: { cpus: null, memory: '4g', pids: null, shmSize: null } });
  assert.ok(partial.includes('        limits:\n          memory: 4g\n    healthcheck:'), partial);
  assert.ok(!partial.includes('shm_size'));
});

test('generateCompose: platform lands on the box and the gateway services', () => {
  const yaml = generateCompose({ ...COMPOSE_ARGS, image: { kind: 'image', image: 'ghcr.io/avirtual/clodex:9.9.9' },
    platform: 'linux/amd64', appPorts: [{ container: 3000, host: 3100 }] });
  assert.ok(yaml.includes('  clodex:\n    hostname: team-x\n    image: ghcr.io/avirtual/clodex:9.9.9\n    platform: linux/amd64\n'), yaml);
  assert.ok(yaml.includes('  team-x-ports:\n    image: ghcr.io/avirtual/clodex:9.9.9\n    platform: linux/amd64\n'), yaml);
  assert.strictEqual(yaml.split('platform: linux/amd64').length - 1, 2);
});

test('generateCompose: unset limits and platform are byte-identical to omitting them', () => {
  const unset = { limits: { cpus: null, memory: null, pids: null, shmSize: null }, platform: null };
  assert.strictEqual(generateCompose({ ...COMPOSE_ARGS, ...unset }), generateCompose(COMPOSE_ARGS));
});

test('probeDockerFigures: parses ncpu and memTotal, nulls on a non-zero exit', async () => {
  const seen = [];
  const ok = await probeDockerFigures((cmd, args) => { seen.push([cmd, ...args]); return fakeChild({ stdout: '12 17179869184\n' }); });
  assert.deepStrictEqual(ok, { ncpu: 12, memTotal: 17179869184 });
  assert.deepStrictEqual(seen, [['docker', 'info', '--format', '{{.NCPU}} {{.MemTotal}}']]);
  assert.deepStrictEqual(await probeDockerFigures(() => fakeChild({ code: 1, stdout: '12 17179869184\n' })), { ncpu: null, memTotal: null });
  assert.deepStrictEqual(await probeDockerFigures(() => { throw new Error('ENOENT'); }), { ncpu: null, memTotal: null });
});

test('manager: figures() probes once and setConfig bounds use the cached figures', async () => {
  let boxes = [{ id: 'b1', label: 'b1', config: {} }];
  let infoProbes = 0;
  const settings = { get: () => ({ boxes }), set: (p) => { if (p.boxes) boxes = p.boxes; } };
  const mgr = createSandboxManager({ getUiSettings: () => settings, getUserDataPath: () => TMP, registryDir: TMP,
    spawn: (_c, args) => {
      const figuresProbe = args[0] === 'info' && args[2] === '{{.NCPU}} {{.MemTotal}}';
      if (figuresProbe) infoProbes++;
      return fakeChild(figuresProbe ? { stdout: '4 8589934592' } : {});
    } });
  assert.deepStrictEqual(await mgr.figures(), { ncpu: 4, memTotal: 8 * GIB });
  assert.deepStrictEqual(await mgr.figures(), { ncpu: 4, memTotal: 8 * GIB });
  assert.strictEqual(infoProbes, 1, 'the second figures() call is served from the cache');
  assert.deepStrictEqual(mgr.get('b1').setConfig({ limits: { cpus: 6 } }, { writer: 'panel' }),
    { ok: false, error: 'limits.cpus must be between 0.25 and 4 (the Docker VM has 4 cores)' });
});

function statusSpawn({ state = 'running', calls = [] } = {}) {
  return (_cmd, args) => {
    calls.push(args);
    const f = args.indexOf('-f');
    const sub = f >= 0 ? args.slice(f + 2) : args;
    if (sub[0] === 'ps' && sub[1] === '--format') return fakeChild({ stdout: `[{"Service":"clodex","State":"${state}"}]` });
    if (sub[0] === 'ps' && sub[1] === '-q') return fakeChild({ stdout: 'abc123\n' });
    if (sub[0] === 'inspect' && sub[3] === '{{json .HostConfig}}') {
      return fakeChild({ stdout: '{"NanoCpus":2000000000,"Memory":4294967296,"PidsLimit":512,"ShmSize":1073741824}\n' });
    }
    if (sub[0] === 'inspect' && sub[3] === '{{.Image}}') return fakeChild({ stdout: 'sha256:feed\n' });
    if (sub[0] === 'image') return fakeChild({ stdout: 'linux/amd64\n' });
    if (sub[0] === 'stats') return fakeChild({ stdout: '12.34%   1.2GiB / 16GiB\n' });
    return fakeChild();
  };
}

function statusBox(spawn) {
  const dir = mkTmpDirIn(TMP, 'st-');
  const config = { limits: { cpus: 2, memory: '4g', pids: 512, shmSize: '1g' }, platform: 'linux/amd64' };
  return createSandbox({ registryDir: dir, getUserDataPath: () => dir, spawn,
    readBoxConfig: () => config, writeBoxConfig: () => {} });
}

test('status: a running box reports applied limits, platform and usage from inspect and stats', async () => {
  const st = await statusBox(statusSpawn()).status({ live: true });
  assert.strictEqual(st.state, 'running');
  assert.deepStrictEqual(st.limits, {
    configured: { cpus: 2, memory: '4g', pids: 512, shmSize: '1g' },
    applied: { cpus: 2, memory: 4294967296, pids: 512, shmSize: 1073741824 },
  });
  assert.deepStrictEqual(st.platform, { configured: 'linux/amd64', applied: 'linux/amd64' });
  assert.deepStrictEqual(st.usage, { cpuPercent: 12.34, memBytes: Math.round(1.2 * GIB) });
});

test('status: a stopped box has configured values and null applied/usage', async () => {
  const st = await statusBox(statusSpawn({ state: 'exited' })).status({ live: true });
  assert.strictEqual(st.state, 'exited');
  assert.deepStrictEqual(st.limits, { configured: { cpus: 2, memory: '4g', pids: 512, shmSize: '1g' }, applied: null });
  assert.deepStrictEqual(st.platform, { configured: 'linux/amd64', applied: null });
  assert.strictEqual(st.usage, null);
});

test('status: without live a running box spawns no inspect or stats and reports applied null', async () => {
  const calls = [];
  const st = await statusBox(statusSpawn({ calls })).status();
  assert.strictEqual(st.state, 'running', 'ENTER: the box is running, so only the live flag gates the probes');
  const verbs = calls.map((a) => { const f = a.indexOf('-f'); return (f >= 0 ? a.slice(f + 2) : a).slice(0, 2).join(' '); });
  assert.deepStrictEqual(verbs.filter((v) => /^(inspect|image|stats|ps -q)/.test(v)), []);
  assert.deepStrictEqual(st.limits.applied, null);
  assert.strictEqual(st.platform.applied, null);
  assert.strictEqual(st.usage, null);
});

test('applyPorts: a pending platform stays off the recreated gateway until the next full up', async () => {
  const dir = mkTmpDirIn(TMP, 'gw-');
  const config = { platform: 'linux/amd64', ports: [{ container: 3000, host: 3100 }] };
  const sb = createSandbox({ registryDir: dir, getUserDataPath: () => dir, spawn: () => fakeChild(),
    isPortInUse: async () => false, dockerIsLocal: async () => true,
    readBoxConfig: () => config, writeBoxConfig: () => {} });
  fs.mkdirSync(path.dirname(sb.composePath()), { recursive: true });
  fs.writeFileSync(sb.composePath(), generateCompose({ ...COMPOSE_ARGS, hostname: 'sandbox', stateDir: sb.stateDir(), appPorts: config.ports }));
  const r = await sb.applyPorts();
  assert.notStrictEqual(r && r.ok, false, JSON.stringify(r));
  const yaml = fs.readFileSync(sb.composePath(), 'utf8');
  assert.ok(yaml.includes('  sandbox-ports:\n'), 'ENTER: the gateway was rewritten');
  assert.ok(!yaml.includes('platform:'), yaml);
  await sb.writeComposeFile();
  assert.strictEqual(fs.readFileSync(sb.composePath(), 'utf8').split('platform: linux/amd64').length - 1, 2);
});
