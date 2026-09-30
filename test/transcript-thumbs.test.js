'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRemoteWiring } = require('../remote-wiring');
const { RemoteServer } = require('../remote');
const { sliceSince } = require('../transcript');
const { pathFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

function b64(bytes, fill) {
  return Buffer.alloc(bytes, fill).toString('base64');
}

function wiredTranscript({ thumbnail, messages }) {
  const tmp = mkTmpRoot('clx-thumbs-');
  const REGISTRY_DIR = path.join(tmp, 'reg');
  const link = pathFor(REGISTRY_DIR, 'alice', 'transcript');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.writeFileSync(link, '');
  const warns = [];
  let srv = null;
  const deps = {
    path, fs, os,
    log: { info() {}, error() {}, warn: (...a) => warns.push(a.join(' ')) },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR, OUTBOX_DIR: path.join(tmp, 'outbox'), SELF_LABEL: 'testbox',
    parseCtxFile: () => null, cachedMessages: () => messages, sliceSince,
    ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager: { sessions: new Map([['alice', { agentType: 'claude' }]]), create: async () => ({}) },
    proxyPoller: { snapshot: () => null },
    gitWorktree: { listWorktrees: async () => ({ ok: true, repo: '/repo', worktrees: [] }) },
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
    getUiSettings: () => ({ get: () => ({ remoteEnabled: true, remotePort: 0 }) }),
    getWorkspaces: () => ({ get: () => ({}) }),
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; }, setRemoteError: () => {},
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
    thumbnail,
  };
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  try {
    createRemoteWiring(deps).syncRemoteServer();
  } finally {
    remoteMod.RemoteServer = orig;
  }
  return { getTranscript: (...a) => opts.getTranscript('alice', ...a), warns };
}

function page(images) {
  return [
    { role: 'user', text: '[Image #1] [Image #2]', ts: null, interim: false, images, seq: 0 },
    { role: 'assistant', text: 'ok', ts: null, interim: false, seq: 1 },
  ];
}

test('with a seam: an image over 64 KiB is replaced by the seam output, a 10 KiB one passes through untouched', async () => {
  const big = b64(100 * 1024, 1);
  const small = b64(10 * 1024, 2);
  const calls = [];
  const thumbnail = async (buf, mediaType) => {
    calls.push([buf.length, mediaType]);
    return { mediaType: 'image/jpeg', data: 'THUMB' };
  };
  const messages = page([{ n: 1, mediaType: 'image/png', data: big }, { n: 2, mediaType: 'image/png', data: small }]);
  const { getTranscript } = wiredTranscript({ thumbnail, messages });
  const out = await getTranscript(100, null);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.messages[0].images, [
    { n: 1, mediaType: 'image/jpeg', data: 'THUMB' },
    { n: 2, mediaType: 'image/png', data: small },
  ]);
  assert.strictEqual('images' in out.messages[1], false);
  assert.deepStrictEqual(calls, [[100 * 1024, 'image/png']]);
  assert.strictEqual(messages[0].images[0].data, big);
});

test('with a seam: a re-rendered page reuses the thumbnail instead of re-encoding', async () => {
  let calls = 0;
  const thumbnail = async () => { calls++; return { mediaType: 'image/jpeg', data: 'T' }; };
  const { getTranscript } = wiredTranscript({ thumbnail, messages: page([{ n: 1, mediaType: 'image/png', data: b64(80 * 1024, 3) }]) });
  await getTranscript(100, null);
  const again = await getTranscript(100, null);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(again.messages[0].images, [{ n: 1, mediaType: 'image/jpeg', data: 'T' }]);
});

test('a throwing seam yields {n, mediaType, bytes} and one warn per build, never a failed page', async () => {
  const thumbnail = async () => { throw new Error('decode failed'); };
  const messages = page([
    { n: 1, mediaType: 'image/png', data: b64(100 * 1024, 4) },
    { n: 2, mediaType: 'image/webp', data: b64(70 * 1024, 5) },
  ]);
  const { getTranscript, warns } = wiredTranscript({ thumbnail, messages });
  const out = await getTranscript(100, null);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.messages[0].images, [
    { n: 1, mediaType: 'image/png', bytes: 100 * 1024 },
    { n: 2, mediaType: 'image/webp', bytes: 70 * 1024 },
  ]);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /decode failed/);
});

test('without a seam: the page carries the original images', async () => {
  const data = b64(200 * 1024, 6);
  const { getTranscript } = wiredTranscript({ thumbnail: undefined, messages: page([{ n: 1, mediaType: 'image/png', data }]) });
  const out = await getTranscript(100, null);
  assert.deepStrictEqual(out.messages[0].images, [{ n: 1, mediaType: 'image/png', data }]);
});

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf) }));
    }).on('error', reject);
  });
}

test('the transcript route answers an async getTranscript, and hello advertises transcript-images', async () => {
  const images = [{ n: 1, mediaType: 'image/jpeg', data: 'T' }];
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], send: () => ({ ok: true }),
    getTranscript: async (name) => (name === 'boom'
      ? Promise.reject(new Error('nope'))
      : { ok: true, messages: [{ role: 'user', text: 'x', images }], cursor: 0, complete: true }),
  });
  await server.start();
  try {
    const ok = await get(server.port, '/api/sessions/alice/transcript');
    assert.deepStrictEqual([ok.status, ok.json.messages[0].images], [200, images]);
    const bad = await get(server.port, '/api/sessions/boom/transcript');
    assert.deepStrictEqual([bad.status, bad.json.error], [500, 'nope']);
    const hello = await get(server.port, '/api/peer/hello');
    assert.ok(hello.json.caps.includes('transcript-images'));
  } finally { server.stop(); }
});
