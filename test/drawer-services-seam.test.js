'use strict';
// drawer-services-seam.test.js — the drawer's service-backed tenants (a
// clodexctl verb runner over `ctl:*`, a workbench PTY over `wterm:*`) are
// desktop-only, and the boundary is REGISTRATION, not the renderer.
//
// Why registration and not `available()`: web-host.js builds its handler map by
// running the same registerIpcHandlers the desktop runs, and its `invoke` frame
// dispatches any registered channel BY NAME without consulting api-contract —
// the hazard the `session:list` comment in ipc-handlers.js already documents. A
// renderer-side `available()` flag is chosen by the client, so a browser client
// that simply ignores it would reach a token-backed verb runner and a remote
// shell. The seam is `enableDrawerServices`, same construction-time shape as
// `enableSandbox`.
//
// Both prefixes now have handlers behind the gate, so the absence assertion is
// no longer vacuous — it fails the moment one is registered ungated.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');
const { createWebHost } = require('../web-host');

// This list IS the contract — nothing derives it from the handlers. A step-3
// service registered as `clodexctl:run` rather than `ctl:run` would sail past
// every assertion below, so a new drawer service either picks a covered prefix
// or adds its own here.
const GATED_PREFIXES = ['ctl:', 'wterm:', 'drawer:'];
const silentLog = { info() {}, warn() {}, error() {} };

function mkEngine(seams) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-drawer-seam-'));
  return createEngine({ userDataPath: tmp, seams, log: silentLog });
}

test('engine: seam omitted (Electron path) → drawer services enabled', () => {
  const eng = mkEngine({});
  // Three claims, not one: the flag is PRESENT (a typo'd seam name would leave
  // it undefined, which reads as "off" downstream and would silently disable
  // the desktop tabs), it is not the opt-out value, and it is exactly true.
  assert.ok('enableDrawerServices' in eng, 'the engine must expose the flag, not leave it undefined');
  assert.notStrictEqual(eng.enableDrawerServices, false, 'default is not the opt-out');
  assert.strictEqual(eng.enableDrawerServices, true, 'desktop default: drawer services available');
});

test('engine: enableDrawerServices:false → opted out', () => {
  const eng = mkEngine({ enableDrawerServices: false });
  assert.strictEqual(eng.enableDrawerServices, false, 'a host can decline the capability at construction');
});

// The real createWebHost with the real registerIpcHandlers is not stand-uppable
// without a full engine, so this reproduces the ONE thing that matters: the deps
// object web-host hands the registrar. If the flag were missing or true there,
// a gated registration would fire on the web surface.
//
// The stub engine carries `enableDrawerServices: true` ON PURPOSE, and it is
// what gives the assertion teeth: web-host builds deps as `{ ...engine, …,
// enableDrawerServices: false }`, so against a flagless engine the literal
// holds wherever it sits relative to the spread. The REAL engine defaults the
// flag to true (headless-main passes only enableSandbox:false), so an engine
// stub without it would let a spread-ordering mistake ship an enabled
// capability on the web surface with this test green.
test('web-host hands registerIpcHandlers enableDrawerServices:false', () => {
  let seen = null;
  const host = createWebHost({
    engine: { stores: {}, enableDrawerServices: true },
    log: silentLog,
    port: 0,
    host: '127.0.0.1',
    userDataPath: os.tmpdir(),
    registerHandlers: (deps) => { seen = deps; },
  });
  try {
    assert.ok(seen, 'registerHandlers ran — otherwise every assertion below is vacuous');
    assert.ok('enableDrawerServices' in seen, 'the dep must be present, not absent');
    assert.notStrictEqual(seen.enableDrawerServices, true, 'the web surface must not enable drawer services');
    assert.strictEqual(seen.enableDrawerServices, false, 'exactly the opt-out value');
  } finally {
    host.close();
  }
});

test('no ctl:/wterm: channel is registered on the web-host surface', () => {
  // Registration only calls handle()/on(); handler bodies never run, so inert
  // stubs are enough for every other dep. Mirrors api-contract.test.js's
  // capture, with web-host's real flag value on top.
  const registered = new Set();
  const capture = {
    handle: (ch) => registered.add(ch),
    on: (ch) => registered.add(ch),
    enableDrawerServices: false,
  };
  const stub = () => () => {};
  const deps = new Proxy(capture, {
    get(target, prop) { return prop in target ? target[prop] : stub(); },
    has(target, prop) { return prop in target; },
  });
  require('../ipc-handlers').registerIpcHandlers(deps);

  // The apparatus ran: an empty (or tiny) channel set would satisfy the
  // absence below while proving nothing at all.
  assert.ok(registered.size > 100, `registration produced only ${registered.size} channels — capture is broken`);
  assert.ok(registered.has('session:list'), 'ENTER: a known channel registered, so the set is real');

  const gated = [...registered].filter((ch) => GATED_PREFIXES.some((p) => ch.startsWith(p)));
  assert.deepStrictEqual(gated, [],
    `drawer-service channels registered on the web surface: ${gated.join(', ')} — gate them on enableDrawerServices`);
});

// The other half, and it is not optional: the absence above is ALSO true of a
// build where `ctl:run` was never written, was renamed, or was gated on a flag
// that is never true anywhere. Without this, the whole file passes on a broken
// desktop app — the assertion that matters most is the one whose failure mode
// is silence.
test('the SAME registrar registers ctl:* when the capability is granted', () => {
  const registered = new Set();
  const capture = {
    handle: (ch) => registered.add(ch),
    on: (ch) => registered.add(ch),
    enableDrawerServices: true,   // the desktop value — the only difference
  };
  const stub = () => () => {};
  const deps = new Proxy(capture, {
    get(target, prop) { return prop in target ? target[prop] : stub(); },
    has(target, prop) { return prop in target; },
  });
  require('../ipc-handlers').registerIpcHandlers(deps);

  assert.ok(registered.has('session:list'), 'ENTER: the capture is real');
  assert.ok(registered.has('ctl:run'), 'the desktop path must register the verb runner');
  assert.ok(registered.has('ctl:context'), 'and the prompt-line context read');
  // Inside the gate despite carrying no token and touching no wire: a channel
  // the web host never registers cannot be probed to enumerate what the
  // desktop's verb runner would accept.
  assert.ok(registered.has('ctl:help'), 'and the cheat sheet');
  assert.ok(registered.has('wterm:spawn'), 'the desktop path must register the workbench shell');
  assert.ok(registered.has('wterm:write'), 'and its input');
  assert.ok(registered.has('wterm:resize'), 'and its SIGWINCH');
  // The one channel here that writes into an agent's request rather than
  // running something on the host.
  assert.ok(registered.has('drawer:armSelection'), 'and the drawer selection hint');
  assert.ok(registered.has('drawer:releaseSelection'), 'and its release');
});

// The SECOND property of the wterm handlers, and the one a comment alone cannot
// keep true: the workspace is resolved from the SENDER, never from the payload.
// A handler that honoured a caller-supplied id would let one connection type
// into another window's shell — and every other test in this file passes under
// that mutation, because registration and gating are both still correct.
//
// Driven at the REGISTRAR level with a captured pty service: the property lives
// in the handler body, so a test against drawer-pty.js alone cannot see it.
function registerDesktop(overrides) {
  const handlers = {};
  const capture = {
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { handlers[ch] = fn; },
    enableDrawerServices: true,
    ...overrides,
  };
  const stub = () => () => {};
  const deps = new Proxy(capture, {
    get(target, prop) { return prop in target ? target[prop] : stub(); },
    has(target, prop) { return prop in target; },
  });
  require('../ipc-handlers').registerIpcHandlers(deps);
  return handlers;
}

test('wterm:* resolve the workspace from the SENDER, not the payload', () => {
  const calls = [];
  const handlers = registerDesktop({
    // The sender is in ws1. Every payload below claims ws2. The wterm handlers
    // resolve through the STRICT variant (no default-workspace fallback), so
    // faking the shared helper here would prove nothing.
    workspaceOfSenderStrict: () => 'ws1',
    workspaceOfSender: () => 'ws-WRONG',
    getDrawerPtys: () => ({
      spawn: (id, opts) => { calls.push(['spawn', id, opts]); return { ok: true }; },
      write: (id, data) => { calls.push(['write', id, data]); return true; },
      resize: (id, c, r) => { calls.push(['resize', id, c, r]); return true; },
    }),
  });

  assert.ok(handlers['wterm:spawn'], 'ENTER: the handlers registered, so the calls below are real');

  handlers['wterm:spawn']({}, { cols: 80, rows: 24, workspaceId: 'ws2' });
  // write is the sharpest of the three: it is the one that actually delivers
  // keystrokes into a shell, so a payload-honouring version is a live
  // cross-workspace write, not merely a misfiled spawn.
  handlers['wterm:write']({}, 'rm -rf /\r');
  handlers['wterm:resize']({}, 200, 60);

  assert.deepStrictEqual(calls, [
    ['spawn', 'ws1', { cols: 80, rows: 24, workspaceId: 'ws2' }],
    ['write', 'ws1', 'rm -rf /\r'],
    ['resize', 'ws1', 200, 60],
  ], 'every wterm handler addressed the SENDER\'s workspace, ignoring the payload\'s claim');
});

test('wterm:* refuse when the sender resolves to no workspace', () => {
  // The window closed with a keystroke in flight. The SHARED helper answers
  // DEFAULT_WORKSPACE_ID here, which would deliver those bytes into a different
  // workspace's shell — so these three handlers must refuse instead.
  const calls = [];
  const handlers = registerDesktop({
    workspaceOfSenderStrict: () => null,
    workspaceOfSender: () => 'default',   // what the fallback WOULD have said
    getDrawerPtys: () => ({
      spawn: (...a) => { calls.push(['spawn', ...a]); return { ok: true }; },
      write: (...a) => { calls.push(['write', ...a]); return true; },
      resize: (...a) => { calls.push(['resize', ...a]); return true; },
    }),
  });

  const res = handlers['wterm:spawn']({}, {});
  assert.strictEqual(res.ok, false, 'spawn refuses rather than defaulting');
  assert.strictEqual(handlers['wterm:write']({}, 'x'), false);
  assert.strictEqual(handlers['wterm:resize']({}, 80, 24), false);
  assert.deepStrictEqual(calls, [], 'nothing reached the pty service at all');
});

// createEngine's background timers keep the loop alive; exit once results flush.
after(() => { setImmediate(() => process.exit(0)); });
