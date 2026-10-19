'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot, mkTmpDirIn } = require('./lib/tmp-roots');
const {
  createSandbox, generateCompose, parseOwnPorts, parsePortOwners, parseOwnPortMap, probeDockerLocal,
} = require('../sandbox');

const TMP_USERDATA = mkTmpRoot('clx-sbports-ud-');
const TMP_REGISTRY = mkTmpRoot('clx-sbports-reg-');
process.on('exit', () => { try { fs.rmSync(TMP_USERDATA, { recursive: true, force: true }); } catch {} });
process.on('exit', () => { try { fs.rmSync(TMP_REGISTRY, { recursive: true, force: true }); } catch {} });

const DEV_IMAGE = { kind: 'build', context: '/repo', dockerfile: 'docker/web/Dockerfile' };
const PORTS = { web: 7810, wirescope: 7811, wire: 7820 };
const STATE_DIR = '/h/.clodex/boxes/x';
const COMPOSE_ARGS = { image: DEV_IMAGE, ports: PORTS, stateDir: STATE_DIR, workDir: null, authEnvFile: null, hostname: 'team-x' };

function fakeChild(behavior) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (behavior.stdout) child.stdout.emit('data', behavior.stdout);
    if (behavior.stderr) child.stderr.emit('data', behavior.stderr);
    child.emit('exit', behavior.code ?? 0);
  });
  return child;
}

function recordingSpawn(calls, results = {}) {
  return (_cmd, args) => {
    calls.push(args);
    const f = args.indexOf('-f');
    const sub = f >= 0 ? args[f + 2] : `docker ${args[0]}`;
    return fakeChild(results[sub] || { code: 0 });
  };
}

function composeSubcommands(calls) {
  return calls.filter((a) => a.includes('compose') && a.includes('-f')).map((a) => a.slice(a.indexOf('-f') + 2));
}

function fakeSettings(sandbox = {}) {
  let state = { peers: [], sandbox };
  return {
    get() { return { ...state }; },
    set(partial) { state = { ...state, ...partial }; return state; },
  };
}

const SIBLING_YAML = [
  'services:',
  '  clodex:',
  '    hostname: game-old',
  '    ports:',
  '      - "127.0.0.1:7830:8080"',
  '  game-old-ports:',
  '    ports:',
  '      - "127.0.0.1:3000:3000"',
  '      - "0.0.0.0:5173:5173"',
  '',
].join('\n');

function portBox({ ports = [], spawn, dockerIsLocal = async () => true, selfLabel } = {}) {
  const ud = mkTmpDirIn(TMP_USERDATA, 'ud-');
  const sibling = path.join(ud, 'sibling-compose.yaml');
  fs.writeFileSync(sibling, SIBLING_YAML);
  const settings = fakeSettings({ ports });
  const sb = createSandbox({
    registryDir: mkTmpDirIn(TMP_REGISTRY, 'reg-'),
    getUiSettings: () => settings,
    getUserDataPath: () => ud,
    siblingComposePaths: () => [sibling],
    isPortInUse: () => Promise.resolve(false),
    isPackaged: () => false,
    repoRoot: '/repo',
    platform: 'darwin',
    spawn: spawn || recordingSpawn([]),
    dockerIsLocal,
    ...(selfLabel ? { selfLabel } : {}),
  });
  return { sb, settings };
}

const WIDE = { container: 4000, host: 4000, allInterfaces: true, proto: 'http', label: 'lan' };

const REFUSALS = [
  { name: 'container out of range', ports: [{ container: 0 }], error: 'Container port must be a whole number 1–65535 (got 0).' },
  { name: 'container is a Clodex in-box port', ports: [{ container: 8080 }], error: "Container port 8080 is Clodex's own web port inside the box; run the app on another port." },
  { name: 'host below 1024', ports: [{ container: 3001, host: 80 }], error: 'Host port must be a whole number 1024–65535 (got 80).' },
  { name: 'unknown proto', ports: [{ container: 3001, proto: 'udp' }], error: 'Port protocol must be one of tcp, http, https (got "udp").' },
  { name: 'label too long', ports: [{ container: 3001, label: 'x'.repeat(33) }], error: 'Port label is too long (33 characters, max 32).' },
  { name: 'duplicate host', ports: [{ container: 3001, host: 4100 }, { container: 3002, host: 4100 }], error: 'Host port 4100 is listed twice.' },
  { name: "this box's Clodex host port", ports: [{ container: 3001, host: 7810 }], error: "Host port 7810 is one of this box's Clodex ports; pick another host port." },
  { name: 'published by a sibling (loopback)', ports: [{ container: 3000 }], error: '3000 is published by sandbox game-old; use 3000:3001' },
  { name: 'published by a sibling (0.0.0.0)', ports: [{ container: 5173 }], error: '5173 is published by sandbox game-old; use 5173:5174' },
  { name: 'intent sets allInterfaces', writer: 'intent', ports: [{ container: 3001, allInterfaces: true }], error: 'All-interfaces exposure can only be turned on from the Sandbox panel.' },
  { name: 'intent edits an allInterfaces entry', writer: 'intent', prior: [WIDE], ports: [{ ...WIDE, label: 'renamed' }], error: '4000:4000 is published on all IPv4 interfaces; only the Sandbox panel may change it.' },
  { name: 'intent removes an allInterfaces entry', writer: 'intent', prior: [WIDE], ports: [], error: '4000:4000 is published on all IPv4 interfaces; only the Sandbox panel may change it.' },
];

for (const row of REFUSALS) {
  test(`validatePortsForSave refuses: ${row.name}`, () => {
    const { sb } = portBox();
    const r = sb.validatePortsForSave(row.ports, { writer: row.writer || 'panel', prior: row.prior || [] });
    assert.deepStrictEqual(r, { error: row.error });
  });
}

test('validatePortsForSave: ENTER a valid two-entry list survives normalized', () => {
  const { sb } = portBox();
  const r = sb.validatePortsForSave([{ container: 3001, label: ' web ', proto: 'http' }, { container: '5432', host: '15432' }], { writer: 'panel', prior: [] });
  assert.deepStrictEqual(r, { ports: [
    { container: 3001, host: 3001, allInterfaces: false, proto: 'http', label: 'web' },
    { container: 5432, host: 15432, allInterfaces: false, proto: 'tcp', label: '' },
  ] });
});

test('validatePortsForSave: intent may keep an unchanged allInterfaces entry and add a loopback one', () => {
  const { sb } = portBox();
  const r = sb.validatePortsForSave([WIDE, { container: 3001 }], { writer: 'intent', prior: [WIDE] });
  assert.deepStrictEqual(r, { ports: [WIDE, { container: 3001, host: 3001, allInterfaces: false, proto: 'tcp', label: '' }] });
});

test('validatePortsForSave: the panel may set allInterfaces on a new entry', () => {
  const { sb } = portBox();
  const r = sb.validatePortsForSave([{ container: 3001, allInterfaces: true }], { writer: 'panel', prior: [] });
  assert.deepStrictEqual(r, { ports: [{ container: 3001, host: 3001, allInterfaces: true, proto: 'tcp', label: '' }] });
});

test('validatePortsForSave: changing the host of an allInterfaces entry resets it to loopback, even from the panel', () => {
  const { sb } = portBox();
  const r = sb.validatePortsForSave([{ ...WIDE, host: 4001 }], { writer: 'panel', prior: [WIDE] });
  assert.deepStrictEqual(r, { ports: [{ container: 4000, host: 4001, allInterfaces: false, proto: 'http', label: 'lan' }] });
});

test('setConfig: a writer-less call is the intent writer and cannot set allInterfaces', () => {
  const { sb } = portBox();
  assert.deepStrictEqual(sb.setConfig({ ports: [{ container: 3001, allInterfaces: true }] }),
    { ok: false, error: 'All-interfaces exposure can only be turned on from the Sandbox panel.' });
});

test('parseOwnPorts / parsePortOwners: loopback and 0.0.0.0 lines, owner from the hostname', () => {
  assert.deepStrictEqual(parseOwnPorts(SIBLING_YAML), [7830, 3000, 5173]);
  assert.deepStrictEqual(parsePortOwners(SIBLING_YAML), [
    { port: 7830, boxId: 'game-old' }, { port: 3000, boxId: 'game-old' }, { port: 5173, boxId: 'game-old' },
  ]);
  assert.deepStrictEqual(parsePortOwners(''), []);
});

test('generateCompose: no app ports is byte-identical to the pre-ports output', () => {
  const hash = (y) => crypto.createHash('sha256').update(y).digest('hex');
  const golden = 'cd6120e59f69885356ef347d785d977d67589c138eb4f49aa80633dabf03aeda';
  assert.strictEqual(hash(generateCompose(COMPOSE_ARGS)), golden);
  assert.strictEqual(hash(generateCompose({ ...COMPOSE_ARGS, appPorts: [] })), golden);
});

test('generateCompose: a host label lands as CLODEX_HOST_LABEL in the box environment, and only when passed', () => {
  const yaml = generateCompose({ ...COMPOSE_ARGS, hostLabel: 'mac' });
  const env = yaml.split('\n');
  const at = env.indexOf('      CLODEX_HOST_LABEL: "mac"');
  assert.ok(at > env.indexOf('    environment:') && env.indexOf('    environment:') > env.indexOf('  clodex:'), yaml);
  assert.ok(!env.slice(env.indexOf('    environment:') + 1, at).some((l) => !l.startsWith('      ')), 'the line sits inside the environment block');
  assert.doesNotMatch(generateCompose(COMPOSE_ARGS), /CLODEX_HOST_LABEL/);
});

test('writeComposeFile passes the selfLabel dep through as the host label', async () => {
  const { sb } = portBox({ selfLabel: 'mac' });
  await sb.writeComposeFile();
  assert.match(fs.readFileSync(sb.composePath(), 'utf8'), /^ {6}CLODEX_HOST_LABEL: "mac"$/m);
  const { sb: bare } = portBox();
  await bare.writeComposeFile();
  assert.doesNotMatch(fs.readFileSync(bare.composePath(), 'utf8'), /CLODEX_HOST_LABEL/);
});

test('generateCompose: app ports add a locked-down gateway service after the box', () => {
  const yaml = generateCompose({ ...COMPOSE_ARGS, image: { kind: 'image', image: 'ghcr.io/avirtual/clodex:9.9.9' }, appPorts: [
    { container: 3000, host: 3100, proto: 'http' },
    { container: 5432, host: 15432, allInterfaces: true },
  ] });
  const start = yaml.indexOf('  team-x-ports:\n');
  assert.ok(start > yaml.indexOf('  clodex:\n'));
  const block = yaml.slice(start, yaml.indexOf('\n\n', start) + 1);
  assert.strictEqual(block, [
    '  team-x-ports:',
    '    image: ghcr.io/avirtual/clodex:9.9.9',
    '    entrypoint: ["node", "/app/sandbox-port-forwarder.js"]',
    '    ports:',
    '      - "127.0.0.1:3100:3100"',
    '      - "0.0.0.0:15432:15432"',
    '    environment:',
    '      CLODEX_PORT_MAP: "[{\\"host\\":3100,\\"target\\":\\"clodex:3000\\"},{\\"host\\":15432,\\"target\\":\\"clodex:5432\\"}]"',
    '    read_only: true',
    '    cap_drop:',
    '      - ALL',
    '    restart: unless-stopped',
    '    deploy:',
    '      resources:',
    '        limits:',
    '          cpus: "0.5"',
    '          memory: 256m',
    '',
  ].join('\n'));
  const bare = generateCompose({ ...COMPOSE_ARGS, image: { kind: 'image', image: 'ghcr.io/avirtual/clodex:9.9.9' } });
  const at = bare.indexOf('\nvolumes:\n') + 1;
  assert.strictEqual(yaml, `${bare.slice(0, at)}${block}\n${bare.slice(at)}`);
});

test('parseOwnPortMap: a gateway line on a Clodex container number is not read as a Clodex port', () => {
  const yaml = generateCompose({ ...COMPOSE_ARGS, appPorts: [{ container: 3000, host: 7900 }] });
  assert.deepStrictEqual(parseOwnPortMap(yaml), { web: 7810, wirescope: 7811, wire: 7820 });
});

const RUNNING = { code: 0, stdout: '[{"Service":"clodex","State":"running"}]' };

test('applyPorts via setConfig: a running box recreates only the gateway and records the URLs', async () => {
  const calls = [];
  const { sb } = portBox({ spawn: recordingSpawn(calls, { ps: RUNNING }) });
  await sb.setConfig({ ports: [{ container: 3001, proto: 'http' }, { container: 5432, host: 15432 }] }, { writer: 'panel' });
  const subs = composeSubcommands(calls).filter((a) => a[0] !== 'ps');
  assert.deepStrictEqual(subs, [['up', '-d', '--no-deps', 'sandbox-ports']]);
  assert.match(fs.readFileSync(sb.composePath(), 'utf8'), /^ {2}sandbox-ports:$/m);
  assert.deepStrictEqual(sb.portsState().applied, [
    { container: 3001, host: 3001, proto: 'http', allInterfaces: false, applied: true, url: 'http://localhost:3001' },
    { container: 5432, host: 15432, proto: 'tcp', allInterfaces: false, applied: true, url: 'localhost:15432' },
  ]);
});

test('applyPorts: an emptied list removes the gateway while the compose file still names it, then rewrites the file', async () => {
  const calls = [];
  const fileAtRm = [];
  let sb;
  const record = recordingSpawn(calls, { ps: RUNNING });
  const spawn = (cmd, args) => {
    const f = args.indexOf('-f');
    if (f >= 0 && args[f + 2] === 'rm') fileAtRm.push(fs.readFileSync(sb.composePath(), 'utf8'));
    return record(cmd, args);
  };
  ({ sb } = portBox({ ports: [{ container: 3001 }], spawn }));
  await sb.writeComposeFile();
  const cfg = await sb.setConfig({ ports: [] }, { writer: 'panel' });
  assert.deepStrictEqual(composeSubcommands(calls).filter((a) => a[0] !== 'ps'), [['rm', '-sf', 'sandbox-ports']]);
  assert.strictEqual(fileAtRm.length, 1);
  assert.match(fileAtRm[0], /^ {2}sandbox-ports:$/m);
  assert.doesNotMatch(fs.readFileSync(sb.composePath(), 'utf8'), /sandbox-ports:/);
  assert.strictEqual(cfg.portsError, undefined);
  assert.deepStrictEqual(sb.portsState().applied, []);
});

test('applyPorts: a failed gateway rm keeps the file naming it and surfaces the error from setConfig', async () => {
  const { sb } = portBox({ ports: [{ container: 3001 }], spawn: recordingSpawn([], { ps: RUNNING, rm: { code: 1, stderr: 'boom\n' } }) });
  await sb.writeComposeFile();
  const cfg = await sb.setConfig({ ports: [] }, { writer: 'panel' });
  assert.strictEqual(cfg.portsError, 'boom');
  assert.match(fs.readFileSync(sb.composePath(), 'utf8'), /^ {2}sandbox-ports:$/m);
});

test('down: removes orphans and both copies of the ports record', async () => {
  const calls = [];
  const { sb } = portBox({ ports: [{ container: 3001 }], spawn: recordingSpawn(calls) });
  await sb.applyPorts();
  const boxCopy = path.join(sb.stateDir(), 'dot', 'sandbox-ports.json');
  assert.strictEqual(fs.existsSync(boxCopy), true);
  assert.deepStrictEqual(await sb.down(), { ok: true });
  assert.deepStrictEqual(composeSubcommands(calls).at(-1), ['down', '--remove-orphans']);
  assert.strictEqual(fs.existsSync(boxCopy), false);
  assert.deepStrictEqual(sb.portsState().applied, []);
});

test('portsState: a record forged inside the box does not reach the panel', async () => {
  const { sb } = portBox({ ports: [{ container: 3001, proto: 'http' }] });
  await sb.applyPorts();
  const boxCopy = path.join(sb.stateDir(), 'dot', 'sandbox-ports.json');
  fs.writeFileSync(boxCopy, JSON.stringify([{ container: 3001, host: 3001, proto: 'http', allInterfaces: false, applied: true, url: 'https://evil.example' }]));
  assert.deepStrictEqual(sb.portsState().applied, [{ container: 3001, host: 3001, proto: 'http', allInterfaces: false, applied: true, url: 'http://localhost:3001' }]);
});

test('applyPorts: a stopped box writes config only, no compose call', async () => {
  const calls = [];
  const { sb } = portBox({ spawn: recordingSpawn(calls, { ps: { code: 0, stdout: '' } }) });
  const cfg = await sb.setConfig({ ports: [{ container: 3001 }] }, { writer: 'panel' });
  assert.deepStrictEqual(cfg.ports, [{ container: 3001, host: 3001, allInterfaces: false, proto: 'tcp', label: '' }]);
  assert.deepStrictEqual(composeSubcommands(calls).filter((a) => a[0] !== 'ps'), []);
});

test('applyPorts: a failed compose exit records applied:false with the stderr tail and no url', async () => {
  const calls = [];
  const stderr = `${'x'.repeat(300)}Bind for 127.0.0.1:3001 failed: port is already allocated\n`;
  const { sb } = portBox({ ports: [{ container: 3001, proto: 'http' }], spawn: recordingSpawn(calls, { up: { code: 1, stderr } }) });
  const r = await sb.applyPorts();
  const tail = stderr.trim().slice(-200);
  assert.deepStrictEqual(r, { ok: false, error: tail, ports: [{ container: 3001, host: 3001, proto: 'http', allInterfaces: false, applied: false, error: tail }] });
  assert.deepStrictEqual(sb.portsState().applied, r.ports);
});

test('applyPorts: remote Docker records applied entries without a url', async () => {
  const { sb } = portBox({ ports: [{ container: 3001, proto: 'http' }], dockerIsLocal: async () => false });
  const r = await sb.applyPorts();
  assert.deepStrictEqual(r.ports, [{ container: 3001, host: 3001, proto: 'http', allInterfaces: false, applied: true }]);
});

test('probeDockerLocal: DOCKER_HOST is remote without a probe; the context name decides otherwise', async () => {
  const seen = [];
  const spawnWith = (stdout) => (_cmd, args) => { seen.push(args); return fakeChild({ code: 0, stdout }); };
  assert.deepStrictEqual(await probeDockerLocal(spawnWith('default\n'), { DOCKER_HOST: 'ssh://box' }), { local: false });
  assert.deepStrictEqual(seen, []);
  assert.deepStrictEqual(await probeDockerLocal(spawnWith('default\n'), {}), { local: true });
  assert.deepStrictEqual(await probeDockerLocal(spawnWith('desktop-linux\n'), {}), { local: true });
  assert.deepStrictEqual(await probeDockerLocal(spawnWith('colima\n'), {}), { local: false });
  assert.deepStrictEqual(seen[0], ['context', 'show']);
});

const LOOP = { container: 3001, host: 3001, allInterfaces: false, proto: 'tcp', label: '' };
const PAIR_ROWS = [
  { name: 'a reorder keeps consent on the same pair', prior: [WIDE, LOOP], ports: [LOOP, WIDE], want: [LOOP, WIDE] },
  { name: 'a reorder does not carry consent onto a changed pair', prior: [WIDE, LOOP], ports: [LOOP, { ...WIDE, host: 4001 }], want: [LOOP, { container: 4000, host: 4001, allInterfaces: false, proto: 'http', label: 'lan' }] },
];

for (const row of PAIR_ROWS) {
  test(`validatePortsForSave pair matching: ${row.name}`, () => {
    const { sb } = portBox();
    assert.deepStrictEqual(sb.validatePortsForSave(row.ports, { writer: 'panel', prior: row.prior }), { ports: row.want });
  });
}

test('applyPorts: a failed gateway rm leaves the prior record byte-identical', async () => {
  const results = { ps: RUNNING };
  const { sb } = portBox({ ports: [{ container: 3001 }], spawn: recordingSpawn([], results) });
  await sb.applyPorts();
  const before = fs.readFileSync(path.join(path.dirname(sb.composePath()), 'sandbox-ports.json'), 'utf8');
  results.rm = { code: 1, stderr: 'boom\n' };
  const cfg = await sb.setConfig({ ports: [] }, { writer: 'panel' });
  assert.strictEqual(cfg.portsError, 'boom');
  assert.strictEqual(fs.readFileSync(path.join(path.dirname(sb.composePath()), 'sandbox-ports.json'), 'utf8'), before);
});

test('applyPorts: a compose rewrite that throws after the gateway rm records no ports', async () => {
  let sb;
  const record = recordingSpawn([], { ps: RUNNING });
  const spawn = (cmd, args) => {
    const f = args.indexOf('-f');
    if (f >= 0 && args[f + 2] === 'rm') {
      fs.rmSync(sb.composePath());
      fs.mkdirSync(sb.composePath());
      fs.writeFileSync(path.join(sb.composePath(), 'x'), '');
    }
    return record(cmd, args);
  };
  ({ sb } = portBox({ ports: [{ container: 3001 }], spawn }));
  await sb.applyPorts();
  assert.strictEqual(sb.portsState().applied.length, 1);
  const cfg = await sb.setConfig({ ports: [] }, { writer: 'panel' });
  assert.match(cfg.portsError, /^compose write failed: /);
  assert.deepStrictEqual(sb.portsState().applied, []);
});
