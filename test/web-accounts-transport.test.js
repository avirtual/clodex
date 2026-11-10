'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createWebHost } = require('../web-host');
const { registerIpcHandlers } = require('../ipc-handlers');
const { createAccounts } = require('../accounts');
const { INSECURE_KEY_REFUSAL, keyTransportRefusal } = require('../renderer/lib/account-row');
const { mkTmpRoot } = require('./lib/tmp-roots');

const KEY = 'sk-test-LEAKCANARY';
const REFUSAL = 'an API key is accepted only over a local or encrypted connection (set CLODEX_WEB_TRUSTED_TRANSPORT=1 on the node if its tunnel is encrypted)';

function rig({ dropDep = false, trustedTransport } = {}) {
  const root = mkTmpRoot('clx-web-accounts-');
  const claudeHome = path.join(root, 'home', '.claude');
  fs.mkdirSync(claudeHome, { recursive: true });
  const accounts = createAccounts({ fs, path, os, clodexHome: path.join(root, 'clodex'), claudeHome });
  const dir = path.join(root, 'acct');
  accounts.add({ label: 'api-1', plan: 'api', configDir: dir });
  const logged = [];
  const capture = (...args) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  const log = { info: capture, warn: capture, error: capture, debug: capture };
  const manager = { registerWindow() {}, unregisterWindow() {}, listForWorkspace: () => [] };
  const host = createWebHost({
    engine: { stores: {}, manager, accounts },
    log, host: '127.0.0.1', port: 0, userDataPath: root, ...(trustedTransport === undefined ? {} : { trustedTransport }),
    registerHandlers: (deps) => {
      if (!dropDep) return registerIpcHandlers(deps);
      const rest = { ...deps };
      delete rest.secureTransportOfSender;
      return registerIpcHandlers(rest);
    },
  });

  function connect({ remoteAddress, origin }) {
    const ws = new EventEmitter();
    ws.OPEN = 1;
    ws.readyState = 1;
    const frames = [];
    const waiters = new Map();
    ws.send = (raw) => {
      const f = JSON.parse(raw);
      frames.push(f);
      if (f.t === 'reply' && waiters.has(f.id)) { waiters.get(f.id)(f); waiters.delete(f.id); }
    };
    ws.close = () => { ws.readyState = 3; };
    const req = { socket: { remoteAddress }, headers: origin ? { origin } : {} };
    host._wss.emit('connection', ws, req);
    ws.emit('message', JSON.stringify({ t: 'hello' }));
    let seq = 0;
    const invoke = (channel, ...args) => new Promise((resolve) => {
      const id = ++seq;
      waiters.set(id, resolve);
      ws.emit('message', JSON.stringify({ t: 'invoke', id, channel, args }));
    });
    return { frames, invoke };
  }

  const settingsKey = () => {
    const file = path.join(dir, 'settings.json');
    if (!fs.existsSync(file)) return undefined;
    return (JSON.parse(fs.readFileSync(file, 'utf-8')).env || {}).ANTHROPIC_API_KEY;
  };
  return { host, connect, logged, settingsKey };
}

test('(a) a non-loopback, non-https connection is refused and writes nothing', async () => {
  const r = rig();
  try {
    const c = r.connect({ remoteAddress: '203.0.113.7', origin: 'http://203.0.113.7:8080' });
    assert.ok(c.frames.some((f) => f.t === 'welcome'), 'ENTER: the hello was accepted');
    const reply = await c.invoke('accounts:setApiKey', 'api-1', KEY);
    assert.deepStrictEqual(reply.value, { ok: false, error: REFUSAL });
    assert.strictEqual(r.settingsKey(), undefined, 'nothing written');
  } finally { r.host.close(); }
});

test('(b) a loopback connection is accepted, and so is an https Origin from elsewhere', async () => {
  const r = rig();
  try {
    const local = r.connect({ remoteAddress: '::ffff:127.0.0.1' });
    assert.deepStrictEqual((await local.invoke('accounts:setApiKey', 'api-1', KEY)).value, { ok: true });
    assert.strictEqual(r.settingsKey(), KEY);
    const tls = r.connect({ remoteAddress: '203.0.113.7', origin: 'https://clodex.example' });
    assert.deepStrictEqual((await tls.invoke('accounts:setApiKey', 'api-1', `${KEY}2`)).value, { ok: true });
    assert.strictEqual(r.settingsKey(), `${KEY}2`);
  } finally { r.host.close(); }
});

test('(c) with the dep absent, even a loopback connection is refused', async () => {
  const r = rig({ dropDep: true });
  try {
    const c = r.connect({ remoteAddress: '127.0.0.1' });
    const reply = await c.invoke('accounts:setApiKey', 'api-1', KEY);
    assert.deepStrictEqual(reply.value, { ok: false, error: REFUSAL });
    assert.strictEqual(r.settingsKey(), undefined, 'nothing written');
  } finally { r.host.close(); }
});

test('(d) after a successful set the key is in no reply frame and no log line', async () => {
  const r = rig();
  try {
    const c = r.connect({ remoteAddress: '127.0.0.1' });
    const before = r.logged.length;
    assert.deepStrictEqual((await c.invoke('accounts:setApiKey', 'api-1', KEY)).value, { ok: true });
    assert.strictEqual(r.settingsKey(), KEY, 'ENTER: the call ran and stored the key');
    assert.ok(!JSON.stringify(c.frames).includes('LEAKCANARY'), 'no frame sent to the client carries the key');
    assert.ok(!r.logged.slice(before).join('\n').includes('LEAKCANARY'), 'nothing logged during the call carries the key');
  } finally { r.host.close(); }
});

test('(e) accounts:list answers a boolean for the key, never the string', async () => {
  const r = rig();
  try {
    const c = r.connect({ remoteAddress: '127.0.0.1' });
    await c.invoke('accounts:setApiKey', 'api-1', KEY);
    assert.strictEqual(r.settingsKey(), KEY, 'ENTER: the key is stored');
    const list = (await c.invoke('accounts:list')).value;
    assert.deepStrictEqual(list.accounts.map((a) => [a.label, a.apiKey]), [['default', false], ['api-1', true]]);
    assert.ok(!JSON.stringify(list).includes('LEAKCANARY'));
  } finally { r.host.close(); }
});

test('the renderer refuses on an insecure context only, with the host\'s text', () => {
  assert.strictEqual(INSECURE_KEY_REFUSAL, REFUSAL);
  assert.strictEqual(keyTransportRefusal({ isSecureContext: false }), REFUSAL);
  assert.strictEqual(keyTransportRefusal({ isSecureContext: true }), null);
  assert.strictEqual(keyTransportRefusal({}), null, 'undefined is not insecure');
});

test('trustedTransport: true vouches for a non-loopback, non-https connection, and setApiKey proceeds', async () => {
  const r = rig({ trustedTransport: true });
  try {
    const c = r.connect({ remoteAddress: '172.17.0.1', origin: 'http://172.17.0.1:8080' });
    assert.ok(c.frames.some((f) => f.t === 'welcome'), 'ENTER: the hello was accepted');
    assert.deepStrictEqual((await c.invoke('accounts:setApiKey', 'api-1', KEY)).value, { ok: true });
    assert.strictEqual(r.settingsKey(), KEY);
  } finally { r.host.close(); }
});

test('with trustedTransport absent, the same connection is refused with the text naming the variable', async () => {
  const r = rig();
  try {
    const c = r.connect({ remoteAddress: '172.17.0.1', origin: 'http://172.17.0.1:8080' });
    assert.ok(c.frames.some((f) => f.t === 'welcome'), 'ENTER: the hello was accepted');
    const reply = await c.invoke('accounts:setApiKey', 'api-1', KEY);
    assert.deepStrictEqual(reply.value, { ok: false, error: REFUSAL });
    assert.ok(REFUSAL.includes('CLODEX_WEB_TRUSTED_TRANSPORT=1'));
    assert.strictEqual(r.settingsKey(), undefined, 'nothing written');
  } finally { r.host.close(); }
});

test('headless-main enables trustedTransport only on CLODEX_WEB_TRUSTED_TRANSPORT === \'1\'', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'headless-main.js'), 'utf-8');
  assert.match(src, /\n\s+trustedTransport: process\.env\.CLODEX_WEB_TRUSTED_TRANSPORT === '1',\n/);
  const reads = src.match(/process\.env\.CLODEX_WEB_TRUSTED_TRANSPORT[^\n,)]*/g);
  assert.deepStrictEqual(reads, [
    "process.env.CLODEX_WEB_TRUSTED_TRANSPORT === '1'",
    "process.env.CLODEX_WEB_TRUSTED_TRANSPORT === '1'",
  ]);
});
