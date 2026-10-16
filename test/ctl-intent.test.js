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
const ADMIN_DEF = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'library', 'exec', 'clodex-ctl-admin.json'), 'utf-8'));
const { refuse: ctlServiceRefuse, ALLOWED: CTL_SERVICE_ALLOWED } = require('../ctl-service');

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
  ['delete node', 'delete --force node ios'],
  ['delete node', 'delete -o json --force node ios'],
  ['delete node', 'delete node/ios --force'],
  ['create node', 'create node ios --tunnel sh -c x {port}:1'],
  ['create node', 'create -o json node ios --url http://x'],
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

test('the seats tier cannot create a node through the exec path', async () => {
  const REGISTRY_DIR = mkTmpRoot('clx-ctl-exec-');
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  const def = { ...SEATS_DEF, schema: { ...SEATS_DEF.schema, properties: { ...SEATS_DEF.schema.properties, ctx: { type: 'string', enum: ['ios'] } } } };
  fs.writeFileSync(path.join(execDir, 'clodex-ctl-seats.json'), JSON.stringify(def));
  const { calls, svc } = fakeCtl();
  const m = mk({
    REGISTRY_DIR,
    getCtlService: () => svc,
    parseAndValidate,
    resolveTeam: () => null,
    getPersistence: () => ({ list: () => [], get: () => ({ name: 'a', execCommands: ['clodex-ctl-seats'] }) }),
  });
  const replies = [];
  m._injectText = (_s, text) => replies.push(text);
  m._broadcast = () => {};
  await m._handleExecIntent({ ...SEAT }, 'clodex-ctl-seats', JSON.stringify({ ctx: 'ios', verb: 'create', args: "node ios --tunnel sh -c 'touch /tmp/x' {port}:7900" }));
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(replies, ['[agent:exec] clodex-ctl-seats: ctl: create node is operator-only']);
});

test('ctl refuses --import and a session line carrying --tunnel', async () => {
  for (const [line, want] of [['create node ios --import --force', 'ctl: create node is operator-only'], ['get sessions --tunnel sh -c x', 'ctl: --tunnel is fixed by the context and cannot be set']]) {
    const { calls, svc } = fakeCtl();
    const m = mk({ getCtlService: () => svc });
    const replies = [];
    await m._handleCtlIntent({ ...SEAT }, { ctx: 'ios', line }, (t) => replies.push(t));
    assert.deepStrictEqual(calls, [], line);
    assert.deepStrictEqual(replies, [want]);
  }
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

test('both ctl exec entries list help first and no bare nodes verb', () => {
  for (const def of [READ_DEF, SEATS_DEF]) {
    const verbs = def.schema.properties.verb.enum;
    assert.strictEqual(verbs[0], 'help');
    assert.strictEqual(verbs.includes('nodes'), false);
    assert.ok(def.description.length <= 200);
  }
});

test('a help payload through the ctl exec entry reaches the ctl service as help <verb>', async () => {
  const REGISTRY_DIR = mkTmpRoot('clx-ctl-exec-');
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  const def = { ...READ_DEF, schema: { ...READ_DEF.schema, properties: { ...READ_DEF.schema.properties, ctx: { type: 'string', enum: ['ios'] } } } };
  fs.writeFileSync(path.join(execDir, 'clodex-ctl-read.json'), JSON.stringify(def));
  const { calls, svc } = fakeCtl({ output: 'usage: get <resource>', exitCode: 0 });
  const m = mk({
    REGISTRY_DIR,
    getCtlService: () => svc,
    clampReplyBody,
    parseAndValidate,
    resolveTeam: () => null,
    getPersistence: () => ({ list: () => [], get: () => ({ name: 'a', execCommands: ['clodex-ctl-read'] }) }),
  });
  const replies = [];
  m._injectText = (_s, text) => replies.push(text);
  m._broadcast = () => {};
  await m._handleExecIntent({ ...SEAT }, 'clodex-ctl-read', JSON.stringify({ ctx: 'ios', verb: 'help', args: 'get' }));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(calls, ['--ctx ios help get']);
  assert.deepStrictEqual(replies, ['[agent:exec] clodex-ctl-read: [ctl ios exit 0] usage: get <resource>']);
});

test('the admin entry is an argv launcher with the shipped verb envelope and a short timeout', () => {
  assert.deepStrictEqual(validateExecDef(ADMIN_DEF, 'clodex-ctl-admin'), { ok: true });
  assert.strictEqual('inProcess' in ADMIN_DEF, false);
  assert.deepStrictEqual(ADMIN_DEF.argv, ['/usr/bin/env', 'node', '${CLODEX_BIN}/clodex-ctl-admin.js']);
  assert.deepStrictEqual(ADMIN_DEF.schema.properties.verb.enum, ['help', 'deploy', 'upgrade', 'restart']);
  assert.deepStrictEqual(ADMIN_DEF.schema.properties.ctx.enum, []);
  assert.strictEqual(ADMIN_DEF.timeoutMs, 15000);
  assert.ok(ADMIN_DEF.timeoutMs < 60000, 'timeoutMs must stay below EXEC_ACK_MIN_TIMEOUT_MS (60000) or the launcher is tracked as a long run');
  assert.strictEqual(ADMIN_DEF.replyStderr, true);
  assert.strictEqual(ADMIN_DEF.replyMaxBytes, 12000);
  assert.ok(ADMIN_DEF.description.length <= 200);
  assert.match(ADMIN_DEF.description, /enum/);
});

test('the admin entry: an empty enum names itself; the verb dial is the schema alone', () => {
  assert.deepStrictEqual(parseAndValidate(ADMIN_DEF, '{"ctx":"ios","verb":"help"}'), {
    ok: false,
    error: "payload.ctx: the enum is empty — no value is allowed until the operator lists one in the entry's schema",
  });
  const withCtx = (def) => ({ ...def, schema: { ...def.schema, properties: { ...def.schema.properties, ctx: { type: 'string', enum: ['ios'] } } } });
  const filled = withCtx(ADMIN_DEF);
  assert.strictEqual(parseAndValidate(filled, '{"ctx":"ios","verb":"deploy"}').ok, true);
  assert.strictEqual(parseAndValidate(filled, '{"ctx":"ios","verb":"undeploy"}').ok, false);
  assert.strictEqual(parseAndValidate(filled, '{"ctx":"ios","verb":"delete","args":"session w"}').ok, false);
  const dialed = { ...filled, schema: { ...filled.schema, properties: { ...filled.schema.properties, verb: { type: 'string', enum: ['help', 'deploy', 'upgrade', 'restart', 'undeploy'] } } } };
  assert.strictEqual(parseAndValidate(dialed, '{"ctx":"ios","verb":"undeploy"}').ok, true);
});

test('the in-process ctl path still refuses deploy, undeploy and upgrade', () => {
  const rows = OPERATOR_ONLY.map(([verb]) => verb);
  for (const verb of ['deploy', 'undeploy', 'upgrade']) assert.ok(rows.includes(verb), `ENTER: OPERATOR_ONLY still has the ${verb} row`);
  for (const verb of ['deploy', 'upgrade']) {
    assert.match(ctlServiceRefuse([verb, 'node', 'x']) || '', new RegExp(`^refused: "${verb}" is not available in the ctl tab`));
  }
  for (const verb of ['deploy', 'upgrade', 'undeploy']) assert.strictEqual(Object.hasOwn(CTL_SERVICE_ALLOWED, verb), false, verb);
});

test('the docs and the changelog name the admin tier', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8');
  const tools = read('docs/exec-tools.md');
  assert.match(tools, /\| `clodex-ctl-admin` \|/);
  assert.match(tools, /### The admin tier/);
  const readme = read('cli/README.md');
  assert.match(readme, /clodex-ctl-admin/);
  assert.doesNotMatch(readme, /Deploy, undeploy, upgrade, input, exec,\s*port-forward and attach stay operator-only/);
  const changelog = read('CHANGELOG.md');
  const head = changelog.indexOf('\n## Unreleased\n');
  assert.notStrictEqual(head, -1, 'ENTER: the changelog has an Unreleased section');
  const unreleased = changelog.slice(head, changelog.indexOf('\n## ', head + 1));
  assert.match(unreleased, /clodex-ctl-admin/);
});

test('restoreSessionsForWorkspace arms the ctl-admin boot sweep once, under the app interpreter and the registry root', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf-8');
  const start = src.indexOf('async function restoreSessionsForWorkspace(');
  assert.notStrictEqual(start, -1);
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(src, /^let ctlAdminSweepArmed = false;$/m);
  assert.match(body, /if \(!ctlAdminSweepArmed\) \{\s*ctlAdminSweepArmed = true;/);
  assert.match(body, /spawn\(process\.execPath, \[path\.join\(REGISTRY_DIR, 'bin', 'clodex-ctl-admin\.js'\), '--sweep'\]/);
  assert.match(body, /ELECTRON_RUN_AS_NODE: '1', CLODEX_HOME: REGISTRY_DIR/);
});
