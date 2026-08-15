'use strict';
// Run: node --test
// The SEAM between the wire and the quota store (t418), plus the IPC read that
// serves a window opened before any turn.
//
// This file exists because test/wire-quota.test.js structurally cannot express
// what is asserted here. That file drives QuotaStore directly, and the store
// has no notion of a provider — so a codex 429 being filed against the Claude
// org is invisible from inside it, and the suite stayed green over exactly that
// bug. The gate lives in the subscriber, so the test has to live at the
// subscriber.
//
// The wire is REAL (`_ensureWire`), not a fake EventEmitter: half the claim is
// that the subscriber is registered at all and that `provider` reaches it on
// the `response` event. A hand-made emitter would pin my idea of that event's
// shape rather than the shape, which is the same mistake that let the codex
// path through in the first place.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { registerIpcHandlers } = require('../ipc-handlers');

// A real forwarded-turn response, trimmed to the fields the store reads.
const CLAUDE_HEADERS = {
  'content-type': 'application/json',
  'anthropic-organization-id': 'a0aca1fb-5695-4f38-854c-28911e5c20e4',
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
  'anthropic-ratelimit-unified-7d-utilization': '0.95',
  'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
  'anthropic-ratelimit-unified-7d-reset': '1787043600',
};
// What a codex 429 actually looks like: no ratelimit headers, no org id.
const CODEX_429_HEADERS = { 'content-type': 'application/json' };

function mkManager() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-t418-seam-'));
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs,
    path,
    getUserDataPath: () => root,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const m = new SessionManager();
  const broadcasts = [];
  m._broadcast = (channel, payload) => broadcasts.push({ channel, payload });
  return { m, broadcasts, root };
}

// Drives the REAL subscriber by emitting on the REAL wire, then tears the port
// down. `fn` receives the wire so each test emits the responses it cares about.
async function onWire(fn) {
  const { m, broadcasts } = mkManager();
  const wire = await m._ensureWire();
  try {
    await fn({ wire, m, broadcasts });
  } finally {
    await wire.close();
    if (m._holdKeeper) m._holdKeeper.stop();
    const store = m._quotaStore;
    if (store) store.close();
  }
}

test('seam: an anthropic response with quota headers reaches the store and broadcasts', async () => {
  await onWire(async ({ wire, m, broadcasts }) => {
    wire.emit('response', {
      agent: 'a', provider: 'anthropic', reqId: 'r1', status: 200, headers: CLAUDE_HEADERS,
    });
    // ENTER: without this the codex assertions below are vacuous — they would
    // read "no broadcast" off a subscriber that never fires for anything.
    assert.strictEqual(broadcasts.length, 1, 'ENTER: the subscriber is wired and fired for a Claude turn');
    assert.strictEqual(broadcasts[0].channel, 'wire-quota');
    assert.strictEqual(broadcasts[0].payload.primary.used_pct, 95);
    assert.strictEqual(m.quotaStore().snapshot().representative_window, '7d');
  });
});

test('seam: a codex 429 does NOT touch the Claude reading and does not broadcast', async () => {
  // The bug this gate exists for: a 429 carries no ratelimit headers from ANY
  // provider, so the store's 429 branch is reached on status alone and files
  // the refusal against `_lastAccount` — the Claude org. The chip then reads
  // "requests being refused" for a plan that was never refused.
  await onWire(async ({ wire, m, broadcasts }) => {
    wire.emit('response', {
      agent: 'a', provider: 'anthropic', reqId: 'r1', status: 200, headers: CLAUDE_HEADERS,
    });
    assert.strictEqual(broadcasts.length, 1, 'ENTER: a Claude reading exists to be corrupted');
    const before = m.quotaStore().snapshot();
    assert.strictEqual(before.last_429, undefined, 'ENTER: and it carries no refusal yet');

    wire.emit('response', {
      agent: 'codex-1', provider: 'openai', reqId: 'r2', status: 429, headers: CODEX_429_HEADERS,
    });

    const after = m.quotaStore().snapshot();
    assert.strictEqual(after.last_429, undefined, 'the codex refusal was not filed against the Claude org');
    assert.strictEqual(after.last_429_age_s, undefined);
    assert.strictEqual(broadcasts.length, 1, 'and nothing was pushed at the renderer');
  });
});

test('seam: an ANTHROPIC 429 still files, so the gate is on the provider and not on 429s', async () => {
  // The differential arm. Without it, a subscriber that dropped every 429
  // would pass the test above — and the chip would stop reporting refusals
  // entirely, which is the failure the loud level exists to prevent.
  await onWire(async ({ wire, m, broadcasts }) => {
    wire.emit('response', {
      agent: 'a', provider: 'anthropic', reqId: 'r1', status: 200, headers: CLAUDE_HEADERS,
    });
    wire.emit('response', {
      agent: 'a', provider: 'anthropic', reqId: 'r2', status: 429, headers: { 'content-type': 'application/json' },
    });
    const snap = m.quotaStore().snapshot();
    assert.strictEqual(typeof snap.last_429, 'number', 'the Claude refusal was recorded');
    assert.strictEqual(broadcasts.length, 2, 'and the chip was told — a refusal is when it matters most');
  });
});

test('seam: a codex turn with a 200 contributes nothing either', async () => {
  await onWire(async ({ wire, m, broadcasts }) => {
    wire.emit('response', {
      agent: 'codex-1', provider: 'openai', reqId: 'r1', status: 200, headers: { 'content-type': 'text/event-stream' },
    });
    assert.strictEqual(broadcasts.length, 0);
    assert.strictEqual(m.quotaStore().snapshot(), null);
  });
});

test('wire:quota serves the stored reading, so a window opened before any turn is not blank', async () => {
  // api-contract pins that this channel is REGISTERED; nothing pinned that it
  // returns anything. The lazy store is the other half: it must build without a
  // wire, or the restored reading is unreachable at exactly the cold launch
  // persistence exists for.
  const { m } = mkManager();
  const handlers = new Map();
  registerIpcHandlers({
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    manager: m,
    persistence: {},
    log: { info: () => {}, warn: () => {} },
  });
  const fn = handlers.get('wire:quota');
  assert.ok(fn, 'ENTER: the handler registered — every assertion below is vacuous otherwise');
  try {
    assert.strictEqual(fn(null), null, 'nothing observed yet reads as null, not as a hollow reading');
    // No wire was ever built here: the store is reachable on its own.
    m.quotaStore().note(CLAUDE_HEADERS);
    const snap = fn(null);
    assert.strictEqual(snap.primary.used_pct, 95);
    assert.strictEqual(snap.representative_window, '7d');
  } finally {
    if (m._quotaStore) m._quotaStore.close();
  }
});
