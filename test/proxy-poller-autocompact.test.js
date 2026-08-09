'use strict';
// ProxyPoller._maybeAutoCompact — the one side-effecting path in the wirescope
// bundle, and until this file the only injection into a live PTY that no test
// ever constructed. The audit graded the bundle on the assumption that a wrong
// number is the worst outcome here; it is not. This path WRITES.
//
// What it pins is the seam, not the arithmetic: autoCompactDecision is already
// well covered in proxy-util.test.js, so these tests fix the decision to `fire`
// and assert what the poller does with it — specifically that it makes the same
// in-flight check the [agent:context compact] intent makes at
// session-manager.js. The autocompact path cannot inherit that check from the
// inject hold, because it passes bypassHold (required: a bare slash command
// must not be '\n'-joined into a flush batch) and bypassHold is exactly what
// skips the compact-window hold.

const test = require('node:test');
const assert = require('node:assert');

const { createProxyPoller } = require('../wirescope-proxy.js');
const { AUTO_COMPACT } = require('../proxy-util.js');

const silentLog = { info() {}, warn() {}, error() {} };

// A payload that clears every gate in autoCompactDecision, so the poller's own
// behaviour is what is under test rather than the decision function's.
function firingPayload() {
  return {
    linked: true,
    hold: false,
    warmth: { state: 'warm', remaining_s: 10, ttl_s: 3600 },
    context: { inputTokens: AUTO_COMPACT.MIN_INPUT_TOKENS + 50_000 },
  };
}

function firingSession(extra = {}) {
  return {
    name: 'seat-1',
    type: 'claude',
    agentType: 'claude',
    intentSource: 'wire',
    lastMainStop: { isTurn: true },
    needsAttention: null,
    // Older than INPUT_QUIET_MS, so the recent-input veto does not fire.
    lastUserInputTs: Date.now() - (AUTO_COMPACT.INPUT_QUIET_MS + 60_000),
    ...extra,
  };
}

// Records what the poller does to the session instead of touching a real PTY.
function fakeManager() {
  const injected = [];
  const broadcasts = [];
  return {
    injected,
    broadcasts,
    manager: {
      sessions: new Map(),
      _injectText: (s, text, opts) => injected.push({ name: s.name, text, opts }),
      _broadcast: (channel, msg) => broadcasts.push({ channel, msg }),
      _shadowLog: () => {},
    },
  };
}

function makePoller(manager, { warns } = {}) {
  const ProxyPoller = createProxyPoller({
    log: warns
      ? { info() {}, warn: (tag, msg) => warns.push(`${tag}: ${msg}`), error() {} }
      : silentLog,
    stripLevelOf: () => null,
    WIRE_TELEMETRY_LIVE: false,
    autoCompactOf: () => true,
    peerProxyView: () => null,
    getPersistence: () => ({ get: () => null }),
    getRemoteServer: () => null,
    getContextCommands: () => ({ claude: { compact: '/compact' } }),
  });
  return new ProxyPoller(manager);
}

test('a clean session fires: the poller injects /compact with bypassHold', () => {
  const { manager, injected, broadcasts } = fakeManager();
  const poller = makePoller(manager);
  const s = firingSession();

  poller._maybeAutoCompact(s, firingPayload(), {});

  // ENTER: without this the two assertions below hold just as well over a
  // decision that never fired, which is the state every other test here builds.
  assert.strictEqual(injected.length, 1, `ENTER: nothing injected — the decision did not fire (${JSON.stringify(injected)})`);
  assert.strictEqual(injected[0].text, '/compact');
  assert.strictEqual(injected[0].opts.bypassHold, true, 'a bare slash command must not be queue-joined');
  assert.ok(broadcasts.some((b) => b.channel === 'ipc-message'), 'the operator is told');
});

// ── The guard: three in-flight shapes, each on its own ───────────────────────
// isInjectInFlight is an OR over latch/guard/stash, and each is set by a
// different phase of a compact. A test covering only one would pass while the
// other two still collided.

for (const field of ['_compactPending', '_compactGuard', '_compactContinuation']) {
  test(`a compact already in flight (${field}) suppresses the injection`, () => {
    const { manager, injected } = fakeManager();
    const warns = [];
    const poller = makePoller(manager, { warns });
    const s = firingSession({ [field]: field === '_compactGuard' ? true : { cmd: '/compact' } });

    poller._maybeAutoCompact(s, firingPayload(), {});

    assert.deepStrictEqual(injected, [], `injected into a session already compacting (${field})`);
    assert.ok(
      warns.some((w) => /already in flight/.test(w)),
      `the skip must be visible in the log, got ${JSON.stringify(warns)}`,
    );
  });
}

test('the cooldown is NOT stamped when the guard suppresses', () => {
  // The order matters and is easy to get wrong: stamping autoCompacted before
  // the guard would make a suppressed attempt start a 10-minute cooldown, so
  // the compact that never happened would block the one that should.
  const { manager } = fakeManager();
  const poller = makePoller(manager);
  const s = firingSession({ _compactGuard: true });

  poller._maybeAutoCompact(s, firingPayload(), {});
  assert.strictEqual(poller.autoCompacted.has('seat-1'), false, 'a suppressed attempt must not start the cooldown');

  // CONTROL: the same session with the guard cleared fires and DOES stamp, so
  // the assertion above is about the guard rather than about a poller that
  // never stamps anything.
  const s2 = firingSession();
  poller._maybeAutoCompact(s2, firingPayload(), {});
  assert.strictEqual(poller.autoCompacted.has('seat-1'), true, 'CONTROL: an un-suppressed fire stamps the cooldown');
});

test('a dead session is never injected into', () => {
  const { manager, injected } = fakeManager();
  const poller = makePoller(manager);
  poller._maybeAutoCompact(firingSession({ _dead: true }), firingPayload(), {});
  assert.deepStrictEqual(injected, []);
});
