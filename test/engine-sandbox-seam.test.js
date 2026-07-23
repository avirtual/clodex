'use strict';
// engine-sandbox-seam.test.js — T57: the sandbox subsystem is a desktop-only
// feature (docker-compose boxes the GUI spawns). A headless host opts out via
// the `enableSandbox: false` seam so the New Session "Run in" selector shows no
// docker-in-docker placement. This pins the engine-side contract:
//   - enableSandbox:false  → getSandboxManager() returns null (the IPC
//     `getSandboxManager() ? .list() : []` path then yields [] → showPlacementSelector([])
//     is false → the "Run in" row hides; renderer half is pinned in placement.test.js).
//   - seam omitted (the Electron path) → the manager is created exactly as today.
//
// createEngine constructs electron-free against a temp userData and starts
// background timers that keep the loop alive; force-exit once assertions flush
// (node --test isolates each file's process).

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');

function mkEngine(seams) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-eng-sbx-'));
  return createEngine({ userDataPath: tmp, seams, log: { info() {}, warn() {}, error() {} } });
}

test('enableSandbox:false → getSandboxManager() is null and the IPC list-path yields []', () => {
  const eng = mkEngine({ enableSandbox: false });
  const mgr = eng.getSandboxManager();
  assert.strictEqual(mgr, null, 'headless opt-out → no sandbox manager');
  // The exact shape ipc-handlers uses for sandbox:listBoxes.
  assert.deepStrictEqual(mgr ? mgr.list() : [], [], 'the list-path yields no boxes → placement row hides');
  // getSandbox is null-tolerant too (no throw on a null manager).
  assert.strictEqual(eng.getSandbox('sandbox'), null, 'getSandbox returns null, not a throw');
});

test('seam omitted (Electron path) → the sandbox manager is created as today', () => {
  const eng = mkEngine({});
  assert.notStrictEqual(eng.getSandboxManager(), null, 'default-on: manager exists exactly as before');
});

// createEngine's background timers keep the loop alive; exit once results flush.
after(() => { setImmediate(() => process.exit(0)); });
