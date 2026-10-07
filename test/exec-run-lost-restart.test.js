'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createSessionManager } = require('../session-manager');
const { isFilenameToken, parseAndValidate } = require('../exec-schema');
const { mkTmpRoot } = require('./lib/tmp-roots');

const LEDGER = 'exec-runs-inflight.json';

const LONG = {
  argv: ['/bin/sh', '/s.sh'],
  timeoutMs: 420000,
  replyStderr: true,
  schema: { type: 'object', additionalProperties: false },
};

const settle = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

function harness({ ledger, persisted = ['a'] } = {}) {
  const REGISTRY_DIR = mkTmpRoot('clx-lostrun-');
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(execDir, 'digest.json'), JSON.stringify(LONG));
  if (ledger !== undefined) fs.writeFileSync(path.join(REGISTRY_DIR, LEDGER), JSON.stringify(ledger));

  const children = [];
  const warns = [];
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR,
    isFilenameToken,
    parseAndValidate,
    resolveTeam: () => ({ name: 't', root: '/proj/alpha' }),
    os,
    fs,
    path,
    log: { warn(tag, msg) { warns.push(msg); }, info() {}, error() {}, debug() {} },
    getPersistence: () => ({
      list: () => [],
      get: (n) => (persisted.includes(n) ? { execCommands: ['digest'] } : undefined),
    }),
    childProcess: {
      spawn: () => {
        const ee = new EventEmitter();
        ee.pid = 4242;
        ee.stdin = { write() {}, end() {} };
        ee.stderr = new EventEmitter();
        ee.kill = () => {};
        children.push(ee);
        return ee;
      },
    },
  });
  const m = new SessionManager();
  const replies = [];
  m._injectText = (s, t) => replies.push({ to: s.name, text: t });
  m._broadcast = () => {};
  const session = { name: 'a', agentType: 'claude', cwd: '/proj/alpha' };
  m.sessions.set('a', session);
  const readLedger = () => JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, LEDGER), 'utf-8'));
  const cleanup = () => fs.rmSync(REGISTRY_DIR, { recursive: true, force: true });
  return { m, session, replies, children, warns, readLedger, cleanup };
}

const DEAD_RUN = { name: 'a', seq: 3, cmd: 'digest', pid: 2147483000, startedAt: 1000 };

test('a live tracked run is written to the ledger and leaves it when it ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, children, readLedger, cleanup } = harness();
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await settle();
    assert.deepStrictEqual(readLedger().map((r) => [r.name, r.seq, r.cmd]), [['a', 1, 'digest']]);
    assert.deepStrictEqual(m.inFlightExecRuns(), ['a run #1 (digest)']);
    children[0].emit('exit', 0, null);
    children[0].emit('close', 0, null);
    assert.deepStrictEqual(readLedger(), []);
    assert.deepStrictEqual(m.inFlightExecRuns(), []);
  } finally { cleanup(); }
});

test('boot: a run the ledger records as running comes back to its seat once as lost, and status shows none running', async () => {
  const { m, session, replies, readLedger, cleanup } = harness({ ledger: [DEAD_RUN] });
  try {
    assert.strictEqual(m.deliverLostExecRuns(), 1);
    const lines = replies.filter((r) => r.text.startsWith('[agent:exec]'));
    assert.deepStrictEqual(lines, [
      { to: 'a', text: '[agent:exec] run #3 (digest) lost to a host restart; re-emit it' },
    ]);
    assert.deepStrictEqual(readLedger(), []);

    assert.strictEqual(m.deliverLostExecRuns(), 0);
    assert.strictEqual(replies.length, 1, 'a second boot pass re-delivers nothing');

    m._handleExecIntent(session, 'status', '{}');
    const status = replies.at(-1).text;
    assert.ok(status.startsWith('[agent:exec] status: run #3 digest lost'), status);
    assert.ok(!/running/.test(status.replace(/a running run reports/, '')), status);
    assert.deepStrictEqual(m.inFlightExecRuns(), []);
  } finally { cleanup(); }
});

test('boot: the next run on that seat does not reuse the lost run number', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, replies, cleanup } = harness({ ledger: [DEAD_RUN] });
  try {
    m.deliverLostExecRuns();
    m._handleExecIntent(session, 'digest', '{}');
    await settle();
    assert.ok(replies.some((r) => /started \(run #4,/.test(r.text)), JSON.stringify(replies));
  } finally { cleanup(); }
});

test('boot: a run started before delivery does not overwrite the lost record in the ledger', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, readLedger, cleanup } = harness({ ledger: [{ ...DEAD_RUN, name: 'b' }], persisted: ['a', 'b'] });
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await settle();
    assert.deepStrictEqual(readLedger().map((r) => [r.name, r.seq]), [['b', 3], ['a', 1]]);
    assert.strictEqual(m.deliverLostExecRuns(), 0, 'b is persisted but not live yet — kept for a later pass');
    assert.deepStrictEqual(readLedger().map((r) => [r.name, r.seq]), [['b', 3], ['a', 1]]);
  } finally { cleanup(); }
});

test('boot: a lost run whose seat was deleted is dropped without a delivery', () => {
  const { m, replies, readLedger, cleanup } = harness({ ledger: [{ ...DEAD_RUN, name: 'gone' }] });
  try {
    assert.strictEqual(m.deliverLostExecRuns(), 0);
    assert.deepStrictEqual(replies, []);
    assert.deepStrictEqual(readLedger(), []);
  } finally { cleanup(); }
});

test('boot: no ledger, or an empty one, delivers nothing', () => {
  for (const ledger of [undefined, []]) {
    const { m, replies, cleanup } = harness({ ledger });
    try {
      assert.strictEqual(m.deliverLostExecRuns(), 0);
      assert.deepStrictEqual(replies, []);
    } finally { cleanup(); }
  }
});
