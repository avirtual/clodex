'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { InjectQueue } = require('../inject-queue');
const { createSessionManager } = require('../session-manager');
const { isDraftOpen, isHumanPtyInput, draftChunkSignal } = require('../proxy-util');
const { parkDelivery, drainPending, hasActivePending, countPending } = require('../pending-store');
const { mkTmpRoot } = require('./lib/tmp-roots');

function boot() {
  const PENDING_DIR = mkTmpRoot('clodex-injbit-');
  const metas = [];
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    InjectQueue: class extends InjectQueue {
      constructor(o) {
        super({ ...o, onSubmitted: (t, meta) => { metas.push(meta); o.onSubmitted(t, meta); } });
      }
    },
    PENDING_DIR, parkDelivery, drainPending, hasActivePending, isDraftOpen,
    countPending, isHumanPtyInput, draftChunkSignal,
    getPersistence: () => ({ list: () => [], get: () => null }),
    intentEnabled: require('../intent-catalog').intentEnabled,
    MSG_SPILL_THRESHOLD: 1e9,
    INJECT_QUIET_MS: 0,
    INJECT_QUIET_MAXWAIT: 3_600_000,
    INJECT_BOOT_MAXWAIT: 0,
    INJECT_SPEAKING_STALE_MS: 0,
    INJECT_VOICE_DRAFT_STALE_MS: 0,
    SHORT_TEXT_DELAY: 0, LONG_TEXT_DELAY: 0, LONG_TEXT_THRESHOLD: 1e9,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    hintArm: { holding: () => false },
  });
  const m = new SessionManager();
  m._broadcast = () => {};
  const writes = [];
  const s = {
    name: 'hand', agentType: 'claude', _dead: false, _bootReadySeen: true,
    lastUserInputTs: 0, lastUserSubmitTs: 0,
    lastSubmitInjected: false,
    pty: { write: (b) => writes.push(b) },
  };
  m.sessions = new Map([['hand', s]]);
  return { m, s, writes, metas, PENDING_DIR };
}

function cleanup(h) {
  if (h.s._parkCapTimer) { clearTimeout(h.s._parkCapTimer); h.s._parkCapTimer = null; }
  try { fs.rmSync(h.PENDING_DIR, { recursive: true, force: true }); } catch {}
}

const settle = (h) => h.m._injectQueueFor(h.s)._chain;

test('the bit tracks the turn, not the request: [false, true, false]', async () => {
  const h = boot();
  const seq = [];
  const turnInjected = () => h.m.sessions.get('hand')?.lastSubmitInjected === true;

  seq.push(h.s.lastSubmitInjected);

  await h.m._injectQueueFor(h.s).enqueue('[agent:from lead] pick up t1026');
  seq.push(h.s.lastSubmitInjected);

  const perRequest = [turnInjected(), turnInjected()];

  h.m.write('hand', 'now do the other thing\r');
  seq.push(h.s.lastSubmitInjected);

  assert.deepStrictEqual(seq, [false, true, false],
    'fresh seat, then a dm Clodex delivered, then the operator typing and hitting Enter');
  assert.deepStrictEqual(perRequest, [true, true],
    'the closure proxy.js holds is read once per REQUEST, and a tool-call continuation is a '
    + 'second request inside the same turn: it passes through neither call site, so both reads '
    + 'see the dm that started the turn');
  cleanup(h);
});

test('an operator dm is a human turn: the bit is CLEARED, as a keystroke clears it', async () => {
  const h = boot();
  const seq = [h.s.lastSubmitInjected];

  h.m._deliverMessage('hand', 'user', 'hello', 'dm');
  await settle(h);
  seq.push(h.s.lastSubmitInjected);

  h.m._deliverMessage('hand', 'reviewer', 'nit 3 again', 'dm');
  await settle(h);
  seq.push(h.s.lastSubmitInjected);

  h.m._deliverMessage('hand', 'user', 'and one more thing', 'dm');
  await settle(h);
  seq.push(h.s.lastSubmitInjected);

  h.m.write('hand', 'typed\r');
  seq.push(h.s.lastSubmitInjected);

  assert.deepStrictEqual(seq, [false, false, true, false, false],
    'the operator sending from the panel or POST /api/sessions/:name/dm is the two of them '
    + 'TALKING — the same input as typing, so his own answer is never spilled to a pointer. A '
    + 'peer dm travels the same queue and stays injected');

  assert.deepStrictEqual(h.metas, [{ human: true }, { human: false }, { human: true }],
    'and the queue is told which it was at submit time, not guessed from the text');

  const delivered = h.writes.filter((b) => b !== '\x15' && b !== '\r');
  assert.ok(delivered[0].startsWith('[agent:from user]'),
    'ENTER: the operator keeps the sender prefix he always had — human-ness rides the queue '
    + 'option, not a rewritten envelope');
  assert.ok(delivered[1].startsWith('[agent:from reviewer]'));
  cleanup(h);
});

test('nothing but the operator clears the bit: a reminder stays injected', async () => {
  const h = boot();
  h.m._deliverMessage('hand', 'reminder', 'continue: t1027 tests', 'dm');
  await settle(h);
  assert.strictEqual(h.s.lastSubmitInjected, true,
    'a reminder, a ticket reply and an exec result are all Clodex speaking, not the operator');
  assert.deepStrictEqual(h.metas, [{ human: false }]);
  cleanup(h);
});

test('an injected unit sets the bit only once its Enter has gone out', async () => {
  const h = boot();
  const p = h.m._injectQueueFor(h.s).enqueue('a ticket body');
  assert.strictEqual(h.s.lastSubmitInjected, false,
    'enqueued is not submitted: the CLI has not been handed anything yet');
  await p;
  assert.strictEqual(h.s.lastSubmitInjected, true);
  assert.deepStrictEqual(h.writes, ['\x15', 'a ticket body', '\r'],
    'and the bytes are the ordinary unit — the hook adds none');
  cleanup(h);
});

test('an OPEN human draft does not clear the bit; only the submit does', async () => {
  const h = boot();
  await h.m._injectQueueFor(h.s).enqueue('injected');
  assert.strictEqual(h.s.lastSubmitInjected, true, 'ENTER: armed by the injection');

  h.m.write('hand', 'half a th');
  assert.strictEqual(h.s.lastSubmitInjected, true,
    'a keystroke that does not close the draft leaves the previous turn standing: clearing on '
    + 'every keystroke would make a seat read as typed-to the moment he touched the keyboard');

  h.m.write('hand', 'ought\r');
  assert.strictEqual(h.s.lastSubmitInjected, false, 'the Enter is what hands the turn over');
  cleanup(h);
});

test('terminal chatter is not human input and cannot clear the bit', async () => {
  const h = boot();
  await h.m._injectQueueFor(h.s).enqueue('injected');
  h.m.write('hand', '\x1b[<0;10;5M');
  assert.strictEqual(h.s.lastSubmitInjected, true,
    'write() gates on isHumanPtyInput, so a mouse-tracking sequence the renderer forwards must '
    + 'not read as the operator taking the turn');
  cleanup(h);
});

test('a PASSIVE park never submits, so it never arms the bit', async () => {
  const h = boot();
  h.m._injectTextPassive(h.s, '[agent:from lead] read this later');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(h.writes, [], 'a passive park writes nothing to the pty');
  assert.strictEqual(h.s.lastSubmitInjected, false,
    'so no Enter fires and no turn starts here');
  cleanup(h);
});
