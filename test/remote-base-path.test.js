'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const {
  RemoteServer, resolveRemoteBasePath, coerceRemoteBasePath,
  resolveRemoteBasePathSetting, DEFAULT_REMOTE_BASE_PATH,
} = require('../remote');
const { initStores } = require('../stores');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

function req(port, pathname) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function withServer(extra, fn) {
  const server = new RemoteServer({
    port: 0, pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    ...extra,
  });
  await server.start();
  try { return await fn(server.port); } finally { server.stop(); }
}

test('unset base path 404s /c — no undeclared second alias for the API', async () => {
  await withServer({}, async (port) => {
    const api = await req(port, '/c/api/sessions');
    assert.equal(api.status, 404, '/c/api/sessions is not a second door onto /api/sessions');

    const bare = await req(port, '/c');
    assert.equal(bare.status, 404, 'bare /c does not redirect — there is no prefix to redirect to');

    const page = await req(port, '/c/');
    assert.equal(page.status, 404, '/c/ does not serve the viewer page');

    const unprefixed = await req(port, '/api/sessions');
    assert.equal(unprefixed.status, 200, 'the root mount serves unprefixed');
    assert.equal(JSON.parse(unprefixed.body).ok, true);

    const root = await req(port, '/');
    assert.equal(root.status, 200, 'the root serves the viewer page, not a redirect to itself');
  });
});

test('an explicitly configured /c restores the old default exactly', async () => {
  await withServer({ basePath: '/c' }, async (port) => {
    const api = await req(port, '/c/api/sessions');
    assert.equal(api.status, 200, '/c/api/sessions resolves once /c is asked for');

    const bare = await req(port, '/c');
    assert.equal(bare.status, 301, 'bare /c redirects');
    assert.equal(bare.headers.location, '/c/', 'the redirect target is the configured prefix with a slash');

    const page = await req(port, '/c/');
    assert.equal(page.status, 200, '/c/ serves the viewer page');
  });
});

test('bare /i redirects to /i/ when /i is configured, never to /c/', async () => {
  await withServer({ basePath: '/i' }, async (port) => {
    const bare = await req(port, '/i');
    assert.equal(bare.status, 301);
    assert.notEqual(bare.headers.location, '/c/', 'a hardcoded /c/ target would send the page to another instance');
    assert.equal(bare.headers.location, '/i/', 'the redirect follows the configured prefix');
  });
});

test('a configured prefix serves only itself, and never /c', async () => {
  await withServer({ basePath: '/i' }, async (port) => {
    const now = await req(port, '/i/api/sessions');
    assert.equal(now.status, 200, '/i/api/sessions resolves');

    const bare = await req(port, '/i');
    assert.equal(bare.status, 301, 'bare /i redirects');
    assert.equal(bare.headers.location, '/i/', 'to /i/');

    const old = await req(port, '/c/api/sessions');
    assert.equal(old.status, 404, '/c is not magic — it is one prefix among many');

    const unprefixed = await req(port, '/api/sessions');
    assert.equal(unprefixed.status, 200, 'the root mount is unaffected');
  });
});

test('a multi-segment prefix strips its own length, not two characters', async () => {
  await withServer({ basePath: 'i/deep/path' }, async (port) => {
    const api = await req(port, '/i/deep/path/api/sessions');
    assert.equal(api.status, 200, 'the whole prefix is stripped');

    const bare = await req(port, '/i/deep/path');
    assert.equal(bare.status, 301, 'bare multi-segment prefix redirects');
    assert.equal(bare.headers.location, '/i/deep/path/', 'to itself with a trailing slash');

    const partial = await req(port, '/i/api/sessions');
    assert.equal(partial.status, 404, 'a prefix of the prefix is not the prefix');
  });
});

test('accepted spellings all normalise to a leading slash and no trailing slash', () => {
  assert.equal(resolveRemoteBasePath('c'), '/c');
  assert.equal(resolveRemoteBasePath('/c'), '/c');
  assert.equal(resolveRemoteBasePath('/c/'), '/c');
  assert.equal(resolveRemoteBasePath('c/'), '/c');
  assert.equal(resolveRemoteBasePath('  /c/  '), '/c');
  assert.equal(resolveRemoteBasePath('i/deep/path'), '/i/deep/path');
  assert.equal(resolveRemoteBasePath('/i/deep/path/'), '/i/deep/path');
  assert.equal(resolveRemoteBasePath('phone-2.0_x~y'), '/phone-2.0_x~y');
});

test('absent or blank means unset, and unset means NO prefix', () => {
  assert.equal(DEFAULT_REMOTE_BASE_PATH, '', 'the empty string, not "/" — "/" would 301 the root to itself');
  assert.equal(resolveRemoteBasePath(undefined), '');
  assert.equal(resolveRemoteBasePath(null), '');
  assert.equal(resolveRemoteBasePath(''), '');
  assert.equal(resolveRemoteBasePath('   '), '');
});

const REJECTED = [
  ['..', 'a bare parent traversal'],
  ['/..', 'a rooted parent traversal'],
  ['/c/../etc', 'traversal buried mid-path'],
  ['/c/..', 'traversal at the tail'],
  ['.', 'the current-directory segment'],
  ['/c//i', 'an empty interior segment'],
  ['//', 'nothing but separators'],
  ['/', 'the root itself is not a prefix'],
  ['c\\d', 'a backslash segment separator'],
  ['\\c', 'a leading backslash'],
  ['c d', 'a space inside a segment'],
  ['c?q=1', 'a query string'],
  ['c#frag', 'a fragment'],
  ['%2e%2e', 'a percent-encoded traversal'],
  ['/c/%2e%2e/etc', 'a percent-encoded traversal mid-path'],
  ['http://evil/c', 'an absolute URL'],
  ['//evil/c', 'a protocol-relative host'],
  ['c\nd', 'an embedded newline'],
];

for (const [value, why] of REJECTED) {
  test(`rejected base path ${JSON.stringify(value)} (${why}) falls back to no prefix`, () => {
    const seen = [];
    assert.equal(resolveRemoteBasePath(value, (m) => seen.push(m)), '');
    assert.equal(coerceRemoteBasePath(value), null, 'the pure coercion refuses it too');
    assert.equal(seen.length, 1, 'exactly one warning for a rejected value');
    assert.match(seen[0], /CLODEX_REMOTE_BASE_PATH/, 'the warning names the variable');
  });
}

test('a rejected value falls back to the caller-supplied prefix, not to none', () => {
  const seen = [];
  assert.equal(resolveRemoteBasePath('/c/../etc', (m) => seen.push(m), '/keep'), '/keep',
    'a garbage env must not drop a configured prefix');
  assert.match(seen[0], /keep/, 'the warning names what is actually kept');
});

test('a rejected value is warned about once, not once per construction', () => {
  const seen = [];
  const warn = (m) => seen.push(m);
  const value = '/only-warned-once/../x';
  assert.equal(resolveRemoteBasePath(value, warn), '');
  assert.equal(resolveRemoteBasePath(value, warn), '');
  assert.equal(seen.length, 1, 'the second resolution is silent');
});

test('a rejected value leaves the server on no prefix, not on an adjacent one', async () => {
  await withServer({ basePath: '/c/../etc', warn: () => {} }, async (port) => {
    const root = await req(port, '/api/sessions');
    assert.equal(root.status, 200, 'the root mount survives a bad configuration');
    const escaped = await req(port, '/etc/api/sessions');
    assert.equal(escaped.status, 404, 'the refused value is not sanitised into an adjacent prefix');
    const old = await req(port, '/c/api/sessions');
    assert.equal(old.status, 404, 'nor into the prefix its first segment names');
  });
});

function captureRemoteOptions(settings = {}) {
  let srv = null;
  const deps = {
    path, fs: require('node:fs'), os: require('node:os'),
    log: { info() {}, error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: '/tmp/reg', OUTBOX_DIR: '/tmp/outbox', SELF_LABEL: 'testbox',
    parseCtxFile: () => null, jsonlToMessages: () => [], ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager: { sessions: new Map(), create: async () => ({}) },
    proxyPoller: { snapshot: () => null },
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => {}, fetchFilePeek: () => {}, fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash'],
    getPromptLibrary: () => ({ list: () => [] }),
    getAgentLibrary: () => ({ list: () => [] }),
    getSkillLibrary: () => ({ list: () => [] }),
    getPersistence: () => ({ get: () => undefined, setStripLevel: () => {} }),
    getUiSettings: () => ({ get: () => ({ remoteEnabled: true, remotePort: 0, ...settings }) }),
    getWorkspaces: () => ({ get: () => ({}) }),
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; }, setRemoteError: () => {},
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
  };
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  try {
    require('../remote-wiring').createRemoteWiring(deps).syncRemoteServer();
  } finally {
    remoteMod.RemoteServer = orig;
  }
  return opts;
}

test('remote-wiring threads the RESOLVED setting, never process.env itself', () => {
  const had = process.env.CLODEX_REMOTE_BASE_PATH;
  try {
    assert.equal(captureRemoteOptions({ remoteBasePath: '' }).basePath, '',
      'no prefix configured reaches the constructor as no prefix');
    assert.equal(captureRemoteOptions({ remoteBasePath: '/i/phone' }).basePath, '/i/phone',
      'the resolved setting reaches the constructor verbatim');

    process.env.CLODEX_REMOTE_BASE_PATH = '/from-env';
    assert.equal(captureRemoteOptions({ remoteBasePath: '/from-settings' }).basePath, '/from-settings',
      'wiring does NOT read the env itself — stores.get() is the one resolution site');
  } finally {
    if (had === undefined) delete process.env.CLODEX_REMOTE_BASE_PATH;
    else process.env.CLODEX_REMOTE_BASE_PATH = had;
  }
});

test('resolveRemoteBasePathSetting: env wins, then persisted, then no prefix', () => {
  const persisted = { remoteBasePath: '/p' };
  assert.equal(resolveRemoteBasePathSetting(persisted, { CLODEX_REMOTE_BASE_PATH: '/e' }), '/e', 'env wins');
  assert.equal(resolveRemoteBasePathSetting(persisted, {}), '/p', 'persisted when env absent');
  assert.equal(resolveRemoteBasePathSetting(persisted, { CLODEX_REMOTE_BASE_PATH: '' }), '/p', 'empty env is absent');
  assert.equal(resolveRemoteBasePathSetting({}, {}), '', 'neither set is the OFF state');
  assert.equal(resolveRemoteBasePathSetting(null, {}), '', 'no settings at all is still OFF');

  const seen = [];
  assert.equal(
    resolveRemoteBasePathSetting(persisted, { CLODEX_REMOTE_BASE_PATH: '..' }, (m) => seen.push(m)),
    '/p', 'a garbage env keeps the persisted prefix rather than turning the mount off',
  );
  assert.equal(seen.length, 1, 'and says so once');

  assert.equal(resolveRemoteBasePathSetting({ remoteBasePath: 'c' }, {}), '/c',
    'a persisted value is normalised, not taken raw');
  assert.equal(resolveRemoteBasePathSetting({ remoteBasePath: '/c/../etc' }, {}), '',
    'a garbage PERSISTED value is refused too, and refused means off');
});

function withStores(fn) {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basepath-'));
  const had = process.env.CLODEX_REMOTE_BASE_PATH;
  delete process.env.CLODEX_REMOTE_BASE_PATH;
  try {
    return fn(initStores(dir, { registryDir: path.join(dir, 'registry') }), dir);
  } finally {
    if (had === undefined) delete process.env.CLODEX_REMOTE_BASE_PATH;
    else process.env.CLODEX_REMOTE_BASE_PATH = had;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the base path persists, and a fresh install is OFF', () => {
  withStores(({ uiSettings }) => {
    assert.equal(uiSettings.get().remoteBasePath, '', 'a fresh install serves no prefix');
    uiSettings.set({ remoteBasePath: '/c' });
    assert.equal(uiSettings.get().remoteBasePath, '/c', 'an operator who wants /c sets it and keeps it');
    uiSettings.set({ remoteBasePath: 'i/deep' });
    assert.equal(uiSettings.get().remoteBasePath, '/i/deep', 'stored normalised');
    uiSettings.set({ remoteBasePath: '' });
    assert.equal(uiSettings.get().remoteBasePath, '', 'and can be cleared back to off');
  });
});

test('uiSettings.get() applies the env override and set() never persists it', () => {
  const fs = require('node:fs');
  withStores(({ uiSettings }, dir) => {
    uiSettings.set({ remoteBasePath: '/c' });
    assert.equal(uiSettings.get().remoteBasePath, '/c');

    process.env.CLODEX_REMOTE_BASE_PATH = '/i/phone';
    assert.equal(uiSettings.get().remoteBasePath, '/i/phone', 'env wins on read');

    uiSettings.set({ theme: 'midnight' });
    const file = path.join(dir, 'ui-settings.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.remoteBasePath, '/c', 'an unrelated save must not bake the env prefix in');

    assert.equal(uiSettings.set({ theme: 'midnight' }).remoteBasePath, '/i/phone',
      'set() returns the EFFECTIVE settings its callers act on');

    delete process.env.CLODEX_REMOTE_BASE_PATH;
    assert.equal(uiSettings.get().remoteBasePath, '/c',
      'next launch without the var returns to what Settings holds');
  });
});

test('a garbage persisted value on disk reads back as off, not as itself', () => {
  const fs = require('node:fs');
  withStores(({ uiSettings }, dir) => {
    const file = path.join(dir, 'ui-settings.json');
    uiSettings.set({ remoteBasePath: '/c' });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.remoteBasePath = '/c/../etc';
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    assert.equal(uiSettings.get().remoteBasePath, '', 'a hand-edited traversal does not mount anywhere');
  });
});
