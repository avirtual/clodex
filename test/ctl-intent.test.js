'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk: mkBase } = require('./lib/session-fixtures');
const { parseWithRegistry } = require('../intent-registry');
const { validateExecDef, parseAndValidate, clampReplyBody, isFilenameToken } = require('../exec-schema');
const { mkTmpRoot } = require('./lib/tmp-roots');

const READ_DEF = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'library', 'exec', 'clodex-ctl-read.json'), 'utf-8'));
const SEATS_DEF = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'library', 'exec', 'clodex-ctl-seats.json'), 'utf-8'));

function fakeCtl(block = { output: 'NAME  STATE\nhand  idle\n', exitCode: 0 }) {
  const calls = [];
  return { calls, svc: { run: (line) => { calls.push(line); return Promise.resolve({ command: line, ctx: 'ios', ts: 0, ...block }); } } };
}

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
const mk = (o = {}) => mkBase({ log: QUIET, isFilenameToken, fs, path, os: require('node:os'), ...o });

const SEAT = { name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: '/tmp' };

test('ctl row parses the context and the rest of the head line, bodyless', () => {
  const out = parseWithRegistry('[agent:ctl ios] get sessions -o json', '[agent:ctl ios] get sessions -o json');
  assert.deepStrictEqual({ type: out.type, ctx: out.ctx, line: out.line }, { type: 'ctl', ctx: 'ios', line: 'get sessions -o json' });
  assert.strictEqual(parseWithRegistry('[agent:ctl] get sessions', '[agent:ctl] get sessions'), null);
});

test('ctl is off for a seat whose intents do not list it, including the all-enabled default', async () => {
  for (const intents of [undefined, ['*'], ['dm', 'exec']]) {
    const { calls, svc } = fakeCtl();
    const injected = [];
    const m = mk({ getCtlService: () => svc, getPersistence: () => ({ list: () => [], get: () => ({ name: 'a', intents }) }) });
    m._injectText = (_s, text) => injected.push(text);
    m._broadcast = () => {};
    m.sessions.set('a', { ...SEAT });
    await m._handleIntent('a', { type: 'ctl', ctx: 'ios', line: 'get sessions' });
    assert.match(injected[0] || '', /^\[agent:ctl\] the ctl intent is disabled for this session/, String(intents));
    assert.deepStrictEqual(calls, []);
  }
});

const OPERATOR_ONLY = [
  ['input', 'input hand "hi"'],
  ['exec', 'exec box ls'],
  ['deploy', 'deploy node x --ssh root@h'],
  ['undeploy', 'undeploy node x'],
  ['upgrade', 'upgrade node x'],
  ['port-forward', 'port-forward hand 8080'],
  ['attach', 'attach hand'],
  ['web', 'web hand'],
  ['delete node', 'delete node ios'],
  ['use', 'use node ios'],
  ['logs --follow', 'logs hand --follow'],
  ['logs --follow', 'logs hand -f'],
];

for (const [verb, line] of OPERATOR_ONLY) {
  test(`ctl refuses \`${line}\` as operator-only without calling the service`, async () => {
    const { calls, svc } = fakeCtl();
    const m = mk({ getCtlService: () => svc });
    const replies = [];
    await m._handleCtlIntent({ ...SEAT }, { ctx: 'ios', line }, (t) => replies.push(t));
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(replies, [`ctl: ${verb} is operator-only`]);
  });
}

test('ctl refuses a line that re-targets the context or hides the verb behind a flag', async () => {
  for (const line of ['get sessions --ctx other', 'get sessions --url=http://x', 'get sessions --token t', '-o json deploy node x']) {
    const { calls, svc } = fakeCtl();
    const m = mk({ getCtlService: () => svc });
    const replies = [];
    await m._handleCtlIntent({ ...SEAT }, { ctx: 'ios', line }, (t) => replies.push(t));
    assert.deepStrictEqual(calls, [], line);
    assert.match(replies[0], /^ctl: /);
  }
});

test('ctl get sessions runs once on the named context and replies the block with its exit prefix', async () => {
  const { calls, svc } = fakeCtl();
  const m = mk({ getCtlService: () => svc, clampReplyBody });
  const replies = [];
  await m._handleCtlIntent({ ...SEAT }, { ctx: 'ios', line: 'get sessions' }, (t) => replies.push(t));
  assert.deepStrictEqual(calls, ['--ctx ios get sessions']);
  assert.deepStrictEqual(replies, ['[ctl ios exit 0] NAME  STATE\nhand  idle']);
});

test('ctl with no ctl service answers that it is not enabled', async () => {
  const m = mk({ getCtlService: () => null });
  const replies = [];
  await m._handleCtlIntent({ ...SEAT }, { ctx: 'ios', line: 'get sessions' }, (t) => replies.push(t));
  assert.deepStrictEqual(replies, ['ctl is not enabled on this host']);
});

test('both ctl exec entries validate; an empty ctx enum refuses; only the seats tier admits create', () => {
  assert.deepStrictEqual(validateExecDef(READ_DEF, 'clodex-ctl-read'), { ok: true });
  assert.deepStrictEqual(validateExecDef(SEATS_DEF, 'clodex-ctl-seats'), { ok: true });
  assert.strictEqual(parseAndValidate(READ_DEF, '{"ctx":"ios","verb":"get"}').ok, false);
  const filled = (def) => ({ ...def, schema: { ...def.schema, properties: { ...def.schema.properties, ctx: { type: 'string', enum: ['ios'] } } } });
  assert.strictEqual(parseAndValidate(filled(READ_DEF), '{"ctx":"ios","verb":"get","args":"sessions"}').ok, true);
  assert.strictEqual(parseAndValidate(filled(READ_DEF), '{"ctx":"ios","verb":"create"}').ok, false);
  assert.strictEqual(parseAndValidate(filled(SEATS_DEF), '{"ctx":"ios","verb":"create","args":"session w"}').ok, true);
  assert.strictEqual(validateExecDef({ ...READ_DEF, inProcess: 'shell' }).ok, false);
});

test('an inProcess ctl exec entry spawns nothing and reaches the ctl service once', async () => {
  const REGISTRY_DIR = mkTmpRoot('clx-ctl-exec-');
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  const def = { ...READ_DEF, schema: { ...READ_DEF.schema, properties: { ...READ_DEF.schema.properties, ctx: { type: 'string', enum: ['ios'] } } } };
  fs.writeFileSync(path.join(execDir, 'clodex-ctl-read.json'), JSON.stringify(def));
  const spawned = [];
  const { calls, svc } = fakeCtl();
  const m = mk({
    REGISTRY_DIR,
    getCtlService: () => svc,
    clampReplyBody,
    parseAndValidate,
    resolveTeam: () => null,
    getPersistence: () => ({ list: () => [], get: () => ({ name: 'a', execCommands: ['clodex-ctl-read'] }) }),
    childProcess: { spawn: (...a) => { spawned.push(a); throw new Error('spawned'); } },
  });
  const replies = [];
  m._injectText = (_s, text) => replies.push(text);
  m._broadcast = () => {};
  await m._handleExecIntent({ ...SEAT }, 'clodex-ctl-read', '{"ctx":"ios","verb":"get","args":"sessions"}');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(spawned, []);
  assert.deepStrictEqual(calls, ['--ctx ios get sessions']);
  assert.deepStrictEqual(replies, ['[agent:exec] clodex-ctl-read: [ctl ios exit 0] NAME  STATE\nhand  idle']);
});

test('an exec entry with an unknown inProcess value is refused before any spawn', async () => {
  const REGISTRY_DIR = mkTmpRoot('clx-ctl-exec-');
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(execDir, 'x.json'), JSON.stringify({ ...READ_DEF, inProcess: 'shell' }));
  const { calls, svc } = fakeCtl();
  const m = mk({
    REGISTRY_DIR,
    getCtlService: () => svc,
    parseAndValidate,
    resolveTeam: () => null,
    getPersistence: () => ({ list: () => [], get: () => ({ name: 'a', execCommands: ['x'] }) }),
  });
  const replies = [];
  m._injectText = (_s, text) => replies.push(text);
  m._broadcast = () => {};
  await m._handleExecIntent({ ...SEAT }, 'x', '{"ctx":"ios","verb":"get"}');
  assert.deepStrictEqual(calls, []);
  assert.match(replies[0], /inProcess must be "ctl"/);
});
