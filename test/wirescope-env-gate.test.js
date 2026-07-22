'use strict';
// wirescope-env-gate.test.js — the node-level wirescope kill-switch (T49).
// Two gates, one mechanism: CLODEX_WIRESCOPE set falsy/off (explicit opt-out,
// written by `deploy --no-wirescope` into the systemd drop-in / pod env /
// docker -e), and a tee-blind backend in the NODE env (Bedrock/Vertex traffic
// ignores ANTHROPIC_BASE_URL — wirescope would see no bytes). The gate WINS
// over proxyEnabled=true, autoStartWanted() reads process.env at call time,
// status() surfaces the reason additively (envGate), and a manual start()
// while gated refuses with the reason (never a silent no-op).
//
// wirescopeEnvGate is pure (env injected); the instance-level tests build a
// real WirescopeSupervisor through the factory with fake deps — no uvicorn,
// no electron, ProxyClient.probe is a stub.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWirescopeSupervisor, wirescopeEnvGate } = require('../wirescope-supervisor');

// ── pure: wirescopeEnvGate matrix ────────────────────────────────────────────

test('wirescopeEnvGate: CLODEX_WIRESCOPE off/0/false/"" gate; unset/truthy do not', () => {
  for (const v of ['off', 'OFF', '0', 'false', 'False', '', '  ']) {
    assert.match(String(wirescopeEnvGate({ CLODEX_WIRESCOPE: v })), /disabled by CLODEX_WIRESCOPE/,
      `value ${JSON.stringify(v)} must gate`);
  }
  assert.strictEqual(wirescopeEnvGate({}), null, 'unset → no gate');
  for (const v of ['1', 'on', 'true', 'yes']) {
    assert.strictEqual(wirescopeEnvGate({ CLODEX_WIRESCOPE: v }), null, `value ${JSON.stringify(v)} must not gate`);
  }
});

test('wirescopeEnvGate: node-level Bedrock/Vertex env auto-implies off, with the backend named', () => {
  assert.match(String(wirescopeEnvGate({ CLAUDE_CODE_USE_BEDROCK: '1' })),
    /tee-blind backend \(bedrock\)/);
  assert.match(String(wirescopeEnvGate({ CLAUDE_CODE_USE_VERTEX: 'true' })),
    /tee-blind backend \(vertex\)/);
  // isEnvTruthy semantics ride through teeBlindBackend: a falsy value is OFF.
  assert.strictEqual(wirescopeEnvGate({ CLAUDE_CODE_USE_BEDROCK: '0' }), null);
  assert.strictEqual(wirescopeEnvGate({ CLAUDE_CODE_USE_VERTEX: 'false' }), null);
});

test('wirescopeEnvGate: explicit CLODEX_WIRESCOPE gate is reported over the bedrock reason', () => {
  assert.match(String(wirescopeEnvGate({ CLODEX_WIRESCOPE: 'off', CLAUDE_CODE_USE_BEDROCK: '1' })),
    /disabled by CLODEX_WIRESCOPE/);
});

// ── instance-level: autoStartWanted / status / start through the factory ─────

const GATE_KEYS = ['CLODEX_WIRESCOPE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];

// Run fn with process.env patched (gate keys scrubbed first), restore after.
async function withEnv(patch, fn) {
  const saved = {};
  for (const k of GATE_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(patch)) process.env[k] = v;
  try { return await fn(); } finally {
    for (const k of GATE_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const ROUTED = { proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7800', wirescopePort: 7800, wirescopeDir: '' };

function makeSup(settings, { probe } = {}) {
  const probes = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-gate-'));
  const { WirescopeSupervisor } = createWirescopeSupervisor({
    log: () => {},
    ProxyClient: { probe: async (base) => { probes.push(base); if (probe) return probe(base); throw new Error('down'); } },
    getUiSettings: () => ({ get: () => settings }),
    getUserDataPath: () => tmp,
    isPackaged: () => false,
  });
  return { sup: new WirescopeSupervisor(), probes };
}

test('autoStartWanted: gate matrix — env off / bedrock / vertex kill it; unset keeps it; gate beats proxyEnabled', async () => {
  const { sup } = makeSup(ROUTED);
  // unset → current behavior (proxy enabled + managed-local url → wanted).
  await withEnv({}, () => assert.strictEqual(sup.autoStartWanted(), true));
  // explicit env off WINS over proxyEnabled=true.
  await withEnv({ CLODEX_WIRESCOPE: 'off' }, () => assert.strictEqual(sup.autoStartWanted(), false));
  await withEnv({ CLODEX_WIRESCOPE: '0' }, () => assert.strictEqual(sup.autoStartWanted(), false));
  // node-level Bedrock/Vertex auto-implies off.
  await withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => assert.strictEqual(sup.autoStartWanted(), false));
  await withEnv({ CLAUDE_CODE_USE_VERTEX: '1' }, () => assert.strictEqual(sup.autoStartWanted(), false));
  // truthy CLODEX_WIRESCOPE is not a gate.
  await withEnv({ CLODEX_WIRESCOPE: '1' }, () => assert.strictEqual(sup.autoStartWanted(), true));
  // proxyEnabled=false still wins when no gate applies (unchanged behavior).
  const { sup: off } = makeSup({ ...ROUTED, proxyEnabled: false });
  await withEnv({}, () => assert.strictEqual(off.autoStartWanted(), false));
});

test('status: envGate carries WHY autostart is gated (additive field, null when ungated)', async () => {
  const { sup } = makeSup(ROUTED);
  await withEnv({ CLODEX_WIRESCOPE: 'off' }, async () => {
    const st = await sup.status();
    assert.strictEqual(st.state, 'stopped');
    assert.match(st.envGate, /disabled by CLODEX_WIRESCOPE/);
  });
  await withEnv({ CLAUDE_CODE_USE_BEDROCK: 'true' }, async () => {
    const st = await sup.status();
    assert.match(st.envGate, /tee-blind backend \(bedrock\) — proxy would see no traffic/);
  });
  await withEnv({}, async () => {
    const st = await sup.status();
    assert.strictEqual(st.envGate, null);
  });
});

test('start: refused with the reason while gated — no probe, no spawn, error surfaced', async () => {
  const { sup, probes } = makeSup(ROUTED);
  await withEnv({ CLODEX_WIRESCOPE: 'off' }, async () => {
    const res = await sup.start();
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /disabled by CLODEX_WIRESCOPE/);
    assert.strictEqual(probes.length, 0, 'gated start must not even probe');
    // the refusal reason rides status().error like other start failures.
    const st = await sup.status();
    assert.match(st.error, /disabled by CLODEX_WIRESCOPE/);
  });
});

test('restart: also refused while gated — degenerates to the gated start(), never spawns', async () => {
  // Guards a future edit spawning directly from restart(): with nothing of
  // ours running, restart() probes then falls through to start(), which must
  // carry the gate refusal — not a fresh spawn.
  const { sup } = makeSup(ROUTED);
  await withEnv({ CLODEX_WIRESCOPE: 'off' }, async () => {
    const res = await sup.restart();
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /disabled by CLODEX_WIRESCOPE/);
  });
  const { sup: bed } = makeSup(ROUTED);
  await withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, async () => {
    const res = await bed.restart();
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /tee-blind backend \(bedrock\)/);
  });
});
