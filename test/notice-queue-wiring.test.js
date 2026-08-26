'use strict';
// Run: node --test
// t240 — the BRIDGE between the notice queue and the app that owns it.
//
// Why this file is separate from notice-queue.test.js. Every producer test
// there injects `enqueueNotice`, `versionNoticeFor` and `appVersion` into
// createSessionManager itself, so all three are true of a manager wired by the
// harness and say nothing about the manager the engine builds. That projection
// is exactly where a shipped bug hides: the producer is wrapped in a try/catch
// (an advisory must never block a spawn), so an un-passed dep is a
// ReferenceError swallowed in silence — a seat that simply never learns it was
// upgraded, with no error anywhere and a green suite on both banks.
//
// So this drives the REAL createEngine and captures the dependency object it
// actually hands createSessionManager, by wrapping the factory in the module
// exports before the engine destructures it. The engine gets the real manager
// back, so nothing else about it changes.
const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const sessionManagerModule = require('../session-manager');
const { enqueueNotice, versionNoticeFor, clearNotices } = require('../notice-queue');
const { mkTmpRoot } = require('./lib/tmp-roots');

// Wrap, don't replace: capture the deps and delegate, so the engine is built
// exactly as it would be in the app.
const captured = [];
const realFactory = sessionManagerModule.createSessionManager;
sessionManagerModule.createSessionManager = (deps) => {
  captured.push(deps);
  return realFactory(deps);
};

const { createEngine } = require('../engine');

function mkEngine() {
  const tmp = mkTmpRoot('clx-notice-wiring-');
  // registryDir or the engine seeds the operator's live ~/.clodex (t359).
  return createEngine({
    userDataPath: tmp,
    seams: { registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
}

test('the engine hands session-manager a live notice-queue seam and its own version', () => {
  mkEngine();
  assert.strictEqual(captured.length, 1,
    'ENTER: the wrapped factory must have been called — zero calls means the assertions below are about a deps object that was never built');
  const deps = captured[0];

  // The whole trio, asserted as ONE object rather than three probes: a
  // partial-match reads around a missing seam, and every one of these arrives
  // as `undefined` if it is simply not listed at the call site.
  assert.deepStrictEqual(
    {
      enqueueNotice: deps.enqueueNotice,
      versionNoticeFor: deps.versionNoticeFor,
      clearNotices: deps.clearNotices,
      appVersionType: typeof deps.appVersion,
    },
    {
      enqueueNotice,
      versionNoticeFor,
      clearNotices,
      appVersionType: 'string',
    },
    'the engine must pass the real producer, the real decision, the boundary clear and a version string — all four run inside the same try/catch, so an undefined here is a silently skipped notice or an uncleared queue, not a crash',
  );

  // And the version must be the app's own, not a placeholder: comparing a seat's
  // recorded version against something that is not this build would announce
  // upgrades that never happened, or none that did.
  assert.strictEqual(deps.appVersion, require('../package.json').version);
});

// createEngine's background timers keep the loop alive; exit once results flush.
after(() => { setImmediate(() => process.exit(0)); });
