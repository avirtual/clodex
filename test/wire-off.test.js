'use strict';
// Run: node --test
// t189 — per-session wire-off (`noWire`). The seat exists for ONE observable
// property: the CLI it spawns must see no `ANTHROPIC_BASE_URL` at all, because
// Anthropic's remote access (phone attach) refuses to run when that variable is
// set. Everything else about the flag is bookkeeping in service of that.
//
// The property is an ABSENCE, and an absence assertion is exactly the shape that
// passes when the fixture never reached the state it names — a create() that
// threw before setupClaudeHook writes no settings file, and "no env key" is
// trivially true of a file that does not exist. So every absence test below is
// paired with a CONTROL arm proving the SAME fixture writes the env key when the
// flag is off. Without that pairing a green run is consistent with the hook
// never running.
//
// Why `wireOff` nulls proxyBase rather than only skipping the wire registration:
// setupClaudeHook falls back to `proxyBase` whenever `wireBase` is absent
// (cli-hooks.js, the `else if (proxyBase)` arm), so skipping the wire alone
// would re-set ANTHROPIC_BASE_URL through the external proxy and defeat the
// flag. That interaction is invisible from session-manager.js alone, which is
// why it is pinned here with the REAL setupClaudeHook rather than a stub.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { createCliHooks } = require('../cli-hooks');
const { pathFor, runDirFor } = require('../clodex-paths');

// The manager under test runs the REAL cli-hooks so the settings bytes asserted
// below are the bytes a spawn actually writes. Everything between create()'s
// entry and that write is stubbed to the minimum — this file says nothing about
// prompt assembly, MCP resolution or the PTY.
function mkManager({ proxyBase = null, wireShadow = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-wireoff-'));
  const store = new Map();
  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {},
  };
  const hooks = createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
  // Records every wire registration. A wire-off spawn must produce ZERO — the
  // flag's other half, and the one that keeps `wireRouted` false.
  const registered = [];
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    resolveProxyBase: () => proxyBase,
    normalizeProxyBase: (v) => v,
    resolveProxyAgentId: () => null,
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: { spawn: () => ({ onData() {}, onExit() {}, pid: 999 }) },
    os,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    WIRE_SHADOW: wireShadow,
    WIRE_INTENTS_LIVE: true,
    setupClaudeHook: hooks.setupClaudeHook,
    setupCodexHook: () => {},
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkillPlugin: () => {}, cleanupAgentPlugin: () => {},
    buildIpcPrompt: () => '', writeClaudeDigestFile: () => false,
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv: () => ({ ...process.env }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => root,
    resolveTeam: () => null,
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: () => null,
    mergeClaudeSystemPrompt: (a) => ({ cleaned: [...a], append: null }),
    readAppendBodies: () => [],
    pluginGrammarLines: () => [],
    // Past the settings write, on the way to sessions.set. None of this is under
    // test; it is the minimum that lets the claude arm reach the session object.
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: () => [],
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [],
    writeSkillPlugin: () => null,
    effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [],
    bakePrompt: () => '',
    nextIncarnation: () => 1,
    memLoad: { noteDigest: () => {}, noteSession: () => {} },
    tiersOf: () => ({}),
    arm: { onContextReset: () => {} },
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  // The wire is never really bound: _ensureWire is replaced by a recorder, so a
  // wire-ON spawn still takes the registration branch (and gets a wireBase back)
  // without opening a port. A wire-OFF spawn must not reach it at all.
  m._ensureWire = async () => ({
    registerAgent: (name, opts) => {
      registered.push({ name, upstreams: (opts && opts.upstreams) || null });
      return 'http://127.0.0.1:9/wire';
    },
  });
  // A real create() leaves watchers/timers behind; an unstopped fs.watch keeps
  // the loop alive and turns a passing file into a hang.
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
  };
  return { m, persistence, registered, root, stop };
}

// The deps above are wired far enough that create() runs to COMPLETION — it is
// deliberately not wrapped in a try/catch. A half-spawned create that threw
// after the settings write would still satisfy "no env key" (the file is
// already on disk), so swallowing the throw here would hide exactly the failure
// the ENTER assertions exist to catch. Let it propagate.
function spawn(m, name, noWire, { cwd = os.tmpdir() } = {}) {
  return m.create(name, 'claude', cwd, [], null, 'ws', null, false, null,
    [], [], [], [], [], null, [], [], null, null, true, noWire);
}

function readSettings(root, name) {
  const p = pathFor(root, name, 'settings');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

test('t189: a noWire spawn writes a settings file with NO env key, while the same fixture wired writes one', async () => {
  // Both arms run against a fixture with an external proxy configured — the
  // interesting case, because that is the fallback that would silently re-set
  // the variable if only the wire registration were skipped.
  const { m, registered, root, stop } = mkManager({ proxyBase: 'http://127.0.0.1:7800' });

  await spawn(m, 'wired', false);
  await spawn(m, 'off', true);
  stop('wired'); stop('off');

  const wired = readSettings(root, 'wired');
  const off = readSettings(root, 'off');

  // ENTER, both arms: the file must exist and be a real settings object. "No env
  // key" is true of a missing file, of `{}`, and of a create() that threw before
  // the hook — none of which is the property under test.
  assert.ok(wired && Array.isArray(wired.hooks.SessionStart),
    'ENTER: the wired arm must have written a real settings file, or the control below proves nothing');
  assert.ok(off && Array.isArray(off.hooks.SessionStart),
    'ENTER: the wire-off arm must have written a real settings file — an absent file makes the absence assertion vacuous');

  // Control: this fixture DOES set the variable when the flag is off.
  assert.ok(wired.env && typeof wired.env.ANTHROPIC_BASE_URL === 'string',
    'the wired arm really does set ANTHROPIC_BASE_URL — otherwise the wire-off arm is not being compared to anything');

  // The property. Not `settings.env.ANTHROPIC_BASE_URL === undefined`, which is
  // also true of `env: {}` — the CLI must see no env block at all.
  assert.strictEqual('env' in off, false,
    `a wire-off session's settings must carry NO env key at all — got ${JSON.stringify(off.env)}`);

  // The other half: no wire registration, so wireBase stays null.
  assert.deepStrictEqual(registered.map((r) => r.name), ['wired'],
    'only the wired arm may register with the tee; a wire-off seat must never reach registerAgent');
});

test('t189: nulling proxyBase is load-bearing — the external proxy alone would re-set the variable', async () => {
  // The narrow half of the test above, isolated: with the wire OFF at the app
  // level (WIRE_SHADOW false) a wired spawn still gets ANTHROPIC_BASE_URL, via
  // the proxyBase fallback. That is the exact path `noWire` has to close, and it
  // is closed by the proxyBase null, not by the WIRE_SHADOW gate.
  const { m, registered, root, stop } = mkManager({ proxyBase: 'http://127.0.0.1:7800', wireShadow: false });

  await spawn(m, 'p-on', false);
  await spawn(m, 'p-off', true);
  stop('p-on'); stop('p-off');

  const on = readSettings(root, 'p-on');
  const off = readSettings(root, 'p-off');
  assert.ok(on && on.hooks, 'ENTER: the proxy-only arm wrote a settings file');
  assert.ok(off && off.hooks, 'ENTER: the wire-off arm wrote a settings file');

  assert.strictEqual(on.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:7800/agent/p-on/anthropic',
    'with the shadow wire off, the external proxy is what sets the variable — this is the fallback noWire must close');
  assert.strictEqual('env' in off, false,
    'so a wire-off seat must reach setupClaudeHook with proxyBase null, or it gets the proxy URL instead of nothing');
  assert.deepStrictEqual(registered, [],
    'ENTER: WIRE_SHADOW false means neither arm registered — the difference above is the proxy fallback alone');
});

test('t189: a wire-off session stays in the already-supported jsonl/unrouted state', async () => {
  const { m, stop } = mkManager({ proxyBase: 'http://127.0.0.1:7800' });
  await spawn(m, 'wired', false);
  await spawn(m, 'off', true);

  const wired = m.sessions.get('wired');
  const off = m.sessions.get('off');
  stop('wired'); stop('off');

  // ENTER: both sessions must be in the map. create() throws after the PTY stub
  // returns, so a session that never landed would make every field read
  // undefined and the strictEquals below would compare nothing to nothing.
  assert.ok(wired, 'ENTER: the wired session reached sessions.set');
  assert.ok(off, 'ENTER: the wire-off session reached sessions.set');

  // The whole triple, not one field: the ticket's claim is that wire-off lands in
  // the state Codex sessions and wire-failed spawns already occupy, and that
  // claim is about the COMBINATION. A partial check passes on a session that is
  // unrouted but still scanning intents off the wire — which would go silent.
  assert.deepStrictEqual(
    { intentSource: off.intentSource, wireRouted: off.wireRouted, noWire: off.noWire },
    { intentSource: 'jsonl', wireRouted: false, noWire: true },
    'a wire-off seat takes intents from the transcript, is not wire-routed, and knows it',
  );
  assert.deepStrictEqual(
    { intentSource: wired.intentSource, wireRouted: wired.wireRouted, noWire: wired.noWire },
    { intentSource: 'wire', wireRouted: true, noWire: false },
    'ENTER (control): the wired arm really is in the OTHER state, so the triple above is a difference and not the default',
  );
});

test('t189: noWire is persisted as a boolean on every spawn, so it survives a respawn and can be turned back off', async () => {
  const { m, persistence, stop } = mkManager();
  await spawn(m, 's', true);
  stop('s');

  assert.strictEqual(persistence.get('s').noWire, true,
    'the record must carry the flag — every respawn path (restore, restart, retry, reload) replays it from here');

  // Written unconditionally, not conditionally-omitted: upsert spread-MERGES, so
  // an omitted `false` would leave the `true` above in place and a seat turned
  // back on would silently stay wire-off forever. This is the same hazard the
  // spawnerHintSet field documents three lines above it in create().
  m.sessions.delete('s');
  await spawn(m, 's', false);
  stop('s');
  assert.strictEqual(persistence.get('s').noWire, false,
    'respawning the SAME name wired must clear the flag on the record, not merge under a stale true');
});
