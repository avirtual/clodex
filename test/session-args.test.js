'use strict';

// Edit Session over the wire — two layers:
//   1. The pure undefined-untouched resolver (session-args.js), the value-decision
//      core shared by the local session:setArgs path and the peer POST endpoint.
//   2. The remote endpoints: 'args' cap advertised only when the callbacks are
//      wired, and the endpoints 501 (with hello omitting 'args') when they aren't.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { resolveSessionArgsPatch, withoutExecGrants, withoutLocalOnly } = require('../session-args');
const { RemoteServer } = require('../remote');

// ---- 1. pure resolver ------------------------------------------------------

const PREV = {
  agents: ['a1'], denyBuiltins: ['Bash'], disabledTools: ['Read'],
  disabledSkills: ['s1'], injectSkills: ['s2'],
  systemPrompt: 'inline body', systemPromptFile: 'sys.md', appendPromptFiles: ['p.md'],
  execCommands: ['deploy'],
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
  assert.equal(out.intents, null, 'absent intents → all-enabled (null)');
});

// Intents gate — the dialog now OWNS it, so the patch value wins over the persisted
// gate (the U9 lesson applied live). Shapes: null = all-enabled/cleared, an array
// (incl [] = everything gated) is a real value, undefined = untouched (preserve).
test('resolver: intents null in patch clears the gate (patch wins over persisted subset)', () => {
  const out = resolveSessionArgsPatch({ intents: null }, { intents: ['dm'] });
  assert.equal(out.intents, null);
});

test('resolver: intents subset in patch applies (patch wins over persisted)', () => {
  const out = resolveSessionArgsPatch({ intents: ['dm', 'exec'] }, { intents: ['spawn'] });
  assert.deepEqual(out.intents, ['dm', 'exec']);
});

test('resolver: intents [] in patch applies ([] = everything gated, a real value)', () => {
  const out = resolveSessionArgsPatch({ intents: [] }, { intents: ['dm'] });
  assert.deepEqual(out.intents, [], 'empty array is NOT treated as absent — everything gated');
});

test('resolver: intents undefined in patch preserves the persisted gate', () => {
  assert.deepEqual(resolveSessionArgsPatch({}, { intents: ['dm'] }).intents, ['dm'],
    'omitted intents keep the persisted subset');
  assert.equal(resolveSessionArgsPatch({}, { intents: null }).intents, null,
    'omitted intents keep a null (all-enabled) gate');
});

// Exec-grant allowlist — array-shaped like agents/disabledTools: undefined = untouched
// (keep persisted grants), an explicit value (incl [] = revoke all) overwrites. The
// Edit dialog OWNS it locally; a peer patch NEVER carries it (stripped at the wire),
// so over the wire it always resolves to undefined = the box's grants preserved.
test('resolver: execCommands undefined preserves the persisted grants (peer/wire-stripped path)', () => {
  assert.deepEqual(resolveSessionArgsPatch({}, PREV).execCommands, ['deploy'],
    'omitted execCommands keeps the persisted grant list');
  assert.deepEqual(resolveSessionArgsPatch({ agents: ['x'] }, PREV).execCommands, ['deploy'],
    'a patch touching other fields but omitting execCommands leaves grants untouched');
});

test('resolver: execCommands explicit array overwrites (local dialog owns it)', () => {
  assert.deepEqual(resolveSessionArgsPatch({ execCommands: ['a', 'b'] }, PREV).execCommands, ['a', 'b']);
});

test('resolver: execCommands [] revokes all grants (a real clear, not untouched)', () => {
  assert.deepEqual(resolveSessionArgsPatch({ execCommands: [] }, PREV).execCommands, [],
    'empty array is an explicit revoke, distinct from omitting the field');
});

test('resolver: no prev entry → execCommands defaults to empty', () => {
  assert.deepEqual(resolveSessionArgsPatch({}, null).execCommands, []);
});

// Session env (T46b) — the Edit dialog OWNS it (LOCAL-only, like execCommands): an
// explicit map is sanitizeFlat'd (deny-list/key/newline gate at the door); undefined =
// untouched (the peer/wire-stripped path keeps the box's env); empty/null = a real clear.
test('resolver: env undefined preserves the persisted env (peer/wire-stripped path)', () => {
  assert.deepEqual(resolveSessionArgsPatch({}, { env: { A: '1' } }).env, { A: '1' },
    'omitting env keeps the box env');
  assert.deepEqual(resolveSessionArgsPatch({ agents: ['x'] }, { env: { A: '1' } }).env, { A: '1' },
    'an unrelated patch leaves env untouched');
});

test('resolver: env explicit map overwrites and is sanitized (deny/invalid dropped at the door)', () => {
  const out = resolveSessionArgsPatch({ env: { AWS_PROFILE: 'acct', CLODEX_REMOTE_TOKEN: 'x', '1bad': 'y' } }, { env: { OLD: '9' } });
  assert.deepEqual(out.env, { AWS_PROFILE: 'acct' },
    'the edit overwrites the old env; the deny key and the invalid key are dropped server-side');
});

test('resolver: env {} is a real clear (distinct from omitting the field)', () => {
  assert.deepEqual(resolveSessionArgsPatch({ env: {} }, { env: { A: '1' } }).env, {},
    'an empty map clears; setEnv then stores absence');
});

test('resolver: no prev entry → env defaults to empty', () => {
  assert.deepEqual(resolveSessionArgsPatch({}, null).env, {});
});

// withoutExecGrants — the LOCAL-ONLY wire strip, applied by remote-wiring in BOTH
// directions (readSessionArgs result outbound, peer patch inbound). Exec grants must
// never cross the peer wire, so this drops the key entirely.
test('withoutExecGrants strips the key from a readSessionArgs-shaped result (outbound)', () => {
  const base = { ok: true, type: 'claude', execCommands: ['deploy'], disabledTools: ['Read'] };
  const out = withoutExecGrants(base);
  assert.ok(!('execCommands' in out), 'execCommands removed');
  assert.equal(out.type, 'claude', 'other fields survive');
  assert.deepEqual(out.disabledTools, ['Read']);
  assert.ok('execCommands' in base, 'input is not mutated (shallow clone)');
});

test('withoutExecGrants strips the key off an inbound peer patch (inbound)', () => {
  // A malicious/legacy peer that DID send execCommands must not reach the resolver
  // with it — after the strip, the resolver sees undefined = the box grants preserved.
  const patch = { extraArgs: ['--x'], restart: false, execCommands: ['deploy'] };
  const stripped = withoutExecGrants(patch);
  assert.ok(!('execCommands' in stripped));
  assert.deepEqual(resolveSessionArgsPatch(stripped, { execCommands: ['keep'] }).execCommands, ['keep'],
    'a wire-stripped patch leaves the box grants untouched');
});

test('withoutExecGrants passes a nullish input through unchanged', () => {
  assert.equal(withoutExecGrants(null), null);
  assert.equal(withoutExecGrants(undefined), undefined);
});

// withoutLocalOnly — the SINGLE named barrier remote-wiring uses in BOTH directions
// to keep exec grants AND session env off the peer wire. The OUTBOUND strip is the
// only thing between a peer viewer and credential values (session env has no secret
// masking), so a refactor that drops env from this must go red here. env AND
// execCommands must both leave, in both directions.
test('withoutLocalOnly strips execCommands AND env from a readSessionArgs result (outbound)', () => {
  const base = { ok: true, type: 'claude', execCommands: ['deploy'], env: { AWS_PROFILE: 'acct' }, disabledTools: ['Read'] };
  const out = withoutLocalOnly(base);
  assert.ok(!('execCommands' in out), 'execCommands removed');
  assert.ok(!('env' in out), 'env removed — the credential barrier holds');
  assert.equal(out.type, 'claude', 'other fields survive');
  assert.deepEqual(out.disabledTools, ['Read']);
  assert.ok('env' in base && 'execCommands' in base, 'input is not mutated (shallow clone)');
});

test('withoutLocalOnly strips execCommands AND env off an inbound peer patch (inbound)', () => {
  // A malicious/legacy peer that DID send env/execCommands must not reach the
  // resolver with either — after the strip, both resolve to undefined = untouched.
  const patch = { extraArgs: ['--x'], restart: false, execCommands: ['deploy'], env: { SECRET: 'x' } };
  const stripped = withoutLocalOnly(patch);
  assert.ok(!('execCommands' in stripped) && !('env' in stripped), 'both local-only keys removed');
  const resolved = resolveSessionArgsPatch(stripped, { execCommands: ['keep'], env: { KEPT: '1' } });
  assert.deepEqual(resolved.execCommands, ['keep'], 'box grants untouched by a stripped patch');
  assert.deepEqual(resolved.env, { KEPT: '1' }, 'box env untouched by a stripped patch');
});

test('withoutLocalOnly passes a nullish input through unchanged', () => {
  assert.equal(withoutLocalOnly(null), null);
  assert.equal(withoutLocalOnly(undefined), undefined);
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
