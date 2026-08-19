'use strict';
// engine-web-info-seam.test.js — t30a: the `webInfo` engine seam, the path a
// box's browser frontend takes to reach the peering hello.
//
// The shape is the point. The web host is started by headless-main.js AFTER
// createEngine returns, and does not exist at all under Electron, so the seam is
// a GETTER read per hello — anything captured at construction would be null
// forever. These pin that end to end: engine's default, remote-wiring's
// pass-through into the RemoteServer, and the headless closure's own shape.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');
const { createRemoteWiring } = require('../remote-wiring');

function mkEngine(seams) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-eng-web-'));
  // registryDir or the engine seeds the operator's live ~/.clodex (t359).
  return createEngine({
    userDataPath: tmp,
    seams: { registryDir: path.join(tmp, 'clodex-home'), ...seams },
    log: { info() {}, warn() {}, error() {} },
  });
}

// The engine does NOT export getWebInfo — it threads the seam into the peer
// wire. So drive the REAL path: stand an engine up with the seam, patch
// RemoteServer to capture its construction options, and read the getter the
// hello would call. Patching means no socket is ever bound.
// CLODEX_REMOTE_ENABLE=1 is the documented headless-container switch that brings
// the wire up with no settings write (remote-wiring.js:75) — the same door the
// web-frontend image uses, so this exercises the deployment that HAS a web host.
function engineRemoteOptions(seams) {
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  const hadEnv = process.env.CLODEX_REMOTE_ENABLE;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    // setWtermCallbacks is reconciled on every sync (t219): the peer-terminal
    // grant is a live toggle, so the fake needs it. Added to the FAKE rather
    // than guarded with a typeof at the call site — a real server missing the
    // method is a wiring break worth crashing on.
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  process.env.CLODEX_REMOTE_ENABLE = '1';
  try {
    mkEngine(seams).syncRemoteServer();
  } finally {
    remoteMod.RemoteServer = orig;
    if (hadEnv === undefined) delete process.env.CLODEX_REMOTE_ENABLE;
    else process.env.CLODEX_REMOTE_ENABLE = hadEnv;
  }
  assert.ok(opts, 'the peer wire was constructed');
  return opts;
}

// A createRemoteWiring dep bundle sufficient to reach `new RemoteServer(...)`
// (the same shape remote-create.test.js uses), plus a capture of the options the
// RemoteServer was actually constructed with.
function captureRemoteOptions(extraDeps) {
  let srv = null;
  const deps = {
    path, fs, os,
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
    getUiSettings: () => ({ get: () => ({ remoteEnabled: true, remotePort: 0 }) }),
    getWorkspaces: () => ({ get: () => ({}) }),
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; }, setRemoteError: () => {},
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
    ...extraDeps,
  };
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    // setWtermCallbacks is reconciled on every sync (t219): the peer-terminal
    // grant is a live toggle, so the fake needs it. Added to the FAKE rather
    // than guarded with a typeof at the call site — a real server missing the
    // method is a wiring break worth crashing on.
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  try {
    createRemoteWiring(deps).syncRemoteServer();
  } finally {
    remoteMod.RemoteServer = orig;
  }
  return opts;
}

// ── engine: the seam is optional, and its default is an honest "none" ────────

test('seam omitted (the Electron path): the wire gets a getter reporting no web host', () => {
  const opts = engineRemoteOptions({});
  assert.strictEqual(typeof opts.getWebInfo, 'function', 'always a function, so the hello needs no null check');
  assert.strictEqual(opts.getWebInfo(), null, 'no seam → no web host, not a guess at wire-port+1');
});

test('seam supplied: the engine reads THROUGH it on every call, never a snapshot', () => {
  // The load-bearing property. headless-main assigns `webHost` AFTER
  // createEngine returns, so a seam captured by value would report null forever
  // — the whole reason this is a getter and not a port number.
  let info = null;
  const opts = engineRemoteOptions({ webInfo: () => info });
  assert.strictEqual(opts.getWebInfo(), null, 'before the web host starts');
  info = { port: 8080, tokenGated: false };
  assert.deepStrictEqual(opts.getWebInfo(), { port: 8080, tokenGated: false }, 'after it starts, same engine');
  info = { port: 9090, tokenGated: true };
  assert.deepStrictEqual(opts.getWebInfo(), { port: 9090, tokenGated: true }, 'and it tracks a move');
  info = null;
  assert.strictEqual(opts.getWebInfo(), null, 'and a shutdown');
});

// ── remote-wiring: the seam reaches the RemoteServer as a callable ───────────

test('remote-wiring threads getWebInfo into the RemoteServer as a live getter', () => {
  let info = { port: 8080, tokenGated: false };
  const opts = captureRemoteOptions({ getWebInfo: () => info });
  assert.strictEqual(typeof opts.getWebInfo, 'function');
  assert.deepStrictEqual(opts.getWebInfo(), { port: 8080, tokenGated: false });
  // Still live on the far side of the wiring — not frozen at construction.
  info = { port: 9090, tokenGated: true };
  assert.deepStrictEqual(opts.getWebInfo(), { port: 9090, tokenGated: true });
});

test('remote-wiring tolerates a missing or non-callable getWebInfo (old/partial hosts)', () => {
  for (const bad of [undefined, null, 'nope', { port: 8080 }]) {
    const opts = captureRemoteOptions({ getWebInfo: bad });
    assert.strictEqual(typeof opts.getWebInfo, 'function', `${JSON.stringify(bad)} → still a function`);
    assert.strictEqual(opts.getWebInfo(), null, 'and it reports no web host');
  }
});

// ── headless: the closure shape, pinned as source ───────────────────────────

test('headless-main declares webInfo as a closure over a `let` assigned LATER', () => {
  // headless-main.js boots a real host (pid lock, engine, session restore), so
  // it cannot be require()d here. The property that matters is textual and
  // exactly the one that would silently regress: if someone "simplifies"
  // `webInfo: () => (webHost ? webHost.info : null)` into `webInfo: webHost` or
  // `webHost.info`, it captures the null that `webHost` holds at that point and
  // every headless box reports no web host forever.
  const src = fs.readFileSync(path.join(__dirname, '..', 'headless-main.js'), 'utf8');
  const seam = /webInfo:\s*\(\)\s*=>\s*\(?webHost\s*\?\s*webHost\.info\s*:\s*null\)?/.exec(src);
  assert.ok(seam, 'webInfo is a getter closing over webHost, null-guarded');
  // And `webHost` is a reassignable binding declared AFTER the seam — the
  // ordering that makes the getter necessary in the first place.
  const declIdx = src.indexOf('let webHost = null;');
  assert.ok(declIdx > 0, 'webHost is a `let`, not a const captured at init');
  assert.ok(declIdx > seam.index, 'declared after the seam that closes over it');
});

// createEngine's background timers keep the loop alive; exit once results flush.
after(() => { setImmediate(() => process.exit(0)); });

// ── t443: the wirescope seam takes the SAME path, one field over ─────────────

test('engine threads a LIVE wirescope getter into the peer wire', () => {
  // A getter for the same reason as webInfo, plus one of its own: the gate is a
  // live fact (Preferences' proxy toggle, CLODEX_WIRESCOPE, the port setting), so
  // a value captured once would advertise a port the box stopped serving. Read
  // through the real engine, whose supervisor answers from real settings.
  const opts = engineRemoteOptions({});
  assert.strictEqual(typeof opts.getWirescopeInfo, 'function',
    'always a function, so the hello needs no null check');
  const out = opts.getWirescopeInfo();
  assert.ok(out === null || (out && Number.isInteger(out.port)),
    'and answers either null or a real port — never undefined');
});

test('remote-wiring tolerates a missing or non-callable getWirescopeInfo (old/partial hosts)', () => {
  // Same degrade as webInfo: a host that does not supply the seam reports "no
  // wirescope", which costs a dashboard link. A throw here would cost the whole
  // peer wire.
  for (const bad of [undefined, null, 42, 'nope', {}]) {
    const opts = captureRemoteOptions({ getWirescopeInfo: bad });
    assert.strictEqual(typeof opts.getWirescopeInfo, 'function', `${JSON.stringify(bad)} → still a function`);
    assert.strictEqual(opts.getWirescopeInfo(), null, 'and it reports no wirescope');
  }
});

test('remote-wiring passes a working seam straight through, and it stays LIVE', () => {
  let info = null;
  const opts = captureRemoteOptions({ getWirescopeInfo: () => info });
  assert.strictEqual(opts.getWirescopeInfo(), null, 'before the supervisor wants one');
  info = { port: 7800 };
  assert.deepStrictEqual(opts.getWirescopeInfo(), { port: 7800 }, 'after, through the same captured getter');
  info = { port: 7999 };
  assert.deepStrictEqual(opts.getWirescopeInfo(), { port: 7999 }, 'and it tracks a move');
});
