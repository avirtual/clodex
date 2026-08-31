'use strict';
// Run: node --test
// The operator finishes a long transcription and re-reads it before sending. The
// recorder went dark when he stopped talking, so the `speaking` gate's window
// (INJECT_SPEAKING_STALE_MS) has long expired; a dm arrives, and the Ctrl-U that opens every injection eats the
// draft he was reading.
//
// A TYPED draft never had this problem: `_parkDivertFor` asks `isDraftOpen` and
// diverts the delivery to the pending store, where his next submit drains it —
// no Ctrl-U is ever written. But both stamps `isDraftOpen` reads are set by
// `isHumanPtyInput` inside SessionManager.write(), i.e. by TYPING, and dictated
// words never pass through write() at all. So the divert that protects a typed
// draft could not fire for a dictated one, at any age.
//
// EVERY ASSERTION HERE IS ON PTY BYTES OR THE ON-DISK STORE, never on a
// predicate's return value: the call site is the whole content of this change.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InjectQueue } = require('../inject-queue');
const { createSessionManager } = require('../session-manager');
const { isDraftOpen } = require('../proxy-util');
const { parkDelivery, drainPending, hasPending, hasActivePending, countPending } = require('../pending-store');
const { composerHasDraft, composerIsEmpty } = require('../renderer/lib/voice-submit');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// A POSITIVE settling signal, because every "nothing was injected" assertion
// here is an ABSENCE and an absence asserted early is trivially true. The
// InjectQueue chain is serial FIFO, so this lands only once the delivery ahead
// of it has finished draining — and the assertions then read the FULL write
// list: a payload that wrongly spliced appears AHEAD of the sentinel and fails
// loudly rather than being missed. Its own enqueue is not parkable, so the
// divert cannot swallow the signal itself.
const SENTINEL = 'settle sentinel';
const SENTINEL_BYTES = ['\x15', SENTINEL, '\r'];
async function settleQueue(h) { await h.m._injectQueueFor(h.s).enqueue(SENTINEL); }

// Deliberately short so a test can outlive it in real time; production's value
// is the one engine.js sets, and its size is not what this file is pinning.
const DRAFT_STALE_MS = 150;

function boot({ draftStale = DRAFT_STALE_MS } = {}) {
  const PENDING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-vdraft-'));
  const SessionManager = createSessionManager({
    InjectQueue,
    PENDING_DIR, parkDelivery, drainPending, hasActivePending, isDraftOpen,
    INJECT_QUIET_MS: 0,
    // Large: the park cap is a real bound on this protection and has its own
    // subject below, but it must not fire underneath the others.
    INJECT_QUIET_MAXWAIT: 3_600_000,
    INJECT_BOOT_MAXWAIT: 0,
    INJECT_SPEAKING_STALE_MS: 0,     // the RECORDER window: expired throughout, so
                                     // nothing below can pass for the `speaking` gate
    INJECT_VOICE_DRAFT_STALE_MS: draftStale,
    SHORT_TEXT_DELAY: 0, LONG_TEXT_DELAY: 0, LONG_TEXT_THRESHOLD: 1e9,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    hintArm: { holding: () => false },
  });
  const m = new SessionManager();
  m._broadcast = () => {};
  const writes = [];
  const s = {
    name: 'hand', agentType: 'claude', _dead: false, _bootReadySeen: true,
    // Never typed and never submitted: isDraftOpen is false for the whole file,
    // so any divert below is the dictated signal and nothing else.
    lastUserInputTs: 0, lastUserSubmitTs: 0,
    pty: { write: (b) => writes.push(b) },
  };
  m.sessions = new Map([['hand', s]]);
  return { m, s, writes, PENDING_DIR };
}

function cleanup(h) {
  if (h.s._parkCapTimer) { clearTimeout(h.s._parkCapTimer); h.s._parkCapTimer = null; }
  try { fs.rmSync(h.PENDING_DIR, { recursive: true, force: true }); } catch {}
}

// --- the gap this closes -----------------------------------------------------

test('a dictated draft parks the delivery: not one byte reaches the pty', async () => {
  const h = boot();
  h.m.noteVoiceDraft('hand');
  assert.ok(h.s.lastVoiceDraftTs > 0,
    'ENTER: the stamp must have landed on the session, or nothing below is under test');
  assert.strictEqual(isDraftOpen(h.s), false,
    'ENTER: the TYPED predicate must be false, or this passes for the old reason');

  h.m._injectText(h.s, '[agent:from lead] a dm mid-review', { parkable: true });
  await settleQueue(h);

  assert.deepStrictEqual(h.writes, SENTINEL_BYTES,
    'the Ctrl-U must never be written for the DM while his dictated draft is on screen; '
    + 'only the later sentinel reached the pane');
  assert.ok(hasPending(h.PENDING_DIR, 'hand'),
    'and the message is on disk, to drain at his next submit — deferred, never dropped');
  cleanup(h);
});

test('REGRESSION: with the recorder dark and no dictated draft, the injection goes straight through', async () => {
  // The unprotected seat. Nothing here reports a draft, so the divert
  // must not engage — this is what keeps the new signal from parking everything.
  const h = boot();
  assert.ok(!h.s.lastVoiceDraftTs, 'ENTER: no draft stamp on this seat');
  h.m._injectText(h.s, 'hi', { parkable: true });
  await settleQueue(h);
  assert.deepStrictEqual(h.writes, ['\x15', 'hi', '\r', ...SENTINEL_BYTES],
    'an unreported seat is injected into exactly as before');
  assert.ok(!hasPending(h.PENDING_DIR, 'hand'), 'and nothing was parked');
  cleanup(h);
});

test('the protection outlives the recorder — the case the 3s speaking window cannot cover', async () => {
  // INJECT_SPEAKING_STALE_MS is 0 in this harness, so the `speaking` gate is
  // fully expired at every instant below. He stopped talking; the words are still on
  // screen; this is the operator's actual exposure.
  const h = boot();
  h.m.noteVoiceDraft('hand');
  await settle(DRAFT_STALE_MS / 3);            // the recorder has been dark this whole time
  h.m._injectText(h.s, 'a dm', { parkable: true });
  await settleQueue(h);
  assert.deepStrictEqual(h.writes, SENTINEL_BYTES,
    'still protected after the recorder went dark — the DM parked, only the sentinel landed');
  assert.ok(hasPending(h.PENDING_DIR, 'hand'));
  cleanup(h);
});

// --- the release conditions, each proven to actually release -----------------

test('RELEASE 1: the stamp expires when the renderer stops reporting', async () => {
  // The report is level-triggered and main expires it, so every way the watcher
  // can stop — window closed, seat switched, disposed, screen unreadable —
  // releases the seat. Nothing has to send an "off" that could be lost.
  const h = boot();
  h.m.noteVoiceDraft('hand');
  await settle(DRAFT_STALE_MS * 2);            // renderer went away; no further reports
  h.m._injectText(h.s, 'hi', { parkable: true });
  await settleQueue(h);
  assert.deepStrictEqual(h.writes, ['\x15', 'hi', '\r', ...SENTINEL_BYTES],
    'a stale stamp must deliver: a protection nobody can release is a seat nobody can reach');
  assert.ok(!hasPending(h.PENDING_DIR, 'hand'), 'and nothing was parked behind it');
  cleanup(h);
});

test('RELEASE 2: a refreshed report holds it open — the level is what protects, not one edge', async () => {
  const h = boot();
  // Reported BEFORE the delivery and then kept up, which is the renderer's own
  // order: the level is already established when a dm arrives mid-reading.
  // Starting only the interval would leave the first divert racing its first
  // tick, and the test would pass or fail on that race rather than on the level.
  h.m.noteVoiceDraft('hand');
  const poll = setInterval(() => h.m.noteVoiceDraft('hand'), DRAFT_STALE_MS / 5);
  try {
    h.m._injectText(h.s, 'a dm', { parkable: true });
    await settleQueue(h);
    await settle(DRAFT_STALE_MS * 2);          // far past the stale bound, still reported
    assert.deepStrictEqual(h.writes, SENTINEL_BYTES,
      'while he keeps re-reading it, the delivery keeps parking');
  } finally { clearInterval(poll); }
  assert.ok(hasPending(h.PENDING_DIR, 'hand'));
  cleanup(h);
});

test('RELEASE 3: the park cap bounds it from main, on a timer that reads no voice signal', async () => {
  // The proof that the protection cannot outlive its release even if every
  // renderer-side release fails at once. The cap is armed AT PARK TIME by
  // _armParkCap and consults nothing about voice; a stuck reporter is bounded by
  // it exactly as a walked-away typist already is.
  const h = boot();
  h.m._armParkCap = () => { h.capArmed = true; };   // observed, not waited out
  h.m.noteVoiceDraft('hand');
  h.m._injectText(h.s, 'a dm', { parkable: true });
  await settleQueue(h);
  assert.deepStrictEqual(h.writes, SENTINEL_BYTES,
    'ENTER: it really parked, or the cap below guards nothing');
  assert.strictEqual(h.capArmed, true,
    'every dictated park arms the same cap a typed park does — this is what makes the bound unloseable');
  cleanup(h);
});

test('a dead seat takes no stamp, and an unknown name does not throw', () => {
  const h = boot();
  h.s._dead = true;
  h.m.noteVoiceDraft('hand');
  assert.ok(!h.s.lastVoiceDraftTs);
  h.m.noteVoiceDraft('nobody');
  cleanup(h);
});

test('the dictated stamp is its own field, not an overload of the typed ones', () => {
  // isDraftOpen's five other call sites ask a question about KEYSTROKES. Stamping
  // this into lastUserInputTs would silently answer it for them too.
  const h = boot();
  h.m.noteVoiceDraft('hand');
  assert.strictEqual(h.s.lastUserInputTs, 0,
    'reporting a dictated draft must not make the seat look like it was TYPED into');
  assert.strictEqual(h.s.lastVoiceRecordingTs, undefined,
    'nor like its recorder is lit — lastVoiceRecordingTs is its own field, with a far shorter window');
  cleanup(h);
});

// --- the polarity trap, at the predicate that carries it ---------------------

test('composerHasDraft: an UNREADABLE screen is not a draft still open', () => {
  // The whole reason this is a positive rule rather than !composerIsEmpty. Main
  // PARKS on this answer, so a row nobody could read must not park deliveries
  // that nothing then releases. Doubt delivers here — the same direction as the
  // speaking gate, the opposite of recorderBlocksRearm.
  for (const unreadable of [null, undefined, '', 'mid-repaint garbage', '⏺ Bash(ls)']) {
    assert.strictEqual(composerHasDraft(unreadable), false,
      `an unreadable row must not read as a draft: ${JSON.stringify(unreadable)}`);
  }
  // ENTER: and a row that IS a composer with words in it does read as one, or
  // every assertion above is passing for want of a working predicate.
  assert.strictEqual(composerHasDraft('❯ the long transcription he is re-reading'), true,
    'ENTER: a real dictated draft must be detectable');
});

test('composerHasDraft is NOT the negation of composerIsEmpty', () => {
  // Stated as its own subject because the negation is the obvious refactor and
  // it inverts the failure direction on exactly the rows that matter.
  const unreadable = null;
  assert.strictEqual(composerIsEmpty(unreadable), false);
  assert.strictEqual(composerHasDraft(unreadable), false,
    'both false for an unreadable row: it is neither known-empty nor known-drafted');
  const empty = '❯ ';
  assert.strictEqual(composerIsEmpty(empty), true);
  assert.strictEqual(composerHasDraft(empty), false);
  const whitespaceOnly = '❯    ';
  assert.strictEqual(composerHasDraft(whitespaceOnly), false,
    'a composer holding only spaces is not a draft to protect');
});
