'use strict';

// t86 — a spilled dm body must not be GC'd out from under a parked pointer.
//
// A dm body over MSG_SPILL_THRESHOLD is delivered as a POINTER to a file in
// ~/.clodex/messages/ (session-manager._buildDeliveryText); a held delivery
// parks that pointer, and the parked record carries no other copy of the body.
// Parking has no expiry, the spill file had one (MSG_MAX_AGE, 30 min), so a
// delivery parked longer arrived pointing at a deleted file — silently, because
// nothing re-reads the file at delivery.
//
// These tests drive engine.sweepSpilledMessages directly (module-level and
// fully parameterized — no engine construction, no timers, no PTY) against real
// temp dirs, and pending-store.allParkedTexts, the read-only scan it uses.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sweepSpilledMessages } = require('../engine');
const { parkDelivery, drainPending, allParkedTexts } = require('../pending-store');
const { mkTmpRoot } = require('./lib/tmp-roots');

const MAX_AGE = 1800;            // seconds — mirrors engine.MSG_MAX_AGE
const NOW = 1_800_000_000_000;   // fixed clock, so nothing depends on wall time
const OLD = NOW - (MAX_AGE + 60) * 1000;
const FRESH = NOW - 60 * 1000;

function tmpDirs() {
  const base = mkTmpRoot('spill-receipt-');
  const msgDir = path.join(base, 'messages');
  const pendingDir = path.join(base, 'pending');
  fs.mkdirSync(msgDir, { recursive: true });
  fs.mkdirSync(pendingDir, { recursive: true });
  return { msgDir, pendingDir };
}

// Write a spill file for `recipient` with the given mtime, using the real
// filename grammar spillToFile mints (msg-<pid>-<counter>.txt).
function spill(msgDir, recipient, name, mtimeMs) {
  const dir = path.join(msgDir, recipient);
  fs.mkdirSync(dir, { recursive: true });
  const fpath = path.join(dir, name);
  fs.writeFileSync(fpath, 'From: bob\n\nbody');
  fs.utimesSync(fpath, mtimeMs / 1000, mtimeMs / 1000);
  return fpath;
}

// The exact pointer text _buildDeliveryText produces for a claude target.
function claudePointer(fpath) {
  return `[agent:from bob] Message (2534 bytes) attached: @${fpath} `;
}

// ...and for a codex target — a DIFFERENT wording for the same reference, which
// is why the scan matches the filename grammar and not the prose.
function codexPointer(fpath) {
  return `[agent:from bob] Message (2534 bytes) saved to ${fpath} — read it with your Read tool.`;
}

test('t86: a spill file referenced by a parked delivery survives past MSG_MAX_AGE', () => {
  const { msgDir, pendingDir } = tmpDirs();
  const fpath = spill(msgDir, 'alice', 'msg-55910-39.txt', OLD);
  parkDelivery(pendingDir, 'alice', claudePointer(fpath), '0001');

  // ENTER CHECK: the file must really be old enough to collect, or "it survived"
  // proves nothing. Assert the sweep WOULD have taken it — by taking it, with
  // the same age, when no park references it.
  const { msgDir: ctlMsg, pendingDir: ctlPending } = tmpDirs();
  const ctl = spill(ctlMsg, 'alice', 'msg-55910-39.txt', OLD);
  sweepSpilledMessages(ctlMsg, ctlPending, MAX_AGE, NOW);
  assert.strictEqual(fs.existsSync(ctl), false, 'control: an unreferenced file of this age is collected');

  sweepSpilledMessages(msgDir, pendingDir, MAX_AGE, NOW);
  assert.strictEqual(fs.existsSync(fpath), true,
    'the referenced body must still be there when the parked pointer is finally drained');
});

test('t86: an unreferenced spill file past MSG_MAX_AGE is still collected', () => {
  const { msgDir, pendingDir } = tmpDirs();
  const fpath = spill(msgDir, 'alice', 'msg-55910-39.txt', OLD);
  // A park exists, but for a DIFFERENT file — so the exemption must not be a
  // blanket "anything parked stops the sweep".
  parkDelivery(pendingDir, 'alice', claudePointer(path.join(msgDir, 'alice', 'msg-55910-99.txt')), '0001');

  sweepSpilledMessages(msgDir, pendingDir, MAX_AGE, NOW);
  assert.strictEqual(fs.existsSync(fpath), false, 'age GC must still run for unreferenced files');
});

test('t86: a fresh unreferenced spill file survives (age still gates the sweep)', () => {
  const { msgDir, pendingDir } = tmpDirs();
  const fpath = spill(msgDir, 'alice', 'msg-55910-39.txt', FRESH);
  sweepSpilledMessages(msgDir, pendingDir, MAX_AGE, NOW);
  assert.strictEqual(fs.existsSync(fpath), true);
});

test('t86: a codex pointer exempts too — the scan matches the filename, not the prose', () => {
  const { msgDir, pendingDir } = tmpDirs();
  const fpath = spill(msgDir, 'alice', 'msg-55910-39.txt', OLD);
  parkDelivery(pendingDir, 'alice', codexPointer(fpath), '0001');
  sweepSpilledMessages(msgDir, pendingDir, MAX_AGE, NOW);
  assert.strictEqual(fs.existsSync(fpath), true,
    'the two pointer wordings must both be recognized');
});

test('t86: the exemption covers root-level stray spill files, in both directions', () => {
  const { msgDir, pendingDir } = tmpDirs();
  // Back-compat shape: a spill file directly in MSG_DIR, no recipient subfolder.
  const kept = path.join(msgDir, 'msg-55910-39.txt');
  const dropped = path.join(msgDir, 'msg-55910-40.txt');
  for (const p of [kept, dropped]) {
    fs.writeFileSync(p, 'body');
    fs.utimesSync(p, OLD / 1000, OLD / 1000);
  }
  parkDelivery(pendingDir, 'alice', claudePointer(kept), '0001');

  sweepSpilledMessages(msgDir, pendingDir, MAX_AGE, NOW);
  assert.strictEqual(fs.existsSync(kept), true, 'referenced stray survives');
  assert.strictEqual(fs.existsSync(dropped), false, 'unreferenced stray is collected');
});

test('t86: draining the park releases the body to normal age GC', () => {
  const { msgDir, pendingDir } = tmpDirs();
  const fpath = spill(msgDir, 'alice', 'msg-55910-39.txt', OLD);
  parkDelivery(pendingDir, 'alice', claudePointer(fpath), '0001');

  sweepSpilledMessages(msgDir, pendingDir, MAX_AGE, NOW);
  assert.strictEqual(fs.existsSync(fpath), true, 'exempt while parked');

  const texts = drainPending(pendingDir, 'alice', 'test');
  // ENTER CHECK: the drain must actually have consumed the pointer — otherwise
  // "collected after drain" would be testing an empty store from the start.
  assert.strictEqual(texts.length, 1);
  assert.match(texts[0], /msg-55910-39\.txt/);

  sweepSpilledMessages(msgDir, pendingDir, MAX_AGE, NOW);
  assert.strictEqual(fs.existsSync(fpath), false,
    'once delivered, the body is no longer referenced and expires normally');
});

test('t86: allParkedTexts returns every parked text across agents, and skips claim dirs', () => {
  const { pendingDir } = tmpDirs();
  parkDelivery(pendingDir, 'alice', 'one', '0001');
  parkDelivery(pendingDir, 'alice', 'two', '0002');
  parkDelivery(pendingDir, 'bob', 'three', '0001');
  assert.deepStrictEqual(allParkedTexts(pendingDir).sort(), ['one', 'three', 'two']);

  // A mid-flight whole-dir claim renames the agent dir to a `.draining.` sibling
  // at ROOT level. It must be skipped, exactly as parkIdInUse skips it.
  fs.renameSync(path.join(pendingDir, 'alice'), path.join(pendingDir, 'alice.draining.t1'));
  assert.deepStrictEqual(allParkedTexts(pendingDir), ['three']);
});

test('t86: allParkedTexts skips a corrupt entry rather than aborting the scan', () => {
  const { pendingDir } = tmpDirs();
  parkDelivery(pendingDir, 'alice', 'good', '0001');
  fs.writeFileSync(path.join(pendingDir, 'alice', '0002.json'), '{not json');
  // A single unreadable park must not blind the GC to every OTHER live pointer —
  // that would turn one corrupt file into a batch of deleted message bodies.
  assert.deepStrictEqual(allParkedTexts(pendingDir), ['good']);
});
