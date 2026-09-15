'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  coercePort, resolveWirescopePort, resolveRemotePort, resolveProxyUrl,
  DEFAULT_WIRESCOPE_PORT, DEFAULT_REMOTE_PORT,
} = require('../service-ports');
const { initStores } = require('../stores');
const { mkTmpRoot } = require('./lib/tmp-roots');

test('coercePort takes 1–65535 as int or decimal string, rejects the rest', () => {
  assert.equal(coercePort(7900), 7900);
  assert.equal(coercePort('7901'), 7901);
  assert.equal(coercePort(' 7901 '), 7901);
  assert.equal(coercePort('65535'), 65535);
  assert.equal(coercePort(1), 1);
  assert.equal(coercePort(0), null, 'port 0 is never bound');
  assert.equal(coercePort('0'), null);
  assert.equal(coercePort(65536), null);
  assert.equal(coercePort('nope'), null);
  assert.equal(coercePort('79 01'), null);
  assert.equal(coercePort('79.5'), null);
  assert.equal(coercePort('0x1ee4'), null);
  assert.equal(coercePort(NaN), null);
  assert.equal(coercePort(7900.5), null);
  assert.equal(coercePort(''), null);
  assert.equal(coercePort(null), null);
  assert.equal(coercePort(undefined), null);
});

test('wirescope port: env wins, persisted when env absent, persisted when env garbage', () => {
  const persisted = { wirescopePort: 7800 };
  assert.equal(resolveWirescopePort(persisted, { CLODEX_WIRESCOPE_PORT: '7801' }), 7801, 'env wins');
  assert.equal(resolveWirescopePort(persisted, {}), 7800, 'persisted when env absent');
  assert.equal(resolveWirescopePort(persisted, { CLODEX_WIRESCOPE_PORT: '' }), 7800, 'empty env is absent');
  const seen = [];
  assert.equal(
    resolveWirescopePort(persisted, { CLODEX_WIRESCOPE_PORT: 'nope' }, (m) => seen.push(m)),
    7800, 'persisted when env garbage',
  );
  assert.equal(seen.length, 1, 'garbage logs once');
  assert.match(seen[0], /CLODEX_WIRESCOPE_PORT/);
  assert.equal(resolveWirescopePort(persisted, { CLODEX_WIRESCOPE_PORT: '0' }), 7800, 'port 0 rejected');
  assert.equal(resolveWirescopePort(persisted, { CLODEX_WIRESCOPE_PORT: '99999' }), 7800, 'out of range rejected');
  assert.equal(resolveWirescopePort({}, {}), DEFAULT_WIRESCOPE_PORT, 'default when neither');
});

test('remote port: env wins, persisted when env absent, persisted when env garbage', () => {
  const persisted = { remotePort: 7900 };
  assert.equal(resolveRemotePort(persisted, { CLODEX_REMOTE_PORT: '7901' }), 7901, 'env wins');
  assert.equal(resolveRemotePort(persisted, {}), 7900, 'persisted when env absent');
  assert.equal(resolveRemotePort(persisted, { CLODEX_REMOTE_PORT: '   ' }), 7900, 'blank env is absent');
  const seen = [];
  assert.equal(
    resolveRemotePort(persisted, { CLODEX_REMOTE_PORT: '-1' }, (m) => seen.push(m)),
    7900, 'persisted when env garbage',
  );
  assert.equal(seen.length, 1);
  assert.match(seen[0], /CLODEX_REMOTE_PORT/);
  assert.equal(resolveRemotePort({}, {}), DEFAULT_REMOTE_PORT, 'default when neither');
});

test('the two vars are independent', () => {
  const s = { wirescopePort: 7800, remotePort: 7900 };
  const env = { CLODEX_WIRESCOPE_PORT: '7801' };
  assert.equal(resolveWirescopePort(s, env), 7801);
  assert.equal(resolveRemotePort(s, env), 7900, 'wirescope var does not move the wire port');
});

test('proxyUrl follows CLODEX_WIRESCOPE_PORT only on loopback', () => {
  const env = { CLODEX_WIRESCOPE_PORT: '7801' };
  assert.equal(
    resolveProxyUrl({ proxyUrl: 'http://127.0.0.1:7800', wirescopePort: 7800 }, env),
    'http://127.0.0.1:7801',
    'the routed default moves with the port, or autoStartWanted would refuse to start',
  );
  assert.equal(
    resolveProxyUrl({ proxyUrl: 'http://localhost:7800/', wirescopePort: 7800 }, env),
    'http://localhost:7801/',
    'the path survives the rewrite',
  );
  assert.equal(
    resolveProxyUrl({ proxyUrl: 'http://wire.example:7800', wirescopePort: 7800 }, env),
    'http://wire.example:7800',
    'a remote proxy is the operator pointing elsewhere: untouched',
  );
  assert.equal(
    resolveProxyUrl({ proxyUrl: 'not a url', wirescopePort: 7800 }, env),
    'not a url',
    'an unparseable proxyUrl is left alone',
  );
  assert.equal(
    resolveProxyUrl({ proxyUrl: 'http://127.0.0.1:7800', wirescopePort: 7800 }, {}),
    'http://127.0.0.1:7800',
    'no env, no rewrite',
  );
  assert.equal(
    resolveProxyUrl({ proxyUrl: 'http://127.0.0.1:7800', wirescopePort: 7800 }, { CLODEX_WIRESCOPE_PORT: 'junk' }),
    'http://127.0.0.1:7800',
    'garbage env leaves the persisted url',
  );
});

function withStores(fn) {
  const dir = mkTmpRoot('svcport-');
  const saved = { w: process.env.CLODEX_WIRESCOPE_PORT, r: process.env.CLODEX_REMOTE_PORT };
  delete process.env.CLODEX_WIRESCOPE_PORT;
  delete process.env.CLODEX_REMOTE_PORT;
  try {
    return fn(initStores(dir, { registryDir: path.join(dir, 'registry') }), dir);
  } finally {
    if (saved.w === undefined) delete process.env.CLODEX_WIRESCOPE_PORT; else process.env.CLODEX_WIRESCOPE_PORT = saved.w;
    if (saved.r === undefined) delete process.env.CLODEX_REMOTE_PORT; else process.env.CLODEX_REMOTE_PORT = saved.r;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('uiSettings.get() applies the override and set() never persists it', () => {
  withStores(({ uiSettings }, dir) => {
    uiSettings.set({ wirescopePort: 7800, remotePort: 7900 });
    assert.equal(uiSettings.get().wirescopePort, 7800);
    assert.equal(uiSettings.get().remotePort, 7900);

    process.env.CLODEX_WIRESCOPE_PORT = '7801';
    process.env.CLODEX_REMOTE_PORT = '7901';
    assert.equal(uiSettings.get().wirescopePort, 7801, 'env wins on read');
    assert.equal(uiSettings.get().remotePort, 7901, 'env wins on read');
    assert.equal(uiSettings.get().proxyUrl, 'http://127.0.0.1:7801', 'routed proxyUrl follows');

    uiSettings.set({ theme: 'midnight' });
    const file = path.join(dir, 'ui-settings.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.wirescopePort, 7800, 'an unrelated save must not bake the env port in');
    assert.equal(raw.remotePort, 7900, 'an unrelated save must not bake the env port in');
    assert.equal(raw.proxyUrl, 'http://127.0.0.1:7800', 'nor the derived url');

    assert.equal(uiSettings.set({ theme: 'midnight' }).remotePort, 7901,
      'set() returns the EFFECTIVE settings its callers act on');

    delete process.env.CLODEX_WIRESCOPE_PORT;
    delete process.env.CLODEX_REMOTE_PORT;
    assert.equal(uiSettings.get().wirescopePort, 7800, 'next launch without the var keeps the persisted port');
    assert.equal(uiSettings.get().remotePort, 7900);
  });
});

test('a garbage override leaves the persisted ports live', () => {
  withStores(({ uiSettings }) => {
    uiSettings.set({ wirescopePort: 7800, remotePort: 7900 });
    process.env.CLODEX_WIRESCOPE_PORT = 'garbage';
    process.env.CLODEX_REMOTE_PORT = '0';
    const s = uiSettings.get();
    assert.equal(s.wirescopePort, 7800);
    assert.equal(s.remotePort, 7900);
    assert.equal(s.proxyUrl, 'http://127.0.0.1:7800');
  });
});
