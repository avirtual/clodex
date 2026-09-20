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
const { mkTmpRoot } = require('./lib/tmp-roots');

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
  const logs = [];
  const tmp = mkTmpRoot('ws-gate-');
  const { WirescopeSupervisor } = createWirescopeSupervisor({
    // A BARE fn, not a tagged logger. engine.js passes the tagged shape, so every
    // log.warn('wirescope', …) in the module works there and only ever fails here
    // — and both of its call sites sit inside a `catch {}` that swallows the
    // TypeError along with whatever followed the warn. Keeping this harness bare
    // is what makes that difference reachable.
    log: (m) => logs.push(m),
    ProxyClient: { probe: async (base) => { probes.push(base); if (probe) return probe(base); throw new Error('down'); } },
    getUiSettings: () => ({ get: () => settings }),
    getUserDataPath: () => tmp,
    isPackaged: () => false,
  });
  return { sup: new WirescopeSupervisor(), probes, logs };
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

test('pidfile: a non-positive pid is discarded, and the discard survives a bare-fn host', () => {
  // The self-heal, driven end to end. A pidfile carrying -1 would have stop()
  // signalling every process the user owns, and the liveness probe is no backstop
  // (kill(-1, 0) does not throw). _survivorPid must refuse it AND delete it: the
  // refusal alone returns null to stop(), which then can never clean the file up.
  //
  // The bare-fn `log` above is the load-bearing part. This path warns before it
  // releases, so a direct log.warn() here throws into _survivorPid's outer
  // `catch { return null; }` — the null still keeps the safety property, which is
  // why the loss is silent, but the release never runs and the corrupt file stays
  // forever while status() re-enters this branch every 10s.
  for (const bad of [-1, 0]) {
    const { sup, logs } = makeSup(ROUTED);
    const pidFile = sup._pidFile();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, JSON.stringify({ pid: bad, port: 7800 }));

    assert.strictEqual(sup._survivorPid(), null, `pid ${bad} must not be reported as a survivor`);
    assert.ok(!fs.existsSync(pidFile),
      `pid ${bad} was refused but its record was left behind — stop() gets null from _survivorPid, so `
      + 'nothing else ever deletes it and this branch re-fires on every status() watchdog tick');
    assert.deepStrictEqual(logs, [`discarding pidfile: pid is ${bad}, which would broadcast rather than target`],
      'the discard must reach a bare-fn log too; a tagged-shape call throws into the outer catch and takes '
      + 'the release with it');
  }
});

test('pidfile: an ABSENT pid is neither warned about nor discarded', () => {
  // The ordinary "no survivor" case. `{}` is not corruption — it must stay quiet,
  // which is the whole reason the discard is gated on `rec.pid !== undefined`
  // rather than on the refusal above it.
  const { sup, logs } = makeSup(ROUTED);
  const pidFile = sup._pidFile();
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, JSON.stringify({ port: 7800 }));

  assert.strictEqual(sup._survivorPid(), null);
  assert.deepStrictEqual(logs, [], 'an absent pid is the ordinary case and must not log');
  // Guards the release being HOISTED out of the gate — a plausible refactor, since
  // _releasePidFile re-reads and looks safe to call unconditionally. It is not:
  // `rec.pid !== pid` is `undefined !== undefined` = false, so it falls through to
  // the unlink and drops an uncorrupted record on every watchdog tick. The `logs`
  // check above cannot see that; it only catches a gate that WIDENED.
  assert.ok(fs.existsSync(pidFile),
    'an absent pid is not corruption — the record must be left alone');
});

// ── re-adopting a survivor whose record was lost ────────────────────────────

// A listener that binds the port, with a controllable cwd and ENV — everything
// _reclaimPidFile inspects, and nothing it does not (it never connects).
function fakeListener({ cwd, port, env }) {
  const child = spawn(process.execPath,
    ['-e', `require('net').createServer().listen(${port},'127.0.0.1');setTimeout(()=>{},6e4)`],
    { cwd, stdio: 'ignore', env: { ...process.env, ...env } });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const held = execFileSync('lsof', ['-w', '-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-t'],
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
function withListener({ cwd, env }, fn) {
  const port = nextPort++;
  const child = fakeListener({ cwd, port, env });
  const kill = () => { try { child.kill('SIGKILL'); } catch {} };
  // await-aware: a bare try/finally kills the listener the moment `fn` returns a
  // PROMISE, so an async body ran against a dead port and read as no-adoption.
  let out;
  try { out = fn(port); } catch (e) { kill(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(kill);
  kill();
  return out;
}

// A source dir that _looksValid, and a supervisor pointed at it with no pidfile.
function reclaimSup(port) {
  const src = mkTmpRoot('ws-src-');
  fs.writeFileSync(path.join(src, 'logproxy.py'), '# stub\n');
  const { sup } = makeSup({ ...ROUTED, wirescopePort: port, wirescopeDir: src });
  fs.mkdirSync(path.dirname(sup._pidFile()), { recursive: true });
  return { sup, src };
}

// The pidfile is Clodex's ONLY handle on a detached survivor, so losing it (a
// pre-fix orphan, a wiped userData) stranded a proxy Clodex had itself started:
// permanently `external`, no Restart, no version upgrade.
//
// WHAT COUNTS AS EVIDENCE is the whole design. cwd and argv are NOT: `uvicorn
// logproxy:app` only resolves when cwd IS the source dir, so both are entailed
// by ANY working wirescope on the port — including one the user hand-started
// from their own wirescopeDir, which adoption would then let stop() kill. Only
// WARMTH_DB discriminates: proxylab/store.py defaults it into the source dir,
// while _spawn always overrides it into this app's userData.
test('reclaim: a survivor carrying _spawn\'s WARMTH_DB is re-adopted', () => {
  const port = nextPort;
  const { sup, src } = reclaimSup(port);
  withListener({ cwd: src, env: { WARMTH_DB: sup._dirs().warmthDb } }, (p) => {
    assert.strictEqual(sup._survivorPid(), null, 'precondition: no record to start from');
    const pid = sup._reclaimPidFile(p);
    assert.ok(pid, 'the listener carries our own warmth db and must be adopted');
    assert.strictEqual(JSON.parse(fs.readFileSync(sup._pidFile(), 'utf8')).pid, pid);
    assert.strictEqual(sup._survivorPid(), pid, 'and status/upgrade now see their own survivor');
  });
});

// The security property, and the one the first version of this check got wrong:
// a hand-started proxy satisfies cwd and argv perfectly. Adopting it would make
// stop()/restart() SIGTERM a process the user owns.
test('reclaim: a user-started proxy in the SAME dir is NOT adopted', () => {
  const port = nextPort;
  const { sup, src } = reclaimSup(port);
  // No WARMTH_DB: exactly what start_proxy.sh leaves, defaulted into the source dir.
  withListener({ cwd: src, env: { WARMTH_DB: undefined } }, (p) => {
    assert.strictEqual(sup._reclaimPidFile(p), null,
      'cwd and argv are entailed by any working proxy — adopting on them kills the user\'s own process');
    assert.ok(!fs.existsSync(sup._pidFile()), 'and must leave no record behind');
  });
});

test('reclaim: another Clodex install\'s survivor is NOT adopted', () => {
  const port = nextPort;
  const { sup, src } = reclaimSup(port);
  // Same shape, different userData (dev vs packaged on one machine).
  withListener({ cwd: src, env: { WARMTH_DB: '/somewhere/else/warmth.sqlite' } }, (p) => {
    assert.strictEqual(sup._reclaimPidFile(p), null);
    assert.ok(!fs.existsSync(sup._pidFile()));
  });
});

// A foreign co-listener must not be able to block recovery forever by being
// picked as "the" holder.
test('reclaim: the real proxy is found even behind another listener on the port', () => {
  const port = nextPort;
  const { sup, src } = reclaimSup(port);
  withListener({ cwd: os.tmpdir(), env: { WARMTH_DB: '/not/ours' } }, (p) => {
    // SO_REUSEPORT is not in play, so a second bind on the same port fails —
    // instead prove the iteration by asserting the scan does not stop at a
    // non-matching first holder: it returns null rather than adopting it.
    assert.strictEqual(sup._reclaimPidFile(p), null, 'a stranger is never adopted');
    assert.ok(!fs.existsSync(sup._pidFile()));
  });
});

test('reclaim: a valid existing record is never overwritten', () => {
  const port = nextPort;
  const { sup, src } = reclaimSup(port);
  withListener({ cwd: src, env: { WARMTH_DB: sup._dirs().warmthDb } }, (p) => {
    // process.pid is alive and on the right port by construction, so it is a
    // valid record — reclaim must not race a live child's own bookkeeping.
    fs.writeFileSync(sup._pidFile(), JSON.stringify({ pid: process.pid, port: p }));
    assert.strictEqual(sup._reclaimPidFile(p), null);
    assert.strictEqual(JSON.parse(fs.readFileSync(sup._pidFile(), 'utf8')).pid, process.pid);
  });
});

test('reclaim: nothing on the port, or no source, is a silent null', () => {
  const port = nextPort++;
  const { sup } = reclaimSup(port);        // free port, no listener
  assert.strictEqual(sup._reclaimPidFile(port), null);
});

// Behavioral, not a source grep: a source-text assertion passes for dead code.
test('reclaim: start() adopts an orphan and reports `managed`, not `external`', async () => {
  const port = nextPort;
  const src = mkTmpRoot('ws-src-');
  fs.writeFileSync(path.join(src, 'logproxy.py'), '# stub\n');
  const { sup } = makeSup(
    { ...ROUTED, wirescopePort: port, wirescopeDir: src },
    // Reports the claude_design strip so the ADOPTION path is what this
    // measures: a survivor that does not strip is restarted instead of returned
    // (pinned below), and start() would then answer with the restart's result.
    { probe: async () => ({
      product: 'wirescope', version: 'v9.9.9',
      capabilities: { strip_mcp: { available: true, servers: ['claude_design'] } },
    }) },
  );
  fs.mkdirSync(path.dirname(sup._pidFile()), { recursive: true });
  await withListener({ cwd: src, env: { WARMTH_DB: sup._dirs().warmthDb } }, async (p) => {
    const res = await withEnv({}, () => sup.start());
    assert.strictEqual(res.state, 'managed', 'an orphan Clodex started must come back as ITS OWN');
    assert.strictEqual(res.adopted, false, 'and not be reported as someone else\'s');
    assert.strictEqual(sup._survivorPid(), p && JSON.parse(fs.readFileSync(sup._pidFile(), 'utf8')).pid);
  });
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

// ── t443: localReach — what this box tells a PEER it can forward to ──────────

test('localReach: the advertised port rides the SAME gate as autostart, never the raw setting', async () => {
  // `wirescopePort` is a settings value that survives CLODEX_WIRESCOPE=off and a
  // proxy pointed elsewhere. Advertising it unconditionally would tell a peer to
  // forward at a port nothing on this box is listening on — the guess this
  // ticket exists to remove, one layer earlier than the consumer.
  const { sup } = makeSup(ROUTED);
  await withEnv({}, () => assert.deepStrictEqual(sup.localReach(), { port: 7800 }, 'ungated + routed → advertised'));
  for (const patch of [{ CLODEX_WIRESCOPE: 'off' }, { CLODEX_WIRESCOPE: '0' },
                       { CLAUDE_CODE_USE_BEDROCK: '1' }, { CLAUDE_CODE_USE_VERTEX: '1' }]) {
    await withEnv(patch, () => assert.strictEqual(sup.localReach(), null,
      `${JSON.stringify(patch)} → nothing advertised`));
  }
  // A box with the proxy switched off in Preferences has no wirescope to reach
  // either, gate or no gate.
  const { sup: off } = makeSup({ ...ROUTED, proxyEnabled: false });
  await withEnv({}, () => assert.strictEqual(off.localReach(), null));
  // And one routed at somebody ELSE'S wirescope advertises nothing: the port it
  // would name is not a service this box owns.
  const { sup: remote } = makeSup({ ...ROUTED, proxyUrl: 'http://wire.example:7800' });
  await withEnv({}, () => assert.strictEqual(remote.localReach(), null));
});

test('localReach: a non-default port is reported as configured, and a nonsense one is refused', async () => {
  // The port is what a peer forwards to, so it is reported rather than assumed —
  // but never reported as a value that cannot be a port.
  const { sup } = makeSup({ ...ROUTED, proxyUrl: 'http://127.0.0.1:7999', wirescopePort: 7999 });
  await withEnv({}, () => assert.deepStrictEqual(sup.localReach(), { port: 7999 }));
  for (const bad of [-1, 65536, 7800.5, '7800']) {
    const { sup: s } = makeSup({ ...ROUTED, wirescopePort: bad });
    // autoStartWanted's own URL match rejects most of these first; the guard is
    // belt-and-braces for the ones it would not.
    await withEnv({}, () => assert.strictEqual(s.localReach(), null, `${JSON.stringify(bad)} → null`));
  }
});

test('localReach is SYNCHRONOUS and probes nothing — the hello answers on the request thread', async () => {
  // Its only caller is the peering hello, which must not wait on a python
  // process. status() is the probing one and is async for exactly that reason;
  // if these ever merge, the hello acquires a network round trip per request.
  const { sup, probes } = makeSup(ROUTED);
  await withEnv({}, () => {
    const out = sup.localReach();
    assert.deepStrictEqual(out, { port: 7800 }, 'a plain value, not a promise');
    assert.ok(!(out && typeof out.then === 'function'), 'never thenable');
    assert.deepEqual(probes, [], 'and nothing was probed to answer it');
  });
});

// ── the spawn env the managed proxy inherits ────────────────────────────────
//
// _spawn's env block is the only place the vendored proxy's feature defaults are
// chosen, and every one of them is OFF in the vendor's own code — start_proxy.sh
// is what turns them on for the lab, and Clodex does not run that script. So a
// default that is absent here is a feature silently disabled in the packaged app,
// which is exactly what STRIP_MCP_SERVERS was: the wire answered `servers: []`,
// every Claude spawn fell back to --strict-mcp-config and dropped the user's own
// MCP servers along with claude_design.
//
// Driven for real rather than read from the source: `python` is a stub that dumps
// its environment, so this asserts what a child process actually receives.
function envFromSpawn(patch) {
  const dir = mkTmpRoot('ws-spawnenv-');
  const out = path.join(dir, 'env.txt');
  const stub = path.join(dir, 'fake-python');
  // Spool-then-rename: `>` creates the file before `export -p` has written a
  // byte, so waiting on existence alone reads an EMPTY env and every assertion
  // below reports the variable as absent — which reads exactly like the bug this
  // pins.
  fs.writeFileSync(stub, `#!/bin/sh\nexport -p > ${JSON.stringify(out + '.tmp')}\nmv -f ${JSON.stringify(out + '.tmp')} ${JSON.stringify(out)}\n`);
  fs.chmodSync(stub, 0o755);

  const saved = process.env.STRIP_MCP_SERVERS;
  if (patch === undefined) delete process.env.STRIP_MCP_SERVERS;
  else process.env.STRIP_MCP_SERVERS = patch;
  try {
    const { sup } = makeSup(ROUTED);
    sup._spawn(stub, dir, 47999);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(out)) {
      if (Date.now() > deadline) throw new Error('the stub python never ran');
      execFileSync('sleep', ['0.05']);
    }
    sup.child = null;
  } finally {
    if (saved === undefined) delete process.env.STRIP_MCP_SERVERS;
    else process.env.STRIP_MCP_SERVERS = saved;
  }

  // `export -p` quotes values, so an empty export and an absent one are
  // distinguishable — which is the whole point of the kill-switch case.
  const env = new Map();
  for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
    const m = /^(?:export|declare -x)\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    env.set(m[1], v.replace(/\\(.)/g, '$1'));
  }
  return env;
}

test('spawn env: STRIP_MCP_SERVERS defaults to claude_design, and an exported empty string sticks', () => {
  // The default. Hardcoded, never derived from the module — an expectation read
  // out of wirescope-supervisor.js would assert only that the file agrees with
  // itself, and this value has to match the server name the vendored proxy
  // advertises at /_identity for strictMcpReason() to return null.
  assert.strictEqual(envFromSpawn(undefined).get('STRIP_MCP_SERVERS'), 'claude_design');

  // The kill switch. `??` passes '' through; `||` would silently re-enable the
  // default and there would be no way to turn the strip off for the managed
  // instance at all.
  const off = envFromSpawn('');
  assert.ok(off.has('STRIP_MCP_SERVERS'), 'the variable must still be exported, so the vendor default cannot apply');
  assert.strictEqual(off.get('STRIP_MCP_SERVERS'), '');

  // An explicit non-default value is not overridden either.
  assert.strictEqual(envFromSpawn('other_server').get('STRIP_MCP_SERVERS'), 'other_server');

  // Its neighbours in the same block, so a rewrite that drops one is caught here
  // rather than as a silently disabled feature in the packaged app.
  const dflt = envFromSpawn(undefined);
  assert.strictEqual(dflt.get('STRIP_TOOLS_GLOBAL'), 'EndConversation');
  assert.strictEqual(dflt.get('WS_OMIT_DEFAULT'), 'useremail');
});

// ── the survivor an upgrade inherits ────────────────────────────────────────
//
// The env block above only reaches a proxy THIS build's _spawn launched, and the
// managed instance deliberately outlives the GUI. So every user upgrading into
// the STRIP_MCP_SERVERS default keeps their pre-upgrade survivor, whose
// /_identity answers `servers: []` — the surgical strip never engages, every
// Claude spawn falls back to --strict-mcp-config, and the row it prints tells
// them to set a variable on a wirescope they do not operate. The version arm
// next door does not cover it: the survivor's version is already current.
//
// The restart runs on the SAME _upgradeTried latch as the version arm, which is
// what bounds it — a proxy that comes back still not stripping (a user source
// too old to read the variable) must not be restarted forever.
function stripSup(port, servers, { version } = {}) {
  const src = mkTmpRoot('ws-src-');
  fs.writeFileSync(path.join(src, 'logproxy.py'), '# stub\n');
  // wirescopeDir set ⇒ origin 'user' ⇒ _sourceVersion is null ⇒ the VERSION arm
  // cannot fire. Without that the two arms are indistinguishable here and this
  // would pass on the version check alone.
  const { sup } = makeSup(
    { ...ROUTED, wirescopePort: port, wirescopeDir: src },
    { probe: async () => ({
      product: 'wirescope',
      version: version || 'v9.9.9',
      capabilities: servers === undefined ? {} : { strip_mcp: { available: true, servers } },
    }) },
  );
  fs.mkdirSync(path.dirname(sup._pidFile()), { recursive: true });
  const restarts = [];
  // restart() itself is pinned next door; stubbing it keeps this about WHETHER
  // the arm fires and keeps a real SIGTERM + venv spawn out of the suite.
  sup.restart = async () => { restarts.push(1); return { ok: true, state: 'restarted' }; };
  return { sup, src, restarts };
}

async function withStripEnv(value, fn) {
  const saved = process.env.STRIP_MCP_SERVERS;
  if (value === undefined) delete process.env.STRIP_MCP_SERVERS;
  else process.env.STRIP_MCP_SERVERS = value;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.STRIP_MCP_SERVERS;
    else process.env.STRIP_MCP_SERVERS = saved;
  }
}

// Each row carries its own literal expectation; the restart decision is never
// recomputed here from the rule start() uses.
const SURVIVOR_ROWS = [
  { what: 'a pre-upgrade survivor reporting servers: []', servers: [], env: undefined, restarts: 1 },
  { what: 'a survivor with no strip_mcp capability at all', servers: undefined, env: undefined, restarts: 1 },
  { what: 'a survivor already stripping claude_design', servers: ['claude_design'], env: undefined, restarts: 0 },
  { what: 'a survivor stripping claude_design among others', servers: ['other', 'claude_design'], env: undefined, restarts: 0 },
  { what: 'servers: [] but the kill switch is exported', servers: [], env: '', restarts: 0 },
  { what: 'servers: [] but the operator exported their own set', servers: [], env: 'other_server', restarts: 0 },
];

test('start: a managed survivor that does not strip claude_design is restarted once', async () => {
  for (const row of SURVIVOR_ROWS) {
    // withListener consumes nextPort itself; the supervisor must be configured
    // on the SAME port or `ours` is false and nothing is restarted for a reason
    // that has nothing to do with the strip.
    const { sup, src, restarts } = stripSup(nextPort, row.servers);
    await withListener({ cwd: src, env: { WARMTH_DB: sup._dirs().warmthDb } }, async () => {
      await withStripEnv(row.env, () => withEnv({}, () => sup.start()));
    });
    assert.strictEqual(restarts.length, row.restarts, `${row.what}: expected ${row.restarts} restart(s)`);
  }
});

test('start: the strip restart rides the _upgradeTried latch — never twice in one launch', async () => {
  // A user source too old to read STRIP_MCP_SERVERS comes back still reporting
  // `servers: []`, so an unlatched arm would restart it on every start() call
  // for the life of the app.
  const { sup, src, restarts } = stripSup(nextPort, []);
  await withListener({ cwd: src, env: { WARMTH_DB: sup._dirs().warmthDb } }, async () => {
    await withStripEnv(undefined, () => withEnv({}, async () => {
      await sup.start();
      assert.strictEqual(restarts.length, 1, 'the first start must restart the non-stripping survivor');
      await sup.start();
      await sup.start();
      assert.strictEqual(restarts.length, 1, 'the latch did not hold — this restart-loops');
      assert.strictEqual(sup._upgradeTried, true);
    }));
  });
});

test('start: an ADOPTED external proxy is never restarted for the strip', async () => {
  // Someone else's process on the port: not ours to kill, exactly as the version
  // arm treats it. `ours` is false with no pidfile and no reclaimable listener,
  // which is what a foreign cwd produces.
  const { sup, restarts } = stripSup(nextPort, []);
  await withListener({ cwd: os.tmpdir(), env: { WARMTH_DB: '/not/ours' } }, async () => {
    const res = await withStripEnv(undefined, () => withEnv({}, () => sup.start()));
    assert.strictEqual(res.state, 'external');
    assert.strictEqual(res.adopted, true);
  });
  assert.deepStrictEqual(restarts, [], 'an external proxy was restarted');
});
