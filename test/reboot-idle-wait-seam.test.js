'use strict';
// reboot-idle-wait-seam.test.js — t282: [agent:reboot] must not quit the app out
// from under the seat that asked for it. The intent is scanned MID-TURN, so an
// immediate relaunch destroys the turn boundary the reboot notice is delivered
// across (the log's "GIVEN UP after 3 attempts — never confirmed reaching the
// seat" is that race landing).
//
// The fix is a SPLIT seam, and the split is the thing these pin. `restartHost`
// stays immediate because it is a human pressing a control — the app menu, and
// the phone/web "restart app" button that reaches it through engine's
// `restartClodex` (remote-wiring.js `restartApp`, web-host's `app:restart`).
// `restartHostWhenIdle` is the agent path and waits for the seats to settle.
// Collapsing the two — in either direction — is the regression: one way the
// agent race comes back, the other way an operator's phone tap silently does
// nothing for up to half an hour.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// The seams are consumed deep inside createEngine and never exported, so capture
// the dep bundles at their two construction sites. Both modules are require()d
// INSIDE createEngine, so patching the module object before the call is enough.
function engineSeamTargets(seams) {
  const smMod = require('../session-manager');
  const rwMod = require('../remote-wiring');
  const origSm = smMod.createSessionManager;
  const origRw = rwMod.createRemoteWiring;
  let smDeps = null;
  let rwDeps = null;
  smMod.createSessionManager = (deps) => { smDeps = deps; return origSm(deps); };
  rwMod.createRemoteWiring = (deps) => { rwDeps = deps; return origRw(deps); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t282-'));
  try {
    require('../engine').createEngine({
      userDataPath: tmp,
      log: { info() {}, warn() {}, error() {} },
      seams,
    });
  } finally {
    smMod.createSessionManager = origSm;
    rwMod.createRemoteWiring = origRw;
  }
  assert.ok(smDeps, 'the session manager was constructed');
  assert.ok(rwDeps, 'the peer wiring was constructed');
  // relaunchApp is what [agent:reboot] calls; restartClodex is what the menu and
  // the remote restart button call.
  return { agentPath: smDeps.relaunchApp, operatorPath: rwDeps.restartClodex };
}

test('engine: the agent path and the operator path are DIFFERENT seams', () => {
  const calls = [];
  const { agentPath, operatorPath } = engineSeamTargets({
    restartHost: () => calls.push('immediate'),
    restartHostWhenIdle: () => calls.push('deferred'),
  });
  agentPath();
  assert.deepStrictEqual(calls, ['deferred'], '[agent:reboot] takes the deferred seam, never the immediate one');
  operatorPath();
  assert.deepStrictEqual(calls, ['deferred', 'immediate'],
    'a human pressing restart still restarts now — no silent half-hour wait');
});

test('engine: relaunchApp passes the requester options THROUGH to the host', () => {
  // Without this the host cannot report a given-up wait back to the seat, which
  // is the whole reason the deferred path is allowed to give up at all.
  let seen = 'never called';
  const { agentPath } = engineSeamTargets({
    restartHost: () => {},
    restartHostWhenIdle: (opts) => { seen = opts; },
  });
  const onAbandon = () => {};
  agentPath({ onAbandon });
  assert.ok(seen && typeof seen === 'object', 'the host got an options object');
  assert.strictEqual(seen.onAbandon, onAbandon, 'and the exact callback, not a copy or a wrapper');
});

test('engine: a host with no deferred seam falls back to the immediate one (headless)', () => {
  // headless-main.js supplies only restartHost — its contract is "exit 64 now,
  // the supervisor relaunches", and there is no operator or dialog there to
  // rescue a 30-minute wait. The fallback is what keeps that unchanged.
  const calls = [];
  const { agentPath, operatorPath } = engineSeamTargets({ restartHost: () => calls.push('immediate') });
  agentPath();
  operatorPath();
  assert.deepStrictEqual(calls, ['immediate', 'immediate'],
    'both paths collapse onto the supervisor exit when no deferred seam exists');
});

// ── main.js: the Electron wiring, pinned as source ──────────────────────────

test('main.js arms the idle waiter on the agent seam and restarts immediately on the other', () => {
  // main.js requires electron, so it cannot be require()d here. The property is
  // textual and is exactly the one that regresses under a "simplify these two
  // identical-looking seams" edit.
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  const agent = /restartHostWhenIdle:\s*\(opts\)\s*=>\s*\{([^}]*)\}/.exec(src);
  assert.ok(agent, 'main.js declares the deferred seam');
  assert.match(agent[1], /idleWaiter\.arm\(/, 'the agent path arms the waiter');
  assert.match(agent[1], /onAbandon/, 'and hands the requester its give-up callback');
  assert.doesNotMatch(agent[1], /restartClodex\s*\(/,
    'the agent path must NOT quit directly — that is the 500ms race this ticket closes');

  assert.match(src, /restartHost:\s*\(\)\s*=>\s*restartClodex\(\)/,
    'the operator/remote seam still restarts immediately');

  // The menu keeps both of its exits, and only the CANCEL one abandons: a
  // "Restart Now" disarm is followed by the restart it promised, so reporting
  // the request as dropped there would be a lie the seat acts on.
  assert.match(src, /idleWaiter\.disarm\(\{\s*abandoned:\s*true\s*\}\)/,
    'cancelling a pending restart tells the agents waiting on it');
  assert.match(src, /idleWaiter\.disarm\(\);\s*restartClodex\(\);/,
    '"Restart Now" disarms silently and takes the restart itself');
});

// createEngine's background timers keep the loop alive; exit once results flush.
after(() => { setImmediate(() => process.exit(0)); });
