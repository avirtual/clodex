'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { pathFor } = require('../clodex-paths');
const { subqHookOutput } = require('../subq');

const ID = 'a606bb8c5bfa9764e';

function harness(extra = {}) {
  const root = mkTmpRoot('clodex-subq-');
  const injected = [];
  const broadcasts = [];
  const m = mk({ REGISTRY_DIR: root, path, pathFor, ...extra });
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = (ch, msg) => broadcasts.push({ ch, msg });
  const session = { name: 'seat', agentType: 'claude', workspaceId: 'ws1' };
  m.sessions.set('seat', session);
  const dir = path.join(path.dirname(pathFor(root, 'seat', 'intentSocket')), 'subq');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ID}.nonce`), 'feedfacecafebeef');
  const send = (target, body) => m._handleIntent('seat', { type: 'sub', target, body });
  return { m, dir, session, injected, broadcasts, send };
}

const bounceText = (t) => `[agent:sub] NOT delivered: no running subagent "${t}" on this seat (the name you gave the Agent tool, or its result's agent_id; a name is known only once the Agent tool has returned).`;

test('t1678 sub by id appends to subq/<id> 0600, in order, and broadcasts seat/id', async () => {
  const h = harness();
  await h.send(ID, 'first');
  await h.send(ID, 'second');
  const q = path.join(h.dir, ID);
  assert.strictEqual(fs.readFileSync(q, 'utf8'), 'first\nsecond\n');
  assert.strictEqual(fs.statSync(q).mode & 0o777, 0o600);
  assert.deepStrictEqual(h.injected, []);
  const ipc = h.broadcasts.filter((b) => b.ch === 'ipc-message').map((b) => b.msg);
  assert.deepStrictEqual(ipc[0], { type: 'sub', from: 'seat', to: `seat/${ID}`, body: 'first' });
  assert.ok(!JSON.stringify(ipc).includes('feedfacecafebeef'));
  const out = JSON.parse(subqHookOutput(JSON.stringify({ agent_id: ID, hook_event_name: 'PostToolUse' }), { dir: h.dir }));
  assert.strictEqual(out.hookSpecificOutput.additionalContext, '[parent feedfacecafebeef] first\nsecond');
});

test('t1678 sub by name resolves through subq/names/<name>', async () => {
  const h = harness();
  fs.mkdirSync(path.join(h.dir, 'names'));
  fs.writeFileSync(path.join(h.dir, 'names', 'subq-live'), ID);
  await h.send('subq-live', 'hi');
  assert.strictEqual(fs.readFileSync(path.join(h.dir, ID), 'utf8'), 'hi\n');
});

for (const [label, target, setup] of [
  ['unknown target', 'nobody', () => {}],
  ['path-escaping target', '../x', () => {}],
  ['federated target', `${ID}@peer`, () => {}],
  ['name whose id has no nonce', 'ghost', (dir) => {
    fs.mkdirSync(path.join(dir, 'names'));
    fs.writeFileSync(path.join(dir, 'names', 'ghost'), 'a0000000000000000');
  }],
]) {
  test(`t1678 sub bounce: ${label}`, async () => {
    const h = harness();
    setup(h.dir);
    const before = fs.readdirSync(path.dirname(h.dir)).concat(fs.readdirSync(h.dir)).sort();
    await h.send(target, 'payload');
    assert.deepStrictEqual(h.injected, [bounceText(target)]);
    const ipc = h.broadcasts.find((b) => b.ch === 'ipc-message').msg;
    assert.deepStrictEqual(ipc, { type: 'sub', from: 'seat', to: target, body: 'UNDELIVERED (no such subagent): payload' });
    assert.deepStrictEqual(fs.readdirSync(path.dirname(h.dir)).concat(fs.readdirSync(h.dir)).sort(), before);
  });
}

test('t1678 _coldRespawn removes subq/ before the new process is created', async () => {
  const h = harness({
    stripLevelOf: () => 0,
    getPersistence: () => ({ list: () => [], get: () => null, upsert() {}, setStripLevel() {} }),
  });
  fs.writeFileSync(path.join(h.dir, ID), 'queued\n');
  let existedAtCreate = null;
  h.m.sessions.delete('seat');
  h.m._preserveAcrossRestart = () => {};
  h.m.resumeCwdOf = () => '/tmp';
  h.m._sendToSession = () => {};
  const created = new Promise((resolve) => {
    h.m.create = async () => { existedAtCreate = fs.existsSync(h.dir); resolve(); };
  });
  assert.strictEqual(h.m._coldRespawn('seat', { type: 'claude' }, h.session, '', 'reload'), true);
  await created;
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(existedAtCreate, false);
});

test('t1678 a denied sub body is spilled like a dm', () => {
  const { deniedBodyDisposition } = require('../session-manager');
  assert.deepStrictEqual(deniedBodyDisposition({ type: 'sub', body: 'x' }), { how: 'spill', label: 'sub' });
});

test('t1678 the sub grammar line renders only for a seat granted sub', () => {
  const { buildIpcPrompt, IPC_PROMPT } = require('../ipc-prompt');
  assert.ok(!buildIpcPrompt(['dm']).includes('[agent:sub'));
  assert.ok(buildIpcPrompt(['sub']).includes('[agent:sub TARGET] body'));
  assert.ok(IPC_PROMPT.includes('[agent:sub TARGET] body'));
});
