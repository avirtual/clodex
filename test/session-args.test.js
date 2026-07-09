'use strict';

// Edit Session over the wire — two layers:
//   1. The pure undefined-untouched resolver (session-args.js), the value-decision
//      core shared by the local session:setArgs path and the peer POST endpoint.
//   2. The remote endpoints: 'args' cap advertised only when the callbacks are
//      wired, and the endpoints 501 (with hello omitting 'args') when they aren't.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { resolveSessionArgsPatch } = require('../session-args');
const { RemoteServer } = require('../remote');

// ---- 1. pure resolver ------------------------------------------------------

const PREV = {
  agents: ['a1'], denyBuiltins: ['Bash'], disabledTools: ['Read'],
  disabledSkills: ['s1'], injectSkills: ['s2'],
  systemPrompt: 'inline body', systemPromptFile: 'sys.md', appendPromptFiles: ['p.md'],
};

test('resolver: undefined fields keep the persisted value (untouched)', () => {
  // The Edit Args dialog passes systemPrompt/disabledSkills/injectSkills undefined.
  const out = resolveSessionArgsPatch({ agents: ['x'] }, PREV);
  assert.deepEqual(out.agents, ['x'], 'explicit field overwrites');
  assert.deepEqual(out.denyBuiltins, ['Bash'], 'undefined denyBuiltins preserved');
  assert.deepEqual(out.disabledTools, ['Read'], 'undefined disabledTools preserved');
  assert.deepEqual(out.disabledSkills, ['s1'], 'undefined disabledSkills preserved');
  assert.deepEqual(out.injectSkills, ['s2'], 'undefined injectSkills preserved');
  assert.equal(out.systemPrompt, 'inline body', 'undefined legacy inline preserved');
  assert.equal(out.systemPromptFile, 'sys.md', 'undefined systemPromptFile preserved');
  assert.deepEqual(out.appendPromptFiles, ['p.md'], 'undefined appendPromptFiles preserved');
});

test('resolver: explicit empty/null overwrites (a real clear, not untouched)', () => {
  const out = resolveSessionArgsPatch({
    agents: [], denyBuiltins: [], disabledTools: [], disabledSkills: [], injectSkills: [],
    systemPrompt: null, systemPromptFile: null, appendPromptFiles: [],
  }, PREV);
  assert.deepEqual(out.agents, []);
  assert.deepEqual(out.disabledTools, []);
  assert.deepEqual(out.disabledSkills, []);
  assert.equal(out.systemPrompt, null);
  assert.equal(out.systemPromptFile, null);
  assert.deepEqual(out.appendPromptFiles, []);
});

test('resolver: no prev entry → undefined fields default to empty/null', () => {
  const out = resolveSessionArgsPatch({}, null);
  assert.deepEqual(out.agents, []);
  assert.deepEqual(out.injectSkills, []);
  assert.equal(out.systemPrompt, null);
  assert.equal(out.systemPromptFile, null);
  assert.deepEqual(out.appendPromptFiles, []);
});

// ---- 2. remote endpoints (cap gating + 501) --------------------------------

function startServer(extra) {
  const server = new RemoteServer({
    port: 0, pagePath: '/nonexistent',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }),
    send: () => ({ ok: true }), hostLabel: 't', version: '0.0.0',
    ...extra,
  });
  return server.start().then(() => server);
}

function req(server, method, path, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const headers = body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {};
    const r = http.request({ hostname: '127.0.0.1', port: server.port, path, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test("no args callbacks → 'args' cap absent and endpoints 501", async () => {
  const server = await startServer({});
  try {
    const hello = await req(server, 'GET', '/api/peer/hello');
    assert.ok(!hello.body.caps.includes('args'), "'args' not advertised without callbacks");
    const get = await req(server, 'GET', '/api/session-args/alpha');
    assert.equal(get.status, 501);
    const post = await req(server, 'POST', '/api/session-args/alpha', { restart: false });
    assert.equal(post.status, 501);
  } finally { server.stop(); }
});

test("args callbacks wired → 'args' cap + GET returns args+catalogs + POST passes patch through", async () => {
  const calls = [];
  const server = await startServer({
    getSessionArgs: (name) => (name === 'alpha'
      ? { ok: true, type: 'claude', extraArgs: ['--foo'], disabledTools: ['Read'],
          catalogs: { agents: ['a1'], prompts: [{ kind: 'system', name: 's' }], claudeTools: ['Bash'], proxyUrl: 'http://p' } }
      : { ok: false }),
    setSessionArgs: (name, patch) => { calls.push({ name, patch }); return { ok: true, restarted: !!patch.restart }; },
  });
  try {
    const hello = await req(server, 'GET', '/api/peer/hello');
    assert.ok(hello.body.caps.includes('args'), "'args' advertised when wired");

    const get = await req(server, 'GET', '/api/session-args/alpha');
    assert.equal(get.status, 200);
    assert.equal(get.body.type, 'claude');
    assert.deepEqual(get.body.catalogs.agents, ['a1']);
    assert.equal(get.body.catalogs.proxyUrl, 'http://p');

    const missing = await req(server, 'GET', '/api/session-args/ghost');
    assert.equal(missing.status, 404, 'unknown name → 404');

    // restart:false → the owner reports restarted:false (no respawn).
    const post = await req(server, 'POST', '/api/session-args/alpha', { extraArgs: ['--bar'], restart: false });
    assert.equal(post.status, 200);
    assert.equal(post.body.restarted, false);
    assert.deepEqual(calls.at(-1).patch.extraArgs, ['--bar'], 'patch reached the owner callback');

    const restart = await req(server, 'POST', '/api/session-args/alpha', { restart: true });
    assert.equal(restart.body.restarted, true);
  } finally { server.stop(); }
});
