// A long exec run tells the seat it started, then reports elapsed time until it
// ends.
//
// The bug this pins is a SILENCE. A seat emits `[agent:exec clodex-run-tests] {}`,
// the suite takes 5-9 minutes, and nothing at all is injected until the digest
// lands. A hand cannot tell a live run from a dead one, so it polls — one ran
// `git status | wc -l` ~300 times waiting, and every poll re-bills its whole
// context. The dispatcher knows the pid, the ceiling and the elapsed time the
// entire time; it just never said.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createSessionManager } = require('../session-manager');
const { isFilenameToken, parseAndValidate, validateExecDef } = require('../exec-schema');

// The dispatcher spawns on setImmediate, and the spawn itself is preceded by one
// more hop; two flushes is what the sibling exec tests settled on. setImmediate
// is NOT among the mocked timer apis, so this still drains under mock.timers.
const settle = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

function harness(entry, { cwd = '/proj/alpha' } = {}) {
  const REGISTRY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-runstatus-'));
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(execDir, 'digest.json'), JSON.stringify(entry));

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
    getPersistence: () => ({ list: () => [], get: () => ({ execCommands: ['digest'] }) }),
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
  const session = { name: 'a', agentType: 'claude', cwd };
  const cleanup = () => fs.rmSync(REGISTRY_DIR, { recursive: true, force: true });
  return { m, session, replies, children, cleanup };
}

const LONG = {
  argv: ['/bin/sh', '/s.sh'],
  timeoutMs: 420000,
  replyStderr: true,
  schema: { type: 'object', additionalProperties: false },
};
const SHORT = { ...LONG, timeoutMs: 10000 };

test('a long run acknowledges its start with the run number, pid and ceiling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, replies, cleanup } = harness(LONG);
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await settle();

    // ENTER: without this line the seat has NOTHING between the intent and the
    // digest minutes later, which is the silence that makes it poll.
    assert.strictEqual(replies.length, 1, `exactly the ack, got ${JSON.stringify(replies)}`);
    const ack = replies[0];
    assert.match(ack, /^\[agent:exec\] digest: started \(run #1, pid 4242, ceiling 7m\)\./,
      'the ack names the run, the pid and the ceiling in minutes');
    assert.match(ack, /END YOUR TURN/, 'and tells the seat what to do instead of polling');
    assert.match(ack, /every 3m/, 'the default cadence is stated so the seat knows what to expect');
  } finally { cleanup(); }
});

test('status lines tick with rising elapsed time, and stop dead at exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, replies, children, cleanup } = harness(LONG);
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await settle();

    t.mock.timers.tick(180000);
    t.mock.timers.tick(180000);
    const status = replies.filter((r) => r.includes('still running'));
    // ENTER: two ticks must yield two DIFFERENT elapsed readings — a status line
    // that always says the same thing cannot distinguish a live run from a wedged
    // one, which is the whole question the seat is asking.
    assert.strictEqual(status.length, 2, `two ticks, two status lines, got ${status.length}`);
    assert.match(status[0], /still running — 3m 00s of a 7m ceiling \(run #1\)/);
    assert.match(status[1], /still running — 6m 00s of a 7m ceiling \(run #1\)/);

    children[0].emit('exit', 0, null);
    const after = replies.length;
    t.mock.timers.tick(180000);
    // ENTER: a status line landing AFTER the result would tell the seat its
    // finished run is still going — worse than no status at all.
    assert.strictEqual(replies.length, after,
      `no status after the result, got ${JSON.stringify(replies.slice(after))}`);
  } finally { cleanup(); }
});

test('the result line carries the run number, then the unchanged body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, replies, children, cleanup } = harness(LONG);
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await settle();
    children[0].stderr.emit('data', 'ignored line\n811/811 green\n');
    children[0].emit('exit', 0, null);

    // ENTER: the prefix is what lets a seat pair a digest with the ack it got
    // minutes earlier; the body after it must still be byte-for-byte the old one.
    assert.strictEqual(replies.at(-1), '[agent:exec] digest: run #1 811/811 green');
  } finally { cleanup(); }
});

test('a nonzero exit is stamped with the same run number through fail()', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, replies, children, cleanup } = harness(LONG);
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await settle();
    children[0].stderr.emit('data', 'boom: cannot start\n');
    children[0].emit('exit', 7, null);

    // ENTER: the failure path is the one a seat most needs to pair with its ack —
    // an unstamped error reads as belonging to whatever it fired last.
    assert.strictEqual(replies.at(-1), '[agent:exec] digest: run #1 exit 7: boom: cannot start');
  } finally { cleanup(); }
});

test('a short run stays silent — no ack, no status, whatever the def asks for', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, replies, cleanup } = harness({ ...SHORT, statusEveryMs: 30000 });
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await settle();
    // ENTER: a 10s `clodex-team roster` must not pay a two-line prompt tax to
    // report that it started. The floor is the ceiling, not the cadence: even an
    // explicit statusEveryMs buys nothing below it.
    assert.deepStrictEqual(replies, [], 'nothing at start');
    t.mock.timers.tick(9999);
    assert.deepStrictEqual(replies, [], 'and nothing on a tick inside the ceiling');
  } finally { cleanup(); }
});

test('session.execRuns records the run while it runs and after it ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, children, cleanup } = harness(LONG);
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await settle();

    // ENTER: 'running' with no endedAt is what a later status query reads to tell
    // a live run from a finished one; a record written only at exit answers the
    // question nobody asks.
    assert.strictEqual(session.execRuns.length, 1);
    assert.strictEqual(session.execRuns[0].seq, 1);
    assert.strictEqual(session.execRuns[0].cmd, 'digest');
    assert.strictEqual(session.execRuns[0].pid, 4242);
    assert.strictEqual(session.execRuns[0].state, 'running');
    assert.strictEqual(session.execRuns[0].endedAt, null);

    t.mock.timers.tick(60000);
    children[0].stderr.emit('data', '811/811 green\n');
    children[0].emit('exit', 0, null);

    assert.strictEqual(session.execRuns[0].state, 'ok');
    assert.strictEqual(session.execRuns[0].endedAt, 60000);
    assert.strictEqual(session.execRuns[0].tail, 'run #1 811/811 green',
      'the record carries the same string the seat was sent');
  } finally { cleanup(); }
});

test('the record array is capped, dropping the oldest run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, children, cleanup } = harness(LONG);
  try {
    for (let i = 0; i < 22; i++) {
      m._handleExecIntent(session, 'digest', '{}');
      await settle();
      children[i].emit('exit', 0, null);
    }
    // ENTER: unbounded, this array grows for the life of a long-lived seat —
    // a lead session runs the suite dozens of times a day.
    assert.strictEqual(session.execRuns.length, 20);
    assert.strictEqual(session.execRuns[0].seq, 3, 'the oldest two were dropped');
    assert.strictEqual(session.execRuns.at(-1).seq, 22, 'and the counter kept climbing');
  } finally { cleanup(); }
});

test('validateExecDef takes a sane statusEveryMs and refuses the rest', () => {
  const base = { argv: ['/bin/true'], schema: { type: 'object' } };
  assert.deepStrictEqual(validateExecDef({ ...base, statusEveryMs: 30000 }), { ok: true });
  // ENTER: the floor is the point — every status line is injected into the
  // caller's prompt, so a 1s cadence costs more than the polling it replaces.
  assert.match(validateExecDef({ ...base, statusEveryMs: 1000 }).error || '', /statusEveryMs/);
  assert.strictEqual(validateExecDef({ ...base, statusEveryMs: 1000 }).ok, false);
  assert.strictEqual(validateExecDef({ ...base, statusEveryMs: '3m' }).ok, false,
    'a duration string is authored as a typo, not honoured as a unit');
});
