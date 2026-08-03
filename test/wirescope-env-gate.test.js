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

// ── the pidfile: whose record is it, and who may delete it ──────────────────

// A restart's OUTGOING child must never delete its SUCCESSOR's pidfile. `exit`
// is emitted asynchronously, so it lands after restart() has already unlinked
// the old record and start() has written a new one — an unconditional unlink
// there orphans the live proxy.
//
// The consequence is not cosmetic. Clodex identifies its own detached survivor
// ONLY by that file: _survivorPid() returns null without it, so status() reports
// `external` (prefs reads "not running" and hides Restart) and start()'s `ours`
// gate never runs the version comparison — pinning the running proxy at whatever
// it launched with while a newer vendored copy sits unused. Observed live: a
// v0.6.46 survivor ignored a v0.6.47 vendor bump across GUI restarts, and the
// only recovery was killing the process by hand.
test('pidfile: a dying child does not delete its successor\'s record', () => {
  const { sup } = makeSup(ROUTED);
  const pidFile = sup._pidFile();
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });

  // restart(): old child 111 is signalled, its record dropped, successor 222 writes.
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 111, port: 7800 }));
  sup._releasePidFile(111);
  assert.ok(!fs.existsSync(pidFile), 'the outgoing child releases its own record');
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 222, port: 7800 }));

  // ...and NOW the old child's exit event finally fires.
  sup._releasePidFile(111);
  assert.ok(fs.existsSync(pidFile), 'the successor\'s record must survive the old child\'s exit');
  assert.strictEqual(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid, 222,
    'and must still name the successor');
});

test('pidfile: a lone child exiting still cleans up after itself', () => {
  // The guard must not become a leak: a stale record naming a dead pid makes
  // _survivorPid() throw on process.kill and read as "no survivor" anyway, but it
  // would also let a recycled pid be adopted as the proxy.
  const { sup } = makeSup(ROUTED);
  const pidFile = sup._pidFile();
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 333, port: 7800 }));
  sup._releasePidFile(333);
  assert.ok(!fs.existsSync(pidFile), 'the record names this child, so it goes');
});

test('pidfile: an unreadable or absent record is cleared, not preserved', () => {
  const { sup } = makeSup(ROUTED);
  const pidFile = sup._pidFile();
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, 'not json{');
  sup._releasePidFile(444);
  assert.ok(!fs.existsSync(pidFile),
    'a corrupt record must not be treated as a successor claim and left forever');
  assert.doesNotThrow(() => sup._releasePidFile(444), 'and a missing file is not an error');
});

// Every unlink of the pidfile must go through the guard. A new call site added
// with a bare fs.unlinkSync re-opens the race, and nothing else would catch it.
test('pidfile: no raw unlink survives outside the guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'wirescope-supervisor.js'), 'utf8');
  const raw = (src.match(/unlinkSync\(this\._pidFile\(\)\)/g) || []).length;
  assert.strictEqual(raw, 1,
    `expected exactly 1 raw pidfile unlink (the one inside _releasePidFile) and found ${raw} — `
    + 'a bare unlink at a new call site lets an outgoing child delete its successor\'s record');
  const guard = src.slice(src.indexOf('_releasePidFile(pid)'));
  assert.match(guard.slice(0, 400), /rec\.pid !== pid/,
    'the guard must compare the recorded pid against the caller\'s');
});
