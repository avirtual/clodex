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
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
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

// Slice a seam's arrow-function body by BALANCING braces from its opening one.
// A regex must not do this job: `\{([^}]*)\}` stops at the first `}`, which here
// belongs to the inner `arm({ ... })` object literal — so a `restartClodex();`
// appended AFTER that literal falls outside the capture entirely, and a guard
// built on it passes over the exact regression it exists to catch. A brace in a
// string or comment inside the body would misalign this and fail loudly, which
// is the right direction to fail in.
function seamBody(src, name) {
  const at = src.indexOf(`${name}: (`);
  assert.ok(at > 0, `${name} seam is declared`);
  const open = src.indexOf('{', src.indexOf('=>', at));
  assert.ok(open > at, `${name} has a block body`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open + 1, i); }
  }
  throw new Error(`unbalanced braces in the ${name} seam`);
}

test('main.js arms the idle waiter on the agent seam and restarts immediately on the other', () => {
  // main.js requires electron, so it cannot be require()d here. The property is
  // textual and is exactly the one that regresses under a "simplify these two
  // identical-looking seams" edit.
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  const agent = seamBody(src, 'restartHostWhenIdle');
  // ENTER: without this the assertions below can be read against a truncated
  // slice that stops inside the arm() argument, where every one of them is
  // vacuously true. The nested literal must be closed INSIDE the captured body.
  assert.match(agent, /\}\s*\)\s*;/,
    'ENTER: the slice runs past the inner object literal to the arm() call\'s own close');
  assert.match(agent, /idleWaiter\.arm\(/, 'the agent path arms the waiter');
  assert.match(agent, /onAbandon/, 'and hands the requester its give-up callback');
  assert.match(agent, /requester/,
    'and its NAME — the operator\'s give-up notification is unattributable without it');
  assert.doesNotMatch(agent, /restartClodex\s*\(/,
    'the agent path must NOT quit directly — arming AND THEN quitting is the 500ms race, additively restored');
  assert.doesNotMatch(agent, /app\.(relaunch|quit)\s*\(/,
    'nor reach past restartClodex to quit by hand');

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

test('main.js: the give-up notification delegates its copy to the tested builder', () => {
  // main.js requires electron and cannot be require()d, so anything asserted here
  // is a source pin — which is exactly why the COPY is not asserted here anymore.
  // Only the two things that are source-only live here: the delegation, and the
  // constant title.
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = seamBody(src, 'notify');
  // ENTER: the slice must run past the nested Notification({...}) literal, or
  // every assertion below reads an empty string and passes vacuously.
  assert.match(body, /\}\)\.show\(\)/, 'ENTER: the captured body reaches the .show() call');

  const litAt = body.indexOf('new Notification(');
  assert.ok(litAt > 0, 'the seam constructs a Notification');
  const lit = body.slice(litAt, body.indexOf(').show()', litAt));

  // The body's CONTENT is not pinned here. Source assertions could only show the
  // copy interpolates something, which a mutant that wires the attribution to a
  // dead value passes — so the copy lives in `giveUpBody` and is tested by being
  // CALLED (test/restart-waiter.test.js). What is source-only, and therefore
  // pinned here, is that main.js delegates to it and hands it the names.
  assert.match(lit, /body:\s*giveUpBody\(\s*asked\s*\)/,
    'ENTER: this is the give-up notification, and its copy comes from the tested builder — '
    + 'a body rebuilt inline here would escape the behavioural tests entirely');

  // The title is a constant, so a source pin is the whole of it; it is read from
  // the SAME literal the delegation above identifies.
  const t = /title:\s*'([^']*)'/.exec(lit);
  assert.ok(t, 'the notification has a title');
  assert.doesNotMatch(t[1], /cancel/i,
    'not "canceled" — this is the cap giving up, and an operator cancel never reaches notify at all, '
    + 'so that word would be false on every render');
  assert.match(t[1], /drop/i, 'it says what actually happened, in the body\'s own vocabulary');
});

// createEngine's background timers keep the loop alive; exit once results flush.
after(() => { setImmediate(() => process.exit(0)); });
