'use strict';
// Run: node --test
// t156 — a ticket's spec was delivered when it was ASSIGNED and never again, so a
// seat that died between assignment and completion came back holding a bare id
// with no body. From inside the seat that is indistinguishable from a ticket it
// has correctly been told to hold, so no design that waits for the seat to notice
// can fire: the asymmetry has to be resolvable from the RECORD.
//
// These drive REAL create()s, and the respawn is modelled as a SECOND
// SessionManager over the same on-disk tickets.json — which is what a GUI restart
// actually is. That matters more than harness convenience: the fix turns on a key
// that lives only in memory, so a respawn modelled inside one manager instance
// could pass while the real one fails. Delivery is observed at the seat's PTY
// bytes, not at a _deliverTicketSpec spy: the property is that the seat ends up
// holding the body, and a spy pins the call while proving nothing about the
// record or the gates between.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { createTicketsStore } = require('../tickets-store');

const CWD = os.tmpdir();

// One durable world (team dir + persistence) that several managers open in turn.
// The persistence store is shared because sessions.json survives a GUI restart —
// making it per-manager would hand the fix a discriminator the real system does
// not have.
function mkWorld() {
  // The clodex HOME is part of the durable world, not of a boot: the board lives
  // under it (projects/<leaf>-<hash8>/tickets.json), so minting a fresh one per
  // manager would hand every "second process" test an empty board and the replay
  // it exists to prove would look correct while testing nothing.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-tr-home-'));
  const tstore = createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: '/proj', lead: 'lead', watchdogMs: null,
    file: path.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
    },
  };
  const store = new Map();
  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {}, setStripLevel: () => {}, setLabel: () => {},
    setArchived: () => {}, setRosterSent: () => {},
  };
  return { home, tstore, team, persistence, tickets: () => tstore.load(team.root) };
}

// A manager = one app process. `boot()` returns a fresh one over the same world.
function boot(world, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-tr-run-'));
  const writes = new Map();          // seat name → concatenated PTY bytes
  const dataCb = new Map();          // seat name → the manager's onData handler
  // Seat name → the ms after which this terminal keeps what is written to it.
  // Before it, a write is DISCARDED rather than accumulated: that is what the CLI's
  // boot re-render does to text spliced into a composer that is not yet up, and
  // without modelling it the harness cannot tell a delivery that survived from one
  // that was wiped — both look like a call to pty.write().
  const keepFrom = new Map();
  let pending = null;                // the name create() is currently spawning
  const SessionManager = createSessionManager({
    // The WORLD's home, not this boot's `root`: the board resolves under
    // REGISTRY_DIR, and a per-boot one would give each "second process" a board
    // with no tickets on it — every replay assertion below would then be checking
    // that nothing is delivered from nothing.
    REGISTRY_DIR: world.home,
    fs, path, pathFor, runDirFor,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => world.persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => root,
    resolveProxyBase: () => null,
    resolveProxyAgentId: () => null,
    normalizeProxyBase: (v) => v,
    randBase36: (n) => 'x'.repeat(n),
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: {
      spawn: () => {
        const who = pending;
        return {
          onData(cb) { dataCb.set(who, cb); }, onExit() {}, pid: 999, kill() {},
          write(b) {
            const gate = keepFrom.get(who);
            if (gate != null && Date.now() < gate) return;   // wiped by the boot re-render
            writes.set(who, (writes.get(who) || '') + b);
          },
        };
      },
    },
    os,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    // The team is what gates the replay, so these two are the only resolution
    // seams that must be real-ish; everything under them is stubbed.
    resolveTeam: () => world.team,
    findProjectRoot: () => world.team.root,
    setupClaudeHook: () => path.join(root, 'settings.json'),
    // The real one creates run/<name>/ as a side effect, and create()'s codex arm
    // writes instructions.md into it without an ensureDir of its own.
    setupCodexHook: (name) => fs.mkdirSync(runDirFor(root, name), { recursive: true }),
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkillPlugin: () => {}, cleanupAgentPlugin: () => {},
    writeClaudeDigestFile: () => false,
    buildIpcPrompt: () => '', bakePrompt: () => '',
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv: () => ({ ...process.env }),
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: () => null,
    mergeClaudeSystemPrompt: (a) => ({ cleaned: [...a], append: null }),
    readAppendBodies: () => [], pluginGrammarLines: () => [],
    getAgentLibrary: () => ({ list: () => [] }),
    getPromptLibrary: () => ({ raw: () => null }),
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [], effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [], writeSkillPlugin: () => null,
    unionEnabled: require('../scope-util').unionEnabled,
    intentEnabled: require('../intent-catalog').intentEnabled,
    parkDelivery: require('../pending-store').parkDelivery,
    // REAL, like parkDelivery beside it: the hold-park mints its id through this,
    // so a stub returning a constant would collide every park after the first.
    parkIdInUse: require('../pending-store').parkIdInUse,
    drainPending: () => [], countPending: () => 0, peekPending: () => [],
    hasActivePending: () => false,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    // REAL, not a pass-through stub: `held` and `parked` are outcomes the replay
    // must treat differently from `delivered`, so a gate stubbed open would hide
    // the one interaction between this fix and the delivery path.
    shouldHoldDm: require('../proxy-util').shouldHoldDm,
    peerStatusLabel: require('../proxy-util').peerStatusLabel,
    InjectQueue: require('../inject-queue').InjectQueue,
    whichBin: () => null,
    codexStatusLineArg: () => [],
    mergeCodexInstructions: (a) => ({ cleaned: [...a], merged: '' }),
    spillToFile: () => null,
    isAlive: () => false,
    scheduleTrayRefresh: () => {}, refreshAppMenu: () => {}, refreshTrayMenu: () => {},
    // Every wait to 0: the boot-readiness gate gets its latch from a real
    // mode-2004 byte, which a fake PTY never sends, so the production caps would
    // leave the delivery queued forever — the file would go green and then hang.
    INJECT_BOOT_MAXWAIT: 0, INJECT_QUIET_MAXWAIT: 0, INJECT_QUIET_MS: 0,
    SHORT_TEXT_DELAY: 0, LONG_TEXT_DELAY: 0, LONG_TEXT_THRESHOLD: 1e9,
    INJECT_HOLD_TIMEOUT: 60_000,
    ...opts.deps,
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  const spawn = async (name, type = 'claude') => {
    pending = name;
    await m.create(name, type, CWD, [], null, 'ws');
    const s = m.sessions.get(name);
    assert.ok(s, `ENTER: create() must have put ${name} in the map`);
    return s;
  };
  // Feed bytes back up the PTY the way a real CLI does — the only way to reach the
  // boot-ready latch and the codex boot-settle timer, both of which are driven by
  // terminal OUTPUT and not by anything create() returns.
  const emit = (name, data) => { const cb = dataCb.get(name); if (cb) cb(data); };
  // A real create() leaves an fs.watch handle and timers behind; without this the
  // file reports green and then HANGS.
  const stop = () => {
    for (const s of m.sessions.values()) {
      try { if (s.sentinel) s.sentinel.stop(); } catch {}
      try { if (s.watcher) s.watcher.stop(); } catch {}
      try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
      clearTimeout(s._bootDrainTimer);
      clearTimeout(s._injectHoldTimer);
      clearTimeout(s._bootSettleTimer);
      clearTimeout(s._parkCapTimer);
      clearTimeout(s._replayFallbackTimer);
      clearTimeout(s._specConfirmTimer);
    }
  };
  return {
    m, spawn, stop, emit,
    seen: (name) => writes.get(name) || '',
    wipeUntil: (name, ms) => keepFrom.set(name, Date.now() + ms),
    // What the CLI actually CONSUMED, which is a different record from `seen`
    // (what this process wrote at the PTY) — and the difference between the two is
    // the whole subject of t409. Written under the world's REGISTRY_DIR because
    // that is where the manager's probe looks; a plain file rather than the
    // production symlink, since realpathSync resolves both.
    transcript: (name, text) => {
      const p = pathFor(world.home, name, 'transcript');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, text);
    },
    // How many parked entries MATCH — not how many exist. "Nothing reached the PTY"
    // is equally true of a park that THREW (_parkHeldDelivery catches, returns null,
    // and the log is a stub here), so a park must be proven positively. Matched
    // rather than counted because a dialog-blocked seat parks EVERYTHING sent to it,
    // including the roster broadcast, whose arrival is timing-dependent — a bare
    // count asserts the absence of unrelated traffic, which is not the property and
    // fails only on a loaded machine.
    // Matches the WHOLE parked text, not peekPending's snippet: that returns only
    // the first body line, so any change to what leads a dispatch (the close-verb
    // pointer line did exactly this) moves the spec out of the matched region and
    // turns a passing park assertion red for a reason that has nothing to do with
    // parking. Reads the store directly for the same reason app.seen does.
    parked: (name, re) => {
      const dir = path.join(root, 'pending', name);
      let files;
      try { files = fs.readdirSync(dir); } catch { return 0; }
      return files.filter((f) => f.endsWith('.json') && !f.startsWith('.')).filter((f) => {
        try {
          const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return obj && typeof obj.text === 'string' && re.test(obj.text);
        } catch { return false; }
      }).length;
    },
  };
}

// The inject queue is a promise chain with a settle sleep, so the bytes land a
// few ticks after create() returns. Polls rather than sleeping a fixed span: a
// fixed sleep tuned on a fast machine is how a green suite starts flaking.
async function settled(app, name, want = /ticket/, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (want.test(app.seen(name))) return app.seen(name);
    await new Promise((r) => setTimeout(r, 5));
  }
  return app.seen(name);
}

// The one-shot is spent exactly when the replay pass has run, so it is the
// deterministic anchor for asserting ABSENCE. A bare sleep asserts nothing was
// delivered at a moment that may simply be BEFORE the pass, which passes on a loaded
// box for the wrong reason and would keep passing against a fix that deletes the
// filter entirely.
async function replayPassed(app, name, tries = 400) {
  const s = app.m.sessions.get(name);
  for (let i = 0; i < tries; i++) {
    if (s && s._replayTicketsPending === false) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`ENTER: the replay pass never ran for ${name}, so every absence assertion below is vacuous`);
}

// The stamp rides the WRITE, not the enqueue, so it lands a few ticks after the
// bytes appear at the PTY — `settled` returning is not evidence the record has
// caught up. Every test that reads `deliveredTo`, and every fixture that hands a
// world to a second process, needs the record settled first; without this they
// race the queue and read a null that the next tick fills in.
async function stamped(world, id = 't1', tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (world.tickets().find((t) => t.id === id)?.deliveredTo) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`ENTER: ${id} was never stamped delivered, so a later assertion about the stamp reads a record this fixture never built`);
}

// Wait for the ordering a test means to create rather than sleeping into it.
async function fallbackArmed(s, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (s._replayFallbackTimer != null && !s._bootReadySeen) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.fail('ENTER: the cap never armed, so the emit below is not the interleaving under test');
}

// The queue polls its ready gate every 250ms by default, which would push a pre-fix
// write past the wipe window for timing reasons alone and let broken code pass. A
// fast poll reproduces the production ordering, where the boot-drain defer is the
// ONLY margin.
class FastQueue extends require('../inject-queue').InjectQueue {
  constructor(o) { super({ ...o, readyPollMs: 10 }); }
}

// Assign t1 to `who` from a live lead, and confirm the seat got it in THIS
// process — every replay assertion below is about a second process, so an
// assignment that never landed would make them pass for the wrong reason.
async function assigned(world, who = 'hand') {
  const app = boot(world);
  const lead = await app.spawn('lead');
  await app.spawn('team-hand');
  app.m._handleTask(lead, { type: 'task', sub: 'add', who, id: null, body: 'BUILD THE WIDGET\ntasks/widget/SPEC.md\nstep one' });
  // t308 moved dispatch out of `add`: writing the ticket and running it are two
  // steps now. The property under test is unchanged — a seat that received its
  // spec in THIS process, so a replay in the next one is distinguishable from a
  // first delivery arriving late.
  app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const t = world.tickets().find((x) => x.id === 't1');
  assert.ok(t, 'ENTER: the assign must have minted a ticket');
  assert.strictEqual(t.state, 'open', 'ENTER: minted open');
  const got = await settled(app, 'team-hand');
  assert.match(got, /BUILD THE WIDGET/,
    'ENTER: the seat must receive the spec on the ORIGINAL assignment — if this delivery never happened, a '
    + 'replay in the next process would be indistinguishable from the assign path simply running late');
  // Before the teardown: the stamp lands at write time, so stopping here without
  // waiting leaves the on-disk record in whichever half-written state the queue
  // happened to reach — and every second-process test below reads that record.
  await stamped(world);
  app.stop();
  return app;
}

test('a respawned seat is handed the spec of a ticket still open against it', async () => {
  const world = mkWorld();
  await assigned(world);

  // Second process, same tickets.json. Nothing but the record survives.
  const app2 = boot(world);
  try {
    const s = await app2.spawn('team-hand');
    const got = await settled(app2, 'team-hand');
    assert.match(got, /BUILD THE WIDGET/,
      'the spec must be redelivered to the respawned seat — this is the whole defect: the ticket stayed open '
      + 'and assigned, and the seat came back holding an id with no body it could act on');
    assert.match(got, /REPLAY/,
      'and it must be MARKED as a replay — a seat that cannot tell a redelivery from a fresh assignment will '
      + 'redo work it already finished, which is the same silent failure pointed the other way');
    // t353: a replayed seat is the one MOST likely to close in prose — it is a
    // fresh process that never read the original dispatch, and the role prompt is
    // a seeded file that may be stale. Asserted at the PTY bytes like everything
    // else here: the verb has to survive the same gates the spec does.
    assert.match(got, /CLOSE WITH: \[agent:task done t1\]/,
      'the close verb must ride the REPLAY too — the respawned seat has no memory of the first dispatch');

    const t = world.tickets().find((x) => x.id === 't1');
    assert.ok(t.deliveredTo, 'the delivery must be stamped on the record');
    assert.strictEqual(t.deliveredTo.seat, 'team-hand');
    assert.strictEqual(t.deliveredTo.incarnation, s.incarnation,
      'stamped with the LIVE incarnation key, which is what makes the next respawn (a different key) replay '
      + 'again while this process does not');
  } finally { app2.stop(); }
});

// The mutation this test exists for: compare `deliveredTo.seat` only and drop the
// incarnation. That looks correct — the ticket WAS delivered to this seat — and it
// reproduces the original bug exactly, because the stamp survives the respawn that
// lost the delivery. The first respawn cannot catch it (nothing is stamped yet);
// only a SECOND one can.
test('a second respawn replays again — the stamp identifies an incarnation, not a seat', async () => {
  const world = mkWorld();
  await assigned(world);

  const app2 = boot(world);
  let firstKey = null;
  try {
    firstKey = (await app2.spawn('team-hand')).incarnation;
    await settled(app2, 'team-hand');
    assert.ok(world.tickets().find((x) => x.id === 't1').deliveredTo,
      'ENTER: the first respawn must have stamped, or the second one below is just repeating that test');
  } finally { app2.stop(); }

  const app3 = boot(world);
  try {
    const s = await app3.spawn('team-hand');
    assert.notStrictEqual(s.incarnation, firstKey,
      'ENTER: a fresh process must mint a FRESH key — an incarnation key that repeats across processes cannot '
      + 'discriminate at all, and every assertion in this file would pass on a broken fix');
    const got = await settled(app3, 'team-hand');
    assert.match(got, /BUILD THE WIDGET/,
      'the third process must ALSO be handed the spec: a stamp naming only the seat survives every respawn, so '
      + 'matching on it would suppress replay forever after the first one — the original bug, wearing a field '
      + 'that makes it look fixed');
    assert.strictEqual(world.tickets().find((x) => x.id === 't1').deliveredTo.incarnation, s.incarnation,
      'and the stamp must move to the new incarnation');
  } finally { app3.stop(); }
});

test('exactly one delivery per incarnation — a re-entered replay in the SAME process delivers nothing', async () => {
  const world = mkWorld();
  await assigned(world);

  const app2 = boot(world);
  try {
    const s = await app2.spawn('team-hand');
    const once = await settled(app2, 'team-hand');
    assert.strictEqual(once.match(/REPLAY/g).length, 1, 'ENTER: exactly one replay so far');

    app2.m._replayOpenTickets(s);
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(app2.seen('team-hand').match(/REPLAY/g).length, 1,
      'a second replay pass in the same process must deliver NOTHING — the stamp is what bounds it, and '
      + 'without that bound any re-entry (a settle, a reconcile, a future caller) hands the seat the same spec '
      + 'again and burns a turn per pass');
  } finally { app2.stop(); }
});

test('a closed ticket is never replayed', async () => {
  const world = mkWorld();
  await assigned(world);
  const tickets = world.tickets();
  tickets.find((t) => t.id === 't1').state = 'done';
  world.tstore.save(world.team.root, tickets);

  const app2 = boot(world);
  try {
    await app2.spawn('team-hand');
    await replayPassed(app2, 'team-hand');
    assert.doesNotMatch(app2.seen('team-hand'), /BUILD THE WIDGET/,
      'a done ticket must not be replayed — the record already says the work is finished, and re-handing it is '
      + 'the double-execution this fix is supposed to avoid');
  } finally { app2.stop(); }
});

test('a cancelled ticket is never replayed', async () => {
  const world = mkWorld();
  await assigned(world);
  const tickets = world.tickets();
  tickets.find((t) => t.id === 't1').state = 'cancelled';
  world.tstore.save(world.team.root, tickets);

  const app2 = boot(world);
  try {
    await app2.spawn('team-hand');
    await replayPassed(app2, 'team-hand');
    assert.doesNotMatch(app2.seen('team-hand'), /BUILD THE WIDGET/,
      'a cancelled ticket must not be replayed — cancel is a decision the lead already made, and reviving it '
      + 'through a respawn would let a restart overrule it');
  } finally { app2.stop(); }
});

// The durable assignee for a role-addressed ticket is the ROLE, so a replay that
// matched seat names only would silently skip every ticket dispatched the normal
// way (`[agent:task add hand]` stores 'hand', not 'team-hand').
test('a ticket assigned to a ROLE replays to the seat filling that role', async () => {
  const world = mkWorld();
  await assigned(world, 'hand');
  // Dispatched to a live seat, so the record carries the delivery-time pin and
  // the role it was filed under. The replay resolves through both.
  assert.strictEqual(world.tickets().find((t) => t.id === 't1').role, 'hand',
    'ENTER: the role it was filed under is what was persisted');

  const app2 = boot(world);
  try {
    await app2.spawn('team-hand');
    const got = await settled(app2, 'team-hand');
    assert.match(got, /BUILD THE WIDGET/,
      'the seat matching the role must be replayed to — role is the durable assignee for every ticket the '
      + 'lead dispatches by role, so a name-only resolver would leave the common case broken');
  } finally { app2.stop(); }
});

test('a backlog ticket (no assignee) is replayed to nobody', async () => {
  const world = mkWorld();
  const app1 = boot(world);
  const lead = await app1.spawn('lead');
  await app1.spawn('team-hand');
  app1.m._handleTask(lead, { type: 'task', sub: 'add', who: null, id: null, body: 'BUILD THE WIDGET\ntasks/widget/SPEC.md\nunowned' });
  assert.strictEqual(world.tickets().find((t) => t.id === 't1').assignee, null,
    'ENTER: backlog means assignee null');
  app1.stop();

  const app2 = boot(world);
  try {
    await app2.spawn('team-hand');
    await replayPassed(app2, 'team-hand');
    assert.doesNotMatch(app2.seen('team-hand'), /BUILD THE WIDGET/,
      'an unassigned ticket must not be handed to whoever happens to respawn — backlog is work the lead has '
      + 'deliberately not dispatched, and a replay that claimed it for the first seat back would assign work '
      + 'nobody decided to assign');
  } finally { app2.stop(); }
});

// The incarnation key is only a signal because it CANNOT survive. If a later
// change persists it (the obvious "tidy" — every other create-time field is on the
// record), the respawned process reads its predecessor's key back, the comparison
// matches, and replay stops firing. Nothing above would fail: the tests spawn
// fresh managers whose in-memory key is fresh either way.
test('the incarnation key is never written to the persistence record', async () => {
  const world = mkWorld();
  const app = boot(world);
  try {
    const s = await app.spawn('team-hand');
    assert.ok(s.incarnation, 'ENTER: create() must mint one, or there is nothing to check');
    const rec = world.persistence.get('team-hand');
    assert.ok(rec, 'ENTER: create() persisted a record');
    assert.strictEqual(JSON.stringify(rec).includes(s.incarnation), false,
      'the incarnation key must appear NOWHERE on the persisted record: its whole value is that it cannot '
      + 'survive a respawn, so persisting it under any field name turns the replay condition into one that is '
      + 'always false — the original bug, restored, behind a field that reads as the fix');
  } finally { app.stop(); }
});

// The claude seat's inject queue gates on the mode-2004 latch, but that latch is
// set when the CLI ANNOUNCES bracketed paste — which precedes the readline loop
// actually accepting input, so the queue releases into a composer the boot
// re-render then wipes. BOOT_DRAIN_SETTLE_MS exists because that gate is not enough
// on its own, and a spec written inside the window is stamped `delivered`: the loss
// is invisible until the next respawn, which is the very failure this ticket closes.
test('the replay survives the boot re-render — it rides the boot-drain defer, not the queue gate', async () => {
  const world = mkWorld();
  await assigned(world);

  const app2 = boot(world, {
    deps: {
      bootDrainSettleMs: 300,
      // Large enough that the never-announced fallback cannot fire during this test:
      // here the seat DOES announce, and the defer is what must carry the delivery.
      INJECT_BOOT_MAXWAIT: 60_000,
      InjectQueue: FastQueue,
    },
  });
  try {
    await app2.spawn('team-hand');
    // Latch and re-render window open together: this byte IS the announcement, and
    // the composer is not ready for the span that follows it.
    app2.wipeUntil('team-hand', 120);
    app2.emit('team-hand', '\x1b[?2004h');

    const got = await settled(app2, 'team-hand');
    assert.match(got, /BUILD THE WIDGET/,
      'the spec must still be at the seat AFTER the boot re-render window — a replay released by the queue\'s '
      + 'ready gate alone lands in a composer that is not up yet, gets wiped, and is stamped delivered anyway, '
      + 'so the seat is left holding a bare id and the record says it was told');
    assert.match(got, /REPLAY/, 'and still marked, since it is the same delivery');
    assert.strictEqual(world.tickets().find((x) => x.id === 't1').deliveredTo.seat, 'team-hand',
      'ENTER: stamped — a fix that simply never delivered would pass the assertion above only if it also '
      + 'never stamped');
  } finally { app2.stop(); }
});

// The drain that carries the replay is armed BY the mode-2004 edge, so a seat that
// never announces never arms it. Without a fallback the spec is not late, it is
// gone for the life of the process.
test('a seat that never announces bracketed paste still gets its spec, via the cap', async () => {
  const world = mkWorld();
  await assigned(world);

  const app2 = boot(world, { deps: { bootDrainSettleMs: 60_000, INJECT_BOOT_MAXWAIT: 20 } });
  try {
    await app2.spawn('team-hand');   // no emit(): this terminal never announces
    const got = await settled(app2, 'team-hand');
    assert.match(got, /BUILD THE WIDGET/,
      'the cap must deliver when the boot-ready edge never fires — the defer is a margin, not a precondition, '
      + 'and a seat that never announces would otherwise wait forever for an edge that is not coming');
  } finally { app2.stop(); }
});

// A slow seat can announce just BEFORE the cap expires, leaving the fallback timer
// and the boot-drain timer both live — and the fallback firing first would deliver
// inside the very window the drain exists to sit out, then consume the one-shot so
// the drain has nothing left to deliver. Whichever of the two fires must be the one
// that is safe, so the fallback yields when the drain is armed.
test('a seat announcing just before the cap is served by the drain, not the cap', async () => {
  const world = mkWorld();
  await assigned(world);

  const app2 = boot(world, {
    deps: { bootDrainSettleMs: 300, INJECT_BOOT_MAXWAIT: 80, InjectQueue: FastQueue },
  });
  try {
    const s = await app2.spawn('team-hand');
    await fallbackArmed(s);                        // cap still pending, latch not yet set
    app2.wipeUntil('team-hand', 200);
    app2.emit('team-hand', '\x1b[?2004h');         // announce: arms the drain, cap fires ~30ms later

    const got = await settled(app2, 'team-hand');
    assert.match(got, /BUILD THE WIDGET/,
      'the spec must survive: the cap must stand down once the boot-drain is armed, or it delivers into the '
      + 're-render window AND consumes the one-shot, leaving the drain nothing to deliver — the seat ends up '
      + 'with neither');
  } finally { app2.stop(); }
});

// The mirror of the test above, and the harder half. `enqueue` returns
// `{delivered: true}` SYNCHRONOUSLY, but the bytes wait in the queue's ready loop and
// are written within one poll of whenever the latch arrives — stamp time and write
// time are different times. So a cap that fires with no latch yet and delivers has
// not delivered: it has queued a write that lands moments after the announcement,
// inside the re-render window, and stamped it. The guard against the drain being
// armed cannot see this one, because the announcement has not happened yet.
test('a seat announcing just AFTER the cap is still served safely — the cap must not deliver blind', async () => {
  const world = mkWorld();
  await assigned(world);

  const app2 = boot(world, {
    deps: { bootDrainSettleMs: 300, INJECT_BOOT_MAXWAIT: 80, InjectQueue: FastQueue },
  });
  try {
    const s = await app2.spawn('team-hand');
    // Wait for the cap to have FIRED at least once, without assuming what it did:
    // the handle is nulled on a one-shot fire and replaced on a re-arm, so a change
    // of identity is the one signal both shapes share.
    const first = s._replayFallbackTimer;
    for (let i = 0; i < 400 && s._replayFallbackTimer === first; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.notStrictEqual(s._replayFallbackTimer, first,
      'ENTER: the cap must have fired before the emit, or this is the sibling ordering already covered above');

    app2.wipeUntil('team-hand', 200);
    app2.emit('team-hand', '\x1b[?2004h');

    const got = await settled(app2, 'team-hand');
    assert.match(got, /BUILD THE WIDGET/,
      'the spec must survive an announcement that arrives after the cap: delivering at the cap only queues the '
      + 'write, which the ready gate then releases within a poll of the latch — squarely inside the re-render '
      + 'window — while the record is stamped delivered at cap time, so the seat is left holding a bare id and '
      + 'nothing says so until the next respawn');
  } finally { app2.stop(); }
});

// Every production replay spills: the head is ~490 chars, so head+spec clears
// MSG_SPILL_THRESHOLD for all but a trivial spec. A spilled body is announced only as
// "Message (N bytes) attached", so a marker carried inside the body is invisible until
// the file is opened — and this marker exists precisely to be acted on BEFORE the spec
// is read. The rest of this file stubs the spill away, so nothing else can see it.
test('a spilled replay carries the marker on the POINTER line, not only inside the file', async () => {
  const world = mkWorld();
  await assigned(world);

  const spills = [];
  const app2 = boot(world, {
    deps: {
      MSG_SPILL_THRESHOLD: 500,
      spillToFile: (sender, body, recipient) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-tr-spill-'));
        const f = path.join(dir, `msg-${recipient}-${spills.length}.txt`);
        fs.writeFileSync(f, `From: ${sender}\n\n${body}`);
        spills.push(f);
        return f;
      },
    },
  });
  try {
    await app2.spawn('team-hand');
    const got = await settled(app2, 'team-hand', /attached|saved/);
    assert.strictEqual(spills.length, 1,
      'ENTER: the replay must actually SPILL at the production threshold — if it did not, this test is asserting '
      + 'against the inline shape and says nothing about the case that ships');
    assert.doesNotMatch(got, /BUILD THE WIDGET/,
      'ENTER: and the body must be in the file, not the line — otherwise there is no pointer to mark');

    assert.match(got, /\[ticket t1 REPLAY\]/,
      'the pointer line must name the ticket and mark it a REPLAY: this is the only text the seat sees before it '
      + 'decides whether to open the file, and a seat that cannot tell a redelivery from a fresh assignment redoes '
      + 'finished work — the failure this marker exists to prevent, and a codex seat spends a whole turn on a Read '
      + 'to learn it');
    // t353 r3: and the close verb rides that same line. A replayed seat is the one
    // MOST likely to close in prose — it was respawned, so it holds no memory of the
    // verb — and the body carrying it is in the file, behind the Read turn. The
    // REPLAY marker alone satisfies the assertion above, so without this the verb
    // could be dropped from the tag and every test here would still pass.
    assert.match(got, /\[ticket t1 REPLAY\] close with \[agent:task done t1\]/,
      'the replay pointer carries the close verb, not just the REPLAY marker');
    const spilled = fs.readFileSync(spills[0], 'utf8');
    assert.match(spilled, /BUILD THE WIDGET/, 'and the spec is what the file holds');
    assert.match(spilled, /REPLAY/, 'the in-body marker stays too — the pointer is an addition, not a move');
  } finally { app2.stop(); }
});

test('a codex seat is replayed to at boot-settle, not at create', async () => {
  const world = mkWorld();
  // Assign to the seat by NAME: the codex seat below spawns under the same name, and
  // this keeps the test about the hook point rather than about role resolution.
  await assigned(world, 'team-hand');

  // The cap must be far away: this test is about the settle EDGE, and a cap that can
  // fire during it would deliver the spec for a reason the test does not mean to prove.
  const app2 = boot(world, { deps: { rosterSettleMs: 20, INJECT_BOOT_MAXWAIT: 60_000 } });
  try {
    await app2.spawn('team-hand', 'codex');
    await new Promise((r) => setTimeout(r, 60));
    assert.doesNotMatch(app2.seen('team-hand'), /BUILD THE WIDGET/,
      'nothing may be written before boot output settles — a codex seat\'s queue has no readiness gate at all, '
      + 'so a write at create() goes into a TUI that is not in raw mode yet and is swallowed as an unsubmitted '
      + 'draft');

    app2.emit('team-hand', 'codex booting\n');    // arms the settle timer
    const got = await settled(app2, 'team-hand');
    assert.match(got, /BUILD THE WIDGET/,
      'and it must arrive once boot output goes quiet — codex seats take tickets through _advanceSeat today, so '
      + 'a claude-only replay would leave them holding the original bug');
    assert.match(got, /REPLAY/, 'marked, same as the claude path');
  } finally { app2.stop(); }
});

// The codex arm's "absolute cap" is not a wall clock: _settleBoot is reachable only
// through _armBootSettle, which runs only from onData. A seat that emits nothing never
// settles, so it would hold its spec for the life of the process. The reason this arm
// has no ordinary fallback — never write while boot output is streaming — says nothing
// about a seat that has produced no output at all.
test('a codex seat that emits NOTHING still gets its spec, via the cap', async () => {
  const world = mkWorld();
  await assigned(world, 'team-hand');

  const app2 = boot(world, { deps: { INJECT_BOOT_MAXWAIT: 30, rosterSettleMs: 60_000 } });
  try {
    const s = await app2.spawn('team-hand', 'codex');   // no emit(): this seat never speaks
    const got = await settled(app2, 'team-hand');
    assert.match(got, /BUILD THE WIDGET/,
      'the cap must deliver when boot output never arrives — the settle edge is armed BY output, so with none '
      + 'there is no edge coming and the spec is not late but gone');
    assert.strictEqual(s._bootSettling, true,
      'ENTER: the boot window must still be OPEN — _settleBoot closes it, so if it had run, this delivery would '
      + 'be the settle path working normally rather than the cap covering for it');
  } finally { app2.stop(); }
});

// The one-shot bounds the replay to one per process, so what it is spent ON matters. A
// `held` verdict delivers nothing and stamps nothing; consuming the flag there burns
// the process's only replay on a pass that did no work, while a later edge is still to
// come. Held is a property of the SEAT at an instant — unlike `self` or `undelivered`,
// which are structural and would repeat identically forever.
test('a held delivery leaves the replay armed, and a later edge still lands it', async () => {
  const world = mkWorld();
  await assigned(world, 'team-hand');

  // codex, because a claude seat under a permission hold is PARKED instead (a real
  // delivery), and parking is not the outcome under test.
  const app2 = boot(world, { deps: { INJECT_BOOT_MAXWAIT: 40, rosterSettleMs: 60_000 } });
  try {
    const s = await app2.spawn('team-hand', 'codex');
    s.needsAttention = { kind: 'permission' };   // urgent bypasses every hold except this one
    for (let i = 0; i < 400 && s._replayFallbackTimer != null; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.strictEqual(s._replayFallbackTimer, null, 'ENTER: the cap must have fired, or nothing was held yet');
    assert.doesNotMatch(app2.seen('team-hand'), /BUILD THE WIDGET/, 'ENTER: held means nothing reached the seat');
    assert.strictEqual(world.tickets().find((x) => x.id === 't1').deliveredTo.incarnation !== s.incarnation, true,
      'ENTER: and nothing was stamped for this incarnation');

    assert.strictEqual(s._replayTicketsPending, true,
      'the replay must stay armed after a held pass — held says the seat cannot take it RIGHT NOW, not that '
      + 'there is nothing to take, so spending the one-shot on it strands the ticket for the whole process');

    s.needsAttention = null;                     // the dialog is answered
    app2.m._replayTicketsOnce(s);
    const got = await settled(app2, 'team-hand');
    assert.match(got, /BUILD THE WIDGET/,
      'and the next edge must land it: the retry is the entire value of leaving the flag armed');
    assert.strictEqual(world.tickets().find((x) => x.id === 't1').deliveredTo.incarnation, s.incarnation,
      'now stamped, because now it was delivered');
  } finally { app2.stop(); }
});

// Replay is the OTHER hand-off, and handing a queued ticket to a seat IS its
// dispatch — so it re-pins like advance does. Left un-pinned, an inherited ticket
// keeps naming the dead seat, and its close bills that seat's lifetime ledger for
// work a sibling did.
test('replay re-pins an inherited ticket to the seat that actually received it', async () => {
  const world = mkWorld();
  const app1 = boot(world);
  const lead = await app1.spawn('lead');
  await app1.spawn('team-hand-1');
  app1.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\ntasks/widget/SPEC.md\nstep one' });
  // t308: the pin is made by the DISPATCH, so it needs the second step. The
  // ENTER was pinning "a live seat holds this ticket before the process dies" —
  // the dead pin the replay is supposed to inherit — and that is unchanged; an
  // add-only ticket carries the role key and never had a pin to inherit at all.
  app1.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(world.tickets().find((t) => t.id === 't1').assignee, 'team-hand-1',
    'ENTER: pinned to the first seat, or there is no dead pin to inherit');
  await settled(app1, 'team-hand-1');
  app1.stop();

  // The pinned seat never comes back; a SIBLING of the same role boots instead.
  const app2 = boot(world);
  try {
    await app2.spawn('team-hand-2');
    await settled(app2, 'team-hand-2');
    await new Promise((r) => setTimeout(r, 60));

    assert.match(app2.seen('team-hand-2'), /BUILD THE WIDGET/,
      'ENTER: the sibling must actually receive the spec, or the re-pin below is about an undelivered ticket');
    const t = world.tickets().find((x) => x.id === 't1');
    assert.strictEqual(t.assignee, 'team-hand-2',
      'the record names the seat that got the work, not the dead one it was pinned to');
    assert.strictEqual(t.role, 'hand', 'and still carries the role it was filed under');
  } finally { app2.stop(); }
});

// _openTicketsFor matches a role ticket to EVERY seat filling that role, but
// _deliverTicketSpec re-resolves it to the first live one. Multi-seat roles are
// first class (`-N` suffixes are stripped when matching), so without a guard the
// second seat's replay hands seat #1 a duplicate and then stamps the record with a
// seat that received nothing — which also breaks the once-per-incarnation bound.
test('two seats on one role: the spec goes once, to the seat that resolves', async () => {
  const world = mkWorld();
  const app1 = boot(world);
  const lead = await app1.spawn('lead');
  await app1.spawn('team-hand-1');
  await app1.spawn('team-hand-2');
  app1.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\ntasks/widget/SPEC.md\nstep one' });
  // t308: `role` is written by the dispatch, not by `add` — that asymmetry is
  // deliberate (it is how `start` knows a ticket has already been started), so
  // this ENTER now needs the second step. What it pins is untouched: the ticket
  // is filed under a ROLE, which is what makes two seats answer for it.
  app1.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(world.tickets().find((t) => t.id === 't1').role, 'hand',
    'ENTER: the ROLE is what the ticket was filed under — the case is two seats answering for it');
  await settled(app1, 'team-hand-1');
  app1.stop();

  const app2 = boot(world);
  try {
    const s1 = await app2.spawn('team-hand-1');
    await app2.spawn('team-hand-2');
    await settled(app2, 'team-hand-1');
    await new Promise((r) => setTimeout(r, 60));

    assert.strictEqual((app2.seen('team-hand-1').match(/REPLAY/g) || []).length, 1,
      'the resolved seat must be handed the spec exactly ONCE — every seat on the role replays the same ticket, '
      + 'and each delivery re-resolves to this same seat, so an unguarded replay burns one turn per sibling seat');
    assert.doesNotMatch(app2.seen('team-hand-2'), /BUILD THE WIDGET/,
      'and the sibling gets nothing, because the delivery resolved elsewhere');

    const d = world.tickets().find((x) => x.id === 't1').deliveredTo;
    assert.strictEqual(d.seat, 'team-hand-1',
      'the stamp must name the seat that actually RECEIVED it: stamping the seat whose replay pass ran last '
      + 'records a delivery to a seat holding nothing, and the next respawn then suppresses the real one');
    assert.strictEqual(d.incarnation, s1.incarnation, 'with that seat\'s key, for the same reason');
  } finally { app2.stop(); }
});

// N open tickets used to mean N back-to-back injects in one tick. That race is
// already documented in this file's product code, where a forced drain was changed
// to join into ONE injection: #1's Enter starts a turn and #2 lands in the churn
// with its Enter swallowed, leaving a stranded draft.
test('with two tickets open, a respawn delivers only the head', async () => {
  const world = mkWorld();
  const app1 = boot(world);
  const lead = await app1.spawn('lead');
  await app1.spawn('team-hand');
  app1.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\ntasks/widget/SPEC.md\nfirst' });
  app1.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'PAINT THE SHED\ntasks/shed/SPEC.md\nsecond' });
  // t308: replay delivers STARTED tickets only, so both need the dispatch step —
  // an added-but-unstarted ticket is deliberately invisible to it. What this test
  // pins is untouched: with two in the queue, a respawn hands over exactly one.
  app1.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  app1.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  assert.strictEqual(world.tickets().filter((t) => t.state === 'open').length, 2, 'ENTER: two open');
  assert.strictEqual(world.tickets().filter((t) => t.startedAt != null).length, 2,
    'ENTER: and BOTH are started — with either one unstarted the head assertion below '
    + 'would pass for the wrong reason, since replay would have had only one candidate');
  app1.stop();

  const app2 = boot(world);
  try {
    await app2.spawn('team-hand');
    await settled(app2, 'team-hand');
    await new Promise((r) => setTimeout(r, 80));
    const got = app2.seen('team-hand');

    assert.match(got, /BUILD THE WIDGET/, 'the oldest open ticket is what the seat is handed');
    assert.doesNotMatch(got, /PAINT THE SHED/,
      'the second must NOT follow it in the same tick — two injects race, the second one\'s Enter is swallowed '
      + 'by the turn the first one started, and it strands as a draft. The seat gets it on close, via the '
      + 'advance path that is already proven');
    assert.ok(world.tickets().find((x) => x.id === 't2').deliveredTo == null,
      'and an undelivered ticket must not be stamped — stamping it would suppress its replay next time too, '
      + 'which is this bug with extra steps');
  } finally { app2.stop(); }
});

// A record can be hand-edited (the store is a JSON file the lead's tooling writes).
// A spec-less ticket must be skipped, not delivered: template interpolation turns a
// missing body into the literal string "undefined", which reads as an instruction.
test('a ticket with no spec is skipped rather than delivered empty', async () => {
  const world = mkWorld();
  await assigned(world);
  const tickets = world.tickets();
  delete tickets.find((t) => t.id === 't1').spec;
  world.tstore.save(world.team.root, tickets);
  // Compared rather than asserted null: the assigning process replays to itself
  // here (its own fallback fires immediately at INJECT_BOOT_MAXWAIT 0), so a stamp
  // already exists. What must hold is that THIS incarnation adds nothing.
  const before = JSON.stringify(world.tickets().find((t) => t.id === 't1').deliveredTo || null);

  const app2 = boot(world);
  try {
    const s = await app2.spawn('team-hand');
    await replayPassed(app2, 'team-hand');
    assert.doesNotMatch(app2.seen('team-hand'), /undefined/,
      'a spec-less record must never be injected — the seat would be handed the word "undefined" as its task');
    const after = world.tickets().find((x) => x.id === 't1').deliveredTo;
    assert.notStrictEqual(after && after.incarnation, s.incarnation,
      'and it must not be stamped with the live key, so a later repair of the record still replays — stamping a '
      + 'ticket that was skipped records a delivery that never happened');
    assert.strictEqual(JSON.stringify(after || null), before, 'the record is untouched');
  } finally { app2.stop(); }
});

// ── t349: a write that reached the queue is not a spec that reached the seat ──
//
// `queued` means the bytes went to the inject queue. A write landing inside the
// CLI's boot re-render is either wiped or keeps its Enter as content, and both
// stamp the record delivered — so the failure is silent and the log line for a
// lost dispatch is byte-identical to a healthy one. Measured over 24 consecutive
// real dispatches the write goes out 1.02s after spawn in EVERY case, healthy and
// lost alike, which is why no timing constant can separate them and these tests
// drive the confirmation latch instead.
//
// The latch clears on any non-idle activity, because starting a turn is exactly
// what a lost write prevents. Four of the five tests below therefore assert
// SILENCE, and each names the shape it is silent about — a detector that fires on
// a seat that is merely slow is worse than none, since the redelivery it triggers
// lands in a live composer.

// Fire the confirmation check at a moment the test chooses. The production timer
// is cancelled first so it cannot also fire and turn a one-shot retry into two.
function fireConfirm(app, s) {
  clearTimeout(s._specConfirmTimer);
  s._specConfirmTimer = null;
  app.m._checkSpecConfirm(s);
}

// The window is injected LONG and the check is then called directly. Driving it
// at 0 instead makes the check race the delivery it is meant to judge: it fires
// while the first write is still settling through the queue, so the latch is
// already spent by the time a test can look at it, and every assertion about the
// latch's state reads a value the production ordering never produces.
async function dispatched(world, opts = {}) {
  const app = boot(world, { deps: { specConfirmMs: 60_000, ...(opts.deps || {}) } });
  const lead = await app.spawn('lead');
  const s = await app.spawn('team-hand');
  // With a long INJECT_BOOT_MAXWAIT the ready gate holds every write, including
  // this fixture's own — a fake PTY never sends the mode-2004 byte that latches
  // it. Sending it by hand lets the SETUP flow at a cap the test can later use to
  // hold a write open, by dropping the latch again once the collision is built.
  if (opts.bootReady) app.emit('team-hand', '\x1b[?2004h');
  // Spend the respawn-replay one-shot on an EMPTY board before the ticket exists.
  // Left armed it fires against t1 a few ticks later and writes a REPLAY of its
  // own, which is indistinguishable at the PTY from the redelivery under test —
  // the silence assertions below would then be reading another mechanism's bytes
  // and failing (or worse, passing) for a reason that has nothing to do with this.
  await replayPassed(app, 'team-hand');
  app.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\ntasks/widget/SPEC.md\nstep one' });
  app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const got = await settled(app, 'team-hand');
  assert.match(got, /BUILD THE WIDGET/,
    'ENTER: the spec must have been written at all — with no first delivery there is nothing for the latch to '
    + 'confirm, and a redelivery assertion below would pass for the wrong reason');
  assert.ok(s._specUnconfirmed,
    'ENTER: the write must ARM the latch — unarmed, every silence assertion below holds trivially and the '
    + 'file stays green against a fix that never runs');
  // An injected unit is three writes (Ctrl-U, text, Enter) and `settled` returns
  // on the middle one. The silence tests below baseline the PTY and assert it is
  // UNCHANGED, so a baseline taken here would still be missing the trailing Enter
  // and every one of them would fail on the first delivery finishing itself.
  for (let i = 0; i < 200 && !app.seen('team-hand').endsWith('\r'); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(app.seen('team-hand').endsWith('\r'),
    'ENTER: the first delivery must be COMPLETE before a test baselines the terminal');
  return { app, s, lead };
}

test('t349: a seat written to that never starts a turn is redelivered to, exactly once', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    const first = app.seen('team-hand');
    // No activity at all — the seat never submitted. This is the wedged shape:
    // from outside it is indistinguishable from a seat that is simply thinking,
    // which is the whole reason the failure went unnoticed four times in a night.
    fireConfirm(app, s);
    const after = await settled(app, 'team-hand', /REPLAY/);
    assert.match(after, /REPLAY/,
      'a spec whose seat never took a turn must be redelivered — the write is fire-and-forget into a PTY, so '
      + 'nothing else in the system can tell a lost dispatch from a delivered one');
    assert.ok(after.length > first.length, 'ENTER: the redelivery must be a SECOND write, not a re-read of the first');
    assert.strictEqual(s._specUnconfirmed && s._specUnconfirmed.retried, true,
      'and the retry must be spent — an unspent budget redelivers forever, spraying a live composer');

    // Second window, still no turn: the budget is exhausted, so this escalates to
    // the lead rather than writing a third copy.
    const beforeLead = app.seen('lead');
    fireConfirm(app, s);
    const leadSaw = await settled(app, 'lead', /ESCALATED/);
    assert.match(leadSaw, /ESCALATED/,
      'two writes with no turn is not a lost write, and a third copy would not fix it — it goes to the lead');
    assert.ok(leadSaw.length > beforeLead.length, 'ENTER: the escalation must be a new write to the lead');
    assert.strictEqual(s._specUnconfirmed, null, 'and the latch is released, so nothing re-fires behind the escalation');
  } finally { app.stop(); }
});

test('t349: a seat thinking for minutes on its first turn is never redelivered to', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    const first = app.seen('team-hand');
    // To think at all it SUBMITTED, which is the event the latch is asking about.
    // The turn's length is irrelevant and stays irrelevant however long it runs —
    // this detector can only ever see the absence of a FIRST turn.
    app.m._emitActivity('team-hand', 'thinking');
    assert.strictEqual(s._specUnconfirmed, null, 'a started turn clears the latch');
    fireConfirm(app, s);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(app.seen('team-hand'), first,
      'a seat mid-turn must receive NOTHING — a redelivery here splices a second copy of the spec into a live '
      + 'composer, which is a worse failure than the one being fixed');
  } finally { app.stop(); }
});

test('t349: a seat that finished its turn and went idle is never redelivered to', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    // Terminal idle is reached THROUGH thinking, and that transit is what clears
    // the latch. An idle seat with the latch still set is unreachable — which is
    // why this case needs no threshold to stay silent.
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    const first = app.seen('team-hand');
    assert.strictEqual(s._specUnconfirmed, null, 'ENTER: the turn must have cleared the latch on its way to idle');
    fireConfirm(app, s);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(app.seen('team-hand'), first,
      'a finished seat must receive nothing — it did its work and is waiting, not wedged');
  } finally { app.stop(); }
});

test('t349: a seat blocked on a permission dialog is not redelivered to, and is still watched', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    const first = app.seen('team-hand');
    // A dialog produces no activity and waits an unbounded time on a human, so it
    // looks exactly like the wedged shape. It must not alarm — but it must not be
    // written off either, since the spec may still be unread behind it.
    s.needsAttention = { kind: 'permission', ts: Date.now(), message: 'allow?' };
    fireConfirm(app, s);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(app.seen('team-hand'), first,
      'a blocked seat must receive nothing — its silence is the human\'s, not a lost write');
    assert.ok(s._specUnconfirmed,
      'and the latch must SURVIVE rather than clear: a dialog answered ten minutes later leaves a seat that '
      + 'still never took a turn, and clearing here would retire the only check that would catch it');
    assert.strictEqual(s._specUnconfirmed.retried, false, 'the retry budget is untouched — nothing was tried');

    // Dialog answered, still no turn: the check that was re-armed now fires.
    s.needsAttention = null;
    fireConfirm(app, s);
    const after = await settled(app, 'team-hand', /REPLAY/);
    assert.match(after, /REPLAY/, 'once the dialog clears, a seat that still never woke is redelivered to');
  } finally { app.stop(); }
});

test('t349: a closed ticket is never redelivered to a silent seat', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    const first = app.seen('team-hand');
    // The seat closed the ticket through some other path and went quiet. There is
    // no work left to hand back, and redelivering would re-open finished work.
    const all = world.tickets();
    all.find((t) => t.id === 't1').state = 'done';
    world.tstore.save(world.team.root, all);
    fireConfirm(app, s);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(app.seen('team-hand'), first,
      'a ticket that is no longer open must not be redelivered — the record, not the seat, is the authority '
      + 'on whether there is still work');
    assert.strictEqual(s._specUnconfirmed, null, 'and the latch is dropped rather than left to fire again');
  } finally { app.stop(); }
});

// ── t349 r1: the latch may only watch a delivery whose consumption is observable ──
//
// The three tests below are the review's must-fixes. The first is the important
// one: it is the case where "the confirm signal and the consumption event are the
// same event" — the argument the whole redelivery rests on — is FALSE.

test('t349: a spec PARKED to a busy seat is not watched — consuming it produces no edge', async () => {
  const world = mkWorld();
  const app = boot(world, { deps: { specConfirmMs: 60_000 } });
  try {
    const lead = await app.spawn('lead');
    const s = await app.spawn('team-hand');
    await replayPassed(app, 'team-hand');
    // Mid-turn at dispatch. Every ticket dispatch is urgent, so shouldHoldDm does
    // NOT hold a busy seat — the delivery goes to _maybeParkDelivery instead and
    // becomes a FILE. That is the designed path, not a failure.
    s.activityState = 'thinking';
    const before = app.seen('team-hand');
    app.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\ntasks/widget/SPEC.md\nstep one' });
    app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
    await new Promise((r) => setTimeout(r, 60));

    assert.strictEqual(app.seen('team-hand'), before,
      'ENTER: the spec must have PARKED rather than been written — if it was injected instead, this fixture '
      + 'never reaches the state it names and the assertion below passes for the wrong reason');
    // Same trap the held-park test closes: a park that FAILS is caught by
    // _maybeParkDelivery, and _injectText then queues the text behind the busy hold
    // instead of writing it — so nothing reaches the PTY, nothing arms, and the
    // assertions here pass with the spec in neither the park store nor the terminal.
    assert.strictEqual(app.parked('team-hand', /BUILD THE WIDGET/), 1,
      'ENTER: the spec must actually BE parked — "nothing was written" is equally true of a park that failed '
      + 'and left the text queued behind the busy hold, which is not the state this test names');
    assert.ok(!s._specUnconfirmed,
      'a parked spec must NOT arm the latch: the out-of-process hook drains it mid-loop and a seat already '
      + '"thinking" emits no fresh activity edge for it (ActivityTracker._set dedupes on unchanged state), so '
      + 'the latch could never be cleared by consumption — it would redeliver a full spec into a seat that '
      + 'HAS it and is working on it');

    // And the seat consuming it stays silent at the window, because nothing armed.
    const armed = app.seen('team-hand');
    app.m._checkSpecConfirm(s);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('team-hand'), armed, 'and no redelivery is produced for it');
  } finally { app.stop(); }
});

test('t349: a spec DIVERTED to a park at write time drops the latch it already armed', async () => {
  const world = mkWorld();
  const app = boot(world, { deps: { specConfirmMs: 60_000 } });
  try {
    const lead = await app.spawn('lead');
    const s = await app.spawn('team-hand');
    await replayPassed(app, 'team-hand');
    // The divert runs INSIDE the queue's critical section, after the producer has
    // already reported 'injected'. An operator with an open draft at that instant
    // turns the write into a park — so the latch armed a moment earlier is now
    // watching for an edge that consumption will never produce.
    s.lastUserInputTs = Date.now();
    s.lastUserSubmitTs = 0;
    app.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\ntasks/widget/SPEC.md\nstep one' });
    app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
    await new Promise((r) => setTimeout(r, 120));

    assert.strictEqual(app.seen('team-hand'), '',
      'ENTER: the delivery must have been DIVERTED to a park rather than written — if it reached the PTY, '
      + 'this fixture never enters the state it names and the latch assertion below is about nothing');
    assert.ok(!s._specUnconfirmed,
      'a write claimed by the fire-time divert must leave no latch behind: the bytes became a file, and a '
      + 'file is drained without producing the activity edge the latch waits for — last disposition wins');
  } finally { app.stop(); }
});

test('t349: a ticket reassigned during the window is not redelivered to the old seat', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    const other = await app.spawn('other-hand');
    // Spend the new seat's OWN respawn-replay one-shot while the ticket still
    // belongs to team-hand. Left armed it fires after the reassignment below and
    // delivers a legitimate REPLAY — a different mechanism doing its job, but
    // byte-identical at the PTY to the stale-latch redelivery under test, so the
    // assertion would fail (or pass) for a reason unrelated to the fix.
    await replayPassed(app, 'other-hand');
    // The operator's documented recovery for a silent seat. It re-pins the ticket
    // and delivers to the new seat, which starts work and clears its OWN latch —
    // nothing clears the old seat's, so the stale latch is what must not fire.
    const all = world.tickets();
    all.find((t) => t.id === 't1').assignee = 'other-hand';
    world.tstore.save(world.team.root, all);
    // Baseline AFTER the spawn settles: a fresh seat's own boot traffic is not the
    // redelivery under test, and folding it into the baseline would make this
    // assert that a busy terminal stayed byte-identical rather than that no spec
    // arrived.
    await new Promise((r) => setTimeout(r, 40));
    const otherBefore = app.seen('other-hand');

    fireConfirm(app, s);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('other-hand'), otherBefore,
      'the seat that now holds the ticket must receive nothing — a stale latch re-resolves to whoever holds '
      + 'the ticket NOW, which injects a REPLAY into a seat mid-work on it');
    assert.strictEqual(s._specUnconfirmed, null,
      'and the stale latch is dropped, so the second window cannot escalate naming the wrong seat');
    assert.ok(other, 'ENTER: the second seat must be live, or "received nothing" is trivially true');
  } finally { app.stop(); }
});

test('t349: a stranded ticket that resolves to no live seat escalates instead of going silent', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    // The assignee died inside the window and nothing took its role, so the ticket
    // resolves to nobody. Dropping this alongside the reassignment case would be
    // silent in exactly the shape this ticket exists to report: an open ticket whose
    // spec reached no one, and no one told.
    app.m.sessions.delete('team-hand');
    fireConfirm(app, s);
    const leadSaw = await settled(app, 'lead', /ESCALATED/);
    assert.match(leadSaw, /ESCALATED/,
      'a stranded spec must reach the lead — a ticket that resolves to no seat is the loudest case this '
      + 'ticket exists to surface, not a case to drop');
    assert.match(leadSaw, /spec-undelivered/, 'and it names the step, so the lead knows which mechanism spoke');
    // The evidence must name STRANDING, not a failed redelivery. Both paths end in
    // an escalation, so a test that only matches /ESCALATED/ passes with this branch
    // deleted — control simply falls through to the retry, which escalates for a
    // different reason and hands the lead the wrong diagnosis.
    assert.match(leadSaw, /no longer resolves to any live seat/,
      'and the evidence names the actual condition: nobody holds the ticket, so no redelivery was even '
      + 'attempted — reporting this as a failed redelivery would send the lead looking at a delivery path '
      + 'that never ran');
    assert.doesNotMatch(leadSaw, /redelivery could not be handed/,
      'ENTER: it must NOT be the retry path speaking — that path is reached only when a seat still holds the '
      + 'ticket, and confusing the two makes this test blind to the branch it names');
    assert.strictEqual(s._specUnconfirmed, null, 'and the latch is cleared rather than left to re-fire');
  } finally { app.stop(); }
});

// The OTHER park, and the one the round-1 fix missed. A dialog-blocked seat is the
// single hold `urgent` cannot override (shouldHoldDm returns noUrgent for
// attention==='permission'), so a dispatch to one lands in _parkHeldDelivery rather
// than in the inject queue. The seat is IDLE here — this is not the busy-park shape
// one test up, it is a live composer that simply cannot be written to yet.
test('t349: a spec HELD-PARKED behind a permission dialog does not arm the latch', async () => {
  const world = mkWorld();
  const app = boot(world, { deps: { specConfirmMs: 60_000 } });
  try {
    const lead = await app.spawn('lead');
    const s = await app.spawn('team-hand');
    await replayPassed(app, 'team-hand');
    // BEFORE the dispatch, which is the whole gap: arming via a normal injected
    // delivery and only then raising the dialog exercises the injected path with a
    // dialog attached, never the hold-park.
    s.needsAttention = { kind: 'permission', ts: Date.now(), message: 'allow?' };
    const before = app.seen('team-hand');
    app.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\ntasks/widget/SPEC.md\nstep one' });
    app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
    await new Promise((r) => setTimeout(r, 60));

    assert.strictEqual(app.seen('team-hand'), before,
      'ENTER: the spec must have been HELD-PARKED rather than written — if it reached the PTY this fixture '
      + 'never entered _parkHeldDelivery and every assertion below is about a path it did not take');
    // POSITIVELY, not by the absence above: a park that threw is caught inside
    // _parkHeldDelivery, returns null, and leaves the PTY equally untouched — so
    // `seen === before` alone is just as true of a bare `held` that parked nothing,
    // and this test would go green over the one path it exists to cover.
    assert.strictEqual(app.parked('team-hand', /BUILD THE WIDGET/), 1,
      'ENTER: the SPEC itself must be in the park store — the assertion above cannot tell a successful park '
      + 'from a park that failed silently, and only one of those is the state this test names');
    assert.ok(!s._specUnconfirmed,
      'a held-parked spec must NOT arm the latch: it is a file the hook drains mid-loop, and the operator '
      + 'answering the dialog clears needsAttention synchronously while the seat never leaves "thinking" — so '
      + 'no activity edge is ever emitted for it and the latch could never be cleared by consumption');

    // The exact interleaving that redelivered before the fix: dialog answered inside
    // the window, seat consumed the parked spec, no edge, and the check then finds no
    // dialog to defer behind, an open ticket, and this seat still holding it.
    s.needsAttention = null;
    const armed = app.seen('team-hand');
    app.m._checkSpecConfirm(s);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('team-hand'), armed,
      'and nothing is redelivered once the dialog clears — a full REPLAY here would land in a seat that '
      + 'already has the spec and is working on it, which is worse than the loss this ticket closes');
  } finally { app.stop(); }
});

// The gates sit AHEAD of the write, so the disposition alone is not enough: a seat
// that was idle when the park decision was taken can be mid-turn by the time the
// bytes land. The divert catches only a seat with an OPEN draft; one that submitted
// has none.
test('t349: a seat that went busy while the unit waited in the gates does not arm the latch', async () => {
  const world = mkWorld();
  const app = boot(world, { deps: { specConfirmMs: 60_000 } });
  try {
    const lead = await app.spawn('lead');
    const s = await app.spawn('team-hand');
    await replayPassed(app, 'team-hand');
    app.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\ntasks/widget/SPEC.md\nstep one' });
    // Busy at WRITE time, idle at park-decision time. _armSpecConfirm runs inside
    // `produce`, so it reads the state here, not the one the disposition was chosen
    // under. The ordering is deterministic rather than raced: _handleTask is
    // synchronous, and the queue's _drain does not start until a microtask, so this
    // assignment always lands between the park decision and the write.
    app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
    s.activityState = 'thinking';
    const got = await settled(app, 'team-hand');
    assert.match(got, /BUILD THE WIDGET/,
      'ENTER: the spec must have been WRITTEN — this test is about a write into a busy seat, so a park here '
      + 'would make the latch assertion below true for the unrelated reason the test above already covers');
    assert.ok(!s._specUnconfirmed,
      'a write into a seat that is already thinking must not arm: it emits no fresh activity edge (_set '
      + 'dedupes on unchanged state), so the latch would run its full window over a spec that landed fine '
      + 'and then redeliver into a working seat');
  } finally { app.stop(); }
});

// The timer fires 90s after EVERY dispatch, in the app's main process. The
// redelivery path underneath it does real fs work (_buildDeliveryText -> spillToFile),
// so "the check threw" must degrade to a logged error rather than an unhandled
// exception in the host. This is a mutant on the CATCH, not on the happy path.
// ── t409: a turn is only evidence about the write that CAUSED it ──
//
// Observed live: `task start t408` minted the worktree, branch and seat, the
// record read `state: open, assignee: clodex-hand-408, spec: 3171 bytes`, and the
// seat had no spec — it saw only the roster and correctly stood by. Nothing was
// wrong from outside: a live seat, idle, a healthy record. The operator noticed
// before any mechanism did.
//
// Two defects compose, and BOTH are needed for silence. The stamp is taken from
// `{queued:true}` (the bytes are in the queue, not at the seat), so a write wiped
// by the boot re-render is recorded delivered and never replayed again; and the
// 90s latch built to catch exactly that had already been cleared by the turn the
// seat took to read an unrelated roster park. Each test below kills one.

test('t409: a turn the transcript cannot attribute does NOT clear the latch', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    // The t408 interleaving: the spec write was wiped, so it is absent from the
    // transcript, and the seat then turns for something else entirely — a roster
    // park draining ~12s after spawn. Modelled as a real transcript that records
    // the roster and NOT the ticket, because that difference is the only thing
    // separating this from the healthy case below.
    app.transcript('team-hand', '{"role":"user","content":"[agent:from team] roster: lead clodex"}\n');
    app.m._emitActivity('team-hand', 'thinking');
    // Back to idle, which is where t408 actually sat: it read the roster, said "no
    // task spec attached", and stood by. The transit matters for the redelivery
    // below — a seat still mid-turn parks it instead, which is a different (and
    // already covered) path.
    app.m._emitActivity('team-hand', 'idle');

    assert.ok(s._specUnconfirmed,
      'a turn over text that is NOT this spec must leave the latch armed — clearing on any turn is what made '
      + 'the loss silent: the seat read a roster, the mechanism read "it started", and the spec was gone');

    // And the deadline still does its job, which is the point of staying armed.
    const first = app.seen('team-hand');
    fireConfirm(app, s);
    const after = await settled(app, 'team-hand', /REPLAY/);
    assert.match(after, /REPLAY/,
      'so the spec is redelivered — an unattributable turn must not consume the one mechanism that would '
      + 'otherwise notice');
    assert.ok(after.length > first.length, 'ENTER: a SECOND write, not a re-read of the first');
  } finally { app.stop(); }
});

test('t409: a turn over the spec ITSELF still clears the latch, and no redelivery follows', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    // The healthy case, and the mutation guard for the test above: if attribution
    // were implemented as "never clear", that test would pass and this one would
    // fail. The seat consumed the dispatch, so its id is in the transcript — the
    // id and not the body, because a spilled dispatch announces only the pointer
    // line and that is what production actually matches on.
    app.transcript('team-hand', '{"role":"user","content":"[ticket t1] close with [agent:task done t1]"}\n');
    app.m._emitActivity('team-hand', 'thinking');

    assert.strictEqual(s._specUnconfirmed, null,
      'a turn over the delivered spec clears the latch — this is the confirmation the mechanism exists to '
      + 'take, and a fix that stopped taking it would redeliver into every live seat');

    const first = app.seen('team-hand');
    fireConfirm(app, s);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(app.seen('team-hand'), first,
      'and nothing is redelivered: splicing a second copy of the spec into a seat that is working it is a '
      + 'worse failure than the one being fixed');
  } finally { app.stop(); }
});

// r1 must-fix 1. Ids are monotonic, so every low id is a PREFIX of ~10 live higher
// ones — `includes('t1')` is true of a transcript that merely mentions t156 in a
// cross-reference, a lead dm, or a review scope. Discriminating a turn caused by
// THIS dispatch from a turn that merely name-drops the ticket is the one job this
// probe has, so a bare-id match hands back the silent loss under a new name.
test('t409: a turn mentioning a SUPERSTRING ticket id does not attribute', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    // The seat is owed t1 and never got it. Its turn is about t1000 — a different
    // ticket entirely, whose id merely starts with this one's.
    app.transcript('team-hand', '{"role":"user","content":"[ticket t1000] close with [agent:task done t1000]"}\n');
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');

    assert.ok(s._specUnconfirmed,
      'a turn over t1000 must not confirm t1 — a bare `includes(id)` matches every superstring id, so a seat '
      + 'owed a low-numbered ticket is falsely confirmed by any mention of a higher one, and the spec is lost '
      + 'silently exactly as before');

    const first = app.seen('team-hand');
    fireConfirm(app, s);
    const after = await settled(app, 'team-hand', /REPLAY/);
    assert.match(after, /REPLAY/, 'so the real spec is still redelivered');
    assert.ok(after.length > first.length, 'ENTER: a SECOND write, not a re-read of the first');
  } finally { app.stop(); }
});

// r1 must-fix 2, and the one that matters most: the replay path IS the respawn
// path, so this is t156's whole population. A `--resume` seat's transcript already
// carries this ticket's marker from the incarnation that died — that is how it got
// the spec the first time — so an unanchored probe attributes ANY later turn (a
// parked-mail drain on respawn is the norm, and is t408's own +12s shape) to that
// stale copy and reverts to pre-fix silence.
test('t409: a respawned seat is not confirmed by its PREVIOUS incarnation transcript', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    // The dead incarnation's delivery, already on disk before this write went out.
    // Written BEFORE the dispatch below so it sits behind the latch's anchor —
    // which is the whole discrimination under test.
    app.transcript('team-hand', '{"role":"user","content":"[ticket t1] close with [agent:task done t1]"}\n');
    assert.ok(s._specUnconfirmed, 'ENTER: the latch must be armed, or there is nothing to false-clear');
    // Re-arm so the anchor is taken AFTER the stale copy exists — production takes
    // it inside `produce`, i.e. at write time on the respawn, which is exactly
    // after any resumed transcript content.
    app.m._armSpecConfirm('team-hand', 't1', 'injected');
    assert.ok(s._specUnconfirmed.since > 0,
      'ENTER: the anchor must be past the stale marker — at 0 this test cannot tell an anchored probe from an '
      + 'unanchored one and would pass against both');

    // Now an unrelated turn: parked mail draining on respawn, mentioning no ticket.
    app.transcript('team-hand', '{"role":"user","content":"[agent:from team] roster: lead clodex"}\n');
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');

    assert.ok(s._specUnconfirmed,
      'the stale marker from the dead incarnation must NOT confirm this write: the replay path is the respawn '
      + 'path, so an unanchored search leaves every respawned seat exactly as unprotected as before the fix');

    const first = app.seen('team-hand');
    fireConfirm(app, s);
    const after = await settled(app, 'team-hand', /REPLAY/);
    assert.match(after, /REPLAY/, 'so the respawned seat is redelivered to');
    assert.ok(after.length > first.length, 'ENTER: a SECOND write, not a re-read of the first');
  } finally { app.stop(); }
});

// The mutation guard for the anchor: a marker written AFTER the anchor is the
// genuine article and must still confirm. Without this, "never attribute anything
// past a respawn" would pass the test above and redeliver into every working seat.
test('t409: a marker written after the anchor still confirms, respawn or not', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    app.transcript('team-hand', '{"role":"user","content":"[ticket t1] stale copy from the dead incarnation"}\n');
    app.m._armSpecConfirm('team-hand', 't1', 'injected');
    // This one lands past the anchor: the seat really did consume the redelivery.
    app.transcript('team-hand', '{"role":"user","content":"[ticket t1 REPLAY] close with [agent:task done t1]"}\n');
    app.m._emitActivity('team-hand', 'thinking');

    assert.strictEqual(s._specUnconfirmed, null,
      'a marker past the anchor is this write being consumed, and must clear the latch — the REPLAY form '
      + 'proves the boundary match covers the marked variants, not just the plain pointer line');
  } finally { app.stop(); }
});

// The nit's cheap close. A wire-routed seat's activity edge comes from wire
// `turn.started`, not from the transcript, so it can arrive before the CLI has
// appended the user message and leave the latch armed over a spec that WAS
// consumed. By the deadline the write is on disk, so the check re-probes rather
// than spending a redelivery on the race.
test('t409: the deadline re-probes, so an edge that raced the transcript costs no redelivery', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    // The seat has a transcript (so the probe can answer at all) but this write is
    // not in it yet, and the wire edge fires anyway. The latch survives, correctly:
    // at this instant the seat is indistinguishable from one that lost the write.
    app.transcript('team-hand', '{"role":"user","content":"an earlier turn"}\n');
    app.m._armSpecConfirm('team-hand', 't1', 'injected');
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    assert.ok(s._specUnconfirmed, 'ENTER: the raced edge must leave the latch armed, or there is no race to close');

    // The CLI catches up before the 90s deadline.
    app.transcript('team-hand', '{"role":"user","content":"[ticket t1] close with [agent:task done t1]"}\n');
    const first = app.seen('team-hand');
    fireConfirm(app, s);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(s._specUnconfirmed, null, 'the deadline re-probe confirms it');
    assert.strictEqual(app.seen('team-hand'), first,
      'and nothing is redelivered — a transport race must not cost a spurious second copy of the spec');
  } finally { app.stop(); }
});

test('t409: an unreadable transcript trusts the turn rather than manufacturing a redelivery', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    // No transcript at all — a seat whose hook never installed. The probe cannot
    // answer, and its blind spot must not become an alarm: it would redeliver into
    // every codex seat and every seat with a broken hook, forever.
    app.m._emitActivity('team-hand', 'thinking');
    assert.strictEqual(s._specUnconfirmed, null,
      'an unanswerable probe falls back to the pre-t409 behaviour — "cannot say" must never be read as '
      + '"the seat did not get it", because those two justify opposite actions');
  } finally { app.stop(); }
});

test('t409: a replay still waiting in the boot gate is NOT stamped delivered', async () => {
  const world = mkWorld();
  await assigned(world);
  // Clear the stamp the assigning process left, so the absence asserted below is
  // THIS process declining to stamp and not simply an untouched empty field.
  const seed = world.tickets();
  delete seed.find((t) => t.id === 't1').deliveredTo;
  world.tstore.save(world.team.root, seed);

  // A seat that never announces bracketed paste, with the boot cap far out of
  // reach: the delivery is enqueued and then sits in the queue's ready loop,
  // unwritten. `_deliverTicketSpec` returns `{queued:true}` throughout — which is
  // exactly why that return cannot be the stamp.
  const app2 = boot(world, {
    deps: { bootDrainSettleMs: 60_000, INJECT_BOOT_MAXWAIT: 60_000, InjectQueue: FastQueue },
  });
  try {
    const s = await app2.spawn('team-hand');   // no emit(): never announces
    // Driven DIRECTLY rather than waiting for a boot edge, because the edge is
    // what this fixture is holding shut: the two drains that would call it are
    // both parked behind the same gate, so a test that waited would be asserting
    // the absence of a stamp for a pass that never ran — vacuous against every
    // implementation, correct or not.
    const done = app2.m._replayOpenTickets(s);
    assert.strictEqual(done, true,
      'ENTER: the replay must have RESOLVED to this seat and handed its spec to the queue — a pass that '
      + 'skipped the ticket (wrong seat, no spec) stamps nothing for reasons that have nothing to do with '
      + 'this test');
    assert.strictEqual(app2.seen('team-hand'), '',
      'ENTER: and the queue must still be holding it — if the bytes were released the seat really was told, '
      + 'and the assertion below would be demanding the absence of a legitimate stamp');

    const t = world.tickets().find((x) => x.id === 't1');
    assert.strictEqual(t.state, 'open', 'ENTER: still open, so this is the record a later replay would read');
    assert.ok(!t.deliveredTo,
      'a spec still sitting in the queue must NOT be stamped delivered: a seat that dies in the gates is '
      + 'never written to at all, and the stamp is what suppresses every later replay — so recording a '
      + 'delivery the queue never released turns a recoverable loss into a permanent one');

    // And the stamp is not merely DELAYED past the assertion: releasing the gate
    // must produce it. Without this the test would also pass against code that
    // never stamps at all, which would break the replay's once-per-incarnation bound.
    app2.emit('team-hand', '\x1b[?2004h');
    await settled(app2, 'team-hand', /BUILD THE WIDGET/);
    await stamped(world);
    assert.strictEqual(world.tickets().find((x) => x.id === 't1').deliveredTo.incarnation, s.incarnation,
      'once the write is released the stamp lands, with this incarnation key — deferring it must not lose it');
  } finally { app2.stop(); }
});

test('t349: a throw inside the confirmation check is contained, not raised into the host', async () => {
  const world = mkWorld();
  const errs = [];
  const app = boot(world, {
    deps: {
      specConfirmMs: 20,
      log: { info: () => {}, warn: () => {}, error: (_t, m) => errs.push(String(m)), debug: () => {} },
    },
  });
  try {
    const lead = await app.spawn('lead');
    const s = await app.spawn('team-hand');
    await replayPassed(app, 'team-hand');
    app.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\ntasks/widget/SPEC.md\nstep one' });
    app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
    await settled(app, 'team-hand');
    assert.ok(s._specUnconfirmed,
      'ENTER: the latch must be armed, or the timer below never runs and this test proves nothing');

    // The throw has to come from INSIDE the timer callback, which is the only place
    // the try/catch under test can protect. Replacing the method reaches it because
    // the callback dispatches through `this`.
    app.m._checkSpecConfirm = () => { throw new Error('BOOM: fs failed under the redelivery'); };
    // Re-arm so the patched method is what the next firing calls.
    app.m._armSpecConfirmTimer(s);

    // An unhandled throw out of a setTimeout callback would reach the process, and
    // node's default is to terminate the run — so surviving this await IS the
    // assertion. Uncaught, the file dies here instead of reporting a failure.
    await new Promise((r) => setTimeout(r, 120));

    assert.ok(errs.some((m) => /BOOM/.test(m)),
      'the throw must be CAUGHT AND LOGGED: an observer-grade timer that dies silently is indistinguishable '
      + 'from one that never fired, and this one runs after every dispatch in the app');
    assert.ok(errs.some((m) => /team-hand/.test(m)),
      'and the log must name the seat, or an operator reading it cannot tell which dispatch went unconfirmed');
  } finally { app.stop(); }
});

// ── t387: the same latch over the three seat-bound ticket REDIRECTS ──
//
// A rejection or a follow-up set of must-fixes is written back to a seat that is
// already working the ticket, and until now nothing watched that write at all.
// The loss is worse than a lost spec in one specific way: the seat keeps working
// the version that was just rejected, and the stall sweep reports it as a stalled
// seat — so the operator is told the wrong CAUSE, which is what these tests pin
// alongside the redelivery itself.
//
// The redirect kind reuses `_specConfirmTimer` rather than minting a second timer
// field, which is what makes it inherit the disarm-on-activity and
// clear-on-cleanup defences. Inheritance by construction is an argument, not
// evidence, so each of those defences is asserted on the REDIRECT path below
// rather than assumed from the spec path's coverage.

// A dispatched ticket whose spec latch has been RETIRED by a real turn, closed,
// and then rejected by the lead — i.e. a seat holding a redirect and nothing
// else. The turn matters: without it the spec latch is still armed and every
// assertion below could be reading the spec mechanism's bytes instead of the
// redirect's, which is the reduction-ate-the-row failure this file's t349 block
// already had to defend against once.
async function redirected(world, opts = {}) {
  const { app, s, lead } = await dispatched(world, opts);
  // Clears the spec latch the way production does — through a turn, not by
  // assignment — and leaves the seat idle so the redirect can arm.
  app.m._emitActivity('team-hand', 'thinking');
  app.m._emitActivity('team-hand', 'idle');
  assert.strictEqual(s._specUnconfirmed, null,
    'ENTER: the SPEC latch must be gone before the rejection — otherwise a redelivery asserted below could be '
    + 'the spec mechanism firing, and every kind-specific assertion here would be reading the wrong bytes');

  const all = world.tickets();
  all.find((t) => t.id === 't1').state = 'done';
  world.tstore.save(world.team.root, all);
  app.m._handleTask(lead, { type: 'task', sub: 'reject', who: null, id: 't1', body: 'FIX THE WIDGET MOUNT' });
  const got = await settled(app, 'team-hand', /FIX THE WIDGET MOUNT/);
  assert.match(got, /FIX THE WIDGET MOUNT/,
    'ENTER: the rejection must have been written at all — with no first delivery there is nothing for the '
    + 'latch to confirm and every assertion below holds vacuously');
  for (let i = 0; i < 200 && !app.seen('team-hand').endsWith('\r'); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(app.seen('team-hand').endsWith('\r'),
    'ENTER: the rejection delivery must be COMPLETE before a test baselines the terminal');
  return { app, s, lead };
}

test('t387: a seat that never starts a turn after a REJECTION is redelivered to, exactly once', async () => {
  const world = mkWorld();
  const { app, s } = await redirected(world);
  try {
    assert.ok(s._specUnconfirmed,
      'ENTER: the rejection write must ARM the latch — this is the mutant of dropping the onWrite hook at the '
      + '_taskReject call site, and unarmed every assertion below is vacuous');
    assert.strictEqual(s._specUnconfirmed.kind, 'redirect',
      'and it must be armed as a REDIRECT: the kind is what selects the rebuild and the escalation label, so a '
      + 'redirect latched as a spec would redeliver the SPEC text over a rejection');

    const first = app.seen('team-hand');
    fireConfirm(app, s);
    const after = await settled(app, 'team-hand', /REDELIVERY/);
    assert.match(after, /REDELIVERY/,
      'a rejection whose seat never took a turn must be redelivered — nothing else in the system can tell a '
      + 'swallowed redirect from a delivered one, and the seat is meanwhile working the rejected version');
    assert.ok(after.length > first.length, 'ENTER: the redelivery must be a SECOND write, not a re-read of the first');
    // Sliced past the first copy on purpose. Matched against the whole buffer this
    // assertion is vacuous — the reason is already in there from the FIRST
    // delivery, so a redelivery rebuilt with an empty reason passes it untouched.
    assert.match(after.slice(first.length), /FIX THE WIDGET MOUNT/,
      'and the redelivery must carry the REASON, not just an announcement — the reason is not persisted on the '
      + 'ticket record, so a rebuild that re-derived from the record would hand the seat an empty rejection');
    assert.strictEqual(s._specUnconfirmed && s._specUnconfirmed.retried, true,
      'and the retry must be spent — an unspent budget redelivers forever into a live composer');
  } finally { app.stop(); }
});

// The half of the ticket that is about ATTRIBUTION rather than delivery. With the
// spec label reused, the lead is told a seat never got its task about a seat that
// has been working the ticket for an hour — and the sweep's "stalled seat" reading
// is exactly the wrong place to send them looking.
test('t387: an undelivered rejection escalates as a REDIRECT, not as a spec and not as a stall', async () => {
  const world = mkWorld();
  const { app, s } = await redirected(world);
  try {
    fireConfirm(app, s);
    await settled(app, 'team-hand', /REDELIVERY/);
    assert.strictEqual(s._specUnconfirmed && s._specUnconfirmed.retried, true,
      'ENTER: the retry must be spent, or the second window below redelivers again instead of escalating');

    const beforeLead = app.seen('lead');
    fireConfirm(app, s);
    const leadSaw = await settled(app, 'lead', /ESCALATED/);
    assert.ok(leadSaw.length > beforeLead.length, 'ENTER: the escalation must be a new write to the lead');
    assert.match(leadSaw, /redirect-undelivered/,
      'the step must name the REDIRECT: this is the mutant of reusing the spec-undelivered label, and it is the '
      + 'misattribution the ticket exists to retire');
    assert.doesNotMatch(leadSaw, /spec-undelivered/,
      'and it must NOT report a spec — the spec arrived and was worked; what was lost is the rejection');
    assert.match(leadSaw, /never saw the rejected/,
      'the evidence must say the seat was never told, in those terms — a lead reading a silent seat on an open '
      + 'ticket defaults to "stalled", and replacing that guess is half the value of watching this path');
    assert.strictEqual(s._specUnconfirmed, null, 'and the latch is released, so nothing re-fires behind the escalation');
  } finally { app.stop(); }
});

test('t387: a seat that starts a turn after a rejection is never redelivered to', async () => {
  const world = mkWorld();
  const { app, s } = await redirected(world);
  try {
    assert.ok(s._specUnconfirmed, 'ENTER: the latch must be armed for its clearing to mean anything');
    // The defence the redirect kind INHERITS by reusing _specConfirmTimer and
    // _specUnconfirmed. Asserted on this path anyway: "it inherits it" is a claim
    // about the code, and a second timer field added later would break it silently.
    app.m._emitActivity('team-hand', 'thinking');
    assert.strictEqual(s._specUnconfirmed, null,
      'a started turn clears the REDIRECT latch too — the seat cannot submit without having consumed the '
      + 'rejection, which is the same entailment the spec latch rides');
    const first = app.seen('team-hand');
    fireConfirm(app, s);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(app.seen('team-hand'), first,
      'a seat mid-turn must receive NOTHING — splicing a second copy of the must-fixes into a live composer is '
      + 'a worse failure than the one being fixed');
  } finally { app.stop(); }
});

test('t387: a rejection PARKED behind a permission dialog does not arm the latch', async () => {
  const world = mkWorld();
  const { app, s, lead } = await dispatched(world);
  try {
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    const all = world.tickets();
    all.find((t) => t.id === 't1').state = 'done';
    world.tstore.save(world.team.root, all);

    // A dialog-blocked seat parks everything sent to it. The park is DURABLE and
    // owned by its own drains, and it emits no fresh activity edge when it drains
    // into a thinking seat — so arming here would redeliver a rejection into a
    // seat that has it and is acting on it.
    s.needsAttention = { kind: 'permission', ts: Date.now(), message: 'allow?' };
    app.m._handleTask(lead, { type: 'task', sub: 'reject', who: null, id: 't1', body: 'FIX THE WIDGET MOUNT' });
    for (let i = 0; i < 200 && app.parked('team-hand', /FIX THE WIDGET MOUNT/) === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.strictEqual(app.parked('team-hand', /FIX THE WIDGET MOUNT/), 1,
      'ENTER: the rejection must actually be PARKED — if it was injected instead, the latch assertion below is '
      + 'about the wrong disposition entirely and would pass against an arm that fires on every write');
    assert.ok(!s._specUnconfirmed,
      'a parked rejection must not arm: the park has its own durability and produces no edge to confirm, so the '
      + 'latch would run its full window over a delivery that landed and redeliver into a working seat');
  } finally { app.stop(); }
});

test('t387: a rejection written into an already-busy seat does not arm the latch', async () => {
  const world = mkWorld();
  const { app, s, lead } = await dispatched(world);
  try {
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    const all = world.tickets();
    all.find((t) => t.id === 't1').state = 'done';
    world.tstore.save(world.team.root, all);

    app.m._handleTask(lead, { type: 'task', sub: 'reject', who: null, id: 't1', body: 'FIX THE WIDGET MOUNT' });
    // Busy at WRITE time. The arm runs inside `produce`, so this is the state it
    // reads — a seat already thinking emits no fresh edge for the unit it consumes.
    s.activityState = 'thinking';
    const got = await settled(app, 'team-hand', /FIX THE WIDGET MOUNT/);
    assert.match(got, /FIX THE WIDGET MOUNT/,
      'ENTER: the rejection must have been WRITTEN — a park here would make the assertion below true for the '
      + 'unrelated reason the test above already covers');
    assert.ok(!s._specUnconfirmed,
      'a write into a thinking seat must not arm the redirect latch, for the same reason it does not arm the '
      + 'spec latch: the consumed unit produces no fresh activity edge to clear it');
  } finally { app.stop(); }
});

// The mutant here is the retry-budget carry condition matching on ticketId alone.
// That reads correct — it IS the same ticket — and it silently denies the redirect
// the single retry this whole ticket exists to give it, on precisely the tickets
// that have already had delivery trouble.
test('t387: a spec that spent its retry does not deny a later redirect on the same ticket its own', async () => {
  const world = mkWorld();
  const { app, s, lead } = await dispatched(world);
  try {
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    // A spec latch on t1 with its budget already spent — the state the mutant
    // carries forward across kinds.
    s._specUnconfirmed = { ticketId: 't1', kind: 'spec', at: Date.now(), retried: true };

    const all = world.tickets();
    all.find((t) => t.id === 't1').state = 'done';
    world.tstore.save(world.team.root, all);
    app.m._handleTask(lead, { type: 'task', sub: 'reject', who: null, id: 't1', body: 'FIX THE WIDGET MOUNT' });
    await settled(app, 'team-hand', /FIX THE WIDGET MOUNT/);

    assert.ok(s._specUnconfirmed, 'ENTER: the rejection must have re-armed the latch');
    assert.strictEqual(s._specUnconfirmed.kind, 'redirect',
      'ENTER: the latch must now be the REDIRECT one — still reading `spec` means the arm never ran and the '
      + 'budget assertion below is about the state this test planted, not about the carry rule');
    assert.strictEqual(s._specUnconfirmed.retried, false,
      'the redirect gets its OWN retry: the budget carries forward only within one kind, and a spent spec '
      + 'budget bleeding across would leave the rejection unwatched after a single write');
  } finally { app.stop(); }
});

// The non-injected arm drops the latch so it does not watch for an edge that will
// never come. Dropping it UNCONDITIONALLY is the mutant: a parked redirect would
// then retire a spec latch that is still legitimately watching an unconsumed spec.
test('t387: a diverted redirect drops only its OWN latch, not a live spec latch on the same ticket', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    assert.ok(s._specUnconfirmed && s._specUnconfirmed.kind === 'spec',
      'ENTER: a SPEC latch must be live on t1 — with nothing armed, "it survived" is vacuously true');
    const planted = s._specUnconfirmed;

    app.m._armSpecConfirm('team-hand', 't1', 'parked', { label: 'rejected', reason: 'r', from: 'lead' });
    assert.strictEqual(s._specUnconfirmed, planted,
      'a parked REDIRECT must leave the spec latch exactly as it found it — the spec is still unconsumed and '
      + 'still the only thing watching it, and an unconditional drop here retires it silently');

    app.m._armSpecConfirm('team-hand', 't1', 'parked');
    assert.strictEqual(s._specUnconfirmed, null,
      'ENTER: a parked SPEC still drops the spec latch — without this the assertion above would also pass '
      + 'against an arm whose non-injected branch does nothing at all');
  } finally { app.stop(); }
});

test('t387: the FOLLOW-UP must-fixes path arms the same latch', async () => {
  const world = mkWorld();
  const { app, s, lead } = await redirected(world);
  try {
    // Retire the first rejection's latch through a turn, and leave the ticket
    // open-with-reworkRound — the state that routes `reject` to _taskRejectFollowUp
    // rather than to a second reopen.
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    assert.strictEqual(s._specUnconfirmed, null, 'ENTER: the rejection latch must be retired first');
    const t = world.tickets().find((x) => x.id === 't1');
    assert.strictEqual(t.state, 'open', 'ENTER: the rejection must have reopened the ticket');
    assert.ok(Number(t.reworkRound) > 0,
      'ENTER: reworkRound must be set — it is what routes the next reject to the FOLLOW-UP path, and without it '
      + 'this test exercises the reopen path the test above already covers');

    app.m._handleTask(lead, { type: 'task', sub: 'reject', who: null, id: 't1', body: 'ALSO FIX THE LATCH' });
    const got = await settled(app, 'team-hand', /ALSO FIX THE LATCH/);
    assert.match(got, /more must-fixes/,
      'ENTER: this must be the FOLLOW-UP delivery, not a second reopen — they are different call sites and only '
      + 'one of them is under test here');
    assert.ok(s._specUnconfirmed,
      'the follow-up must arm too: a seat that never sees its second set of must-fixes is in exactly the state '
      + 'this ticket describes, holding a closed premise with the sweep calling it stalled');
    assert.strictEqual(s._specUnconfirmed.kind, 'redirect', 'and as a redirect');
    assert.strictEqual(s._specUnconfirmed.label, 'more must-fixes',
      'labelled as the follow-up, so the escalation names what was actually lost rather than a generic rejection');
  } finally { app.stop(); }
});

test('t387: the LOOP rejection path arms the same latch', async () => {
  const world = mkWorld();
  const { app, s } = await dispatched(world);
  try {
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    assert.strictEqual(s._specUnconfirmed, null, 'ENTER: the spec latch must be retired first');

    const r = app.m._rejectTicketFromLoop(world.team, 't1', 'SUITE RED: three failures');
    assert.ok(r && r.ok, `ENTER: the loop rejection must have succeeded (${r && r.error})`);
    const got = await settled(app, 'team-hand', /SUITE RED/);
    assert.match(got, /SUITE RED: three failures/, 'ENTER: the rework must have been written to the seat');
    assert.ok(s._specUnconfirmed,
      'the loop rejection must arm too — it is the path that fires unattended, so a seat that never sees it '
      + 'keeps working the branch the suite just rejected with nobody watching');
    assert.strictEqual(s._specUnconfirmed.kind, 'redirect', 'and as a redirect');
  } finally { app.stop(); }
});

// The redelivery is marked for the same reason a spec REPLAY is: the seat may be
// holding an unsubmitted copy of the first write, and nothing else in the text
// distinguishes a second delivery from a second, different rejection. The FIRST
// delivery must not carry the marker — a seat told "you already saw this" the
// first time is being lied to.
test('t387: the redirect marker rides the redelivery only, and the first copy is unchanged', async () => {
  const world = mkWorld();
  const { app, s } = await redirected(world);
  try {
    const first = app.seen('team-hand');
    assert.doesNotMatch(first, /REDELIVERY/,
      'the FIRST rejection must not be marked as a redelivery — this is the mutant of building both copies with '
      + 'the replay head, and it tells a seat it has already seen must-fixes that are new');
    assert.match(first, /\[ticket t1 rejected\]/,
      'ENTER: the first copy keeps the bytes it had before the latch existed, so the label the escalation and '
      + 'the redelivery both reuse is the one the seat actually saw');
    assert.match(first, /CLOSE WITH: \[agent:task done t1\]/,
      'and the close verb still rides it — rework closes the ticket a second time');

    fireConfirm(app, s);
    const after = await settled(app, 'team-hand', /REDELIVERY/);
    const second = after.slice(first.length);
    assert.match(second, /already sent to you once/,
      'the redelivery must say so in the text, not just in a tag — over the spill threshold the tag is all the '
      + 'seat sees before deciding to read, but the body is what it acts on');
    assert.match(second, /CLOSE WITH: \[agent:task done t1\]/,
      'and the redelivery carries the close verb too — it is a full replacement copy, not a pointer to the first');
  } finally { app.stop(); }
});

test('t387: a redirect latch and its timer are dropped when the seat dies', async () => {
  const world = mkWorld();
  const { app, s } = await redirected(world);
  try {
    assert.ok(s._specUnconfirmed && s._specConfirmTimer,
      'ENTER: both the latch and its timer must be live, or the cleanup assertion below is vacuous');
    // The redirect kind reuses _specConfirmTimer precisely so it lands in
    // _cleanup's existing clearTimeout list. Asserted rather than assumed: a
    // future second timer field would leave a 90s timer firing at a dead session.
    app.m._cleanup('team-hand');
    assert.ok(!app.m.sessions.get('team-hand'), 'ENTER: cleanup must have removed the session');
    fireConfirm(app, s);
    assert.doesNotThrow(() => app.m._checkSpecConfirm(s),
      'a check running against a cleaned-up session must not throw into the host timer');
  } finally { app.stop(); }
});

// t410 — the stamp rides the WRITE, and the queue's gates put that up to
// INJECT_QUIET_MAXWAIT (5min) after the replay decided. Reassignment is the
// documented recovery for a silent seat, so a hand-off landing inside that window
// is the reachable case, not a theoretical one — and a stamp taken at the far end
// of it names seat A against a pin that now names B. Nothing self-heals it:
// _repinTicketToSeat bails on pinned-and-live.
//
// The deferral is REAL here, not simulated by calling the hook late: the claude
// queue's ready gate blocks on _bootReadySeen, this seat never announces until the
// emit below, and the reassignment happens while the write is still sitting in that
// loop. A test that merely invoked the stamp after a reassignment would pass
// against a guard placed anywhere, including one the queue can never reach.
test('a reassignment inside the deferral window is not overwritten by the late stamp', async () => {
  const world = mkWorld();
  // Dispatched to the ROLE with no hand live, so it goes out UNDELIVERED and
  // unstamped — the ordinary way a ticket reaches a later process with a bare
  // record, and the only setup where "no stamp for A" is a statement about this
  // process rather than about an earlier one's leftovers.
  const app1 = boot(world);
  const lead1 = await app1.spawn('lead');
  app1.m._handleTask(lead1, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\ntasks/widget/SPEC.md\nstep one' });
  app1.m._handleTask(lead1, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const filed = world.tickets().find((t) => t.id === 't1');
  assert.strictEqual(filed.state, 'open', 'ENTER: minted open');
  assert.ok(filed.startedAt, 'ENTER: and STARTED — an unstarted ticket is not replayed at all, so the '
    + 'interleaving below would never begin');
  assert.strictEqual(filed.deliveredTo == null, true,
    'ENTER: and carries no stamp, or the absence asserted at the end would be inherited rather than proven');
  app1.stop();

  // Both caps far away: the fallback and the boot drain must not fire during this
  // test, so the ONLY thing that releases the queued write is the emit below —
  // which is what makes the reassignment land strictly inside the window.
  const app2 = boot(world, { deps: { INJECT_BOOT_MAXWAIT: 60_000, bootDrainSettleMs: 60_000 } });
  try {
    const lead2 = await app2.spawn('lead');
    const a = await app2.spawn('team-hand-1');
    await app2.spawn('team-hand-2');
    app2.m._replayTicketsOnce(a);

    // The write is committed to the queue and STUCK in its ready loop. Asserted
    // positively in both directions: something is pending, and nothing has been
    // written or stamped — an assertion about a reassignment racing a write says
    // nothing if there is no write in flight to race.
    assert.ok(a._injectPtyQueue && a._injectPtyQueue.length > 0,
      'ENTER: the replay must have enqueued a delivery, or there is no deferred write to interleave with');
    assert.doesNotMatch(app2.seen('team-hand-1'), /BUILD THE WIDGET/,
      'ENTER: and it must not have reached the PTY yet — the ready gate is what holds it');
    assert.strictEqual(world.tickets().find((t) => t.id === 't1').deliveredTo == null, true,
      'ENTER: nor stamped yet, since the stamp rides that write');

    // The operator reassigns while the bytes are still in the loop.
    app2.m._handleTask(lead2, { type: 'task', sub: 'assign', who: 'team-hand-2', id: 't1', body: '' });
    assert.strictEqual(world.tickets().find((t) => t.id === 't1').assignee, 'team-hand-2',
      'ENTER: the reassignment must have landed, or the guard under test is never reached');

    // Release the gate: A's queued write now goes out, and its stamp hook fires
    // against a record naming B.
    app2.emit('team-hand-1', '\x1b[?2004h');
    const got = await settled(app2, 'team-hand-1', /BUILD THE WIDGET/);
    assert.match(got, /BUILD THE WIDGET/,
      'ENTER: the deferred write must actually land at A — if the delivery were dropped instead, the missing '
      + 'stamp below would be proving nothing about the guard');

    const t = world.tickets().find((x) => x.id === 't1');
    assert.strictEqual(t.assignee, 'team-hand-2',
      'the record still names the seat the operator moved it to');
    assert.strictEqual(t.deliveredTo == null, true,
      'and carries NO stamp: a write-time stamp taken after the reassignment records a delivery to a seat the '
      + 'ticket is no longer assigned to, and nothing later reconciles the two — the unstamped record simply '
      + 'replays again, which is the safe failure');
  } finally { app2.stop(); }
});

// ── t357: a second dispatch to one seat destroys the first ticket's draft ─────
//
// The two halves of the damage land in the same instant and neither is visible
// from outside: t2's injection leads with Ctrl-U, which clears t1's unsubmitted
// spec out of the composer, and t2's arm REPLACES t1's latch, which was the only
// thing watching for it. What remains is the stall watchdog, and it reports the
// seat as STALLED on a ticket the seat was never told about — the exact
// misreading _checkSpecConfirm's escalation exists to retire.
//
// Fire the drain at a moment the test chooses, cancelling the production timer
// first so it cannot also fire and turn a one-shot redelivery into two.
function fireOwed(app, s) {
  clearTimeout(s._specOwedTimer);
  s._specOwedTimer = null;
  app.m._drainOwedSpec(s);
}

// An injected unit is three writes (Ctrl-U, text, Enter) and `settled` returns on
// the middle one. A test that baselines the PTY straight after a redelivery would
// therefore baseline it mid-unit, and the trailing Enter landing a tick later
// reads as "a further copy was written" — a flake that fails on a loaded box and
// says nothing about the code.
async function writeComplete(app, name, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (app.seen(name).endsWith('\r')) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`ENTER: the write to ${name} never completed, so a baseline taken here is mid-unit`);
}

// A second ticket dispatched to the SAME seat while t1's latch is still live.
// Returns with t1 displaced and t2 holding the slot.
async function collided(world, opts = {}) {
  const { app, s, lead } = await dispatched(world, opts);
  app.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'PAINT THE FRAME\ntasks/frame/SPEC.md\nstep one' });
  app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  const got = await settled(app, 'team-hand', /PAINT THE FRAME/);
  assert.match(got, /PAINT THE FRAME/,
    'ENTER: the SECOND dispatch must actually have been written — with no second write there is no Ctrl-U, no '
    + 'displacement, and every assertion below is about a collision that never happened');
  assert.ok(s._specUnconfirmed && s._specUnconfirmed.ticketId === 't2',
    'ENTER: the slot must now hold t2 — if t1 were still in it nothing was displaced and the queue under test '
    + 'is never reached');
  // Same reason `dispatched` waits: the tests below baseline the PTY and assert
  // it is UNCHANGED, and a baseline taken mid-unit sees the trailing Enter land a
  // tick later as a write this fix did not make.
  await writeComplete(app, 'team-hand');
  return { app, s, lead };
}

test('t357: a spec displaced by a second dispatch is redelivered, not left for the stall watchdog', async () => {
  const world = mkWorld();
  const { app, s } = await collided(world);
  try {
    // The positive half: the loss is KNOWN at the moment of the second write, so
    // it is queued there rather than watched for.
    assert.deepStrictEqual((s._specOwed || []).map((o) => `${o.ticketId}:${o.kind}`), ['t1:spec'],
      'ENTER: t1 must be recorded as owed — an empty queue makes the redelivery below unreachable and every '
      + 'assertion in this file about serialization vacuous');

    // The seat takes its turn on t2 and comes back. The turn retires the live
    // latch (until it does, the drain must not write — that is the serialization
    // test below); the return to idle is what makes the redelivery an INJECTION
    // rather than a park, which is what this test observes at the PTY.
    app.m._emitActivity('team-hand', 'thinking');
    assert.strictEqual(s._specUnconfirmed, null, 'ENTER: t2`s latch must be retired before the drain can run');
    app.m._emitActivity('team-hand', 'idle');

    const before = app.seen('team-hand');
    fireOwed(app, s);
    const after = await settled(app, 'team-hand', /REPLAY[\s\S]*BUILD THE WIDGET/);
    assert.ok(after.length > before.length,
      'ENTER: the redelivery must be a NEW write, not a re-read of the first copy still sitting in the buffer');
    assert.match(after.slice(before.length), /BUILD THE WIDGET/,
      'the displaced ticket`s spec must reach the seat again — its first copy was destroyed by the Ctrl-U that '
      + 'led the second dispatch, and nothing else in the system knows that happened');
    assert.match(after.slice(before.length), /REPLAY/,
      'and it must be marked a REPLAY: the seat may be holding an unsubmitted copy, and read as a fresh '
      + 'assignment it would start the ticket twice');
    assert.deepStrictEqual(s._specOwed, [], 'the queue is drained');
  } finally { app.stop(); }
});

test('t357: the drain is SERIAL — nothing is redelivered while a latch is still live', async () => {
  const world = mkWorld();
  const { app, s } = await collided(world);
  try {
    assert.ok(s._specUnconfirmed && s._specUnconfirmed.ticketId === 't2',
      'ENTER: t2`s latch must still be live — with the slot empty the drain is free to run and this test '
      + 'measures nothing');
    assert.deepStrictEqual((s._specOwed || []).map((o) => o.ticketId), ['t1'],
      'ENTER: and t1 must be owed, or the refusal below is a refusal to do nothing');

    const before = app.seen('team-hand');
    fireOwed(app, s);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('team-hand'), before,
      'a redelivery here would put a second Ctrl-U in flight against a composer that already holds an '
      + 'unconfirmed write — reproducing the exact collision this fix exists to repair');
    // The positive half of that silence: it WAITED, it did not drop the ticket.
    assert.deepStrictEqual((s._specOwed || []).map((o) => o.ticketId), ['t1'],
      'and the owed ticket is still queued — a drain that refused by DISCARDING would also be silent here, and '
      + 'would lose the very spec this mechanism is redelivering');
    assert.ok(s._specOwedTimer, 'and the drain re-armed, so the wait ends when the latch does');
  } finally { app.stop(); }
});

test('t357: a displaced ticket displaced AGAIN after its redelivery escalates rather than looping', async () => {
  const world = mkWorld();
  const { app, s } = await collided(world);
  try {
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    fireOwed(app, s);
    await settled(app, 'team-hand', /REPLAY[\s\S]*BUILD THE WIDGET/);
    await writeComplete(app, 'team-hand');
    assert.ok(s._specOwedSpent && s._specOwedSpent.has('t1:spec'),
      'ENTER: t1`s one redelivery must be recorded as spent, or the bound under test does not exist yet');
    assert.doesNotMatch(app.seen('lead'), /ESCALATED/,
      'ENTER: the lead must not already hold an escalation, or `settled` below returns text this test did not cause');

    // A third dispatch displaces the redelivered copy. The budget is gone, so this
    // must reach the LEAD rather than queueing a third write at the seat.
    const beforeSeat = app.seen('team-hand');
    const beforeLead = app.seen('lead');
    app.m._armSpecConfirm('team-hand', 't2', 'injected');
    assert.deepStrictEqual(s._specOwed || [], [],
      'the exhausted ticket must NOT re-enter the queue — an unbounded requeue redelivers forever, spraying a '
      + 'live composer, which is worse than the loss it is repairing');
    const leadSaw = await settled(app, 'lead', /ESCALATED/);
    assert.ok(leadSaw.length > beforeLead.length,
      'ENTER: the escalation must be a new write to the lead, not text already in its buffer');
    assert.match(leadSaw, /t1/, 'and it must name the ticket that was lost');
    assert.strictEqual(app.seen('team-hand'), beforeSeat,
      'and no third copy went to the seat: two writes with no turn is not a lost write, and a third would not '
      + 'fix it');
  } finally { app.stop(); }
});

test('t357: a displaced ticket that CLOSED while it waited is dropped, not redelivered', async () => {
  const world = mkWorld();
  const { app, s } = await collided(world);
  try {
    assert.deepStrictEqual((s._specOwed || []).map((o) => o.ticketId), ['t1'],
      'ENTER: t1 must be owed — with an empty queue "nothing was redelivered" is true of every implementation');
    // Back to IDLE, not left `thinking`. A busy seat's delivery PARKS to disk
    // (_maybeParkDelivery) and never reaches the PTY, so a buffer assertion taken
    // against a thinking seat holds whether or not the closed-ticket check exists
    // — it would be measuring the park gate, not this drop.
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    const all = world.tickets();
    all.find((t) => t.id === 't1').state = 'done';
    world.tstore.save(world.team.root, all);

    const before = app.seen('team-hand');
    fireOwed(app, s);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('team-hand'), before,
      'a closed ticket has nothing left to redeliver — writing its spec back to the seat would re-task it with '
      + 'work it has already finished');
    // Belt and braces on the same claim: "nothing reached the PTY" is equally
    // true of a delivery that went to the park instead, and that is precisely the
    // ambiguity this helper exists for.
    assert.strictEqual(app.parked('team-hand', /BUILD THE WIDGET/), 0,
      'and it was not parked either — a park is a durable delivery the seat drains later, so a redelivery that '
      + 'merely took the other route would re-task it just the same, one turn later');
    assert.deepStrictEqual(s._specOwed, [],
      'and the entry is CONSUMED rather than left queued: a drop that re-armed instead would re-run this drain '
      + 'against the same dead ticket forever');
  } finally { app.stop(); }
});

// The drain's own serialization hole, closed by `_specOwedInFlight`. A live latch
// is not the only thing that owns the composer: `queued` means the bytes are in
// the ready loop, and INJECT_QUIET_MAXWAIT (5 min) is far longer than the 90s
// re-arm — so a redelivery still waiting in the gates has armed no latch, and a
// second drain behind it puts two Ctrl-U's in flight. That is the collision this
// mechanism repairs, reproduced by its own fix.
test('t357: a second owed entry is not drained behind a redelivery that is queued but unwritten', async () => {
  const world = mkWorld();
  // The gate is held OPEN-ended: the queue polls a ready latch a fake PTY never
  // sets, so the first redelivery stays enqueued and unwritten for the whole test
  // — exactly the window the flag exists to cover.
  // bootDrainSettleMs 0: with INJECT_BOOT_MAXWAIT stretched to 60s the replay
  // one-shot is spent only by the boot drain, whose 750ms default runs against
  // `replayPassed`'s 2s budget. Failure there would be loud rather than silent,
  // but the window is free to remove.
  const { app, s, lead } = await collided(world, {
    bootReady: true, deps: { INJECT_BOOT_MAXWAIT: 60_000, bootDrainSettleMs: 0 },
  });
  try {
    app.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'GLAZE THE PANE\ntasks/pane/SPEC.md\nstep one' });
    app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't3', body: '' });
    await settled(app, 'team-hand', /GLAZE THE PANE/);
    await writeComplete(app, 'team-hand');
    assert.deepStrictEqual((s._specOwed || []).map((o) => o.ticketId), ['t1', 't2'],
      'ENTER: TWO tickets must be owed — with one entry there is no second drain to refuse and this test is vacuous');

    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    s._bootReadySeen = false;                       // hold the write in the gates
    fireOwed(app, s);
    assert.strictEqual(s._specOwedInFlight, true,
      'ENTER: the first redelivery must be IN FLIGHT — if it already wrote, the second drain below is not the '
      + 'pre-write window under test');
    assert.deepStrictEqual((s._specOwed || []).map((o) => o.ticketId), ['t2'],
      'ENTER: and only the second entry may remain queued');

    const before = app.seen('team-hand');
    fireOwed(app, s);
    await new Promise((r) => setTimeout(r, 40));
    // Kept for shape, but it is NOT what pins this test: the ready gate is held
    // open, so nothing could reach the PTY either way. The load-bearing assertion
    // is the next one — t2 still QUEUED is what distinguishes a drain that waited
    // from one that ran.
    assert.strictEqual(app.seen('team-hand'), before,
      'the second entry must NOT be drained behind a redelivery that has not been written: two units in flight is '
      + 'two Ctrl-U`s, and the second destroys the first`s draft — the exact defect this ticket repairs');
    assert.deepStrictEqual((s._specOwed || []).map((o) => o.ticketId), ['t2'],
      'and it is still QUEUED rather than discarded — a refusal that dropped it would be silent in the same way');
    assert.ok(s._specOwedTimer, 'and re-armed, so the wait ends when the write does');
  } finally { app.stop(); }
});

// The trap in the mitigation: onWrite fires for a PARKED disposition too. Clearing
// the flag only on `injected` latches the drain shut for the life of the seat, and
// every later owed entry is stranded in silence — strictly worse than the bug.
test('t357: a PARKED redelivery still releases the drain, so later owed entries are not stranded', async () => {
  const world = mkWorld();
  const { app, s, lead } = await collided(world);
  try {
    app.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'GLAZE THE PANE\ntasks/pane/SPEC.md\nstep one' });
    app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't3', body: '' });
    await settled(app, 'team-hand', /GLAZE THE PANE/);
    await writeComplete(app, 'team-hand');
    assert.deepStrictEqual((s._specOwed || []).map((o) => o.ticketId), ['t1', 't2'],
      'ENTER: two tickets owed, or there is no "later entry" to strand');

    // Busy seat ⇒ the redelivery PARKS rather than injecting.
    app.m._emitActivity('team-hand', 'thinking');
    s._specUnconfirmed = null;
    fireOwed(app, s);
    for (let i = 0; i < 200 && app.parked('team-hand', /BUILD THE WIDGET/) === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.strictEqual(app.parked('team-hand', /BUILD THE WIDGET/), 1,
      'ENTER: the redelivery must really have PARKED — if it injected instead, this test never exercises the '
      + 'parked disposition and the trap it guards goes unmeasured');

    assert.strictEqual(s._specOwedInFlight, false,
      'a parked redelivery is durable and arms no latch, so nothing else would ever clear the in-flight flag — '
      + 'left set, it latches the drain shut for the life of the seat');
    // The consequence, asserted positively rather than as a flag read: the NEXT
    // owed entry still drains.
    app.m._emitActivity('team-hand', 'idle');
    fireOwed(app, s);
    const after = await settled(app, 'team-hand', /REPLAY[\s\S]*PAINT THE FRAME/);
    assert.match(after, /PAINT THE FRAME/,
      'and the later owed entry is still delivered — stranding it would be strictly worse than the loss this '
      + 'mechanism repairs, because nothing downstream would ever report it');
  } finally { app.stop(); }
});

// A transient team-resolution failure must not consume the entry. The shift used
// to sit above resolveTeam, so a throw there dropped the ticket on the floor with
// no timer left — handing it back to the stall watchdog, which is the "stalled
// seat" misdiagnosis this whole ticket exists to retire.
test('t357: a transient resolveTeam failure leaves the owed ticket QUEUED, not discarded', async () => {
  const world = mkWorld();
  let broken = false;
  const { app, s } = await collided(world, {
    deps: { resolveTeam: () => { if (broken) throw new Error('transient'); return world.team; } },
  });
  try {
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    assert.deepStrictEqual((s._specOwed || []).map((o) => o.ticketId), ['t1'],
      'ENTER: t1 must be owed before the failure, or "it survived" is vacuous');

    broken = true;
    const before = app.seen('team-hand');
    fireOwed(app, s);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('team-hand'), before, 'nothing can be delivered without a team to resolve it');
    assert.deepStrictEqual((s._specOwed || []).map((o) => o.ticketId), ['t1'],
      'the entry must SURVIVE the failure: consuming it here drops the ticket silently and leaves the seat to be '
      + 'reported as stalled on work it was never told about');
    assert.ok(s._specOwedTimer,
      'and the timer must be re-armed, or the surviving entry is never looked at again — queued forever is the '
      + 'same loss with an extra step');

    // And it really does recover once resolution works again — the positive half.
    broken = false;
    fireOwed(app, s);
    const after = await settled(app, 'team-hand', /REPLAY[\s\S]*BUILD THE WIDGET/);
    assert.match(after, /BUILD THE WIDGET/, 'the retry delivers what the transient failure deferred');
  } finally { app.stop(); }
});

// ── t448: the three gaps review r2 found in the displaced-spec drain ──────────

// GAP 1. The drain reused _checkSpecConfirm's state and holder checks but not its
// FIRST guard, the transcript re-probe. A wire-routed seat's `turn.started` edge
// can beat the CLI's append: _emitActivity's probe answers `false`, the latch
// stays armed over a spec the seat DID consume, and the seat returns to idle —
// the idle edge never re-probes. A later dispatch then displaces that latch, and
// the drain redelivers a spec the seat is already holding.
test('t448: the drain re-probes the transcript, so a spec the seat already consumed is not redelivered', async () => {
  const world = mkWorld();
  const { app, s } = await collided(world);
  try {
    // The turn is taken with NO transcript, which is how the collision fixture
    // already clears t2's latch (an unanswerable probe trusts the turn). The
    // transcript is written AFTER, so this is the CLI catching up late — the race
    // itself — rather than a seat that was readable all along.
    app.m._emitActivity('team-hand', 'thinking');
    assert.strictEqual(s._specUnconfirmed, null, 'ENTER: t2`s latch must be retired or the drain refuses to run at all');
    app.m._emitActivity('team-hand', 'idle');

    const owed = (s._specOwed || [])[0];
    assert.ok(owed && `${owed.ticketId}:${owed.kind}` === 't1:spec',
      'ENTER: t1 must be the owed entry — the drain reads THIS snapshot`s `since`, so a different row here would '
      + 'anchor the probe somewhere the assertions below say nothing about');
    app.transcript('team-hand', '{"role":"user","content":"[ticket t1] close with [agent:task done t1]"}\n');
    assert.strictEqual(app.m._seatTranscriptHas('team-hand', 't1', owed.since), true,
      'ENTER: the probe must answer a definite YES at the snapshot`s own anchor — `false` or `null` here and this '
      + 'test would be asserting the absence of a redelivery the drain was never going to make');

    const before = app.seen('team-hand');
    fireOwed(app, s);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('team-hand'), before,
      'a spec the transcript proves the seat consumed must NOT be redelivered: the seat is holding it and working '
      + 'it, and a second copy arrives as a fresh-looking REPLAY of work already under way');
    assert.strictEqual(app.parked('team-hand', /BUILD THE WIDGET/), 0,
      'and it must not have PARKED either — a park is a durable delivery the seat drains a turn later, so '
      + '"nothing reached the PTY" alone cannot tell a drop from a deferred duplicate');
    assert.deepStrictEqual(s._specOwed, [],
      'and the entry is consumed rather than left to fire again — the drop is a decision, not a deferral');
  } finally { app.stop(); }
});

// The other side of the same guard, and the reason it is `=== true` rather than a
// truthy test. `false` is a POSITIVE finding — transcript readable, this write not
// in it — which is the seat that really did lose the spec. (`null`, the probe that
// cannot answer at all, is pinned by the plain redelivery test above: that fixture
// has no transcript, so a guard reading `!== false` would drop there instead.)
test('t448: a readable transcript WITHOUT the marker still gets its redelivery', async () => {
  const world = mkWorld();
  const { app, s } = await collided(world);
  try {
    app.m._emitActivity('team-hand', 'thinking');
    assert.strictEqual(s._specUnconfirmed, null, 'ENTER: t2`s latch must be retired before the drain can run');
    app.m._emitActivity('team-hand', 'idle');

    const owed = (s._specOwed || [])[0];
    assert.ok(owed && owed.ticketId === 't1', 'ENTER: t1 must be the owed entry');
    // A turn over something else entirely — the transcript is readable, and t1 is
    // demonstrably not in it.
    app.transcript('team-hand', '{"role":"user","content":"[agent:from team] roster: lead clodex"}\n');
    assert.strictEqual(app.m._seatTranscriptHas('team-hand', 't1', owed.since), false,
      'ENTER: the probe must answer a definite NO — an unreadable transcript would return null and exercise the '
      + 'other branch, leaving the distinction this test exists for unmeasured');

    // Sliced past a baseline, not matched against the whole buffer: t1's FIRST
    // copy is still sitting in there from the fixture, so a whole-buffer match is
    // true whether or not the drain redelivered anything — it would pass against a
    // guard that dropped this entry, which is the mutant this test exists to kill.
    const before = app.seen('team-hand');
    fireOwed(app, s);
    const after = await settled(app, 'team-hand', /REPLAY[\s\S]*BUILD THE WIDGET/);
    assert.ok(after.length > before.length,
      'ENTER: the redelivery must be a NEW write — no growth here and the match below is reading the first copy');
    assert.match(after.slice(before.length), /BUILD THE WIDGET/,
      'a probe that can read the transcript and does not find the spec there is the seat that genuinely lost it — '
      + 'collapsing that with a definite YES would let a readable transcript swallow every real redelivery');
  } finally { app.stop(); }
});

// GAP 2. The composite onWrite hook arms first and calls the caller's hook second.
// Un-guarded, an arm that throws skips the caller's hook — and for the drain that
// hook is the ONLY release of `_specOwedInFlight`, so the flag stays set for the
// life of the seat and every later owed entry is stranded in silence. That is the
// outcome _drainOwedSpec's own comment calls strictly worse than the bug it guards.
//
// The throw is injected AT the arm rather than at its production source
// (`_broadcast` inside `_oweDisplacedSpec`), which would need a latch displaced at
// the redelivery's own write instant. What is under test is the hook's ordering
// guarantee — arm first, release always — not which call inside the arm threw.
test('t448: an arm that THROWS still releases the drain`s in-flight flag', async () => {
  const world = mkWorld();
  const { app, s, lead } = await collided(world);
  try {
    app.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'GLAZE THE PANE\ntasks/pane/SPEC.md\nstep one' });
    app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't3', body: '' });
    await settled(app, 'team-hand', /GLAZE THE PANE/);
    await writeComplete(app, 'team-hand');
    assert.deepStrictEqual((s._specOwed || []).map((o) => o.ticketId), ['t1', 't2'],
      'ENTER: TWO tickets must be owed — with one entry there is no LATER entry for a stranded flag to strand, '
      + 'and the consequence half of this test is unreachable');

    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');

    const real = app.m._armSpecConfirm;
    let armCalls = 0;
    app.m._armSpecConfirm = () => { armCalls++; throw new Error('arm exploded'); };
    fireOwed(app, s);
    assert.strictEqual(s._specOwedInFlight, true,
      'ENTER: the redelivery must actually be IN FLIGHT — the flag is set synchronously and released from the '
      + 'write, so if it were already false here the release below would be proving nothing');

    for (let i = 0; i < 400 && s._specOwedInFlight; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(armCalls > 0,
      'ENTER: the arm must really have been reached and thrown — an unreached arm leaves the flag released for '
      + 'the ordinary reason and this test never exercises the guard');
    assert.strictEqual(s._specOwedInFlight, false,
      'the in-flight flag must be released even when the arm throws: it is the drain`s only gate, and left set it '
      + 'latches the drain shut for the life of the seat — a self-inflicted permanent stall');

    // The consequence, asserted positively rather than as a flag read: the next
    // owed entry still drains.
    app.m._armSpecConfirm = real;
    // Baselined and sliced, like the other four. `settled` does not assert — it
    // returns the whole buffer after a timeout — and t2's ORIGINAL dispatch text
    // is already in there from the `collided` fixture, so a whole-buffer match on
    // PAINT THE FRAME passes whether or not this drain ever wrote.
    const before2 = app.seen('team-hand');
    fireOwed(app, s);
    const after = await settled(app, 'team-hand', /REPLAY[\s\S]*PAINT THE FRAME/);
    assert.ok(after.length > before2.length,
      'ENTER: the second redelivery must be a NEW write — no growth and the match below is reading t2`s first copy');
    assert.match(after.slice(before2.length), /PAINT THE FRAME/,
      'and the later owed entry is still delivered — stranding it would be strictly worse than the loss this '
      + 'mechanism repairs, because nothing downstream would ever report it');
  } finally { app.stop(); }
});

// GAP 3. The REDIRECT arm of the drain — `_deliverRedirectReplay(..., onWrite)`,
// the one signature round 2 changed — had no test at all. A displaced rejection
// must reach the seat again AND release the in-flight flag on that path, or the
// drain latches shut for the seat exactly as it would on the spec arm.
test('t448: a displaced REDIRECT is redelivered and releases the drain', async () => {
  const world = mkWorld();
  const { app, s, lead } = await redirected(world);
  try {
    assert.strictEqual(s._specUnconfirmed && s._specUnconfirmed.kind, 'redirect',
      'ENTER: the live latch must be the REDIRECT one — displacing a spec latch here would queue `t1:spec` and '
      + 'every assertion below would be reading the spec arm this test does not cover');

    // A second dispatch to the same seat: its leading Ctrl-U destroys the
    // rejection's draft and its arm replaces the redirect latch.
    app.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'PAINT THE FRAME\ntasks/frame/SPEC.md\nstep one' });
    app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
    await settled(app, 'team-hand', /PAINT THE FRAME/);
    await writeComplete(app, 'team-hand');
    assert.deepStrictEqual((s._specOwed || []).map((o) => `${o.ticketId}:${o.kind}`), ['t1:redirect'],
      'ENTER: the owed entry must be the REDIRECT kind — the kind is what selects _deliverRedirectReplay over '
      + '_deliverTicketSpec, so a `t1:spec` row here would drain through the arm that is already covered');

    app.m._emitActivity('team-hand', 'thinking');
    assert.strictEqual(s._specUnconfirmed, null, 'ENTER: t2`s latch must be retired before the drain can run');
    app.m._emitActivity('team-hand', 'idle');

    const before = app.seen('team-hand');
    fireOwed(app, s);
    const after = await settled(app, 'team-hand', /REDELIVERY/);
    assert.ok(after.length > before.length,
      'ENTER: the redelivery must be a NEW write, not a re-read of the rejection`s first copy still in the buffer');
    assert.match(after.slice(before.length), /REDELIVERY/,
      'a displaced rejection must reach the seat again — the seat is meanwhile working the version that was '
      + 'rejected, and nothing else in the system can tell a swallowed redirect from a delivered one');
    assert.match(after.slice(before.length), /FIX THE WIDGET MOUNT/,
      'and it must carry the REASON: the reason is not persisted on the ticket record, so a rebuild that '
      + 're-derived from the record would hand the seat an empty rejection');
    assert.strictEqual(s._specOwedInFlight, false,
      'and the redirect arm must release the in-flight flag exactly as the spec arm does — this is the path whose '
      + 'signature round 2 changed, and left set the flag strands every later owed entry in silence');
  } finally { app.stop(); }
});

// The same guard on the REDIRECT arm. `_deliverRedirectReplay` carries its own
// copy of the composite hook, so the ordering guarantee has to be pinned on both —
// a `finally` on one arm and a bare sequence on the other strands the flag for
// every displaced rejection while the spec arm looks correct.
test('t448: an arm that throws on the REDIRECT arm still releases the drain', async () => {
  const world = mkWorld();
  const { app, s, lead } = await redirected(world);
  try {
    assert.strictEqual(s._specUnconfirmed && s._specUnconfirmed.kind, 'redirect',
      'ENTER: the live latch must be the REDIRECT one, or the entry displaced below drains through the spec arm');
    app.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'PAINT THE FRAME\ntasks/frame/SPEC.md\nstep one' });
    app.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
    await settled(app, 'team-hand', /PAINT THE FRAME/);
    await writeComplete(app, 'team-hand');
    assert.deepStrictEqual((s._specOwed || []).map((o) => `${o.ticketId}:${o.kind}`), ['t1:redirect'],
      'ENTER: the owed entry must be the REDIRECT kind — a `t1:spec` row here exercises the other arm entirely');

    app.m._emitActivity('team-hand', 'thinking');
    assert.strictEqual(s._specUnconfirmed, null, 'ENTER: t2`s latch must be retired before the drain can run');
    app.m._emitActivity('team-hand', 'idle');

    let armCalls = 0;
    app.m._armSpecConfirm = () => { armCalls++; throw new Error('arm exploded'); };
    fireOwed(app, s);
    assert.strictEqual(s._specOwedInFlight, true,
      'ENTER: the redelivery must really be IN FLIGHT — already false here and the release below proves nothing');

    for (let i = 0; i < 400 && s._specOwedInFlight; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(armCalls > 0,
      'ENTER: the arm must have been reached and thrown, or the flag is released for the ordinary reason');
    assert.strictEqual(s._specOwedInFlight, false,
      'the redirect arm must release the in-flight flag even when the arm throws — left set it latches the drain '
      + 'shut for the life of the seat, which is worse than the displaced rejection it was repairing');
  } finally { app.stop(); }
});

// ── t447: `_specOwedSpent` is pruned on RECEIPT, so a second episode is owed its
// own redelivery ──────────────────────────────────────────────────────────────
//
// The set carries the retry bound across the latch REPLACEMENT (the redelivery
// arms a fresh latch whose `retried` is false), and t357 never removed from it —
// so it lived as long as the seat. A ticket dispatched to one seat twice over a
// long session therefore got ONE redelivery ever: the second genuine displacement
// escalated on a budget spent by an episode the seat had long since consumed.
//
// The two receipt exits are pinned SEPARATELY below because they live in
// different modules and only one of them is on the common path: a seat that
// consumes its spec normally clears the latch at the turn (_emitActivity), and
// _checkSpecConfirm's re-probe runs only when no turn did.

// Drive the seat through a turn the transcript ATTRIBUTES to `ticketId` — the
// production receipt, not a hand-cleared latch. Returns with the seat idle again.
async function received(app, s, ticketId) {
  assert.ok(s._specUnconfirmed && s._specUnconfirmed.ticketId === ticketId,
    `ENTER: ${ticketId}'s latch must be live in the slot — without it the probe below dies on a TypeError `
    + 'instead of naming the fixture mistake');
  app.transcript('team-hand', `{"role":"user","content":"[ticket ${ticketId}] close with [agent:task done ${ticketId}]"}\n`);
  assert.strictEqual(app.m._seatTranscriptHas('team-hand', ticketId, s._specUnconfirmed.since), true,
    `ENTER: the probe must answer a definite YES for ${ticketId} — anything else clears the latch through the `
    + 'blind-spot branch instead of the receipt branch, and this fixture would be testing the wrong exit');
  app.m._emitActivity('team-hand', 'thinking');
  assert.strictEqual(s._specUnconfirmed, null, `ENTER: the turn must retire ${ticketId}'s latch`);
  app.m._emitActivity('team-hand', 'idle');
}

// Poll for GROWTH past a baseline, then hand back only the new bytes. `settled`
// cannot serve here: it returns as soon as its pattern is anywhere in the buffer,
// and episode 2 redelivers the same ticket with the same REPLAY head as episode 1
// — so a `settled` match would be satisfied by episode 1's bytes and return
// before episode 2's write ever landed. Measured: it does exactly that.
async function grownSlice(app, name, before, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (app.seen(name).length > before.length && app.seen(name).endsWith('\r')) return app.seen(name).slice(before.length);
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`ENTER: nothing new was written to ${name}, so the slice below would be empty and match nothing`);
}

// A SECOND displacement episode for t1 at the same seat: the lead re-arms t1 (a
// re-`assign`, long after the first episode closed) and a further dispatch
// destroys its draft. Written through _armSpecConfirm rather than a second
// `task start` because what is under test is the spent-key read at the
// displacement instant, not the dispatch path that reaches it.
function displaceAgain(app, s) {
  app.m._armSpecConfirm('team-hand', 't1', 'injected');
  assert.ok(s._specUnconfirmed && s._specUnconfirmed.ticketId === 't1',
    'ENTER: t1 must hold the latch again — with the slot empty nothing is displaced below and the queue '
    + 'assertion reads the FIRST episode`s state');
  assert.strictEqual(s._specUnconfirmed.retried, false,
    'ENTER: and the fresh latch`s own budget must be unspent, or the escalation under test could come from '
    + '`retried` rather than from the spent SET this ticket is about');
  app.m._armSpecConfirm('team-hand', 't2', 'injected');
}

test('t447: a turn that CONFIRMS the spec ends the episode, so a later displacement is owed a redelivery', async () => {
  const world = mkWorld();
  const { app, s } = await collided(world);
  try {
    // Episode 1, in full: t1 displaced, redelivered, budget spent.
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    const before = app.seen('team-hand');
    fireOwed(app, s);
    const after = await settled(app, 'team-hand', /REPLAY[\s\S]*BUILD THE WIDGET/);
    assert.ok(after.length > before.length,
      'ENTER: episode 1`s redelivery must be a NEW write — without it nothing spends the budget and the prune '
      + 'below has nothing to remove, making every assertion here true of the unfixed code');
    await writeComplete(app, 'team-hand');
    assert.ok(s._specOwedSpent && s._specOwedSpent.has('t1:spec'),
      'ENTER: the budget must be recorded as spent, or the pruning under test is unreachable');
    assert.ok(s._specUnconfirmed && s._specUnconfirmed.ticketId === 't1',
      'ENTER: the redelivery must have armed a FRESH t1 latch — that latch is what the receipt below confirms');

    // The seat consumes it. THIS is the end of the episode.
    await received(app, s, 't1');
    assert.ok(!(s._specOwedSpent && s._specOwedSpent.has('t1:spec')),
      'a confirmed turn is proof the seat holds the spec, which closes the episode: the spent key must not '
      + 'outlive it, or the next genuine loss of this ticket is denied the redelivery it is owed');

    // Episode 2, much later: t1 is re-assigned and displaced again.
    const beforeSeat = app.seen('team-hand');
    const beforeLead = app.seen('lead');
    displaceAgain(app, s);
    assert.deepStrictEqual((s._specOwed || []).map((o) => `${o.ticketId}:${o.kind}`), ['t1:spec'],
      'a NEW episode destroys a NEW draft, so it is owed its own redelivery — escalating here reports a loss '
      + 'the mechanism could have repaired, on a budget that was spent by an episode the seat already consumed');

    // And the queue really drains it — the entry is not merely parked in a list.
    // Through a REAL receipt on t2, not a bare `thinking` edge: t2's latch is live
    // and the drain refuses (correctly) while it is, and an unattributed turn does
    // not clear it — so a fixture that skipped this would read the drain's
    // serialization refusal as a missing redelivery.
    await received(app, s, 't2');
    fireOwed(app, s);
    const fresh = await grownSlice(app, 'team-hand', beforeSeat);
    assert.match(fresh, /REPLAY[\s\S]*BUILD THE WIDGET/,
      'and the second episode`s redelivery reaches the PTY as a NEW write carrying t1`s spec, not just a queue '
      + 'entry — sliced past the baseline because episode 1 put the identical text in this buffer already');
    assert.strictEqual(app.seen('lead'), beforeLead,
      'and the lead was not escalated to: this loss was repaired, and reporting it as unrepairable is the '
      + 'defect under test');
  } finally { app.stop(); }
});

test('t447: the DEADLINE re-probe ends the episode too, for a seat whose turn never cleared the latch', async () => {
  const world = mkWorld();
  const { app, s } = await collided(world);
  try {
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    const before = app.seen('team-hand');
    fireOwed(app, s);
    const after = await settled(app, 'team-hand', /REPLAY[\s\S]*BUILD THE WIDGET/);
    assert.ok(after.length > before.length,
      'ENTER: the redelivery must be a NEW write, or nothing spends the budget this test prunes');
    await writeComplete(app, 'team-hand');
    assert.ok(s._specOwedSpent && s._specOwedSpent.has('t1:spec'),
      'ENTER: the budget must be spent before the re-probe, or the prune has nothing to remove');

    // The wire-routed race: the seat DID consume it, but no attributable edge ever
    // cleared the latch, so the deadline re-probe is the only exit that sees the
    // receipt. Deliberately NOT through _emitActivity — that is the other test's
    // line, and a fixture that touched it here would leave neither line isolated.
    app.transcript('team-hand', '{"role":"user","content":"[ticket t1] close with [agent:task done t1]"}\n');
    assert.strictEqual(app.m._seatTranscriptHas('team-hand', 't1', s._specUnconfirmed.since), true,
      'ENTER: the probe must answer a definite YES — a `false` here walks into the redelivery arm and this test '
      + 'measures the wrong exit entirely');
    app.m._checkSpecConfirm(s);
    assert.strictEqual(s._specUnconfirmed, null,
      'ENTER: the re-probe must have taken its receipt exit — any other exit leaves the latch and this is not '
      + 'the path under test');
    assert.ok(!(s._specOwedSpent && s._specOwedSpent.has('t1:spec')),
      'the deadline re-probe is receipt just as much as the turn is, and a seat whose activity edge raced the '
      + 'transcript reaches its confirmation ONLY here — pruning at the other exit alone leaves this population '
      + 'with the unpruned bug');

    const beforeLead = app.seen('lead');
    displaceAgain(app, s);
    assert.deepStrictEqual((s._specOwed || []).map((o) => `${o.ticketId}:${o.kind}`), ['t1:spec'],
      'so its next episode is queued for redelivery like anyone else`s');
    assert.strictEqual(app.seen('lead'), beforeLead,
      'and nothing was escalated on a budget the receipt released');
  } finally { app.stop(); }
});

// The whole risk of the prune, and the reason it is keyed on RECEIPT rather than
// on "the latch went away": `_specOwedSpent` exists to stop displace → redeliver →
// displace → redeliver forever, and a fix that restored per-episode redelivery by
// reopening that loop would be strictly worse than the bug — an unbounded loop
// sprays a live composer. Two further displacement rounds with NO receipt in
// between, which is the shape that loops if the escalation path prunes.
test('t447: an ESCALATION does not restore the budget — repeated displacement with no receipt still terminates', async () => {
  const world = mkWorld();
  const { app, s } = await collided(world);
  try {
    app.m._emitActivity('team-hand', 'thinking');
    app.m._emitActivity('team-hand', 'idle');
    fireOwed(app, s);
    await settled(app, 'team-hand', /REPLAY[\s\S]*BUILD THE WIDGET/);
    await writeComplete(app, 'team-hand');
    assert.ok(s._specOwedSpent && s._specOwedSpent.has('t1:spec'),
      'ENTER: round 1 must have spent the budget, or the refusals below are refusals to do nothing');

    // Round 2: displaced again, still no turn anywhere. Escalates — t357's bound.
    const seatAfterOne = app.seen('team-hand');
    app.m._armSpecConfirm('team-hand', 't2', 'injected');
    await settled(app, 'lead', /ESCALATED/);
    // `settled` returns on the unit's TEXT write; its trailing \r lands a tick
    // later. A baseline taken here would be mid-unit, and the second-escalation
    // check below would be satisfiable by one pending byte of the first.
    await writeComplete(app, 'lead');
    const leadSawOne = app.seen('lead');
    assert.match(leadSawOne, /t1/,
      'ENTER: the first escalation must have happened and must name t1 — it is the event whose prune-or-not '
      + 'this test is about');
    assert.strictEqual(app.seen('team-hand'), seatAfterOne,
      'ENTER: and no third copy went to the seat, which is the bound still holding at round 2');
    assert.ok(s._specOwedSpent && s._specOwedSpent.has('t1:spec'),
      'the escalation must NOT release the budget: it is the opposite of receipt — two writes produced no turn '
      + '— and a third copy into a composer that swallowed both is what the bound exists to refuse');

    // Round 3: the loop, if the prune were keyed on anything but receipt.
    app.m._emitActivity('team-hand', 'idle');
    displaceAgain(app, s);
    // t1 is ABSENT and t2 is present, and the whole list is asserted rather than
    // filtered for t1: the t2 row is this fixture's own second `_armSpecConfirm`
    // displacing the latch round 2 left in the slot — a first, unspent episode for
    // t2, which is exactly what SHOULD queue. Reducing it away to look at t1 alone
    // would hide a t1 row that had merely moved.
    assert.deepStrictEqual((s._specOwed || []).map((o) => `${o.ticketId}:${o.kind}`), ['t2:spec'],
      'so t1 does not re-enter the queue on round 3: without a receipt the seat is silent, and requeueing on '
      + 'every displacement is the unbounded redelivery loop that sprays a live composer');
    const leadSawTwo = await settled(app, 'lead', /ESCALATED[\s\S]*ESCALATED/, 400);
    // Counted, not measured: growth past a baseline cannot distinguish a second
    // escalation from trailing bytes of the first.
    assert.strictEqual((leadSawTwo.match(/ESCALATED/g) || []).length, 2,
      'the lead hears about it a second time instead — the terminating disposition, and the only one that can '
      + 'get a human to look at a seat that has stopped reading its composer');
    assert.strictEqual(app.seen('team-hand'), seatAfterOne,
      'and across BOTH further rounds not one byte reached the seat: the sequence terminates in escalations, '
      + 'which is the property `_specOwedSpent` was added to guarantee and the prune must not weaken');
  } finally { app.stop(); }
});

// ── t449: a redelivery that PARKS releases the budget too ─────────────────────
//
// t447 released `_specOwedSpent` at the two RECEIPT exits and nowhere else, on
// the reading that the set proves the seat READ the write. It does not: it exists
// to stop a THIRD copy entering a composer that swallowed two. The rule that
// actually justifies every release site is *the budget is spent on a DESTROYABLE
// write and released once that write is no longer at risk* — and a PARKED copy is
// a file on disk that no later Ctrl-U can reach, so it qualifies as squarely as a
// receipt does, while an escalation (a second copy still sitting in the composer)
// does not.
//
// Unreleased there, every ticket whose first repair parked kept its spent key for
// the life of the seat, and a genuinely new displacement weeks later escalated on
// a budget spent in an episode that had already been safely delivered — precisely
// the defect t447 was opened to fix, surviving for that population.
//
// WHERE the release goes is the whole of the fix, and it is not where the latch is
// cleared. `_drainOwedSpec` refuses to run while `_specUnconfirmed` is set, so a
// redelivery that parks from a busy seat finds the latch slot EMPTY: the
// matching-latch guard in `_armSpecConfirm`'s non-injected branch is false, and a
// release gated on it would cover only the fire-time divert — which arms and then
// clears its own latch — and would be inert for exactly the population above.
// The first test asserts that empty slot directly, so the placement is pinned and
// not merely exercised.

// Drive the owed redelivery to a PARK rather than an injection, and hand back the
// PTY baseline from just before it. Busy seat => _maybeParkDelivery/the hold verdict
// claims the text, and the fixture proves the park positively rather than inferring
// it from an absence of PTY bytes.
async function parkedRedelivery(app, s) {
  const beforeSeat = app.seen('team-hand');
  app.m._emitActivity('team-hand', 'thinking');
  assert.strictEqual(s._specUnconfirmed, null,
    'ENTER: the latch slot must be EMPTY when the redelivery parks — that is the state this fix is about, and '
    + 'with a live latch here the drain would refuse to run at all');
  fireOwed(app, s);
  for (let i = 0; i < 400 && app.parked('team-hand', /BUILD THE WIDGET/) === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.strictEqual(app.parked('team-hand', /BUILD THE WIDGET/), 1,
    'ENTER: the redelivery must really have PARKED — injected instead, it arms a latch and ends at one of the '
    + 'receipt exits t447 already repaired, and this test would measure that path rather than this one');
  assert.strictEqual(app.seen('team-hand'), beforeSeat,
    'ENTER: and not one byte of it may have reached the PTY, or it was an injection with a park beside it');
  assert.strictEqual(s._specUnconfirmed, null,
    'ENTER: and the park must have armed NO latch — a latch here means the slot was not empty after all, so the '
    + 'matching-latch guard would have run and the placement under test is not the one being exercised');
  app.m._emitActivity('team-hand', 'idle');
  return beforeSeat;
}

test('t449: a redelivery that PARKS ends the episode, so the next displacement is owed its own redelivery', async () => {
  const world = mkWorld();
  const { app, s } = await collided(world);
  try {
    // t2's latch retired by a REAL receipt, not a hand-cleared slot: the drain
    // reads that field, and clearing it by hand would let a fixture mistake pass
    // for the serialization refusal.
    await received(app, s, 't2');
    assert.deepStrictEqual((s._specOwed || []).map((o) => `${o.ticketId}:${o.kind}`), ['t1:spec'],
      'ENTER: t1 must be owed, or the drain below writes nothing and spends no budget');

    await parkedRedelivery(app, s);
    assert.ok(!(s._specOwedSpent && s._specOwedSpent.has('t1:spec')),
      'a parked copy is a file the seat drains on its own and no later Ctrl-U can destroy, so the write it paid '
      + 'for is no longer at risk and the budget must be released — held, this ticket escalates for the life of '
      + 'the seat on a budget spent by an episode that was safely delivered');

    // The second episode, much later: t1 re-assigned to the same seat and its new
    // draft destroyed by a further dispatch. A NEW destroyable write, so a new
    // budget.
    const beforeLead = app.seen('lead');
    displaceAgain(app, s);
    assert.deepStrictEqual((s._specOwed || []).map((o) => `${o.ticketId}:${o.kind}`), ['t1:spec'],
      'so the new loss is queued for repair like any other first episode`s — escalating here reports as '
      + 'unrepairable a loss the mechanism is holding everything it needs to repair');
    assert.strictEqual(app.seen('lead'), beforeLead,
      'and the lead is not told, because there is nothing yet to tell: the CHANGELOG`s "gets its own '
      + 'redelivery" is either true of this seat or it overclaims');
  } finally { app.stop(); }
});

// The bound, in the direction the fix could break it: releasing a budget must not
// let displace -> redeliver -> displace -> redeliver run without an intervening
// real event, because an unbounded loop sprays a live composer and is strictly
// worse than the bug. A parked redelivery arms NO latch, and a displacement needs
// a live one — so t1 cannot re-enter the queue until something writes it into the
// composer again, which is a genuine new dispatch and a genuine new loss.
test('t449: the released budget cannot manufacture a redelivery — a park arms no latch to displace', async () => {
  const world = mkWorld();
  const { app, s } = await collided(world);
  try {
    await received(app, s, 't2');
    const beforeSeat = await parkedRedelivery(app, s);
    assert.ok(!(s._specOwedSpent && s._specOwedSpent.has('t1:spec')),
      'ENTER: the budget must actually have been released — still spent, the refusals below are the OLD bug '
      + 'refusing, not the bound holding');
    assert.deepStrictEqual((s._specOwed || []).map((o) => `${o.ticketId}:${o.kind}`), [],
      'ENTER: and the queue must be empty, or the "nothing re-enters it" assertions below read a leftover row');

    // No fresh injected write of t1 anywhere, so no t1 latch exists. A further
    // dispatch to the same seat therefore displaces nothing of t1's.
    app.m._armSpecConfirm('team-hand', 't3', 'injected');
    assert.deepStrictEqual((s._specOwed || []).map((o) => `${o.ticketId}:${o.kind}`), [],
      't1 does not re-enter the queue off the back of its own release: a redelivery needs a live latch to '
      + 'displace and the park left none, so the released budget cannot feed a second repair by itself');
    fireOwed(app, s);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('team-hand'), beforeSeat,
      'and the drain writes nothing — one repair per real loss, which is the property that keeps this a repair '
      + 'and not a spray');
    assert.strictEqual(app.parked('team-hand', /BUILD THE WIDGET/), 1,
      'and still exactly ONE copy of t1`s spec is outstanding for this seat, counted rather than measured: a '
      + 'second parked file is the loop, and buffer growth cannot see one');
  } finally { app.stop(); }
});

// The other side of the branch: where the park DOES land on a live latch of its
// own (the fire-time divert arms 'injected' from the producer, then re-reports
// 'parked' when the divert claims the text), the release must not cost the latch
// its clear. Driven through _armSpecConfirm directly because the divert's window
// is one tick wide inside the queue's critical section, and a fixture racing it
// would be a fragile test of a property that is exact here.
test('t449: a park that DOES clear its own latch still clears it, and releases the budget once', async () => {
  const world = mkWorld();
  const { app, s } = await collided(world);
  try {
    await received(app, s, 't2');
    await parkedRedelivery(app, s);
    // Rebuild the divert's state by hand: a live t1 latch, and t1's budget spent.
    app.m._armSpecConfirm('team-hand', 't1', 'injected');
    (s._specOwedSpent || (s._specOwedSpent = new Set())).add('t1:spec');
    assert.ok(s._specUnconfirmed && s._specUnconfirmed.ticketId === 't1' && s._specUnconfirmed.kind === 'spec',
      'ENTER: the matching latch must be live, or the guard under test is not entered and this duplicates the '
      + 'empty-slot case');
    assert.ok(s._specConfirmTimer, 'ENTER: and its timer armed, or "the timer was cleared" is vacuous');

    app.m._armSpecConfirm('team-hand', 't1', 'parked');
    assert.strictEqual(s._specUnconfirmed, null,
      'the latch is still dropped: the text it was watching became a file, and a latch left watching for an '
      + 'edge that can never come redelivers over a spec the seat already has');
    assert.strictEqual(s._specConfirmTimer, null, 'and its timer with it');
    assert.ok(!(s._specOwedSpent && s._specOwedSpent.has('t1:spec')),
      'and the budget is released on this path too — the write became durable here exactly as it did on the '
      + 'empty-slot path, and the two must not disagree about what a park means');

    // Keyed on ONE ticket+kind, never a wholesale clear: a park of t1 says nothing
    // about a t9 draft some earlier Ctrl-U destroyed, and that key is the only
    // thing bounding a ticket the seat has still never seen.
    (s._specOwedSpent || (s._specOwedSpent = new Set())).add('t9:spec');
    app.m._armSpecConfirm('team-hand', 't1', 'parked');
    assert.ok(s._specOwedSpent && s._specOwedSpent.has('t9:spec'),
      'and no other ticket`s budget goes with it');
  } finally { app.stop(); }
});

after(() => { setImmediate(() => process.exit(0)); });


