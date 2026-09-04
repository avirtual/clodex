'use strict';
// plugin-text-feed.test.js — `host.sessions.onAgentText` (t192).
//
// The feed EXPORTS text that already exists at two junctions; it collects
// nothing new. So the properties worth pinning are not "does the text arrive"
// but the four things that make the export honest:
//
//   1. the GATE — the per-session `turns` capability, and specifically not
//      "holds any capability", or a Bash-reading grant would also yield prose;
//   2. the NULLS — `isTurnEnd`/`reads` are wire-only, and on the jsonl path they
//      are null rather than false/[]. A plugin must be able to tell "no" from
//      "unknowable"; false and [] are claims the jsonl path cannot support;
//   3. DEFERRAL — dispatch happens off the junction's stack, because that stack
//      also dispatches intents;
//   4. NO DOUBLE-DELIVERY where it would be deterministic (a wire-routed session
//      whose intents still come off jsonl has BOTH junctions live).
//
// Most of those are ABSENCE assertions — "this subscriber was not called", "this
// field is not false". Per CLAUDE.md's `## Tests`, an absence is TRUE of a
// fixture that never wired anything, so each one below is paired with a CONTROL
// arm that makes the same fixture deliver.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');

// Grants live on the persistence entry, so the engine needs a persistence
// getter. `entries` is a plain object the test mutates between deliveries —
// a revoke is a WRITE to it, which is what makes the read-at-delivery
// property (rather than read-at-subscribe) testable.
function mkEngine(entries = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-textfeed-'));
  let ui = {};
  // Every persistence read is recorded: the read is a synchronous whole-file
  // sessions.json parse, so WHEN it happens is a property of its own, not just
  // WHAT it returns.
  const reads = [];
  const logged = [];
  const engine = createPluginHostEngine({
    manager: {
      sessions: new Map(),
      list: () => [], listForWorkspace: () => [],
      _broadcast: () => {}, _sendToSession: () => {}, windowForWorkspace: () => null,
      _injectText: () => {},
    },
    getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
    log: {
      info: (scope, msg) => logged.push(`${scope} ${msg}`),
      error: (scope, msg) => logged.push(`${scope} ${msg}`),
    },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
    telemetrySnapshot: () => null,
    getLoader: () => null,
    getPersistence: () => ({ get: (name) => { reads.push(name); return entries[name] || null; } }),
  });
  return { engine, entries, reads, logged, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Dispatch is deferred through setImmediate by design, so every assertion about
// what a subscriber received has to await a macrotask first.
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// A plugin that records every event it is handed.
function recorder(seen) {
  return { activate(h) { h.sessions.onAgentText((ev) => seen.push(ev)); } };
}

const wireEv = (over = {}) => ({
  session: 'seat', text: 'hello', source: 'wire', truncated: false,
  isTurnEnd: true, files: [], reads: [], ...over,
});

// ── The gate ────────────────────────────────────────────────────────────────

test('the feed is gated on the `turns` grant — not on holding ANY capability', async () => {
  const { engine, entries, cleanup } = mkEngine();
  try {
    const seen = [];
    engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'session' });

    // No grants at all: a session that never opted in.
    entries.seat = { name: 'seat' };
    engine.hooks.fireAgentText(wireEv());
    await settle();
    assert.strictEqual(seen.length, 0, 'an ungranted session delivers nothing');

    // The load-bearing case, and the reason this gate is pluginGranted per
    // capability: toolInputs is the SHARPEST grant (Bash commands, Write
    // contents) and turn prose is a different exposure. Holding one must not
    // yield the other, in either direction — that is the whole reason the
    // capabilities are split by risk rather than bundled.
    entries.seat = { name: 'seat', pluginGrants: ['archiver:toolInputs'] };
    engine.hooks.fireAgentText(wireEv());
    await settle();
    assert.strictEqual(seen.length, 0, 'a toolInputs-only grant does NOT yield turn text');

    entries.seat = { name: 'seat', pluginGrants: ['archiver:thinking'] };
    engine.hooks.fireAgentText(wireEv());
    await settle();
    assert.strictEqual(seen.length, 0, 'nor does a thinking-only grant');

    // CONTROL: the same plugin, the same fixture, the same event — with the
    // grant that matches this payload. Without this arm every assertion above
    // would pass on an engine that never wired the hook at all.
    entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };
    engine.hooks.fireAgentText(wireEv());
    await settle();
    assert.strictEqual(seen.length, 1, 'CONTROL: the turns grant delivers');
    assert.strictEqual(seen[0].text, 'hello');
  } finally { cleanup(); }
});

test('grants are read at DELIVERY, so a revoke lands on the next turn', async () => {
  const { engine, entries, cleanup } = mkEngine();
  try {
    const seen = [];
    engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'session' });

    entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };
    engine.hooks.fireAgentText(wireEv({ text: 'one' }));
    await settle();
    assert.deepStrictEqual(seen.map((e) => e.text), ['one'],
      'ENTER: the subscriber is live and receiving — so the silence below is the revoke');

    // The revoke, exactly as session:setPluginGrants writes it.
    entries.seat = { name: 'seat', pluginGrants: [] };
    engine.hooks.fireAgentText(wireEv({ text: 'two' }));
    await settle();
    assert.deepStrictEqual(seen.map((e) => e.text), ['one'],
      'nothing after the revoke — the grant is not captured at subscribe time');

    // CONTROL: re-granting resumes delivery on the same subscriber, proving the
    // silence above was the gate and not a disposed hook.
    entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };
    engine.hooks.fireAgentText(wireEv({ text: 'three' }));
    await settle();
    assert.deepStrictEqual(seen.map((e) => e.text), ['one', 'three'], 'CONTROL: re-granting resumes');
  } finally { cleanup(); }
});

test('grants are per-SESSION and per-PLUGIN — one seat\'s grant is not another\'s', async () => {
  const { engine, entries, cleanup } = mkEngine();
  try {
    const a = [];
    const b = [];
    engine.register('plug-a', recorder(a), { hostApi: HOST_API_VERSION, scope: 'session' });
    engine.register('plug-b', recorder(b), { hostApi: HOST_API_VERSION, scope: 'session' });

    entries.seat1 = { name: 'seat1', pluginGrants: ['plug-a:turns'] };
    entries.seat2 = { name: 'seat2', pluginGrants: ['plug-b:turns'] };

    engine.hooks.fireAgentText(wireEv({ session: 'seat1', text: 'from-1' }));
    engine.hooks.fireAgentText(wireEv({ session: 'seat2', text: 'from-2' }));
    await settle();

    assert.deepStrictEqual(a.map((e) => e.text), ['from-1'], 'plug-a sees only seat1');
    assert.deepStrictEqual(b.map((e) => e.text), ['from-2'], 'plug-b sees only seat2');
  } finally { cleanup(); }
});

test('an unknown session, or no persistence at all, delivers nothing', async () => {
  // Not a hypothetical: the wire fires turn.completed for an agent name, and a
  // session can be gone from persistence by the time a late receipt lands.
  const { engine, entries, cleanup } = mkEngine();
  try {
    const seen = [];
    engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'session' });
    entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };

    engine.hooks.fireAgentText(wireEv({ session: 'ghost' }));
    await settle();
    assert.strictEqual(seen.length, 0, 'an unknown session name has no grants, so it is refused');

    engine.hooks.fireAgentText(wireEv({ session: '' }));
    await settle();
    assert.strictEqual(seen.length, 0, 'and an empty name is dropped rather than looked up');

    engine.hooks.fireAgentText(wireEv());
    await settle();
    assert.strictEqual(seen.length, 1, 'CONTROL: the known, granted seat still delivers');
  } finally { cleanup(); }

  // A host built with no persistence getter must fail CLOSED, not open: this is
  // the Phase-1 shape and any construction failure path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-textfeed-np-'));
  try {
    const seen = [];
    const engine = createPluginHostEngine({
      manager: {
        sessions: new Map(), list: () => [], listForWorkspace: () => [],
        _broadcast: () => {}, _sendToSession: () => {}, windowForWorkspace: () => null,
        _injectText: () => {},
      },
      getUiSettings: () => ({ get: () => ({}), set: () => {} }),
      log: { info: () => {}, error: () => {} },
      userDataPath: dir, fs, path, gitWorktree: {},
      telemetrySnapshot: () => null, getLoader: () => null,
      // getPersistence deliberately absent
    });
    engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'session' });
    engine.hooks.fireAgentText(wireEv());
    await settle();
    assert.strictEqual(seen.length, 0, 'no persistence ⇒ no grants ⇒ refusal, never an open door');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── The payload ─────────────────────────────────────────────────────────────

test('isTurnEnd and reads are NULL on jsonl — never false, never []', async () => {
  const { engine, entries, cleanup } = mkEngine();
  try {
    const seen = [];
    engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'session' });
    entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };

    engine.hooks.fireAgentText({
      session: 'seat', text: 'from the transcript', source: 'jsonl',
      files: [{ tool: 'Write', path: '/repo/a.js' }],
    });
    await settle();
    assert.strictEqual(seen.length, 1, 'ENTER: the jsonl event was delivered');

    const ev = seen[0];
    assert.strictEqual(ev.source, 'jsonl');
    // The distinction this whole field exists for. `false` would say "this was
    // not a turn end", which the jsonl path has no protocol signal to claim —
    // it inferred boundaries from 1s of silence, which is why the wire cutover
    // happened. Asserting `!== false` as well as `=== null` because a strict
    // null check alone would also pass on undefined, and an absent key is a
    // third meaning nobody wants.
    assert.strictEqual(ev.isTurnEnd, null, 'isTurnEnd is null on jsonl');
    assert.notStrictEqual(ev.isTurnEnd, false, 'and specifically NOT false');
    assert.ok('isTurnEnd' in ev, 'present as an explicit null, not absent');

    assert.strictEqual(ev.reads, null, 'reads is null on jsonl — the path cannot see tool-use blocks');
    assert.ok('reads' in ev, 'present as an explicit null');
    // files IS computable on both paths (extractFileTouches), so it stays a real
    // array here — the nulls above are about what the path cannot know, not a
    // blanket "jsonl is poorer".
    assert.deepStrictEqual(ev.files.map((f) => f.path), ['/repo/a.js']);

    // CONTROL: the same subscriber on the wire path gets real values, so the
    // nulls above are the jsonl path's honesty and not a subscriber that
    // receives an empty object whatever happens.
    engine.hooks.fireAgentText(wireEv({ text: 'from the wire', reads: [{ tool: 'Read', path: '/repo/b.js' }] }));
    await settle();
    assert.strictEqual(seen[1].isTurnEnd, true, 'CONTROL: wire carries a real turn-end boolean');
    assert.deepStrictEqual(seen[1].reads.map((r) => r.path), ['/repo/b.js'], 'CONTROL: and real reads');

    // An unrecognised source resolves toward the nulls, not toward the claims.
    // Both callers pass a literal today, so this only decides what a third one
    // would get — and "wire" would have it assert isTurnEnd:false and reads:[]
    // about a path nobody identified.
    engine.hooks.fireAgentText({ session: 'seat', text: 'from somewhere new', source: 'sse-v2' });
    await settle();
    assert.strictEqual(seen.length, 3, 'ENTER: the unknown-source event was delivered');
    assert.strictEqual(seen[2].source, 'jsonl', 'an unknown source resolves to the less-claiming path');
    assert.strictEqual(seen[2].isTurnEnd, null, 'so isTurnEnd is null, not a false it cannot support');
    assert.strictEqual(seen[2].reads, null, 'and reads is null, not an empty-array claim');
  } finally { cleanup(); }
});

test('isTurnEnd is a real false on the wire — a tool-loop hop is a known "no"', async () => {
  // The other half of the null discipline: on the wire, false is a legitimate
  // observation (~4.4 requests per user turn, only one of which ends it), so
  // collapsing wire-false to null would lose the signal the field exists for.
  const { engine, entries, cleanup } = mkEngine();
  try {
    const seen = [];
    engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'session' });
    entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };

    engine.hooks.fireAgentText(wireEv({ isTurnEnd: false, text: 'mid-turn hop' }));
    await settle();
    assert.strictEqual(seen.length, 1, 'ENTER: a mid-turn hop is delivered at all — the feed is not turn-gated');
    assert.strictEqual(seen[0].isTurnEnd, false, 'and reports a real false, not null');
  } finally { cleanup(); }
});

test('the event is frozen, and its arrays are copies — a subscriber cannot reach core state', async () => {
  const { engine, entries, cleanup } = mkEngine();
  try {
    const seen = [];
    engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'session' });
    entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };

    // The live arrays the wire collector hands core — the same objects
    // _noteFileTouches reads these for the touched-files UI.
    const liveFiles = [{ tool: 'Write', path: '/repo/a.js' }];
    engine.hooks.fireAgentText(wireEv({ files: liveFiles }));
    await settle();

    const ev = seen[0];
    assert.ok(Object.isFrozen(ev), 'the event is frozen');
    assert.ok(Object.isFrozen(ev.files), 'and so is its files array');
    assert.ok(Object.isFrozen(ev.files[0]), 'and each entry');
    assert.notStrictEqual(ev.files, liveFiles, 'the array is a copy, not core\'s live one');
    assert.notStrictEqual(ev.files[0], liveFiles[0], 'and so are the entries');

    // A hostile subscriber mutating what it was handed must not reach core.
    try { ev.files[0].path = '/etc/passwd'; } catch { /* frozen throws in strict mode */ }
    try { ev.text = 'rewritten'; } catch { /* likewise */ }
    assert.strictEqual(liveFiles[0].path, '/repo/a.js', 'core\'s array is untouched');
    assert.strictEqual(ev.text, 'hello', 'and the event itself did not change');
  } finally { cleanup(); }
});

test('every subscriber gets the SAME frozen event object', async () => {
  // Sharing one object is only safe because it is frozen; if the freeze is ever
  // dropped, this test is the one that says the sharing became a leak between
  // plugins rather than a mere mutation of a private copy.
  const { engine, entries, cleanup } = mkEngine();
  try {
    const a = [];
    const b = [];
    engine.register('plug-a', recorder(a), { hostApi: HOST_API_VERSION, scope: 'session' });
    engine.register('plug-b', recorder(b), { hostApi: HOST_API_VERSION, scope: 'session' });
    entries.seat = { name: 'seat', pluginGrants: ['plug-a:turns', 'plug-b:turns'] };

    engine.hooks.fireAgentText(wireEv());
    await settle();
    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 1);
    assert.strictEqual(a[0], b[0], 'one event, shared — safe only because it is frozen');
  } finally { cleanup(); }
});

// ── Deferral ────────────────────────────────────────────────────────────────

test('dispatch is DEFERRED — the junction\'s stack unwinds before any subscriber runs', async () => {
  // The wire junction that calls this also dispatches intents. A subscriber
  // running inline would sit in that path: one plugin doing real work on a 4MB
  // turn would delay every intent behind it.
  const { engine, entries, cleanup } = mkEngine();
  try {
    const seen = [];
    engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'session' });
    entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };

    engine.hooks.fireAgentText(wireEv());
    assert.strictEqual(seen.length, 0, 'nothing has run by the time fireAgentText returns');
    await settle();
    assert.strictEqual(seen.length, 1, 'CONTROL: and it does run on a later tick');
  } finally { cleanup(); }
});

test('the grant read is deferred too — no sessions.json parse on the intent stack', async () => {
  // persistence.get is a synchronous whole-file read + JSON.parse, and _load can
  // WRITE the file back when it back-fills workspaceId. Doing that inline would
  // pay the exact cost the deferral exists to avoid, ~782 times a session, on
  // the same stack that dispatches intents.
  const { engine, entries, reads, cleanup } = mkEngine();
  try {
    const seen = [];
    engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'session' });
    entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };

    engine.hooks.fireAgentText(wireEv());
    assert.deepStrictEqual(reads, [], 'persistence was not touched on the caller\'s stack');
    await settle();
    assert.deepStrictEqual(reads, ['seat'], 'CONTROL: it is read once, on the deferred tick');
    assert.strictEqual(seen.length, 1, 'CONTROL: and delivery still happened');
  } finally { cleanup(); }
});

test('a plugin whose manifest is GLOBAL receives nothing, even holding a turns token', async () => {
  // Grants are persisted per session and survive the plugin: sanitizeGrants does
  // not validate scope and grantsForUnlistedPlugins deliberately preserves
  // tokens, so an upgrade that flips a manifest session→global would otherwise
  // keep feeding turn text to a plugin the grants editor no longer lists.
  const { engine, entries, cleanup } = mkEngine();
  try {
    const seen = [];
    engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'global' });
    entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };

    engine.hooks.fireAgentText(wireEv());
    await settle();
    assert.strictEqual(seen.length, 0, 'a global-scoped plugin gets no turn text');
  } finally { cleanup(); }

  // The BUNDLED shape: no `scope` key at all, which scopeOf collapses to global
  // and which all four shipped manifests use. Mutation-equivalent to the arm
  // above today, but it is the case an author actually writes — a declaration
  // they omitted rather than one they made.
  {
    const { engine, entries, cleanup } = mkEngine();
    try {
      const seen = [];
      engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION });
      entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };

      engine.hooks.fireAgentText(wireEv());
      await settle();
      assert.strictEqual(seen.length, 0, 'an ABSENT scope is global too, and gets nothing');
    } finally { cleanup(); }
  }

  // CONTROL: the identical fixture with the manifest scoped to session. Without
  // it the assertion above passes on an engine that delivers to nobody.
  {
    const { engine, entries, cleanup } = mkEngine();
    try {
      const seen = [];
      engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'session' });
      entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };

      engine.hooks.fireAgentText(wireEv());
      await settle();
      assert.strictEqual(seen.length, 1, 'CONTROL: scope is the only difference');
    } finally { cleanup(); }
  }
});

test('a throwing subscriber is contained, and does not stop the next one', async () => {
  const { engine, entries, cleanup } = mkEngine();
  try {
    const seen = [];
    engine.register('bad-plug', {
      activate(h) { h.sessions.onAgentText(() => { throw new Error('subscriber blew up'); }); },
    }, { hostApi: HOST_API_VERSION, scope: 'session' });
    engine.register('good-plug', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'session' });
    entries.seat = { name: 'seat', pluginGrants: ['bad-plug:turns', 'good-plug:turns'] };

    engine.hooks.fireAgentText(wireEv());
    await settle();
    assert.strictEqual(seen.length, 1, 'the good subscriber still ran');
  } finally { cleanup(); }
});

// ── Disposal ────────────────────────────────────────────────────────────────

test('the returned disposer stops delivery, and deactivate() stops it too', async () => {
  const { engine, entries, cleanup } = mkEngine();
  try {
    const seen = [];
    let off = null;
    engine.register('archiver', {
      activate(h) { off = h.sessions.onAgentText((ev) => seen.push(ev)); },
    }, { hostApi: HOST_API_VERSION, scope: 'session' });
    entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };

    engine.hooks.fireAgentText(wireEv({ text: 'one' }));
    await settle();
    assert.strictEqual(seen.length, 1, 'ENTER: delivering before disposal');
    assert.strictEqual(engine._hookCounts().text, 1, 'and the hook is counted');

    off();
    assert.strictEqual(engine._hookCounts().text, 0,
      'the empty Set is dropped, not left behind — fireAgentText\'s fast path is size===0');
    engine.hooks.fireAgentText(wireEv({ text: 'two' }));
    await settle();
    assert.strictEqual(seen.length, 1, 'nothing after the disposer');
  } finally { cleanup(); }

  // deactivate() as a separate arm: a subscriber that escaped the ledger would
  // keep receiving turn text after the operator disabled the plugin.
  {
    const { engine, entries, cleanup } = mkEngine();
    try {
      const seen = [];
      engine.register('archiver', recorder(seen), { hostApi: HOST_API_VERSION, scope: 'session' });
      entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };

      engine.hooks.fireAgentText(wireEv({ text: 'one' }));
      await settle();
      assert.strictEqual(seen.length, 1, 'ENTER: delivering before deactivate');

      engine.deactivate('archiver');
      assert.strictEqual(engine._hookCounts().text, 0, 'deactivate cleared the plugin\'s text hooks');
      engine.hooks.fireAgentText(wireEv({ text: 'two' }));
      await settle();
      assert.strictEqual(seen.length, 1, 'a disabled plugin receives nothing, grant or no grant');
    } finally { cleanup(); }
  }
});

test('a global plugin subscribing is TOLD, not silently ignored', () => {
  // The refusal is right, but silence is the wrong diagnostic: every other
  // refusal in the engine logs or throws, and the shape that lands here is an
  // author who omitted `"scope": "session"` and sees nothing happen.
  const { engine, logged, cleanup } = mkEngine();
  try {
    engine.register('archiver', {
      activate(h) { h.sessions.onAgentText(() => {}); },
    }, { hostApi: HOST_API_VERSION });
    assert.ok(logged.some((l) => /onAgentText/.test(l) && /"scope": "session"/.test(l)),
      'the log names the field to add');
  } finally { cleanup(); }

  // CONTROL: a session-scoped plugin subscribes silently — the line above is
  // the diagnostic firing, not the engine narrating every subscribe.
  {
    const { engine, logged, cleanup } = mkEngine();
    try {
      engine.register('archiver', {
        activate(h) { h.sessions.onAgentText(() => {}); },
      }, { hostApi: HOST_API_VERSION, scope: 'session' });
      assert.ok(!logged.some((l) => /onAgentText/.test(l)), 'CONTROL: nothing logged for the correct case');
    } finally { cleanup(); }
  }
});

test('subscribing AFTER deactivate is refused — a late timer cannot resurrect the fast path', async () => {
  // No text can leak (delivery re-checks the record), so this is cost, not
  // exposure: a re-created Set has no teardown left to drain it, and
  // fireAgentText's size===0 fast path would be defeated for the process's
  // life — a whole-file persistence read per request, forever, for a plugin
  // nobody is running.
  const { engine, entries, reads, cleanup } = mkEngine();
  try {
    let host = null;
    engine.register('archiver', { activate(h) { host = h; } },
      { hostApi: HOST_API_VERSION, scope: 'session' });
    engine.deactivate('archiver');

    const off = host.sessions.onAgentText(() => {});
    assert.strictEqual(typeof off, 'function', 'the caller still gets a disposer — a leak here has no correctness cost');
    assert.strictEqual(engine._hookCounts().text, 0, 'but nothing was registered');

    entries.seat = { name: 'seat', pluginGrants: ['archiver:turns'] };
    engine.hooks.fireAgentText(wireEv());
    await settle();
    assert.deepStrictEqual(reads, [],
      'and the fast path still holds: no persistence read at all, which is the cost this refusal exists for');
  } finally { cleanup(); }
});

test('onAgentText refuses a non-function and still returns a callable disposer', () => {
  const { engine, cleanup } = mkEngine();
  try {
    let off;
    engine.register('archiver', {
      activate(h) { off = h.sessions.onAgentText('not a function'); },
    }, { hostApi: HOST_API_VERSION, scope: 'session' });
    assert.strictEqual(engine._hookCounts().text, 0, 'nothing was subscribed');
    assert.strictEqual(typeof off, 'function', 'but the caller still gets a disposer to hold');
    assert.doesNotThrow(() => off(), 'and calling it is safe');
  } finally { cleanup(); }
});

// ── The junctions (session-manager side) ────────────────────────────────────

const { createSessionManager } = require('../session-manager');

// A real SessionManager over the same dep set session-manager.test.js uses, with
// the plugin-hooks seam wired to a recorder. The junctions call the REAL
// _publishAgentText and the REAL _scanJsonlText; only the hook target is a stub,
// because the engine half is already covered above.
function mkManager(fired, overrides = {}) {
  const SessionManager = createSessionManager({
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    // The real scanner leaves — _scanJsonlText runs _extractIntents for real, and
    // a stub here would test the stub. (An UNWIRED one is worse than either: it
    // throws inside the junction, which is how this list was found.)
    fencedLines: require('../intent-scanner').fencedLines,
    parseIntent: require('../intent-scanner').parseIntent,
    looksLikeIntent: require('../intent-scanner').looksLikeIntent,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    intentEnabledForSeat: require('../intent-registry').intentEnabledForSeat,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs: require('node:fs'),
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    getPluginHooks: () => ({ fireAgentText: (ev) => fired.push(ev) }),
    ...overrides,
  });
  return new SessionManager();
}

test('_publishAgentText drops an event carrying neither text nor file info', () => {
  // 576 of 1359 measured requests carried no text at all (pure tool calls). An
  // event with nothing in it is a wake-up every subscriber pays for.
  const fired = [];
  const m = mkManager(fired);

  m._publishAgentText({ session: 'seat', text: '', source: 'wire', files: [], reads: [] });
  assert.strictEqual(fired.length, 0, 'empty text and empty arrays is nothing to say');

  m._publishAgentText({ session: 'seat', text: '', source: 'wire', files: [{ tool: 'Write', path: '/a' }], reads: [] });
  assert.strictEqual(fired.length, 1, 'CONTROL: a text-less turn that TOUCHED a file is still news');

  m._publishAgentText({ session: 'seat', text: 'hi', source: 'wire', files: [], reads: [] });
  assert.strictEqual(fired.length, 2, 'CONTROL: and text with no files is news too');

  m._publishAgentText({ session: 'seat', text: '', source: 'wire', files: [], reads: [{ tool: 'Read', path: '/b' }] });
  assert.strictEqual(fired.length, 3, 'CONTROL: a read-only turn is news as well');
});

test('_publishAgentText is consume-only — a throwing hook cannot escape into the junction', () => {
  // It is called from the wire\'s turn.completed handler, which also dispatches
  // intents. An escaping throw there costs intents, not just this feed.
  const m = mkManager([], {
    getPluginHooks: () => ({ fireAgentText: () => { throw new Error('hook exploded'); } }),
  });
  assert.doesNotThrow(() => m._publishAgentText({ session: 'seat', text: 'hi', source: 'wire' }));

  // And the Phase-1 shape: no plugin host at all.
  const m2 = mkManager([], { getPluginHooks: () => null });
  assert.doesNotThrow(() => m2._publishAgentText({ session: 'seat', text: 'hi', source: 'wire' }));
});

test('_scanJsonlText publishes for a jsonl-only session, and NOT for a wire-routed one', () => {
  // A wire-routed session running intentSource:'jsonl' (shadow mode) has BOTH
  // junctions live. Publishing from both would double-deliver every turn
  // deterministically — not the at-least-once the recovery replay causes, but a
  // duplicate on every single turn. The wire wins: it is already firing and
  // carries reads plus a real turn-end signal this path cannot know.
  const fired = [];
  const m = mkManager(fired);
  m.sessions.set('plain', { name: 'plain' });
  m.sessions.set('shadowed', { name: 'shadowed', wireRouted: true, intentSource: 'jsonl' });
  // Tee-blind: a Bedrock/Vertex session keeps its wire registration (the CLI
  // just ignores the injected base URL) so wireRouted is TRUE, but its bytes
  // never traverse the tee — turn.completed never fires and recovery never arms,
  // because recovery triggers on a tee FAILURE and this traffic never enters the
  // tee at all. This watcher is its only junction.
  m.sessions.set('blind', { name: 'blind', wireRouted: true, intentSource: 'jsonl', backend: 'bedrock' });

  m._scanJsonlText('some turn text', 'plain', [{ tool: 'Write', path: '/repo/a.js' }]);
  assert.strictEqual(fired.length, 1, 'ENTER: the jsonl-only session published — so the absence below is the guard');
  assert.strictEqual(fired[0].source, 'jsonl');
  assert.strictEqual(fired[0].session, 'plain');
  assert.deepStrictEqual(fired[0].files.map((f) => f.path), ['/repo/a.js'],
    'and the touches were carried alongside the text they accompanied');

  m._scanJsonlText('some turn text', 'shadowed', []);
  assert.strictEqual(fired.length, 1, 'the wire-routed session did NOT publish from the jsonl junction');

  // The asymmetry that makes this arm required rather than symmetric with the
  // one above: double-delivery needs CLODEX_WIRE_INTENTS=0, an explicit env
  // override. Suppressing a tee-blind session is the DEFAULT configuration —
  // the operator grants `turns` and the plugin receives nothing, forever.
  m._scanJsonlText('some turn text', 'blind', [{ tool: 'Edit', path: '/repo/b.js' }]);
  assert.strictEqual(fired.length, 2, 'a tee-blind session publishes: this watcher is its ONLY junction');
  assert.strictEqual(fired[1].session, 'blind');
  assert.deepStrictEqual(fired[1].files.map((f) => f.path), ['/repo/b.js']);
});

test('the wire junction hands the feed truncated + isTurnEnd + reads, ungated on turn end', () => {
  // Source scan rather than a driven wire: the junction lives inside
  // WireProxy construction (`wire.on('turn.completed')` after an await
  // listen()), which a unit test cannot reach without standing up a proxy. What
  // matters is WHICH fields the call passes and WHERE it sits, and both are
  // readable — a change to either reddens this.
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');

  const call = src.match(/this\._publishAgentText\(\{\s*\n\s*session: t\.agent,[\s\S]{0,260}?\}\);/);
  assert.ok(call, 'the wire junction calls _publishAgentText with the turn.completed payload');
  assert.match(call[0], /text: t\.text/, 'passes the wire\'s already-reassembled text — no re-parsing');
  assert.match(call[0], /truncated: t\.truncated/, 'and the cap flag');
  assert.match(call[0], /isTurnEnd: !!\(t\.stop && t\.stop\.is_turn\)/, 'and a real boolean turn-end');
  assert.match(call[0], /files: t\.files, reads: t\.reads/, 'and both tool arrays');

  // Position: AFTER the main-line early return (so subagent + side-call traffic
  // never reaches a subscriber) and BEFORE the intent extraction it must not be
  // gated behind. `turn.completed` fires per REQUEST — ~4.4 per user turn — so
  // gating on stop.is_turn would silently drop every tool-loop hop's text.
  const mainLineGuard = src.indexOf("if (t.sideCall || isSubagentRole(t.role)) return;");
  const publishAt = src.indexOf('this._publishAgentText({', mainLineGuard);
  const extractAt = src.indexOf('const intents = this._extractIntents(t.text);', mainLineGuard);
  assert.ok(mainLineGuard > 0 && publishAt > mainLineGuard,
    'the publish sits INSIDE the main-line filter');
  assert.ok(extractAt > publishAt,
    'ENTER: and before the intent extraction, which is the ungated neighbour it matches');
  assert.strictEqual(
    /if\s*\([^)]*is_turn[^)]*\)\s*(\{\s*)?this\._publishAgentText/.test(src), false,
    'and it is NOT gated on stop.is_turn',
  );
});

test('the tee-failure recovery replay publishes too — this is what makes the feed at-least-once', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const arm = src.match(/armRecovery\(\(text, touches\) => \{[\s\S]{0,900}?const fired = new Set\(\);/);
  assert.ok(arm, 'ENTER: the recovery arm takes the watcher\'s (text, touches) callback');
  assert.match(arm[0], /this\._publishAgentText\(\{/,
    'and publishes before the intent replay — not publishing here would lose text exactly '
    + 'when the wire produced no receipt');
  assert.match(arm[0], /source: 'jsonl'/, 'labelled jsonl, because that is the path it read');
});

test('JsonlWatcher hands its flushed text the touches that accompanied it', () => {
  // The correlation the feed needs: touches fire per-LINE (the touched-files UI wants
  // them immediately) while text flushes on a requestId change or 1s of silence.
  const { createJsonlWatcher } = require('../jsonl-watcher');
  const { JsonlWatcher } = createJsonlWatcher({ REGISTRY_DIR: '/nonexistent' });

  const flushes = [];
  const immediate = [];
  const w = new JsonlWatcher('seat', (text, touches) => flushes.push({ text, touches }),
    () => {}, () => {}, () => {}, (t) => immediate.push(...t));

  // Drive the SHIPPED _readLines off a real fd rather than re-running its body
  // here: a test that reconstructs the loop asserts its own reconstruction, and
  // the accumulation being tested is one line inside that loop. Only the 250ms
  // polling/symlink half needs a live watcher, and this skips just that.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-jsonlw-'));
  const f = path.join(dir, 'transcript.jsonl');
  try {
    fs.writeFileSync(f, [
      JSON.stringify({ type: 'assistant', requestId: 'r1', message: { content: [{ type: 'text', text: 'turn one' }] } }),
      JSON.stringify({ type: 'assistant', requestId: 'r1', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/repo/a.js' } }] } }),
    ].join('\n') + '\n');

    w._fd = fs.openSync(f, 'r');
    w._position = 0;
    w._readLines();

    assert.deepStrictEqual(immediate.map((t) => t.path), ['/repo/a.js'],
      'ENTER: the per-line touch callback still fires immediately — unchanged');
    assert.strictEqual(flushes.length, 0,
      'ENTER: and nothing has flushed yet — both lines share a requestId');

    w._flushPending();
    assert.strictEqual(flushes.length, 1, 'ENTER: the text flushed');
    assert.deepStrictEqual(flushes[0].touches.map((t) => t.path), ['/repo/a.js'],
      'and carried the touch that accompanied it');

    // Cleared unconditionally: a touch held past its own turn would attach to a
    // LATER turn's text, which is a worse claim than not reporting it. Driven
    // through _readLines again so the clear is measured against real appends.
    fs.appendFileSync(f, JSON.stringify({
      type: 'assistant', requestId: 'r2', message: { content: [{ type: 'text', text: 'turn two' }] },
    }) + '\n');
    w._readLines();
    w._flushPending();
    assert.strictEqual(flushes.length, 2, 'ENTER: the second turn flushed');
    assert.strictEqual(flushes[1].text, 'turn two');
    assert.deepStrictEqual(flushes[1].touches, [],
      'and starts empty — the first turn\'s touch did not follow it');

    fs.closeSync(w._fd);
    w._fd = null;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a symlink repoint drops the old transcript\'s pending touches', () => {
  // /clear mints a NEW transcript and repoints the symlink. Touches left over
  // from the tail of the old one would attach to the first text of the new
  // conversation — a file claim about the wrong turn, in the wrong session
  // history. The same reset bounds the no-text-ever case, where _flushPending
  // is never reached and touches would accumulate for the watcher's life.
  const { createJsonlWatcher } = require('../jsonl-watcher');
  const { pathFor, runDirFor } = require('../clodex-paths');

  const reg = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-repoint-'));
  try {
    const { JsonlWatcher } = createJsonlWatcher({ REGISTRY_DIR: reg });
    fs.mkdirSync(runDirFor(reg, 'seat'), { recursive: true });
    const link = pathFor(reg, 'seat', 'transcript');
    const a = path.join(reg, 'a.jsonl');
    const b = path.join(reg, 'b.jsonl');
    const touchLine = JSON.stringify({
      type: 'assistant', requestId: 'r1',
      message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/repo/old.js' } }] },
    }) + '\n';
    fs.writeFileSync(a, touchLine);
    fs.writeFileSync(b, '');
    fs.symlinkSync(a, link);

    const flushes = [];
    const w = new JsonlWatcher('seat', (text, touches) => flushes.push({ text, touches }));

    w._poll();
    clearTimeout(w._timer);        // one pass only; the 250ms loop is not under test
    // _poll opens at EOF (historical turns must not replay as intents), so read
    // the file's own content deliberately to load a pending touch.
    w._position = 0;
    w._readLines();
    assert.deepStrictEqual(w._pendingTouches.map((t) => t.path), ['/repo/old.js'],
      'ENTER: a touch is pending from the old transcript — so the absence below is the reset');

    fs.unlinkSync(link);
    fs.symlinkSync(b, link);
    w._poll();
    clearTimeout(w._timer);
    assert.deepStrictEqual(w._pendingTouches, [],
      'the repoint dropped them, alongside _readBuf and _position');

    if (w._fd !== null) fs.closeSync(w._fd);
    w._fd = null;
  } finally { fs.rmSync(reg, { recursive: true, force: true }); }
});

test('a repoint flushes pending TEXT too — the mirror image of the same lie', () => {
  // Clearing only the touches leaves the other half of the correlation open:
  // old text survives the repoint, the new conversation's first tool_use pushes
  // into the now-empty _pendingTouches, and the next rid change flushes the OLD
  // text carrying the NEW conversation's file claim. A pairing has two halves.
  // The window is narrow — _readLines only 1s-flushes on a zero-byte read, so
  // a /clear within ~1.25s of the last text leaves text pending — but the event
  // it produces is a lie about which conversation touched a file.
  const { createJsonlWatcher } = require('../jsonl-watcher');
  const { pathFor, runDirFor } = require('../clodex-paths');

  const reg = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-repoint2-'));
  try {
    const { JsonlWatcher } = createJsonlWatcher({ REGISTRY_DIR: reg });
    fs.mkdirSync(runDirFor(reg, 'seat'), { recursive: true });
    const link = pathFor(reg, 'seat', 'transcript');
    const a = path.join(reg, 'a.jsonl');
    const b = path.join(reg, 'b.jsonl');
    fs.writeFileSync(a, '');
    fs.writeFileSync(b, JSON.stringify({
      type: 'assistant', requestId: 'r9',
      message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/repo/new-convo.js' } }] },
    }) + '\n');
    fs.symlinkSync(a, link);

    const flushes = [];
    const w = new JsonlWatcher('seat', (text, touches) => flushes.push({ text, touches }));

    w._poll();
    clearTimeout(w._timer);
    w._pendingText = 'the old conversation\'s last words';
    w._pendingRid = 'r1';
    // FRESH, and load-bearing. _pendingTime defaults to 0, which makes the text
    // instantly stale — _readLines' zero-byte-read branch then flushes it on the
    // 1s-silence timeout, and this test passed with the repoint flush REMOVED.
    // Measured, not theorised. Stamping it now leaves the repoint as the only
    // thing that can flush, which is the mechanism under test.
    w._pendingTime = Date.now();

    fs.unlinkSync(link);
    fs.symlinkSync(b, link);
    w._poll();
    clearTimeout(w._timer);

    assert.strictEqual(flushes.length, 1, 'ENTER: the repoint emitted the old text rather than holding it');
    assert.strictEqual(flushes[0].text, 'the old conversation\'s last words');
    assert.deepStrictEqual(flushes[0].touches, [], 'with its OWN touches — none — not the next file\'s');
    assert.strictEqual(w._pendingText, null, 'and nothing survives the boundary to collect a foreign touch');

    // The new transcript's touch now lands in a cleared buffer, so it can only
    // ever attach to text from its own conversation.
    w._position = 0;
    w._readLines();
    assert.deepStrictEqual(w._pendingTouches.map((t) => t.path), ['/repo/new-convo.js'],
      'CONTROL: the new conversation\'s touch is pending, and has no old text to attach to');
    assert.strictEqual(flushes.length, 1, 'and it did not resurrect the old text');

    if (w._fd !== null) fs.closeSync(w._fd);
    w._fd = null;
  } finally { fs.rmSync(reg, { recursive: true, force: true }); }
});
