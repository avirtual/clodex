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

// The subscriber defers its work to setImmediate so the store's disk sync stays
// off time-to-first-token. Every assertion about it therefore has to cross one
// macrotask boundary — asserting synchronously after emit() reads the state
// before the subscriber has run at all, which would pass every "nothing
// happened" case vacuously.
const tick = () => new Promise((r) => setImmediate(r));

function mkManager(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-t418-seam-'));
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    fs,
    path,
    getUserDataPath: () => root,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...extra,
  });
  const m = new SessionManager();
  const broadcasts = [];
  m._broadcast = (channel, payload) => broadcasts.push({ channel, payload });
  return { m, broadcasts, root };
}

// Drives the REAL subscriber by emitting on the REAL wire, then tears the port
// down. `fn` receives the wire so each test emits the responses it cares about.
async function onWire(fn, extra = {}) {
  const { m, broadcasts, root } = mkManager(extra);
  const wire = await m._ensureWire();
  try {
    await fn({ wire, m, broadcasts });
  } finally {
    await wire.close();
    if (m._holdKeeper) m._holdKeeper.stop();
    const store = m._quotaStore;
    if (store) store.close();
    // _ensureWire opens a real WarmthStore too; both are sqlite handles this
    // test has no use for after the emit.
    if (wire.warmth) wire.warmth.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('seam: an anthropic response with quota headers reaches the store and broadcasts', async () => {
  await onWire(async ({ wire, m, broadcasts }) => {
    wire.emit('response', {
      agent: 'a', provider: 'anthropic', reqId: 'r1', status: 200, headers: CLAUDE_HEADERS,
    });
    await tick();
    // ENTER: without this the codex assertions below are vacuous — they would
    // read "no broadcast" off a subscriber that never fires for anything.
    assert.strictEqual(broadcasts.length, 1, 'ENTER: the subscriber is wired and fired for a Claude turn');
    assert.strictEqual(broadcasts[0].channel, 'wire-quota');
    assert.strictEqual(broadcasts[0].payload.latest.primary.used_pct, 95);
    assert.strictEqual(broadcasts[0].payload.accounts.length, 1);
    assert.strictEqual(m.quotaStore().snapshot().representative_window, '7d');
  });
});

test('seam: a codex 429 does NOT touch the Claude reading and does not broadcast', async () => {
  // The bug this gate exists for: a 429 carries no ratelimit headers from ANY
  // provider, so the store's 429 branch is reached on status alone and files
  // the refusal against `_lastAccount` — the Claude org. The chip then reads
  // "rate-limited … ago" for a plan that was never refused.
  await onWire(async ({ wire, m, broadcasts }) => {
    wire.emit('response', {
      agent: 'a', provider: 'anthropic', reqId: 'r1', status: 200, headers: CLAUDE_HEADERS,
    });
    await tick();
    assert.strictEqual(broadcasts.length, 1, 'ENTER: a Claude reading exists to be corrupted');
    const before = m.quotaStore().snapshot();
    assert.strictEqual(before.last_429, undefined, 'ENTER: and it carries no refusal yet');

    wire.emit('response', {
      agent: 'codex-1', provider: 'openai', reqId: 'r2', status: 429, headers: CODEX_429_HEADERS,
    });
    await tick();

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
    await tick();
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
    await tick();
    assert.strictEqual(broadcasts.length, 0);
    assert.strictEqual(m.quotaStore().snapshot(), null);
  });
});

// ---- which ACCOUNT a reading is filed under (t813) ----

// The consumer's half of the per-account keying. The store's own fallback
// (key by the org header) is exercised in wire-quota.test.js; what only the
// seam can show is that the SEAT's label reaches note() at all — the store
// cannot tell a label it was never handed from one that does not exist.
//
// `agent` IS the session name: the in-process wire's registerAgent() takes the
// bare name (session-manager.js `_ensureWire`), and only the EXTERNAL proxy id
// is a distinct `proxyAgent` label. A fixture that set one here would pass
// against a lookup that never matches a real event.
const ACCOUNTS = {
  labelResolver: () => (dir) => (dir === '/cfg/sub-2' ? 'sub-2' : null),
};

function recordingStore(m) {
  const calls = [];
  m._quotaStore = {
    note: (headers, opts) => { calls.push(opts); return null; },
    snapshot: () => null,
    snapshotAll: () => [],
    close: () => {},
  };
  return calls;
}

test('seam: a response from a seat on a registered account is filed under that label', async () => {
  await onWire(async ({ wire, m }) => {
    const calls = recordingStore(m);
    m.sessions.set('worker', { name: 'worker' });
    wire.emit('response', {
      agent: 'worker', provider: 'anthropic', reqId: 'r1', status: 200, headers: CLAUDE_HEADERS,
    });
    await tick();
    assert.strictEqual(calls.length, 1, 'ENTER: the consumer reached the store at all — every field read below is off this call');
    assert.strictEqual(calls[0].account, 'sub-2');
  }, {
    getAccounts: () => ACCOUNTS,
    getPersistence: () => ({
      list: () => [],
      get: (n) => (n === 'worker' ? { env: { CLAUDE_CONFIG_DIR: '/cfg/sub-2' } } : null),
    }),
  });
});

test('seam: an agent no live session claims is filed with NO label, so the store keys by org', async () => {
  // Null and not 'default': a seat we cannot place would otherwise pile its
  // numbers onto the default account's row, which is worse than the org keying
  // that at least separates two real orgs.
  await onWire(async ({ wire, m }) => {
    const calls = recordingStore(m);
    wire.emit('response', {
      agent: 'cc-ghost-9', provider: 'anthropic', reqId: 'r1', status: 200, headers: CLAUDE_HEADERS,
    });
    await tick();
    assert.strictEqual(calls.length, 1, 'ENTER: the consumer reached the store — an absent call would pass the check below vacuously');
    assert.strictEqual(calls[0].account, null);
  }, {
    getAccounts: () => ACCOUNTS,
    getPersistence: () => ({ list: () => [], get: () => null }),
  });
});

test('wire:quota serves the stored reading, so a window opened before any turn is not blank', async () => {
  // api-contract pins that this channel is REGISTERED; nothing pinned that it
  // returns anything. The lazy store is the other half: it must build without a
  // wire, or the restored reading is unreachable at exactly the cold launch
  // persistence exists for.
  const { m, root } = mkManager();
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
    const payload = fn(null);
    // The SHAPE is the pin: api-contract only says the channel exists, and the
    // renderer reads `latest` for the restore path and `accounts` for the chips.
    // A handler that went back to returning the flat snapshot would leave both
    // undefined and blank the bar at exactly the cold launch this serves.
    assert.deepStrictEqual(Object.keys(payload).sort(), ['accounts', 'latest']);
    assert.strictEqual(payload.latest.primary.used_pct, 95);
    assert.strictEqual(payload.latest.representative_window, '7d');
    assert.strictEqual(payload.accounts.length, 1);
    assert.strictEqual(payload.accounts[0].account, 'a0aca1fb-5695-4f38-854c-28911e5c20e4',
      'no session claims this agent, so the store fell back to keying by the org header');
    assert.strictEqual(payload.accounts[0].primary.used_pct, 95);
  } finally {
    if (m._quotaStore) m._quotaStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
