'use strict';
// Run: node --test
// t483 item 1 — wire-totals.json was the one JSON store off the crash-safe write
// path: session-manager built its persist pair with a bare
// `fs.writeFileSync(totalsPath, ...)` while fs-util's header claims "All JSON
// stores route through this so a torn write can never truncate a whole store."
//
// Why this file and not a contents assertion. The store is all-time per-session
// cost history, rewritten IN FULL on wire-telemetry's 1s debounce, and the read
// side swallows a parse error by design (`catch { /* a corrupt totals file costs
// continuity */ }`) — so a torn write loses the ledger with nothing reporting it.
// A test asserting "the file has the right contents afterwards" is true of the
// bare write too, which is exactly the vacuous shape this ticket exists to
// remove. Both assertions below are FALSE of `fs.writeFileSync` and TRUE of
// `atomicWriteFileSync`, for the two reasons the atomic write exists:
//
//   - it fsyncs the bytes AND the parent dir (a bare write fsyncs neither), and
//   - it lands by RENAME, so the previous file is never the one being written
//     into — the truncate-then-write window a bare write opens is what tears.
//
// The fsync count is the same instrument test/atomic-write-claim.test.js uses.
// The inode check is the half that speaks to truncation specifically: an
// in-place rewrite keeps the inode, a rename cannot.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionManager } = require('../session-manager');
const { WireTelemetry } = require('../wire-telemetry');

// The persist pair is reached through the manager rather than rebuilt here, so
// this pins the bytes production actually writes. Everything _ensureWire does
// around it (a listening proxy, a warmth sqlite) is out of reach of a unit test,
// which is why the pair is its own method.
function mkPersist() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-totals-'));
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root, fs, path, getUserDataPath: () => root,
  });
  const file = path.join(root, 'wire-totals.json');
  return { file, persist: new SessionManager()._wireTotalsPersist(file) };
}

// Count fsyncs during fn by patching the real fs module — every module here
// shares that one instance, so no spy sits on the code under test.
function countingFsync(fn) {
  const orig = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = function (...args) { calls += 1; return orig.apply(this, args); };
  try { return { result: fn(), calls }; } finally { fs.fsyncSync = orig; }
}

const LEDGER = { version: 1, sessions: { s1: { cost: 1.5, turns: 3 } } };

test('the wire-totals write fsyncs the bytes AND the directory entry (t483)', () => {
  const { file, persist } = mkPersist();
  const { calls } = countingFsync(() => persist.write(LEDGER));
  assert.ok(calls >= 2, `a totals write must fsync the file and its dir, saw ${calls}`);
  // The durability change must not have altered what the read side sees.
  assert.deepStrictEqual(persist.read(), LEDGER);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), LEDGER);
});

test('a totals rewrite lands by rename, never into the live ledger (t483)', () => {
  const { file, persist } = mkPersist();
  persist.write(LEDGER);
  const first = fs.statSync(file).ino;

  const GROWN = { version: 1, sessions: { ...LEDGER.sessions, s2: { cost: 9, turns: 40 } } };
  persist.write(GROWN);

  // ENTER: the rewrite really happened — without this the inode assertion below
  // could be reading a file the second write never touched.
  assert.deepStrictEqual(persist.read(), GROWN, 'ENTER: the second write landed');
  assert.notStrictEqual(fs.statSync(file).ino, first,
    'the ledger must be replaced by rename — an in-place rewrite is the torn write');
  // And no temp file is left behind for the next read to trip over.
  assert.deepStrictEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f !== 'wire-totals.json'), []);
});

test('WireTelemetry saves through that same crash-safe pair (t483)', () => {
  // The seam is only worth pinning if the real consumer uses it: WireTelemetry's
  // debounced _save is the sole writer of this store.
  const { file, persist } = mkPersist();
  const wt = new WireTelemetry({ persist });
  wt.noteTurn({
    agent: 'a1', sessionId: 'sess-1', reqId: 'r1',
    sessionTotals: { est_usd: 0.25, turns: 1, requests: 1 },
  });
  const { calls } = countingFsync(() => wt._save());
  assert.ok(calls >= 2, `the telemetry save must be crash-safe too, saw ${calls}`);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.version, 1);
  assert.ok(onDisk.sessions && Object.keys(onDisk.sessions).length >= 1,
    'ENTER: the save wrote a session row, so the fsync count is about a real write');
});

test('the totals path is built in exactly one place, and it is that pair (t483)', () => {
  // A source pin because the two tests above hold for a helper nothing calls: an
  // inlined `fs.writeFileSync(totalsPath, ...)` put back into _ensureWire would
  // leave them green. The store is named once in this module; that occurrence
  // must be the argument to the crash-safe pair.
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const lines = src.split('\n').filter((l) => l.includes('wire-totals.json'));
  assert.strictEqual(lines.length, 1, 'session-manager names wire-totals.json exactly once');
  assert.match(lines[0], /_wireTotalsPersist\(/,
    'the totals file must reach the disk only through the crash-safe persist pair');
});
