'use strict';
// terminal-reports-pref.test.js — the tri-state that split terminal CAPABILITY
// from terminal DISCLOSURE (t235), pinned at the two places it can go wrong:
// the store that migrates the old boolean, and engine's two gates.
//
// Why the split exists: `terminalReporting: boolean` decided both whether the
// shell emits OSC 133 marks at all (without them `[agent:term exec]` is refused,
// because a command with no ending would leave the agent waiting forever) AND
// whether the operator's own commands are pushed to the agent unasked. "Let the
// agent run a command, but stop narrating everything I type" could not be
// expressed. Marks are knowledge, not disclosure; the two gates must stay
// separate, and a single condition serving both is the regression to catch.
//
// The engine half is pinned against SOURCE rather than a live engine: engine.js
// requires node-pty at load, so neither gate is reachable from a unit test.
// Same technique term-marks.test.js and team-frontdoor-seam.test.js already use.
// A source pin cannot see behaviour, so it is written to fail on the specific
// wrong EDIT — the two gates collapsing into one comparison — rather than to
// describe the right one loosely.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initStores } = require('../stores.js');

function openStores(dir) {
  return initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    // A resourcesDir that does not exist suppresses library seeding, which is
    // irrelevant here (same trick as test/stores.test.js).
    resourcesDir: path.join(dir, '__no_seed__'),
  });
}

function mkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-termreports-'));
}

function writeSettings(dir, obj) {
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify(obj));
}

// ── the store: migration ──────────────────────────────────────────────────

test('a stored `true` becomes `all` — the operator had the firehose and keeps it', () => {
  const dir = mkDir();
  writeSettings(dir, { terminalReporting: true });
  assert.strictEqual(openStores(dir).uiSettings.get().terminalReports, 'all');
});

test('a stored `false` becomes `off`, NOT `asked`', () => {
  // The load-bearing direction. `asked` would preserve the operator's evident
  // intent (they declined the firehose, not the capability) at the cost of
  // granting a privileged agent capability during a version bump they did not
  // ask for. A control they can flip once is the cheaper mistake.
  const dir = mkDir();
  writeSettings(dir, { terminalReporting: false });
  assert.strictEqual(openStores(dir).uiSettings.get().terminalReports, 'off');
});

test('an existing settings file with NEITHER key lands on `off`, not the new default', () => {
  // The same hazard through the other door. This store rebuilds field-by-field
  // and falls back per key to DEFAULT_UI_SETTINGS, whose value is now `asked` —
  // so an install predating the feature would be handed the capability by the
  // fallback alone. A parsed file means the operator has settings; only a
  // MISSING file is a new install.
  const dir = mkDir();
  writeSettings(dir, { theme: 'midnight' });
  const s = openStores(dir).uiSettings.get();
  assert.strictEqual(s.theme, 'midnight', 'ENTER: the settings file really was read');
  assert.strictEqual(s.terminalReports, 'off');
});

test('a fresh install (no settings file at all) defaults to `asked`', () => {
  // The state that could not be expressed before: the agent can run a command,
  // and the operator is not narrated. Nothing is disclosed by it.
  const dir = mkDir();
  assert.ok(!fs.existsSync(path.join(dir, 'ui-settings.json')), 'ENTER: no settings file exists');
  assert.strictEqual(openStores(dir).uiSettings.get().terminalReports, 'asked');
});

test('each tri-state value survives a round trip', () => {
  for (const want of ['off', 'asked', 'all']) {
    const dir = mkDir();
    const ui = openStores(dir).uiSettings;
    assert.strictEqual(ui.set({ terminalReports: want }).terminalReports, want);
    assert.strictEqual(openStores(dir).uiSettings.get().terminalReports, want,
      `${want} must survive a restart`);
  }
});

test('an unrecognised value is refused on the way IN, keeping the current state', () => {
  // Validating only on load would let `'On'` sit in the file and read back as
  // itself. Every gate downstream compares against a literal, so that string is
  // neither `all` nor `off` — disclosure would then depend on a typo.
  const dir = mkDir();
  const ui = openStores(dir).uiSettings;
  ui.set({ terminalReports: 'all' });
  assert.strictEqual(ui.set({ terminalReports: 'On' }).terminalReports, 'all',
    'a junk write must not change the state');
  assert.strictEqual(ui.set({ terminalReports: true }).terminalReports, 'all',
    'nor may the OLD boolean shape sneak back in through set()');
  assert.strictEqual(openStores(dir).uiSettings.get().terminalReports, 'all');
});

test('a stored tri-state wins over a leftover boolean', () => {
  // Both keys present is what an upgrade-then-downgrade-then-upgrade leaves.
  // The explicit choice is the newer one.
  const dir = mkDir();
  writeSettings(dir, { terminalReporting: false, terminalReports: 'all' });
  assert.strictEqual(openStores(dir).uiSettings.get().terminalReports, 'all');
});

test('a corrupt tri-state falls back to the boolean rather than to `asked`', () => {
  const dir = mkDir();
  writeSettings(dir, { terminalReporting: true, terminalReports: 'sometimes' });
  assert.strictEqual(openStores(dir).uiSettings.get().terminalReports, 'all');
});

// ── engine: the two gates, pinned in source ───────────────────────────────

const engineSrc = fs.readFileSync(require.resolve('../engine.js'), 'utf8');

test('the capability gate and the disclosure gate read the pref DIFFERENTLY', () => {
  // The whole ticket in one assertion. `shimEnv` decides whether marks exist;
  // `onCommand` decides whether the operator's commands are handed over. If a
  // future edit makes these two comparisons the same, the tri-state has
  // silently become a boolean again and `asked` stops being a state.
  const shim = engineSrc.match(/shimEnv: \(seat\) => \{\n\s*(if \(.*?\) return null;)/);
  assert.ok(shim, 'ENTER: the shimEnv gate was found in engine.js');
  assert.match(shim[1], /terminalReports === 'off'/,
    'capability is withdrawn ONLY by `off`');

  const onCmd = engineSrc.match(/onCommand: \(seat, rec\) => \{\n\s*(if \(.*?\) return;)/);
  assert.ok(onCmd, 'ENTER: the onCommand gate was found in engine.js');
  assert.match(onCmd[1], /terminalReports !== 'all'/,
    'disclosure is granted ONLY by `all`');

  // Stated as absences too, because the collapse can land either way round: a
  // single `!== 'all'` serving both would revoke the capability the moment the
  // firehose went off, and a single `=== 'off'` would put the operator's
  // commands back on the wire under `asked`.
  assert.doesNotMatch(shim[1], /'all'/, 'the capability gate must not consult `all`');
  assert.doesNotMatch(onCmd[1], /'off'/, 'the disclosure gate must not consult `off`');
});

test('the passive firehose is the only queue writer that tags its rows', () => {
  // The tag is what lets the revocation drop the operator's undrained terminal
  // reports without also dropping their own Copy attachments (queued through
  // selection-arm's injected `queue`, same file) or an exec answer that fell
  // back to the queue when its dm could not be delivered. Three writers, one
  // `selection.jsonl`; two of them are these.
  const calls = engineSrc.match(/^\s*queueForSeat\([^)]*\);/gm) || [];
  assert.strictEqual(calls.length, 2, 'ENTER: both queueForSeat CALL sites were found');
  const tagged = calls.map((c) => c.trim()).filter((c) => /PASSIVE_TERM_KIND/.test(c));
  assert.deepStrictEqual(tagged, ['queueForSeat(seat, text, PASSIVE_TERM_KIND);'],
    'exactly one call tags, and it is the firehose');
});

test('the revocation fires only on leaving `all`, and only for passive rows', () => {
  const fn = engineSrc.match(/function syncTerminalReports\(prev\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'ENTER: syncTerminalReports was found in engine.js');
  assert.match(fn[0], /if \(prev !== 'all'\) return;/,
    'turning the firehose ON has nothing to withdraw');
  assert.match(fn[0], /=== 'all'\) return;/,
    'a write that left the state alone must not sweep the queue');

  const drop = engineSrc.match(/function dropPassiveTermReports\(seats\) \{[\s\S]*?\n\}/);
  assert.ok(drop, 'ENTER: dropPassiveTermReports was found in engine.js');
  assert.match(drop[0], /o\.kind === PASSIVE_TERM_KIND/,
    'only tagged rows are dropped');
  assert.match(drop[0], /catch \{ kept\.push\(line\); continue; \}/,
    'an unparseable row is KEPT — it is not ours to judge, and dropping what we cannot read makes corruption an amplifier');
});

// ── the revocation, driven through a REAL engine ──────────────────────────
//
// Behaviour, not source: the queue file is the operator's only revocation
// window, and what matters is which rows survive the sweep — a claim no regex
// over engine.js can make. `os.homedir()` reads $HOME on POSIX, which is how the
// engine's REGISTRY_DIR lands in a scratch dir here (same override
// memory-viewer-plugin.test.js uses).

function bootEngine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-termreports-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const { createEngine } = require('../engine');
  const userData = mkDir();
  // registryDir or the engine seeds the operator's live ~/.clodex (t359).
  // Overriding HOME above is NOT enough on its own: engine.js resolves the root
  // ONCE at construction, so anything that lands after that call is never
  // consulted, and any path not routed through this seam keeps the old root.
  const eng = createEngine({
    userDataPath: userData,
    seams: { registryDir: path.join(home, '.clodex') },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  // `shutdown()` is not optional here. createEngine arms the wirescope watchdog,
  // the message-cleanup timer and the proxy poller at construction; leaving them
  // running holds the event loop open, and the test FILE then hangs after the
  // last assertion has already passed. It also disposes the drawer ptys, so a
  // real shell spawned below cannot outlive its test.
  const restore = () => {
    try { eng.shutdown(); } catch {}
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  };
  return { eng, home, restore };
}

// The seat's queue file, written the way each of the three writers writes it.
function seedQueue(eng, seat, rows) {
  const dir = path.join(eng.REGISTRY_DIR, 'run', seat);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'selection.jsonl');
  fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return file;
}

const readRows = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  : null);

test('leaving `all` drops the undrained firehose rows and NOTHING else', () => {
  const { eng, restore } = bootEngine();
  try {
    eng.stores.uiSettings.set({ terminalReports: 'all' });
    eng.manager.sessions.set('alice', {});
    const file = seedQueue(eng, 'alice', [
      { text: '[terminal] git status\nexit 0', kind: 'terminal-passive' },
      { text: 'a line the operator hit Copy on' },
      { text: '[terminal] npm test\nexit 1', kind: 'terminal-passive' },
      { text: '[terminal] ls\nexit 0' },
      'not json at all',
    ]);
    assert.strictEqual(readRows(file).length, 5, 'ENTER: the queue really was seeded');

    eng.stores.uiSettings.set({ terminalReports: 'asked' });
    eng.syncTerminalReports('all');

    assert.deepStrictEqual(readRows(file), [
      // The operator's own Copy attachment: they queued it deliberately, and it
      // is not theirs to lose for declining a different feature.
      JSON.stringify({ text: 'a line the operator hit Copy on' }),
      // An exec answer that fell back to the queue when its dm could not be
      // delivered. The agent ASKED for this one — it is the half the split
      // exists to keep working, and it is untagged for exactly that reason.
      JSON.stringify({ text: '[terminal] ls\nexit 0' }),
      'not json at all',
    ]);
  } finally { restore(); }
});

test('a queue of nothing but firehose rows is removed, not left empty', () => {
  const { eng, restore } = bootEngine();
  try {
    eng.stores.uiSettings.set({ terminalReports: 'all' });
    eng.manager.sessions.set('bob', {});
    const file = seedQueue(eng, 'bob', [
      { text: '[terminal] pwd\nexit 0', kind: 'terminal-passive' },
    ]);
    assert.ok(fs.existsSync(file), 'ENTER: the queue file exists before the sweep');

    eng.stores.uiSettings.set({ terminalReports: 'off' });
    eng.syncTerminalReports('all');

    assert.strictEqual(readRows(file), null, 'an emptied queue is removed');
  } finally { restore(); }
});

test('switching the firehose ON, or not moving it, sweeps nothing', () => {
  // The revocation is a TRANSITION out of `all`. A sweep on any other write
  // would let an unrelated settings save (a theme, a port) eat reports the
  // operator never asked to withdraw.
  const { eng, restore } = bootEngine();
  try {
    eng.manager.sessions.set('carol', {});
    const rows = [{ text: '[terminal] whoami\nexit 0', kind: 'terminal-passive' }];

    const f1 = seedQueue(eng, 'carol', rows);
    eng.stores.uiSettings.set({ terminalReports: 'all' });
    eng.syncTerminalReports('asked');
    assert.strictEqual(readRows(f1).length, 1, 'turning it ON withdraws nothing');

    const f2 = seedQueue(eng, 'carol', rows);
    eng.stores.uiSettings.set({ terminalReports: 'all' });
    eng.syncTerminalReports('all');
    assert.strictEqual(readRows(f2).length, 1, 'a write that left the state alone withdraws nothing');
  } finally { restore(); }
});

// ── both gates, through a REAL shell on the engine's own wiring ───────────
//
// The tests above seed the queue by hand. These drive the operator's actual
// path — a shell spawned by the engine, a command typed into it, the shell's
// own OSC 133 marks — so the row the sweep looks for is the row the firehose
// really writes. Pinning the two halves separately would let them disagree
// about the tag and both stay green.
//
// Skipped rather than failed where the host has no usable shell: an absent
// zsh/bash is a fact about the machine, and the source pins above still hold.
const { unsupportedShellReason } = require('../term-shim');
const shellSkip = (() => {
  try { require('node-pty'); } catch { return 'node-pty unavailable'; }
  return unsupportedShellReason({ shell: process.env.SHELL }) || false;
})();
const shellOpts = { skip: shellSkip, timeout: 60000 };

// Types a command and waits for a report to land in the seat's queue file.
//
// Never used to prove an ABSENCE by timing out: a wait that expires is
// indistinguishable from a shell that was simply slow, and it would put a
// multi-second stall into the suite for every silent case. Each absence below
// is instead measured against a POSITIVE control — a command that does report,
// typed into the same shell or a shimmed one beside it. When the control lands,
// the silent command has had its chance, and the queue says what happened.
async function typeAndWait(ptys, seat, file, command) {
  ptys.write('ws-1', seat, `${command}\n`);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// Types a command that is NOT expected to report. Returns once the shell has
// had a fair chance to run it — a round trip through the pty, which is the same
// path a reporting command's mark takes.
async function typeSilently(ptys, seat, command) {
  ptys.write('ws-1', seat, `${command}\n`);
  await new Promise((r) => setTimeout(r, 250));
}

test('a real shell under `all`: the report is queued, tagged, and revocable', shellOpts, async () => {
  const { eng, restore } = bootEngine();
  const ptys = eng.getDrawerPtys();
  try {
    eng.stores.uiSettings.set({ terminalReports: 'all' });
    eng.manager.sessions.set('dave', {});
    fs.mkdirSync(path.join(eng.REGISTRY_DIR, 'run', 'dave'), { recursive: true });
    const file = path.join(eng.REGISTRY_DIR, 'run', 'dave', 'selection.jsonl');

    const spawned = ptys.spawn('ws-1', 'dave', {});
    assert.strictEqual(spawned.ok, true, `the shell spawned: ${spawned.error || ''}`);
    assert.strictEqual(ptys._execState('ws-1', 'dave').shimmed, true,
      'ENTER: `all` built the shim, so the shell can mark its commands at all');

    assert.ok(await typeAndWait(ptys, 'dave', file, 'echo t235'),
      'ENTER: the real shell really did report a command');
    const rows = readRows(file);
    const row = JSON.parse(rows[0]);
    assert.match(row.text, /echo t235/, 'the operator\'s own command was disclosed');
    assert.strictEqual(row.kind, 'terminal-passive',
      'and it carries the tag the revocation looks for');

    eng.stores.uiSettings.set({ terminalReports: 'asked' });
    eng.syncTerminalReports('all');
    assert.strictEqual(readRows(file), null, 'switching off withdrew it');
  } finally { try { ptys.dispose(); } catch {} restore(); }
});

test('a real shell under `asked`: the command runs, and nothing is disclosed', shellOpts, async () => {
  // The state the whole ticket exists to make expressible, end to end: marks
  // are built (so `[agent:term exec]` works), and the operator is not narrated.
  const { eng, restore } = bootEngine();
  const ptys = eng.getDrawerPtys();
  try {
    eng.stores.uiSettings.set({ terminalReports: 'asked' });
    fs.mkdirSync(path.join(eng.REGISTRY_DIR, 'run', 'erin'), { recursive: true });
    const file = path.join(eng.REGISTRY_DIR, 'run', 'erin', 'selection.jsonl');

    ptys.spawn('ws-1', 'erin', {});
    assert.strictEqual(ptys._execState('ws-1', 'erin').shimmed, true,
      'ENTER: `asked` still builds the shim — the capability survives');

    await typeSilently(ptys, 'erin', 'echo t235');
    assert.strictEqual(readRows(file), null, 'the operator was not narrated');

    // The positive control for that absence, and the live-shell claim in one:
    // the SAME shell, still open, reports the moment the pref allows it. So
    // what was measured above is the gate refusing — not a shell that never
    // reported, and not a wait that was too short.
    eng.stores.uiSettings.set({ terminalReports: 'all' });
    assert.ok(await typeAndWait(ptys, 'erin', file, 'echo again'),
      'ENTER: the same live shell reports once the pref allows it');
    const rows = readRows(file);
    assert.strictEqual(rows.length, 1,
      'exactly one report — the silent command did not arrive late');
    assert.match(JSON.parse(rows[0]).text, /echo again/);
  } finally { try { ptys.dispose(); } catch {} restore(); }
});

test('turning the firehose off bites a LIVE shell, with no reopen', shellOpts, async () => {
  // The free win the split delivers (design §4). Before it, both halves rode
  // one spawn-time flag, so an operator who switched off mid-session kept being
  // reported on until they closed the tab. Only the `off` boundary is
  // spawn-bound now, and `off` is not the control that matters for privacy.
  const { eng, restore } = bootEngine();
  const ptys = eng.getDrawerPtys();
  try {
    eng.stores.uiSettings.set({ terminalReports: 'all' });
    fs.mkdirSync(path.join(eng.REGISTRY_DIR, 'run', 'frank'), { recursive: true });
    const file = path.join(eng.REGISTRY_DIR, 'run', 'frank', 'selection.jsonl');

    ptys.spawn('ws-1', 'frank', {});
    assert.ok(await typeAndWait(ptys, 'frank', file, 'echo before'),
      'ENTER: this shell was reporting before the switch');
    fs.rmSync(file, { force: true });

    eng.stores.uiSettings.set({ terminalReports: 'asked' });
    await typeSilently(ptys, 'frank', 'echo after');
    assert.strictEqual(readRows(file), null,
      'the SAME shell, still open, stopped reporting immediately');

    // The control that dates the silence: switching back makes this same shell
    // report again, so the absence above was the gate and not a shell that had
    // stopped marking (or died) at some point after `echo before`.
    eng.stores.uiSettings.set({ terminalReports: 'all' });
    assert.ok(await typeAndWait(ptys, 'frank', file, 'echo later'),
      'the shell was still alive and still marking');
    assert.match(JSON.parse(readRows(file)[0]).text, /echo later/,
      'and `echo after` never arrived late under a name it was not reported by');
  } finally { try { ptys.dispose(); } catch {} restore(); }
});

test('a real shell under `off` has no marks, so the agent is refused', shellOpts, async () => {
  // The capability half. `off` withholds the shim, `exec` refuses rather than
  // typing a command whose ending nothing could report, and the operator's own
  // commands are not disclosed either.
  const { eng, restore } = bootEngine();
  const ptys = eng.getDrawerPtys();
  try {
    eng.stores.uiSettings.set({ terminalReports: 'off' });
    fs.mkdirSync(path.join(eng.REGISTRY_DIR, 'run', 'gina'), { recursive: true });
    const file = path.join(eng.REGISTRY_DIR, 'run', 'gina', 'selection.jsonl');

    ptys.spawn('ws-1', 'gina', {});
    assert.strictEqual(ptys._execState('ws-1', 'gina').shimmed, false,
      'ENTER: the shell really was born without the shim');
    assert.deepStrictEqual(ptys.exec('ws-1', 'gina', 'echo t235'),
      { ok: false, code: 'no-marks' });

    await typeSilently(ptys, 'gina', 'echo t235');
    assert.strictEqual(readRows(file), null, 'and nothing was disclosed either');

    // The control, and it has to be a SECOND shell: `off` is the one boundary
    // that is spawn-bound, so flipping the pref cannot make gina's shell start
    // marking. A shimmed shell beside it, under the same engine and the same
    // queue machinery, does report — which dates the silence above to the
    // missing shim rather than to anything else in this harness.
    eng.stores.uiSettings.set({ terminalReports: 'all' });
    const other = path.join(eng.REGISTRY_DIR, 'run', 'gus', 'selection.jsonl');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    ptys.spawn('ws-1', 'gus', {});
    assert.ok(await typeAndWait(ptys, 'gus', other, 'echo control'),
      'a shimmed shell in the same engine does report');
    assert.strictEqual(readRows(file), null,
      'and gina STILL says nothing — the shim is missing for its whole life');
  } finally { try { ptys.dispose(); } catch {} restore(); }
});

test('a seatless shell gets no shim in ANY state', () => {
  // The shared terminal with no session selected has nobody to report to.
  const { eng, restore } = bootEngine();
  try {
    eng.stores.uiSettings.set({ terminalReports: 'all' });
    const ptys = eng.getDrawerPtys();
    ptys.spawn('ws-1', '', {});
    assert.strictEqual(ptys._execState('ws-1', '').shimmed, false);
    try { ptys.dispose(); } catch {}
  } finally { restore(); }
});

// `shutdown()` in each teardown above stops what the engine itself owns, but a
// constructed engine also leaves handles nothing exposes a stop for (a pipe and
// two timers, measured). Same teardown engine-context-timeout.test.js and
// engine-web-info-seam.test.js already use for the same reason: without it the
// file hangs AFTER every assertion has passed.
after(() => { setImmediate(() => process.exit(0)); });

test('the diagnosis has a branch per state that can produce it', () => {
  const fn = engineSrc.match(/function termShimDiagnosis\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'ENTER: termShimDiagnosis was found in engine.js');
  assert.match(fn[0], /reports === 'off'/, 'off: the pref is the cause and says so');
  assert.match(fn[0], /reports === 'asked'/,
    'asked: the shell predates the switch — naming the checkbox they just ticked sends them back to tick it again');
});

// ── the IPC seam that ARMS the revocation ─────────────────────────────────
//
// Everything above proves the sweep does the right thing once called. Nothing
// above proves anything CALLS it: `settings:set` is the only caller, and the
// value it must pass is the one that exists only before `uiSettings.set` runs.
// Deleting the call, or reading the previous value after the write, both leave
// a revocation that is correct and unreachable — the operator flips the switch
// and their undrained reports go to the agent anyway.

function settingsSetFixture(initial) {
  const handlers = new Map();
  const store = { terminalReports: initial };
  const calls = [];
  const { registerIpcHandlers } = require('../ipc-handlers');
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, error() {} },
    manager: {},
    uiSettings: {
      get: () => store,
      set: (patch) => { Object.assign(store, patch); return store; },
    },
    syncTerminalReports: (prev) => calls.push(prev),
    rebuildAllStatusScripts: () => {},
    wirescope: { autoStartWanted: () => false, start: () => Promise.resolve(), stop: () => {} },
    syncRemoteServer: () => {},
    syncPeerManager: () => {},
  });
  const handler = handlers.get('settings:set');
  assert.equal(typeof handler, 'function', 'ENTER: settings:set really registered');
  return { handler, store, calls };
}

test('settings:set hands the revocation the value from BEFORE the write', () => {
  const { handler, store, calls } = settingsSetFixture('all');
  handler({}, { terminalReports: 'asked' });
  assert.strictEqual(store.terminalReports, 'asked', 'ENTER: the write really landed');
  // 'all', not 'asked'. Passing the post-write value makes `prev !== 'all'`
  // true on the one transition that must sweep, so the revocation silently
  // never fires — the same defect as deleting the call, but green-looking.
  assert.deepStrictEqual(calls, ['all']);
});

test('settings:set arms the revocation on EVERY write, and lets it decide', () => {
  // Not the handler's judgement to make: syncTerminalReports owns the
  // transition test, and a second copy of it here would be a second thing to
  // keep in step. An unrelated save must still reach it — with a prev that
  // makes it a no-op.
  const { handler, calls } = settingsSetFixture('asked');
  handler({}, { theme: 'dark' });
  assert.deepStrictEqual(calls, ['asked']);
});

// ── the dialog's read of the tri-state ────────────────────────────────────
//
// renderer.js cannot be required (no DOM, and it runs on load), so the two
// helpers are lifted out of the source and driven against a fake radio group.
// What matters is the FALLBACK: openPrefs paints whatever settings:get returned
// and Save writes back what is painted, so a value the dialog does not
// recognise must not be redrawn — and must not be saved — as the state that
// grants the capability.
const rendererSrc = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');

function loadRadioHelpers(checked) {
  const set = rendererSrc.match(/function setTerminalReports\(value\) \{[\s\S]*?\n\}/);
  const read = rendererSrc.match(/function readTerminalReports\(\) \{[\s\S]*?\n\}/);
  assert.ok(set, 'ENTER: setTerminalReports was found in renderer.js');
  assert.ok(read, 'ENTER: readTerminalReports was found in renderer.js');

  const radios = ['off', 'asked', 'all'].map((value) => ({ value, checked: value === checked }));
  const prefsTerminalReports = {
    querySelectorAll: () => radios,
    querySelector: () => radios.find((r) => r.checked) || null,
  };
  const make = new Function('prefsTerminalReports', 'TERMINAL_REPORTS',
    `${set[0]}\n${read[0]}\nreturn { setTerminalReports, readTerminalReports };`);
  return { radios, ...make(prefsTerminalReports, ['off', 'asked', 'all']) };
}

test('an unrecognised stored value paints — and therefore saves — as `off`', () => {
  const { radios, setTerminalReports, readTerminalReports } = loadRadioHelpers('all');
  setTerminalReports('EVERYTHING');
  assert.deepStrictEqual(radios.map((r) => r.checked), [true, false, false],
    'the dialog falls back to off, not to the store default `asked`');
  assert.strictEqual(readTerminalReports(), 'off');
});

test('each recognised value round-trips through the radio group', () => {
  for (const value of ['off', 'asked', 'all']) {
    const { setTerminalReports, readTerminalReports } = loadRadioHelpers('asked');
    setTerminalReports(value);
    assert.strictEqual(readTerminalReports(), value);
  }
});

test('a radio group with nothing checked reads as `off`', () => {
  // The state a markup change could leave behind (no `checked` attribute on any
  // choice). Save must not read that as the firehose.
  const { radios, readTerminalReports } = loadRadioHelpers(null);
  assert.ok(radios.every((r) => !r.checked), 'ENTER: nothing is checked');
  assert.strictEqual(readTerminalReports(), 'off');
});
