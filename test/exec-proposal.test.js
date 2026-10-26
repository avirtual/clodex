'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mk } = require('./lib/session-fixtures');
const { isFilenameToken, parseAndValidate, clampReplyBody } = require('../exec-schema');
const { mkTmpRoot } = require('./lib/tmp-roots');

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

function harness({ remote = null, def } = {}) {
  const REGISTRY_DIR = mkTmpRoot('clx-exec-proposal-');
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(execDir, 'avh-form.json'), JSON.stringify(def || {
    proposal: true, description: 'fill the form',
    schema: { type: 'object', additionalProperties: false, required: ['verb'], properties: { verb: { type: 'string' } } },
  }));
  const spawned = [];
  const m = mk({
    log: QUIET, isFilenameToken, fs, path, os, REGISTRY_DIR, clampReplyBody, parseAndValidate,
    resolveTeam: () => null,
    getRemoteServer: () => remote,
    getPersistence: () => ({ list: () => [], get: () => ({ name: 'a', execCommands: ['avh-form'] }) }),
    childProcess: { spawn: (...args) => { spawned.push(args); throw new Error('spawn must not be reached'); } },
  });
  const injected = [];
  const bcast = [];
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = (ch, msg) => bcast.push(msg);
  const session = { name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: '/tmp' };
  return { m, session, spawned, injected, bcast };
}

test('a granted proposal def notifies the game, tells the seat, and never spawns', async () => {
  const proposals = [];
  const turns = [];
  const remote = { notifyProposal: (n, p) => proposals.push([n, p]), notifyTurn: (n, t) => turns.push(t) };
  const h = harness({ remote });
  await h.m._handleExecIntent(h.session, 'avh-form', '{"verb":"standings"}');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(h.spawned, []);
  assert.strictEqual(proposals.length, 1, 'ENTER: one proposal emitted');
  const [name, p] = proposals[0];
  assert.strictEqual(name, 'a');
  assert.match(p.id, /^p-[0-9a-f]{12}$/);
  assert.deepStrictEqual(p, { cmd: 'avh-form', id: p.id, payload: { verb: 'standings' } });
  assert.deepStrictEqual(h.injected, [`[agent:exec] avh-form: proposed #${p.id} — the player confirms in the game`]);
  assert.deepStrictEqual(h.bcast, [{ type: 'exec', from: 'a', to: 'avh-form', body: `proposal #${p.id}` }]);
  h.m._assistantPolicy = () => true;
  h.m._resolveTurnWaiters(h.session, { text: 'done' });
  assert.deepStrictEqual(turns.map((t) => t.proposals), [[{ cmd: 'avh-form', id: p.id, payload: { verb: 'standings' } }]]);
  h.m._resolveTurnWaiters(h.session, { text: 'again' });
  assert.deepStrictEqual(turns[1].proposals, [], 'the turn after drops the answered proposal');
});

test('a proposal def with no remote server is refused and never spawns', async () => {
  const h = harness({ remote: null });
  await h.m._handleExecIntent(h.session, 'avh-form', '{"verb":"feed"}');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(h.spawned, []);
  assert.deepStrictEqual(h.injected, ['[agent:exec] avh-form: no game client can receive a proposal (phone access is off)']);
  assert.strictEqual(h.session._turnProposals, undefined);
});

test('a proposal payload failing its schema is a schema error, not a proposal', async () => {
  const proposals = [];
  const h = harness({ remote: { notifyProposal: (n, p) => proposals.push(p) } });
  await h.m._handleExecIntent(h.session, 'avh-form', '{"nope":1}');
  assert.deepStrictEqual(proposals, []);
  assert.strictEqual(h.injected.length, 1);
  assert.match(h.injected[0], /^\[agent:exec\] avh-form: /);
});
