// A seat can ASK what its exec runs are doing.
//
// t831 gave a long run an ack, a tick and a stamped result. None of that helps a
// seat that came back from a compact, or lost the ack in a spill: the question
// "is run #3 alive, did it fail, what did it say?" still had no answer, so the
// seat polled the filesystem. `[agent:exec status] {}` is that answer, read from
// the records t831 already keeps — it runs nothing, so it needs no grant, and it
// wins over any registry def of the same name.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createSessionManager } = require('../session-manager');
const { isFilenameToken, parseAndValidate } = require('../exec-schema');

const settle = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

function harness({ grants = ['digest'], defs = { digest: LONG } } = {}) {
  const REGISTRY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-statusq-'));
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  for (const [name, entry] of Object.entries(defs)) {
    fs.writeFileSync(path.join(execDir, `${name}.json`), JSON.stringify(entry));
  }

  const children = [];
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR,
    isFilenameToken,
    parseAndValidate,
    resolveTeam: () => ({ name: 't', root: '/proj/alpha' }),
    os,
    fs,
    path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ list: () => [], get: () => ({ execCommands: grants }) }),
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
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = () => {};
  const session = { name: 'a', agentType: 'claude', cwd: '/proj/alpha' };
  const cleanup = () => fs.rmSync(REGISTRY_DIR, { recursive: true, force: true });
  return { m, session, replies, children, cleanup };
}

const LONG = {
  argv: ['/bin/sh', '/s.sh'],
  timeoutMs: 420000,
  replyStderr: true,
  schema: { type: 'object', additionalProperties: false },
};

const CLOSING = 'Do not poll; a running run reports every few minutes and delivers its result as input.';

const statusOf = (replies) => replies.filter((r) => r.startsWith('[agent:exec] status')).at(-1);

test('a seat with no runs is told so, and the query spawns nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, replies, children, cleanup } = harness();
  try {
    m._handleExecIntent(session, 'status', '{}');
    await settle();

    // ENTER: the empty answer is the one a fresh seat gets, and it must be an
    // ANSWER — falling through to "no such registered command" reads as a broken
    // grant and sends the seat back to the filesystem it was told not to poll.
    assert.deepStrictEqual(replies, ['[agent:exec] status: no exec runs on this seat yet.']);
    assert.strictEqual(children.length, 0, 'a query that runs something is not a query');
  } finally { cleanup(); }
});

test('status names a live run and a finished one, newest first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, replies, children, cleanup } = harness();
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await settle();
    t.mock.timers.tick(60000);
    children[0].stderr.emit('data', '811/811 green\n');
    children[0].emit('exit', 0, null);

    m._handleExecIntent(session, 'digest', '{}');
    await settle();
    t.mock.timers.tick(200000);

    m._handleExecIntent(session, 'status', '{}');
    await settle();

    // ENTER: both halves of the seat's question in one line — the live run's
    // elapsed time (is it alive?) and the finished run's own result string (what
    // did it say?). Newest first because the run being asked about is the one
    // just fired; oldest-first buries it behind history.
    assert.strictEqual(statusOf(replies),
      '[agent:exec] status: run #2 digest running 3m 20s so far, ceiling 7m; '
      + `run #1 digest ok at 1m 00s: run #1 811/811 green ${CLOSING}`);
  } finally { cleanup(); }
});

test('a seq payload narrows to that run, and says so when it is absent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, replies, children, cleanup } = harness();
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await settle();
    t.mock.timers.tick(60000);
    children[0].stderr.emit('data', '811/811 green\n');
    children[0].emit('exit', 0, null);
    m._handleExecIntent(session, 'digest', '{}');
    await settle();

    m._handleExecIntent(session, 'status', '{"seq": 1}');
    await settle();
    const one = statusOf(replies);
    // ENTER: narrowing must DROP the other run, not merely mention the asked-for
    // one — the seat asks by seq precisely when the general reply was too big to
    // read or its run had aged out of the newest three.
    assert.ok(one.includes('run #1 digest ok'), one);
    assert.ok(!one.includes('run #2'), `run #2 must not be in a seq-1 reply: ${one}`);

    m._handleExecIntent(session, 'status', '{"seq": 9}');
    await settle();
    assert.strictEqual(statusOf(replies), '[agent:exec] status: no run #9 on this seat.');
  } finally { cleanup(); }
});

test('status needs no grant — an empty grant list still gets the answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, replies, cleanup } = harness({ grants: [] });
  try {
    m._handleExecIntent(session, 'status', '{}');
    await settle();

    // ENTER: the seat most likely to be lost about its runs is the one with the
    // fewest grants, and asking what YOUR OWN session already recorded spawns
    // nothing — there is no capability here to withhold.
    assert.strictEqual(statusOf(replies), '[agent:exec] status: no exec runs on this seat yet.');
    assert.ok(!replies.some((r) => r.includes('not granted')), JSON.stringify(replies));
  } finally { cleanup(); }
});

test('a registry def named status is shadowed, never spawned', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, replies, children, cleanup } = harness({
    grants: ['digest', 'status'],
    defs: { digest: LONG, status: { ...LONG, argv: ['/bin/sh', '/evil.sh'] } },
  });
  try {
    m._handleExecIntent(session, 'status', '{}');
    await settle();

    // ENTER: the reserved name is checked BEFORE the registry, so a def called
    // `status` — granted by an operator who never heard of this query — cannot
    // take the verb over and run its own argv in its place.
    assert.strictEqual(children.length, 0, 'the def must not have been spawned');
    assert.strictEqual(statusOf(replies), '[agent:exec] status: no exec runs on this seat yet.');
  } finally { cleanup(); }
});

test('the reply stays inside 400 chars, cutting tails and never heads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, replies, children, cleanup } = harness();
  try {
    for (let i = 0; i < 3; i++) {
      m._handleExecIntent(session, 'digest', '{}');
      await settle();
      t.mock.timers.tick(1000);
      children[i].stderr.emit('data', `${'x'.repeat(190)}\n`);
      children[i].emit('exit', 0, null);
    }

    m._handleExecIntent(session, 'status', '{}');
    await settle();
    const line = statusOf(replies);

    // ENTER: three 190-char tails is 570 bytes of result text alone. Unclamped
    // this reply is bigger than the ack, the tick and the digest combined — a
    // query that costs more than the polling it replaces is not worth emitting.
    assert.ok(line.length <= '[agent:exec] '.length + 400, `got ${line.length}: ${line}`);
    assert.ok(line.endsWith(CLOSING), 'the instruction survives the cut');
    for (const seq of [3, 2, 1]) {
      assert.ok(line.includes(`run #${seq} digest ok at 0m 0`), `head for run #${seq} kept: ${line}`);
    }
  } finally { cleanup(); }
});
