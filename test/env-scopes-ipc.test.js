'use strict';
// env-scopes-ipc.test.js — the T46 GUI env-scope IPC handlers (get/set/delete).
// The load-bearing contract is SECRETS DISCIPLINE: a value marked `secret` is
// WRITE-ONLY through IPC — the get handler must NEVER return it, only
// { key, secret:true, hasValue:true } (mirror of the remote/peer token surfaces).
// Non-secret rows return { key, value }. registerIpcHandlers is transport-agnostic
// (Phase 1), so we drive it with capturing seams + an in-memory envScopes store
// fake matching stores.js's shape — no electron, no engine.

const { test } = require('node:test');
const assert = require('node:assert');
const { registerIpcHandlers } = require('../ipc-handlers');
const { envKeyError } = require('../env-scopes');

// An in-memory stand-in for stores.js's envScopes store (same method surface the
// handler calls: getScope/set/remove). set() enforces envKeyError exactly like the
// real store so the handler's throw→{ok:false,error} path is exercised for real.
function makeStore(seed = { global: {}, workspaces: {} }) {
  const data = JSON.parse(JSON.stringify(seed));
  return {
    getScope(scope) {
      return scope === 'global' ? (data.global || {}) : ((data.workspaces && data.workspaces[scope]) || {});
    },
    set(scope, key, value, secret) {
      const err = envKeyError(key, value);
      if (err) throw new Error(err);
      const target = scope === 'global'
        ? (data.global = data.global || {})
        : ((data.workspaces = data.workspaces || {}), (data.workspaces[scope] = data.workspaces[scope] || {}));
      target[key] = { value: String(value == null ? '' : value), secret: secret === true };
    },
    remove(scope, key) {
      if (scope === 'global') { if (data.global) delete data.global[key]; }
      else if (data.workspaces && data.workspaces[scope]) { delete data.workspaces[scope][key]; }
    },
    _data: data, // test-only peek at what actually persisted
  };
}

function fixture(seed) {
  const handlers = new Map();
  const capture = { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) };
  const envScopes = makeStore(seed);
  registerIpcHandlers({ ...capture, envScopes, log: { info() {}, error() {} } });
  return {
    envScopes,
    get: (scope) => handlers.get('envScopes:get')(null, scope),
    set: (scope, key, value, secret) => handlers.get('envScopes:set')(null, scope, key, value, secret),
    del: (scope, key) => handlers.get('envScopes:delete')(null, scope, key),
  };
}

test('envScopes:get MASKS secret values — { key, secret:true, hasValue:true }, never the bytes', () => {
  const { get } = fixture({
    global: {
      AWS_PROFILE: { value: 'acct', secret: false },
      SECRET_TOKEN: { value: 'super-secret-value', secret: true },
    },
    workspaces: {},
  });
  const res = get('global');
  assert.strictEqual(res.ok, true);
  // The whole result serialized must not contain the secret bytes ANYWHERE.
  assert.ok(!JSON.stringify(res).includes('super-secret-value'), 'the secret value never leaves the main process');
  const secretRow = res.vars.find((v) => v.key === 'SECRET_TOKEN');
  assert.deepStrictEqual(secretRow, { key: 'SECRET_TOKEN', secret: true, hasValue: true });
  assert.ok(!('value' in secretRow), 'a secret row carries NO value key at all');
  // A non-secret row shows its value so the editor can display + edit it.
  const plainRow = res.vars.find((v) => v.key === 'AWS_PROFILE');
  assert.deepStrictEqual(plainRow, { key: 'AWS_PROFILE', secret: false, value: 'acct' });
  // vars are sorted by key.
  assert.deepStrictEqual(res.vars.map((v) => v.key), ['AWS_PROFILE', 'SECRET_TOKEN']);
});

test('envScopes:get returns an empty list for an unset scope (no throw)', () => {
  const { get } = fixture();
  assert.deepStrictEqual(get('global'), { ok: true, scope: 'global', vars: [] });
  assert.deepStrictEqual(get('ws-xyz'), { ok: true, scope: 'ws-xyz', vars: [] });
});

test('envScopes:set stores { value, secret } and round-trips through the masking get', () => {
  const { set, get, envScopes } = fixture();
  assert.deepStrictEqual(set('global', 'K', 'v', false), { ok: true });
  assert.deepStrictEqual(set('global', 'TOK', 'sekret', true), { ok: true });
  assert.deepStrictEqual(envScopes._data.global.TOK, { value: 'sekret', secret: true });
  const res = get('global');
  assert.ok(!JSON.stringify(res).includes('sekret'), 'a just-set secret is masked on read-back');
  assert.deepStrictEqual(res.vars.find((v) => v.key === 'TOK'), { key: 'TOK', secret: true, hasValue: true });
});

test('envScopes:set surfaces a deny-listed key as { ok:false, error } (never silently)', () => {
  const { set, envScopes } = fixture();
  const res = set('global', 'CLODEX_REMOTE_TOKEN', 'leak', false);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /reserved/);
  assert.ok(!('CLODEX_REMOTE_TOKEN' in envScopes._data.global), 'the deny key never landed in the store');
});

test('envScopes:set surfaces an invalid key and a newline value as errors', () => {
  const { set } = fixture();
  assert.match(set('global', '2bad', 'x', false).error, /invalid env key/);
  assert.match(set('global', 'OK', 'a\nb', false).error, /newline/);
});

test('envScopes:delete removes a key from the scope', () => {
  const { del, get } = fixture({ global: { A: { value: '1' }, B: { value: '2' } }, workspaces: {} });
  assert.deepStrictEqual(del('global', 'A'), { ok: true });
  assert.deepStrictEqual(get('global').vars.map((v) => v.key), ['B']);
});

test('envScopes:set / get target a workspace scope by id', () => {
  const { set, get } = fixture();
  set('ws-1', 'WK', 'wv', false);
  assert.deepStrictEqual(get('ws-1').vars, [{ key: 'WK', secret: false, value: 'wv' }]);
  assert.deepStrictEqual(get('global').vars, [], 'the global scope is untouched');
});

// --- envDefaults:get / :restore (t676) ---------------------------------------
// The renderer reads the shipped defaults through their own channel rather than
// requiring resources/env-defaults.json: the web frontend builds window.api from
// the same api-contract table and has no filesystem at all.

function defaultsFixture(store) {
  const handlers = new Map();
  const capture = { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) };
  registerIpcHandlers({ ...capture, envDefaults: store, log: { info() {}, error() {} } });
  return {
    get: () => handlers.get('envDefaults:get')(null),
    restore: () => handlers.get('envDefaults:restore')(null),
    registered: (ch) => handlers.has(ch),
  };
}

test('envDefaults:get returns the shipped file verbatim — values AND notes', () => {
  const shipped = { A: { value: 'a', note: 'the a note' }, B: { value: 'b', note: 'the b note' } };
  const { get } = defaultsFixture({ list: () => shipped, restore: () => {} });
  assert.deepStrictEqual(get(), { ok: true, defaults: shipped },
    'the note is what the Env page shows on hover, so a get that dropped it would leave every row unexplained');
});

test('envDefaults:restore calls the store once and reports ok', () => {
  let calls = 0;
  const { restore } = defaultsFixture({ list: () => ({}), restore: () => { calls += 1; } });
  assert.deepStrictEqual(restore(), { ok: true });
  assert.strictEqual(calls, 1);
});

test('envDefaults:restore surfaces a throwing store as { ok:false, error }', () => {
  const { restore } = defaultsFixture({
    list: () => ({}),
    restore: () => { throw new Error('disk full'); },
  });
  const res = restore();
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /disk full/);
});

test('a host with no envDefaults store still registers both channels, refusing in shape', () => {
  // Registration is unconditional so the renderer gets a shaped { ok:false }
  // rather than an unhandled-channel rejection it does not check for.
  const { get, restore, registered } = defaultsFixture(undefined);
  assert.ok(registered('envDefaults:get') && registered('envDefaults:restore'));
  assert.strictEqual(get().ok, false);
  assert.match(get().error, /not supported on this host/);
  assert.strictEqual(restore().ok, false);
});
