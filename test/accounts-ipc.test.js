'use strict';
// accounts-ipc.test.js — t811. The `accounts:*` IPC handlers and the bulk
// move-by-model sweep behind `accounts:move-by-model`.
//
// registerIpcHandlers is transport-agnostic, so this drives it with capturing
// seams and an in-memory accounts store — no electron, no engine, no PTY.
//
// THE LOAD-BEARING CLAIM IS THE SKIP LIST, not the move. `move-by-model` kills
// and respawns live seats, and the one thing the operator must be able to trust
// is that it will not restart a seat that is mid-turn: the sweep is run
// PRECISELY while seats are working (that is when the Fable pool is emptying),
// and a restart there destroys the turn. So every skip carries a literal reason
// and each is asserted by its text, not merely by absence from `moved`.

const { test } = require('node:test');
const assert = require('node:assert');
const { registerIpcHandlers } = require('../ipc-handlers');

// An in-memory stand-in matching accounts.js's surface. Deliberately not the
// real module: these tests are about the HANDLERS, and the real registry's
// behaviour is pinned in test/accounts.test.js.
function makeAccounts(rows = []) {
  const data = rows.map((r) => ({ ...r }));
  return {
    list: () => [{ label: 'default', email: null, configDir: '/home/u/.claude', plan: 'unknown', addedAt: null }, ...data],
    add({ label, email = null, plan = 'unknown', configDir = null }) {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(label || ''))) throw new Error(`invalid account label "${label}"`);
      if (data.some((a) => a.label === label)) throw new Error(`account "${label}" already exists`);
      const row = { label, email, plan, configDir: configDir || `/minted/${label}`, addedAt: 1 };
      data.push(row);
      return row;
    },
    remove(label) {
      const before = data.length;
      for (let i = data.length - 1; i >= 0; i--) if (data[i].label === label) data.splice(i, 1);
      return data.length !== before;
    },
    resync: (label) => (data.some((a) => a.label === label) ? { ok: true, copied: true } : { ok: false, error: `unknown account "${label}"` }),
    configDirFor: (label) => (label === 'default' ? '/home/u/.claude' : (data.find((a) => a.label === label) || {}).configDir || null),
    labelFor: () => 'default',
    _rows: data,
  };
}

function fixture({ rows = [], moveAccountByModel, enableAccounts = true } = {}) {
  const handlers = new Map();
  const accounts = makeAccounts(rows);
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    accounts,
    moveAccountByModel,
    enableAccounts,
    workspaceOfSender: () => 'ws-1',
    log: { info() {}, error() {} },
  });
  return { handlers, accounts, call: (ch, arg) => handlers.get(ch)(null, arg) };
}

test('accounts:list puts `default` first and returns the registered rows after it', () => {
  const { call } = fixture({ rows: [{ label: 'sub-2', plan: 'max', configDir: '/minted/sub-2' }] });
  const res = call('accounts:list');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.accounts.map((a) => a.label), ['default', 'sub-2']);
});

test('accounts:add returns the created row; a bad label comes back as { ok:false, error }', () => {
  const { call, accounts } = fixture();
  const ok = call('accounts:add', { label: 'sub-2', email: 'b@example.com', plan: 'max' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.account.label, 'sub-2');
  assert.strictEqual(ok.account.configDir, '/minted/sub-2', 'no configDir supplied → minted');

  // A store throw becomes a result, never a rejected invoke: the renderer shows
  // the reason in the dialog.
  const bad = call('accounts:add', { label: 'Sub 2', plan: 'max' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /invalid account label/);
  assert.deepStrictEqual(accounts._rows.map((a) => a.label), ['sub-2'], 'the rejected add persisted nothing');
});

test('accounts:remove reports an unknown label rather than silently succeeding', () => {
  const { call } = fixture({ rows: [{ label: 'sub-2', plan: 'max', configDir: '/minted/sub-2' }] });
  assert.deepStrictEqual(call('accounts:remove', { label: 'sub-2' }), { ok: true });
  const missing = call('accounts:remove', { label: 'sub-2' });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error, /unknown account "sub-2"/);
});

test('accounts:resync passes the store result straight through', () => {
  const { call } = fixture({ rows: [{ label: 'sub-2', plan: 'max', configDir: '/minted/sub-2' }] });
  assert.deepStrictEqual(call('accounts:resync', { label: 'sub-2' }), { ok: true, copied: true });
  assert.deepStrictEqual(call('accounts:resync', { label: 'nope' }), { ok: false, error: 'unknown account "nope"' });
});

test('every accounts:* handler answers { ok:false } rather than throwing on a host with no store', () => {
  const { call } = fixture({ rows: [] });
  // Re-register with the store absent — the shape every other store-backed
  // handler in this file uses, and the reason a partial deps object (a plugin
  // harness, a test) cannot crash the registrar.
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn),
    enableAccounts: true, workspaceOfSender: () => 'ws-1', log: { info() {}, error() {} },
  });
  for (const ch of ['accounts:list', 'accounts:add', 'accounts:remove', 'accounts:resync']) {
    const res = handlers.get(ch)(null, { label: 'sub-2' });
    assert.strictEqual(res.ok, false, `${ch} returns a result`);
    assert.match(res.error, /not supported on this host/, `${ch} says why`);
  }
  // ENTER: with a store present the same channel succeeds, so the failures
  // above are the absent store and not a broken handler.
  assert.strictEqual(call('accounts:list').ok, true);
});

test('enableAccounts:false registers NO accounts channel at all — the gate is absence', () => {
  // Registration IS the capability on the web surface (web-host dispatches any
  // registered channel by name), so a flag the handler consults would be no gate.
  const { handlers } = fixture({ enableAccounts: false });
  for (const ch of ['accounts:list', 'accounts:add', 'accounts:remove', 'accounts:resync', 'accounts:move-by-model']) {
    assert.strictEqual(handlers.has(ch), false, `${ch} must not be registered`);
  }
  // ENTER: with the gate open they ARE registered, so the absence above is the
  // gate and not a registrar that never ran.
  const open = fixture({ enableAccounts: true });
  assert.strictEqual(open.handlers.has('accounts:list'), true);
});

test('accounts:move-by-model forwards model + label and returns the sweep result', async () => {
  let seen = null;
  const { call } = fixture({
    moveAccountByModel: async (model, label, wsId) => {
      seen = { model, label, wsId };
      return { ok: true, moved: ['clodex'], skipped: [] };
    },
  });
  const res = await call('accounts:move-by-model', { model: 'fable', label: 'sub-2' });
  assert.deepStrictEqual(seen, { model: 'fable', label: 'sub-2', wsId: 'ws-1' });
  assert.deepStrictEqual(res, { ok: true, moved: ['clodex'], skipped: [] });
});

test('accounts:move-by-model turns a throw into { ok:false } with empty moved/skipped', async () => {
  const { call } = fixture({ moveAccountByModel: async () => { throw new Error('boom'); } });
  const res = await call('accounts:move-by-model', { model: 'fable', label: 'sub-2' });
  assert.deepStrictEqual(res, { ok: false, error: 'boom', moved: [], skipped: [] });
});

// ---------------------------------------------------------------------------
// The sweep itself. `sweepAccountMove` takes every seam it touches as a
// parameter — live sessions, the persistence read, the configDir lookup and the
// restart — so the three-session scenario below runs with no PTY, no engine and
// no real ~/.clodex. engine.js's moveAccountByModel is a thin binding of these
// four seams to the real manager/persistence/accounts/applySessionArgs.
const { sweepAccountMove } = require('../accounts');

// [fable idle, opus idle, fable busy] — the spec's scenario. `fable-idle` is the
// only seat that must move: `opus-idle` is on the wrong model and `fable-busy`
// is mid-turn.
function sweepFixture() {
  const entries = {
    'fable-idle': { extraArgs: ['--model', 'claude-fable-5-1'], workspaceId: 'ws-1' },
    'opus-idle': { extraArgs: ['--model', 'claude-opus-5'], workspaceId: 'ws-1' },
    'fable-busy': { extraArgs: ['--model=fable'], workspaceId: 'ws-1' },
  };
  const restarts = [];
  return {
    entries,
    restarts,
    run: (overrides = {}) => sweepAccountMove({
      model: 'fable',
      label: 'sub-2',
      liveSessions: [
        { name: 'fable-idle', type: 'claude', activityState: 'idle' },
        { name: 'opus-idle', type: 'claude', activityState: 'idle' },
        { name: 'fable-busy', type: 'claude', activityState: 'thinking' },
      ],
      getEntry: (n) => entries[n],
      configDirFor: (l) => (l === 'sub-2' ? '/minted/sub-2' : null),
      applyArgs: async (name, patch, ws) => {
        restarts.push({ name, patch, ws });
        entries[name] = { ...entries[name], env: patch.env };
        return { ok: true, restarted: true };
      },
      ...overrides,
    }),
  };
}

test('sweep: [fable idle, opus idle, fable busy] → moves ONLY the idle fable seat', async () => {
  const fx = sweepFixture();
  const res = await fx.run();
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.moved, ['fable-idle']);
  // The reasons are asserted as LITERALS: "not in moved" would also hold if the
  // sweep skipped everything for the wrong reason, or for no reason at all.
  assert.deepStrictEqual(res.skipped, [
    { name: 'opus-idle', reason: 'model fable not selected' },
    { name: 'fable-busy', reason: 'session is mid-turn' },
  ]);
});

test('sweep: the env is patched on EXACTLY one entry, and the restart ran once for it', async () => {
  const fx = sweepFixture();
  await fx.run();
  assert.strictEqual(fx.restarts.length, 1, 'one restart, not three');
  assert.strictEqual(fx.restarts[0].name, 'fable-idle');
  assert.strictEqual(fx.restarts[0].patch.restart, true, 'the move applies now, not at the next spawn');
  assert.strictEqual(fx.restarts[0].patch.env.CLAUDE_CONFIG_DIR, '/minted/sub-2');
  assert.strictEqual(fx.restarts[0].ws, 'ws-1', 'the seat keeps its own workspace');
  // The other two entries are untouched — a sweep that patched env on every
  // matching row and merely restarted one would leave them pointing at an
  // account they never respawn on.
  assert.strictEqual('env' in fx.entries['opus-idle'], false);
  assert.strictEqual('env' in fx.entries['fable-busy'], false);
});

test('sweep: `fable` matches the dated claude-fable-5-1 id on a live seat', async () => {
  // The same claim as the unit test on modelSelects, made where it bites: the
  // operator types `fable`, the seat's extraArgs carry a dated id.
  const fx = sweepFixture();
  const res = await fx.run();
  assert.ok(res.moved.includes('fable-idle'), 'the dated id matched the alias');
});

test('sweep: a seat already on that account is skipped by reason, not re-restarted', async () => {
  const fx = sweepFixture();
  fx.entries['fable-idle'].env = { CLAUDE_CONFIG_DIR: '/minted/sub-2' };
  const res = await fx.run();
  assert.deepStrictEqual(res.moved, []);
  assert.deepStrictEqual(res.skipped[0], { name: 'fable-idle', reason: 'already on account sub-2' });
  assert.strictEqual(fx.restarts.length, 0, 'no PTY was killed to achieve nothing');
});

test('sweep: the move PRESERVES the seat\'s other env vars', async () => {
  const fx = sweepFixture();
  fx.entries['fable-idle'].env = { MY_KEY: 'keep-me' };
  await fx.run();
  assert.deepStrictEqual(fx.restarts[0].patch.env, { MY_KEY: 'keep-me', CLAUDE_CONFIG_DIR: '/minted/sub-2' });
});

test('sweep: a non-claude session is skipped before its model is ever considered', async () => {
  const res = await sweepAccountMove({
    model: 'fable',
    label: 'sub-2',
    liveSessions: [{ name: 'a-shell', type: 'bash', activityState: 'idle' }],
    getEntry: () => { throw new Error('persistence must not be read for a bash seat'); },
    configDirFor: () => '/minted/sub-2',
    applyArgs: async () => { throw new Error('must not restart a bash seat'); },
  });
  assert.deepStrictEqual(res.skipped, [{ name: 'a-shell', reason: 'not a claude session' }]);
});

test('sweep: an unknown account moves nothing at all', async () => {
  const fx = sweepFixture();
  const res = await fx.run({ label: 'nope', configDirFor: () => null });
  assert.deepStrictEqual(res, { ok: false, error: 'unknown account "nope"', moved: [], skipped: [] });
  assert.strictEqual(fx.restarts.length, 0);
});

test('sweep: a failed restart lands in skipped with the error, not in moved', async () => {
  const fx = sweepFixture();
  const res = await fx.run({ applyArgs: async () => ({ ok: false, error: 'old process did not exit in time' }) });
  assert.deepStrictEqual(res.moved, []);
  assert.deepStrictEqual(res.skipped[0], { name: 'fable-idle', reason: 'old process did not exit in time' });
});

test('sweep: restarts are SEQUENTIAL — never two seats mid-kill at once', async () => {
  // Each restart kills a PTY and rewrites one persistence file. A Promise.all
  // sweep would overlap them, which is what this pins.
  let inFlight = 0;
  let maxInFlight = 0;
  const entries = {
    a: { extraArgs: ['--model', 'fable'] },
    b: { extraArgs: ['--model', 'fable'] },
    c: { extraArgs: ['--model', 'fable'] },
  };
  const res = await sweepAccountMove({
    model: 'fable',
    label: 'sub-2',
    liveSessions: ['a', 'b', 'c'].map((name) => ({ name, type: 'claude', activityState: 'idle' })),
    getEntry: (n) => entries[n],
    configDirFor: () => '/minted/sub-2',
    applyArgs: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true };
    },
  });
  assert.deepStrictEqual(res.moved, ['a', 'b', 'c'], 'ENTER: all three did move — otherwise the count below is trivial');
  assert.strictEqual(maxInFlight, 1, 'exactly one restart in flight at any moment');
});

// --- t812 riders -------------------------------------------------------------

test('accounts:move-by-model refuses an empty model or label BEFORE reaching the sweep', async () => {
  // An empty model selects nothing in modelSelects, so the sweep would walk
  // every live seat and skip each one — an expensive no-op the handler reported
  // as `{ ok: true, moved: [] }`, indistinguishable from "nothing matched".
  let called = 0;
  const { call } = fixture({ moveAccountByModel: async () => { called++; return { ok: true, moved: [], skipped: [] }; } });
  const want = { ok: false, error: 'move needs both a model and an account label', moved: [], skipped: [] };
  assert.deepStrictEqual(await call('accounts:move-by-model', { model: '', label: 'sub-2' }), want);
  assert.deepStrictEqual(await call('accounts:move-by-model', { model: 'fable', label: '' }), want);
  assert.deepStrictEqual(await call('accounts:move-by-model', {}), want);
  assert.deepStrictEqual(await call('accounts:move-by-model', null), want);
  assert.strictEqual(called, 0, 'nothing reached the sweep');
  // ENTER: a complete pair still gets through, so the guard is on the empties
  // and not on the channel.
  assert.deepStrictEqual(
    await call('accounts:move-by-model', { model: 'fable', label: 'sub-2' }),
    { ok: true, moved: [], skipped: [] },
  );
  assert.strictEqual(called, 1);
});

test('sweep: a seat with NO CLAUDE_CONFIG_DIR is already on `default` and is not restarted', async () => {
  // The absence of the var IS the default selection (accounts.js's rule), so a
  // move to `default` must skip such a seat. Without the equivalence it reads
  // `undefined !== '/home/u/.claude'` and kills a PTY to write a variable that
  // changes nothing.
  const fx = sweepFixture();
  const res = await fx.run({
    label: 'default',
    configDirFor: (l) => (l === 'default' ? '/home/u/.claude' : null),
  });
  assert.deepStrictEqual(res.moved, [], 'the only matching seat was already there');
  assert.deepStrictEqual(res.skipped[0], { name: 'fable-idle', reason: 'already on account default' });
  assert.strictEqual(fx.restarts.length, 0, 'no PTY was killed to achieve nothing');
});

test('sweep: the equivalence is DEFAULT-only — a seat with no var still moves to a registered account', async () => {
  // The same seats, the same missing var, moving to `sub-2` instead: this must
  // still restart, or the rider above would have turned every move into a skip.
  const fx = sweepFixture();
  const res = await fx.run();
  assert.deepStrictEqual(res.moved, ['fable-idle']);
  assert.strictEqual(fx.restarts.length, 1);
});
