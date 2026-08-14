'use strict';
// drawer-services-seam.test.js — the drawer's service-backed tenants (a
// clodexctl verb runner over `ctl:*`, the selection reads over `drawer:*`, a
// shell on a PEER over `peer:wterm*`) are desktop-only, and the boundary is
// REGISTRATION, not the renderer.
//
// Why registration and not `available()`: web-host.js builds its handler map by
// running the same registerIpcHandlers the desktop runs, and its `invoke` frame
// dispatches any registered channel BY NAME without consulting api-contract —
// the hazard the `session:list` comment in ipc-handlers.js already documents. A
// renderer-side `available()` flag is chosen by the client, so a browser client
// that simply ignores it would reach a token-backed verb runner and a shell on
// a third machine. The seam is `enableDrawerServices`, same construction-time
// shape as `enableSandbox`.
//
// THE LOCAL `wterm:*` FAMILY IS NOT IN THAT SET (t227) and this file now pins
// its PRESENCE on the web surface rather than its absence. The argument that
// gates the others does not reach it: `session:create` is ungated on web, and a
// `type: 'bash'` session is `$SHELL` on that same box for that same operator —
// so refusing `wterm:*` refused a tab, not a capability. It has its own seam,
// `enableLocalTerminal`, so a host can still decline it deliberately.
//
// Every gated prefix has handlers behind it, so the absence assertion is not
// vacuous — it fails the moment one is registered ungated.

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
// `peer:wterm` is a PREFIX FRAGMENT, not a namespace, and that is deliberate:
// the rest of `peer:*` is deliberately ungated (it drives sessions the far side
// already exposes to attach), while these four open a SHELL on a third machine.
// A rule of "the peer namespace is gated" would be wrong; a rule of "the peer
// TERMINAL is gated" is what this string says.
//
// `wterm:` is absent from this list ON PURPOSE (t227) and its removal is not a
// weakening of the list: `peer:wterm` stays, so the substring that matters most
// is still covered, and WEB_REGISTERED below asserts the local family is
// present rather than leaving it unmentioned. A prefix dropped from a gate list
// with nothing asserted on the other side is how a gate disappears silently.
const GATED_PREFIXES = ['ctl:', 'drawer:', 'peer:wterm'];
// The other half of that removal. Named here beside the gate list because the
// two are one decision: these channels MUST reach the web surface, and a future
// edit that re-gates them has to delete this constant to do it.
const WEB_REGISTERED = ['wterm:spawn', 'wterm:write', 'wterm:resize'];
const silentLog = { info() {}, warn() {}, error() {} };

function mkEngine(seams) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-drawer-seam-'));
  // registryDir or the engine seeds the operator's live ~/.clodex (t359).
  return createEngine({
    userDataPath: tmp,
    seams: { registryDir: path.join(tmp, 'clodex-home'), ...seams },
    log: silentLog,
  });
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

// The t227 seam, and the three claims are the same three as above for the same
// reason: a typo'd seam name leaves the flag undefined, which reads as "off"
// downstream — and here that means no pty service is constructed at all, so the
// desktop's own terminal tab would go inert.
test('engine: enableLocalTerminal defaults ON and is INDEPENDENT of the drawer flag', () => {
  const eng = mkEngine({});
  assert.ok('enableLocalTerminal' in eng, 'the engine must expose the flag, not leave it undefined');
  assert.notStrictEqual(eng.enableLocalTerminal, false, 'default is not the opt-out');
  assert.strictEqual(eng.enableLocalTerminal, true, 'desktop default: the local terminal is available');

  // The independence is the whole point of the split — a host that declines the
  // verb runner and the peer shell still gets a local shell, because it already
  // serves `session:create`. Asserted as a pair: two separate strictEquals
  // would both pass against a single flag aliased under two names.
  const declined = mkEngine({ enableDrawerServices: false });
  assert.deepStrictEqual(
    { drawer: declined.enableDrawerServices, localTerminal: declined.enableLocalTerminal },
    { drawer: false, localTerminal: true },
    'declining drawer services must not drag the local terminal down with it',
  );
});

test('engine: enableLocalTerminal:false → no pty service at all', () => {
  const eng = mkEngine({ enableLocalTerminal: false });
  assert.strictEqual(eng.enableLocalTerminal, false, 'a host can decline the terminal at construction');
  // Not merely unregistered handlers: the service itself is never built, so
  // there is nothing for a stray caller to reach and no shell to reap.
  assert.strictEqual(eng.getDrawerPtys(), null, 'the pty service is not constructed');
  const on = mkEngine({});
  assert.ok(on.getDrawerPtys(), 'ENTER: it IS constructed by default — otherwise the null above proves nothing');
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
    // Both flags carry the value web-host must OVERRIDE, so a spread-ordering
    // mistake shows up as the engine's value surviving rather than as a match.
    engine: { stores: {}, enableDrawerServices: true, enableLocalTerminal: false },
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
    // The t227 split, asserted as a PAIR. Separately these two read as
    // arbitrary; together they are the claim — this host refuses the verb
    // runner, the selection reads and the peer shell, and grants the local
    // terminal, because a `type: 'bash'` session already grants that shell.
    // A single flag that happened to be true would satisfy neither half.
    assert.ok('enableLocalTerminal' in seen, 'the local-terminal flag must be present, not absent');
    assert.deepStrictEqual(
      { drawer: seen.enableDrawerServices, localTerminal: seen.enableLocalTerminal },
      { drawer: false, localTerminal: true },
      'web surface: drawer services declined, local drawer terminal granted',
    );
  } finally {
    host.close();
  }
});

// Finding B of the t227 audit. The wterm handlers resolve the workspace through
// `workspaceOfSenderStrict` and fall back to the LOOSE helper when it is absent
// — and web-host's loose helper ends `|| DEFAULT_WORKSPACE_ID`. So a missing
// strict dep does not fail closed here, it silently restores the default-
// workspace fallback the strict variant exists to prevent, and every other
// assertion in this file stays green while it does.
test('web-host supplies a STRICT workspace resolver for the wterm handlers', () => {
  let seen = null;
  const host = createWebHost({
    engine: { stores: {} },
    log: silentLog,
    port: 0,
    host: '127.0.0.1',
    userDataPath: os.tmpdir(),
    registerHandlers: (deps) => { seen = deps; },
  });
  try {
    assert.ok(seen, 'ENTER: registerHandlers ran');
    assert.strictEqual(typeof seen.workspaceOfSenderStrict, 'function',
      'absent means the handlers take the loose branch, which defaults the workspace');
    const conn = (workspaceId) => ({ sender: { conn: { workspaceId } } });
    assert.strictEqual(seen.workspaceOfSenderStrict(conn('ws-7')), 'ws-7', 'a resolved conn keeps its workspace');
    // The whole point of the strict variant: unresolved is NULL, where the
    // loose one answers the default. Asserted against that loose helper's own
    // reply so the two cannot quietly converge.
    assert.strictEqual(seen.workspaceOfSenderStrict(conn(null)), null, 'unresolved is a refusal');
    assert.strictEqual(seen.workspaceOfSenderStrict({}), null, 'no conn at all is a refusal too');
    assert.notStrictEqual(seen.workspaceOfSender({}), null,
      'ENTER: the loose helper really does default — otherwise the contrast above is vacuous');
  } finally {
    host.close();
  }
});

// The web surface's two answers, in ONE test because they are one decision and
// splitting them is what lets half of it rot. The absence is the older claim;
// the presence is t227's, and without it removing `wterm:` from GATED_PREFIXES
// would leave this file asserting strictly less than it did before — an absence
// list that shed a prefix and gained nothing.
test('the web-host surface gates ctl:/drawer:/peer:wterm and REGISTERS wterm:*', () => {
  // Registration only calls handle()/on(); handler bodies never run, so inert
  // stubs are enough for every other dep. Mirrors api-contract.test.js's
  // capture, with web-host's real flag values on top.
  const registered = new Set();
  const capture = {
    handle: (ch) => registered.add(ch),
    on: (ch) => registered.add(ch),
    enableDrawerServices: false,
    enableLocalTerminal: true,
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
  // The peer block runs on this surface too — without this, `peer:wterm*`'s
  // absence below would also be true of a build where the whole peer family
  // failed to register, which is a different bug wearing the same green.
  assert.ok(registered.has('peer:input'), 'ENTER: the ungated peer surface registered here too');

  const gated = [...registered].filter((ch) => GATED_PREFIXES.some((p) => ch.startsWith(p)));
  assert.deepStrictEqual(gated, [],
    `drawer-service channels registered on the web surface: ${gated.join(', ')} — gate them on enableDrawerServices`);

  // t227. Asserted as the WHOLE set rather than three `ok`s: a fourth
  // `wterm:*` channel added later and gated by accident would pass every
  // individual check while being missing from the surface this test is about.
  assert.deepStrictEqual(
    [...registered].filter((ch) => ch.startsWith('wterm:')).sort(),
    [...WEB_REGISTERED].sort(),
    'the web surface must register the LOCAL workbench terminal — it already serves session:create, which spawns the same shell',
  );
});

// The RENDERER half, and without it this whole file can be green over a feature
// no web operator can see. Registering `wterm:*` on the web surface does
// nothing on its own: drawer-host only calls a tenant's `available()` if it has
// one (`if (def.available && !def.available())`), and term-tab used to carry
// `available: () => !window.__CLODEX_WEB__`, which hid the tab regardless of
// what the host registered. Measured, not reasoned — restoring that line leaves
// every other test in this file, and the three that name term-tab or
// drawer-host, passing at 14/14.
//
// A source grep rather than a behavioural test because term-tab.js is DOM-bound
// (the R1 rule), so there is nothing to drive; and the bundle is checked too,
// since `npm run build:web` is a manual step and the browser frontend runs out
// of the committed artifact. Assert the SOURCE first: a bundle-only pin passes
// over a source that no longer has the feature, because a stale bundle still
// carries what the source dropped.
test('the term tab has no web-surface available() — and the committed bundle agrees', () => {
  const fs = require('node:fs');
  const ROOT = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'term-tab.js'), 'utf8');
  const GATE = 'available: () => !window.__CLODEX_WEB__,';

  assert.ok(src.includes("id: 'term',"), 'ENTER: this really is the term tenant\'s registration');
  assert.ok(!src.includes(GATE),
    'term-tab must not gate itself off the web surface — the handlers are registered there now');

  // The ctl tab is the control: it KEEPS its gate, so a mutation that stripped
  // the string everywhere (or a grep that matches nothing) fails here instead
  // of passing quietly above.
  const ctl = fs.readFileSync(path.join(ROOT, 'renderer', 'ctl-tab.js'), 'utf8');
  assert.ok(ctl.includes(GATE), 'ENTER: ctl-tab still HAS the gate — ctl:* stays desktop-only');

  // One occurrence in the bundle, not zero: ctl-tab's. Zero would mean the
  // grep is looking for a string esbuild rewrote, and this pin would then be
  // green over anything at all.
  const web = fs.readFileSync(path.join(ROOT, 'web-dist', 'index.html'), 'utf8');
  const hits = web.split(GATE).length - 1;
  assert.strictEqual(hits, 1,
    `expected exactly ctl-tab's gate in web-dist/index.html, found ${hits} — either the term tab's gate is back, or web-dist is stale (run \`npm run build:web\` and commit it)`);
});

// The local-terminal flag is a real seam and not decoration: a host that means to
// refuse a shell must still be able to. Without this, `enableLocalTerminal`
// could be ignored entirely by the registrar and every other test here would
// stay green — the presence assertion above would simply be reporting the
// desktop block's unconditional registration.
test('enableLocalTerminal:false withholds wterm:* even with drawer services on', () => {
  const registered = new Set();
  const capture = {
    handle: (ch) => registered.add(ch),
    on: (ch) => registered.add(ch),
    enableDrawerServices: true,     // the OTHER flag granted, to isolate this one
    enableLocalTerminal: false,
  };
  const stub = () => () => {};
  const deps = new Proxy(capture, {
    get(target, prop) { return prop in target ? target[prop] : stub(); },
    has(target, prop) { return prop in target; },
  });
  require('../ipc-handlers').registerIpcHandlers(deps);

  assert.ok(registered.has('ctl:run'), 'ENTER: drawer services DID register, so the absence below is about the local-terminal flag alone');
  assert.deepStrictEqual([...registered].filter((ch) => ch.startsWith('wterm:')), [],
    'the local-terminal flag must actually withhold the family, not merely exist');
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
    enableDrawerServices: true,     // the desktop value — the only difference
    enableLocalTerminal: true,
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
  // The peer terminal (t219) — a shell on ANOTHER box, so the strongest member
  // of the family. Its ungated siblings are the control: `peer:input` proves
  // the registrar ran the peer block at all, so the four absences above are
  // about the gate and not about a peer surface that failed to register.
  assert.ok(registered.has('peer:input'), 'ENTER: the ungated peer surface registered');
  assert.ok(registered.has('peer:wtermOpen'), 'the desktop path must register the peer terminal');
  assert.ok(registered.has('peer:wtermInput'), 'and its keystrokes');
  assert.ok(registered.has('peer:wtermResize'), 'and its SIGWINCH');
  assert.ok(registered.has('peer:wtermClose'), 'and its detach');
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
    // Both flags, because the handlers this helper drives now live in two
    // different blocks: `wterm:*` behind the local-terminal flag, `peer:wterm*`
    // behind the drawer one. Granting only the first would leave the peer tests
    // below asserting against handlers that were never registered — and their
    // own `ENTER` lines are what would catch it.
    enableLocalTerminal: true,
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
      spawn: (id, seat, opts) => { calls.push(['spawn', id, seat, opts]); return { ok: true }; },
      write: (id, seat, data) => { calls.push(['write', id, seat, data]); return true; },
      resize: (id, seat, c, r) => { calls.push(['resize', id, seat, c, r]); return true; },
    }),
  });

  assert.ok(handlers['wterm:spawn'], 'ENTER: the handlers registered, so the calls below are real');

  handlers['wterm:spawn']({}, { cols: 80, rows: 24, workspaceId: 'ws2', seat: 'alpha' });
  // write is the sharpest of the three: it is the one that actually delivers
  // keystrokes into a shell, so a payload-honouring version is a live
  // cross-workspace write, not merely a misfiled spawn.
  handlers['wterm:write']({}, 'alpha', 'rm -rf /\r');
  handlers['wterm:resize']({}, 'alpha', 200, 60);

  // The WORKSPACE is the security boundary and comes from the sender; the SEAT
  // is a scoping key inside the window the sender already owns and rides the
  // payload. That asymmetry is the claim: ws1 in every row despite the payload
  // saying ws2, with the seat passed through.
  assert.deepStrictEqual(calls, [
    ['spawn', 'ws1', 'alpha', { cols: 80, rows: 24, workspaceId: 'ws2', seat: 'alpha' }],
    ['write', 'ws1', 'alpha', 'rm -rf /\r'],
    ['resize', 'ws1', 'alpha', 200, 60],
  ], 'every wterm handler addressed the SENDER\'s workspace, ignoring the payload\'s claim');
});

test('a malformed seat is normalised to null, never passed through', () => {
  // The seat rides the payload, so it is the one wterm input a caller controls.
  // It is a KEY, so a value outside the session-name grammar could alias another
  // pair's shell or escape the key's own separator. Shape-checked, not trusted.
  const calls = [];
  const handlers = registerDesktop({
    workspaceOfSenderStrict: () => 'ws1',
    getDrawerPtys: () => ({
      spawn: (id, seat) => { calls.push(seat); return { ok: true }; },
      write: (id, seat) => { calls.push(seat); return true; },
      resize: (id, seat) => { calls.push(seat); return true; },
    }),
  });

  assert.ok(handlers['wterm:write'], 'ENTER: the handlers registered');
  handlers['wterm:write']({}, 'ws-other\u0000evil', 'x');   // a forged key separator
  handlers['wterm:write']({}, '../../etc/passwd', 'x');
  handlers['wterm:write']({}, '..', 'x');                   // dot-only (t115 grammar)
  handlers['wterm:write']({}, 'a'.repeat(65), 'x');          // past the 64-char grammar
  handlers['wterm:write']({}, { toString: () => 'alpha' }, 'x'); // not a string
  handlers['wterm:write']({}, 'good-name_1.2', 'x');         // the grammar, in full

  assert.deepStrictEqual(calls, [null, null, null, null, null, 'good-name_1.2'],
    'anything outside [a-zA-Z0-9._-]{1,64} becomes the seatless shell');
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

// The peer terminal's own payload property, and the analogue of the two tests
// above: the renderer hands these handlers a COMPOSITE `name@peerId` key, and
// what reaches the connection must be the bare seat. An `@` on the wire fails
// the serving box's grammar, becomes null there, and null is the key of that
// box's SEATLESS WORKSPACE SHELL — so a passthrough is not a 404, it is every
// peer row quietly sharing one remote terminal.
function registerPeerDesktop(conns, overrides) {
  return registerDesktop({
    getPeerManager: () => ({ get: (id) => conns[id] || null }),
    ...overrides,
  });
}

test('peer:wterm* split the composite key — the @ never reaches the connection', async () => {
  const calls = [];
  const conn = {
    wtermOpen: (seat, owner, cb) => { calls.push(['open', seat, owner]); cb({ ok: true }); },
    wtermInput: (seat, data, cb) => { calls.push(['input', seat, data]); cb({ ok: true }); },
    wtermResize: (seat, c, r, cb) => { calls.push(['resize', seat, c, r]); cb({ ok: true }); },
    wtermClose: (seat, owner, cb) => { calls.push(['close', seat, owner]); cb({ ok: true }); },
  };
  // The open/close pair also carries the SENDER's workspace, and it is resolved
  // through the STRICT variant — the same seam the local `wterm:*` family uses,
  // so a payload cannot name a window the sender does not own. That id is what
  // gives the far-side want an owner: without one a renderer reload strands the
  // stream and its shell on the peer's machine with nothing left to close them.
  const handlers = registerPeerDesktop({ 'peer-1': conn }, {
    workspaceOfSenderStrict: () => 'ws1',
    workspaceOfSender: () => 'ws-WRONG',
  });

  assert.ok(handlers['peer:wtermOpen'], 'ENTER: the peer terminal handlers registered');

  assert.deepStrictEqual(await handlers['peer:wtermOpen']({}, 'bob@peer-1'), { ok: true });
  handlers['peer:wtermInput']({}, 'bob@peer-1', 'ls\r');
  assert.deepStrictEqual(await handlers['peer:wtermResize']({}, 'bob@peer-1', 120, 40), { ok: true });
  assert.deepStrictEqual(await handlers['peer:wtermClose']({}, 'bob@peer-1'), { ok: true });

  assert.deepStrictEqual(calls, [
    ['open', 'bob', 'ws1'],
    ['input', 'bob', 'ls\r'],
    ['resize', 'bob', 120, 40],
    ['close', 'bob', 'ws1'],
  ], 'every handler addressed the BARE seat, the peerId chose the connection, and open/close carried the sender\'s own workspace');
});

test('peer:wterm* refuse a key whose seat half fails the wire grammar', async () => {
  const calls = [];
  const conn = {
    wtermOpen: (seat, _owner, cb) => { calls.push(seat); cb({ ok: true }); },
    wtermInput: (seat, data, cb) => { calls.push(seat); cb({ ok: true }); },
    wtermResize: (seat, c, r, cb) => { calls.push(seat); cb({ ok: true }); },
    wtermClose: (seat, _owner, cb) => { calls.push(seat); cb({ ok: true }); },
  };
  const handlers = registerPeerDesktop({ 'peer-1': conn });

  for (const bad of ['bob', '@peer-1', 'bob@', '../etc@peer-1', '..@peer-1', `${'a'.repeat(65)}@peer-1`]) {
    const res = await handlers['peer:wtermOpen']({}, bad);
    assert.strictEqual(res.ok, false, `${JSON.stringify(bad)} is refused`);
  }
  // An unknown peer id is the same refusal — the key parsed, but it addresses
  // nothing, and a handler that fell through to a live connection would send a
  // seat to whichever peer happened to answer.
  assert.strictEqual((await handlers['peer:wtermOpen']({}, 'bob@peer-NOPE')).ok, false);
  handlers['peer:wtermInput']({}, 'bob@peer-NOPE', 'rm -rf /\r');

  assert.deepStrictEqual(calls, [], 'nothing reached any peer connection at all');
});

// createEngine's background timers keep the loop alive; exit once results flush.
after(() => { setImmediate(() => process.exit(0)); });
