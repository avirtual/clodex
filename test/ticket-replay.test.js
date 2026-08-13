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
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkillPlugin: () => {},
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
    buildAgentsArg: () => null, effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [], writeSkillPlugin: () => null,
    unionEnabled: require('../scope-util').unionEnabled,
    intentEnabled: require('../intent-catalog').intentEnabled,
    parkDelivery: require('../pending-store').parkDelivery,
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
    }
  };
  return {
    m, spawn, stop, emit,
    seen: (name) => writes.get(name) || '',
    wipeUntil: (name, ms) => keepFrom.set(name, Date.now() + ms),
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
  app.m._handleTask(lead, { type: 'task', sub: 'add', who, id: null, body: 'BUILD THE WIDGET\nstep one' });
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
  app1.m._handleTask(lead, { type: 'task', sub: 'add', who: null, id: null, body: 'BUILD THE WIDGET\nunowned' });
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
  app1.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\nstep one' });
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
  app1.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\nstep one' });
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
  app1.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'BUILD THE WIDGET\nfirst' });
  app1.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'PAINT THE SHED\nsecond' });
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

after(() => { setImmediate(() => process.exit(0)); });
