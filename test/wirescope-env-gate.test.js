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
const { spawn, execFileSync } = require('node:child_process');
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

// ── re-adopting a survivor whose record was lost ────────────────────────────

// A listener that binds the port, with a controllable cwd and argv — everything
// _reclaimPidFile inspects, and nothing it does not (it never connects).
function fakeListener({ cwd, port, argv }) {
  // `--` or node eats the fake uvicorn flags as its own options ("bad option: -m").
  const child = spawn(process.execPath,
    ['-e', `require('net').createServer().listen(${port},'127.0.0.1');setTimeout(()=>{},6e4)`, '--', ...argv],
    { cwd, stdio: 'ignore' });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const held = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
        { encoding: 'utf8' }).trim();
      if (held) return child;
    } catch { /* nothing listening yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error('listener never bound'); }
    execFileSync('sleep', ['0.05']);
  }
}

// Each case gets its own port: a leftover listener from a previous case would
// otherwise be adopted by the next one and hide a rejection.
let nextPort = 47800;
function withListener({ cwd, argv }, fn) {
  const port = nextPort++;
  const child = fakeListener({ cwd, port, argv });
  try { return fn(port); } finally { try { child.kill('SIGKILL'); } catch {} }
}

const UVICORN_ARGV = (port) => ['-m', 'uvicorn', 'logproxy:app', '--host', '127.0.0.1', '--port', String(port)];

// Setup shared by the reclaim cases: a source dir that _looksValid, pointed at
// by settings, and no pidfile.
function reclaimSup(port) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-src-'));
  fs.writeFileSync(path.join(src, 'logproxy.py'), '# stub\n');
  const { sup } = makeSup({ ...ROUTED, wirescopePort: port, wirescopeDir: src });
  fs.mkdirSync(path.dirname(sup._pidFile()), { recursive: true });
  return { sup, src };
}

// The pidfile is Clodex's ONLY handle on a detached survivor, so losing it (a
// pre-fix orphan, a wiped userData) stranded a proxy Clodex had itself started:
// permanently `external`, no Restart, no version upgrade. Adoption is by OBSERVED
// identity — /_identity carries no pid, and a self-reported one would let any
// listener on the port be recorded as ours and then killed by stop().
test('reclaim: a survivor launched the way _spawn launches one is re-adopted', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-src-'));
  fs.writeFileSync(path.join(src, 'logproxy.py'), '# stub\n');
  withListener({ cwd: src, argv: UVICORN_ARGV(nextPort) }, (port) => {
    const { sup } = makeSup({ ...ROUTED, wirescopePort: port, wirescopeDir: src });
    fs.mkdirSync(path.dirname(sup._pidFile()), { recursive: true });
    assert.strictEqual(sup._survivorPid(), null, 'precondition: no record to start from');
    const pid = sup._reclaimPidFile(port);
    assert.ok(pid, 'the listener matches a Clodex spawn and must be adopted');
    assert.strictEqual(JSON.parse(fs.readFileSync(sup._pidFile(), 'utf8')).pid, pid);
    assert.strictEqual(sup._survivorPid(), pid, 'and status/upgrade now see their own survivor');
  });
});

// The security property. cwd is set by _spawn itself, so it is a fingerprint of
// Clodex's own launch rather than a claim by the process on the port.
test('reclaim: a listener from another directory is NOT adopted', () => {
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-other-'));
  withListener({ cwd: stranger, argv: UVICORN_ARGV(nextPort) }, (port) => {
    const { sup } = reclaimSup(port);
    assert.strictEqual(sup._reclaimPidFile(port), null,
      'adopting a stranger would make stop() kill a process Clodex never started');
    assert.ok(!fs.existsSync(sup._pidFile()), 'and must leave no record behind');
  });
});

test('reclaim: right directory, wrong process is NOT adopted', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-src-'));
  fs.writeFileSync(path.join(src, 'logproxy.py'), '# stub\n');
  // A shell or editor run from the checkout can hold a port; only uvicorn on
  // logproxy:app at OUR port is the proxy.
  withListener({ cwd: src, argv: ['-m', 'http.server'] }, (port) => {
    const { sup } = makeSup({ ...ROUTED, wirescopePort: port, wirescopeDir: src });
    fs.mkdirSync(path.dirname(sup._pidFile()), { recursive: true });
    assert.strictEqual(sup._reclaimPidFile(port), null);
    assert.ok(!fs.existsSync(sup._pidFile()));
  });
});

test('reclaim: a valid existing record is never overwritten', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-src-'));
  fs.writeFileSync(path.join(src, 'logproxy.py'), '# stub\n');
  withListener({ cwd: src, argv: UVICORN_ARGV(nextPort) }, (port) => {
    const { sup } = makeSup({ ...ROUTED, wirescopePort: port, wirescopeDir: src });
    fs.mkdirSync(path.dirname(sup._pidFile()), { recursive: true });
    // process.pid is alive and on the right port by construction, so it is a
    // valid record — reclaim must not race a live child's own bookkeeping.
    fs.writeFileSync(sup._pidFile(), JSON.stringify({ pid: process.pid, port }));
    assert.strictEqual(sup._reclaimPidFile(port), null);
    assert.strictEqual(JSON.parse(fs.readFileSync(sup._pidFile(), 'utf8')).pid, process.pid);
  });
});

test('reclaim: nothing on the port, or no source, is a silent null', () => {
  const { sup } = reclaimSup(nextPort++);   // free port, no listener
  assert.strictEqual(sup._reclaimPidFile(nextPort - 1), null);
  const { sup: nosrc } = makeSup({ ...ROUTED, wirescopeDir: '/nonexistent/nowhere' });
  assert.strictEqual(nosrc._reclaimPidFile(7800), null, 'an invalid source dir cannot match anything');
});

// start() must consult reclaim, not just the pidfile — that is the whole point:
// an orphaned survivor is what needs adopting, and it is discovered on the probe
// path where `ours` is decided.
test('reclaim: start() decides `ours` through reclaim, not the pidfile alone', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'wirescope-supervisor.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('const ours ='));
  assert.match(line, /_reclaimPidFile\(port\)/,
    'without this an orphaned proxy stays `external` forever and never upgrades');
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
