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
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    InjectQueue,
    PENDING_DIR, parkDelivery, drainPending, hasActivePending, isDraftOpen,
    countPending, isHumanPtyInput, draftChunkSignal,
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
  return { m, s, writes, PENDING_DIR };
}

function cleanup(h) {
  if (h.s._parkCapTimer) { clearTimeout(h.s._parkCapTimer); h.s._parkCapTimer = null; }
  try { fs.rmSync(h.PENDING_DIR, { recursive: true, force: true }); } catch {}
}

test('the bit tracks the turn, not the request: [false, true, true, false]', async () => {
  const h = boot();
  const seq = [];

  seq.push(h.s.lastSubmitInjected);

  await h.m._injectQueueFor(h.s).enqueue('[agent:from lead] pick up t1026');
  seq.push(h.s.lastSubmitInjected);

  seq.push(h.s.lastSubmitInjected);

  h.m.write('hand', 'now do the other thing\r');
  seq.push(h.s.lastSubmitInjected);

  assert.deepStrictEqual(seq, [false, true, true, false],
    'fresh seat, then a dm Clodex delivered, then a tool-call continuation inside that same '
    + 'turn — a second REQUEST but not a second turn, passing through neither call site, so the '
    + 'bit still describes the dm — then the operator typing and hitting Enter');
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
