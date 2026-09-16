'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');

const { createRemoteWiring } = require('../remote-wiring');
const { mkPark } = require('./lib/session-fixtures');

const NO_REPLY = '(no reply path)';

function wireDoors({ seatIntents = undefined } = {}) {
  const { m, injected } = mkPark({
    getPeerManager: () => null,
    shouldHoldDm: require('../proxy-util').shouldHoldDm,
    MSG_SPILL_THRESHOLD: 500,
    spillToFile: (sender, body, recipient) => `/tmp/spill-${recipient}-${sender}-${body.length}.txt`,
    // undefined = every intent enabled, which is what the default fixture entry
    // (`get: () => null`) already means; [] gates the receiving seat's dm off.
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'seat' ? { intents: seatIntents } : null) }),
  });
  let srv = null;
  const deps = {
    path,
    fs: require('fs'),
    os,
    log: { info() {}, warn() {}, error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: '/tmp/reg',
    OUTBOX_DIR: '/tmp/outbox',
    SELF_LABEL: 'testbox',
    parseCtxFile: () => null,
    cachedMessages: () => [],
    sliceSince: () => ({ messages: [] }),
    ensureDir: () => {},
    homeRelativize: (x) => x,
    claimOutbox: () => [],
    listOutboxOrigins: () => [],
    manager: m,
    proxyPoller: { snapshot: () => null },
    loadManifest: () => { throw new Error('no teams here'); },
    restartClodex: () => {},
    restartSession: () => {},
    peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }),
    applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }),
    applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {},
    fetchProxyReport: () => {},
    fetchProxyBust: () => {},
    fetchSessionFiles: () => {},
    fetchFilePeek: () => {},
    fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash', 'Read'],
    getPromptLibrary: () => ({ list: () => [] }),
    getAgentLibrary: () => ({ list: () => [] }),
    getSkillLibrary: () => ({ list: () => [] }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    getUiSettings: () => ({ get: () => ({ remoteEnabled: true, remotePort: 0 }) }),
    getWorkspaces: () => ({ get: () => ({}) }),
    getNotifications: () => null,
    getRemoteServer: () => srv,
    setRemoteServer: (v) => { srv = v; },
    setRemoteError: () => {},
    getDrawerPtys: () => null,
    readRemoteEnvToken: () => null,
    resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9',
    isPackaged: () => false,
    getWebInfo: () => null,
    getWirescopeInfo: () => null,
  };

  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  try {
    createRemoteWiring(deps).syncRemoteServer();
  } finally {
    remoteMod.RemoteServer = orig;
  }

  m.sessions.set('seat', { name: 'seat', agentType: 'claude', activityState: 'idle', activityTs: Date.now() });
  return { m, injected, send: opts.send, deliverDm: opts.deliverDm };
}

test('t886: the operator door (/api/send) delivers the canonical [agent:from user] shape', () => {
  const { injected, send } = wireDoors();
  const out = send('seat', 'ship it');
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(injected.length, 1, 'exactly one delivery reached the seat');
  assert.strictEqual(injected[0], '[agent:from user] ship it',
    'the operator door produces the canonical shape, and nothing else rides it');
});

test('t886: an operator delivery contains no [agent:dm substring anywhere', () => {
  const { m, injected, send } = wireDoors();
  m.sessions.set('user', { name: 'user', agentType: 'claude', activityState: 'idle', activityTs: Date.now() });
  assert.strictEqual(m._isDmReachable('user'), true,
    'ENTER: `user` is dm-reachable, so the trailer is suppressed by the guard under test '
    + 'rather than by an unreachable sender — without this the absence below is vacuous');
  send('seat', 'ship it');
  assert.strictEqual(injected.at(-1).includes('[agent:dm'), false,
    'a human has no dm address: an advertised one is a hole that silently discards the reply');
  assert.strictEqual(injected.at(-1).includes(NO_REPLY), false,
    'and no no-reply marker either: `user` is a system sender, not a correspondent that failed');
});

test('t886/t936: the peer-agent door (/api/dm) delivers a reachable peer bare — no trailer, no marker', () => {
  const { injected, deliverDm } = wireDoors();
  const out = deliverDm({ to: 'seat', from: 'bob', origin: 'peerbox', body: 'hi' });
  assert.deepStrictEqual(out, { ok: true, delivered: true });
  assert.strictEqual(injected.at(-1), '[agent:from bob@peerbox] hi',
    'an answerable peer dm costs zero bytes beyond the prefix');
});

test('t886/t936: a GATED receiver on the agent path IS marked — the operator-path silence is measured', () => {
  // The ENTER the old byte-pin provided: without a case where the agent door DOES
  // emit the marker, `user` producing none above is indistinguishable from a
  // marker the suite stopped producing anywhere. Same door, same sender shape —
  // only the receiver's dm gate differs.
  const { injected, deliverDm } = wireDoors({ seatIntents: [] });
  deliverDm({ to: 'seat', from: 'bob', origin: 'peerbox', body: 'hi' });
  assert.strictEqual(injected.at(-1), '[agent:from bob@peerbox] hi ' + NO_REPLY,
    'the seat cannot dm, so its reply would drop and the delivery says so');
});

test('t886: an operator delivery over the spill threshold keeps the shape and the silence', () => {
  const { m, injected, send } = wireDoors();
  m.sessions.set('user', { name: 'user', agentType: 'claude', activityState: 'idle', activityTs: Date.now() });
  send('seat', 'x'.repeat(4000));
  const text = injected.at(-1);
  assert.ok(text.startsWith('[agent:from user] Message ('),
    'the pointer line carries the same operator prefix');
  assert.strictEqual(text.includes('[agent:dm'), false,
    'the trailer rides the POINTER line, so a spilled operator message is where a suppression bug would surface');
});
