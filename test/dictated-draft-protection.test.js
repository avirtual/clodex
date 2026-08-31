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
const { parkDelivery, drainPending, hasPending, hasActivePending } = require('../pending-store');
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

function boot({ draftStale = DRAFT_STALE_MS, recorderStale = 0 } = {}) {
  const PENDING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-vdraft-'));
  const SessionManager = createSessionManager({
    InjectQueue,
    PENDING_DIR, parkDelivery, drainPending, hasActivePending, isDraftOpen,
    countPending: require('../pending-store').countPending,
    INJECT_QUIET_MS: 0,
    // Large: the park cap is a real bound on this protection and has its own
    // subject below, but it must not fire underneath the others.
    INJECT_QUIET_MAXWAIT: 3_600_000,
    INJECT_BOOT_MAXWAIT: 0,
    INJECT_SPEAKING_STALE_MS: recorderStale,   // the RECORDER window: 0 by default, so
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

test('the protection outlives the RECORDER window by a stated multiple', async () => {
  // Bounded against something the first subject does not already prove. There
  // the recorder window is merely expired; here the level is held across a span
  // that is a stated MULTIPLE of it, which is the shape of the operator's real
  // exposure — he stopped talking long ago and is still reading. Anchored to
  // RECORDER_MS rather than to a bare number so the relationship survives a
  // retune of either constant.
  const RECORDER_MS = 30;                       // the harness's speaking window
  const h = boot({ recorderStale: RECORDER_MS });
  const poll = setInterval(() => h.m.noteVoiceDraft('hand'), DRAFT_STALE_MS / 5);
  try {
    h.m.noteVoiceDraft('hand');
    await settle(RECORDER_MS * 10);             // ten recorder windows of pure reading
    h.m._injectText(h.s, 'a dm', { parkable: true });
    await settleQueue(h);
    assert.ok(Date.now() - (h.s.lastVoiceRecordingTs || 0) > RECORDER_MS * 5,
      'ENTER: the recorder window is long gone, or this proves nothing the first subject does not');
    assert.deepStrictEqual(h.writes, SENTINEL_BYTES,
      'still protected ten recorder-windows after he stopped talking');
  } finally { clearInterval(poll); }
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

// --- the drains agree with the divert about what an open draft is ------------
//
// The idle and boot-ready drains guarded on the TYPED predicate alone. With a
// dictated draft open they passed that guard, `drainPending` CLAIMED the parked
// files destructively, and the divert re-parked the joined text as ONE ACTIVE
// entry. No message is lost — the divert catches it — but a `.passive.` park
// comes back ACTIVE, and a passive park never earns a turn by design. The
// promotion wakes a seat that was meant to stay quiet.
//
// Asserted on the FILENAMES on disk, because that is where the distinction
// lives: `<seq>.passive.json` vs `<seq>.json`.

const fsp = require('node:fs');

function parkedNames(h) {
  const dir = path.join(h.PENDING_DIR, 'hand');
  try { return fsp.readdirSync(dir).sort(); } catch { return []; }
}

test('the idle drain leaves a PASSIVE park passive while a dictated draft is open', async () => {
  const h = boot();
  // BOTH kinds. A passive entry ALONE cannot reach the guard under test:
  // `hasActivePending` is false, so the drain returns one line earlier and the
  // subject would pass without ever exercising the draft check. The active entry
  // is what carries the drain past that bail and up to the guard, and
  // `drainPending` claims the whole DIRECTORY — which is how the passive one
  // gets swept up and re-parked as active.
  parkDelivery(h.PENDING_DIR, 'hand', '[agent:from x] passive note', '1', null, true, null);
  parkDelivery(h.PENDING_DIR, 'hand', '[agent:from y] active note', '2', null, false, null);
  assert.ok(parkedNames(h).some((n) => n.includes('.passive.')),
    'ENTER: the entry really is parked passive, or the promotion below cannot be observed');
  assert.ok(hasActivePending(h.PENDING_DIR, 'hand'),
    'ENTER: an active entry is present, or the drain bails before the guard under test');

  h.m.noteVoiceDraft('hand');
  h.m._drainPendingAtIdle(h.s);
  await settleQueue(h);

  assert.deepStrictEqual(h.writes, SENTINEL_BYTES,
    'nothing may be spliced into his dictated draft');
  assert.ok(parkedNames(h).some((n) => n.includes('.passive.')),
    'the passive entry must still be PASSIVE — a re-park as active promotes it, '
    + 'and a passive park never earns a turn');
  cleanup(h);
});

test('the boot-ready drain does the same', async () => {
  const h = boot();
  parkDelivery(h.PENDING_DIR, 'hand', '[agent:from x] passive note', '1', null, true, null);
  parkDelivery(h.PENDING_DIR, 'hand', '[agent:from y] active note', '2', null, false, null);
  h.m.noteVoiceDraft('hand');
  h.m._drainPendingAtBootReady(h.s);
  await settleQueue(h);

  assert.deepStrictEqual(h.writes, SENTINEL_BYTES);
  assert.ok(parkedNames(h).some((n) => n.includes('.passive.')),
    'the boot-ready drain must not promote a passive park either');
  cleanup(h);
});

test('ENTER: with NO dictated draft, the idle drain still delivers an ACTIVE park', async () => {
  // The guard must not have been widened into a drain that never fires. Without
  // this, both subjects above pass for a drain that is simply dead.
  const h = boot();
  parkDelivery(h.PENDING_DIR, 'hand', '[agent:from x] active note', '1', null, false, null);
  h.m._drainPendingAtIdle(h.s);
  await settleQueue(h);
  assert.deepStrictEqual(h.writes, ['\x15', '[agent:from x] active note', '\r', ...SENTINEL_BYTES],
    'an undrafted seat still gets its parked message delivered');
  cleanup(h);
});
