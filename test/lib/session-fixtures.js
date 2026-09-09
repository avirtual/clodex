'use strict';

// Shared session-manager fixtures. Lifted here from test/session-manager.test.js
// so test/team-create-root.test.js can drive the REAL _handleTeamCreate over real
// trees without a second copy of the graph; that file requires them back, so the
// two drive one graph rather than two that can drift apart. mk and mkPark moved
// unchanged; mkTeamCreate gained the gitWorktree dep and the makeRepo option
// t780 needs, both noted at their line.
//
// Node's test glob opens this file as a test file too (see test/lib/tmp-roots.js),
// so it reports as one passing point that executed nothing.

const { createSessionManager } = require('../../session-manager');
const { intentEnabled } = require('../../intent-catalog');
const fsReal = require('fs');
const pathReal = require('path');
const { createTeamManifest: createTeamManifestReal } = require('../../team-manifest');
const { mkTmpRoot } = require('./tmp-roots');
const { execFileSync } = require('child_process');
const { parkDelivery, drainPending, hasPending, hasActivePending, countPending: countPendingReal, parkIdInUse } = require('../../pending-store');
const { isDraftOpen: isDraftOpenReal } = require('../../proxy-util');

// Minimal fake deps: only what the PTY-free methods touch. Everything else is
// undefined, which the destructure tolerates (those methods aren't reached).
function mk(overrides = {}) {
  const deps = {
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    intentEnabled, // real pure leaf — the fire-time gate needs it on every _handleIntent
    withoutPrivilegedIntentsFor: require('../../intent-registry').withoutPrivilegedIntentsFor, // real leaf — _handleSpawnIntent strips privileged grants (core AND plugin verbs)
    fencedLines: require('../../intent-scanner').fencedLines, // real pure leaf — _extractIntents maps fences unconditionally
    // The grammar table (intent-registry) — real pure leaf, like intent-catalog
    // above. _extractIntents asks it for every intent's body-capture mode and
    // _handleIntent asks it for the gate, the bounce list and the plugin
    // dispatch tail, so a fake here would test the fake.
    bodyModeFor: require('../../intent-registry').bodyModeFor,
    intentEnabledFor: require('../../intent-registry').intentEnabledFor,
    // The FIRE gate, and the only one _handleIntent consults. Real leaf for the
    // same reason as the others here: it reads the whole persistence entry, so a
    // fake would answer off a shape the shipped code never sees.
    intentEnabledForSeat: require('../../intent-registry').intentEnabledForSeat,
    pluginRowFor: require('../../intent-registry').pluginRowFor,
    validIntentNames: require('../../intent-registry').validIntentNames,
    fs: require('node:fs'), // real — create()'s pre-spawn cwd validation stats it
    // Real pure leaf, like fs above: _flushParkedNow pre-counts with it OUTSIDE a
    // try/catch (the count decides whether to enqueue a producer at all), so an
    // unwired seam is an uncaughtException, not a silent no-op the way the old
    // in-try drainPending was. Reads the fixture's own PENDING_DIR and returns 0
    // for a missing dir, so a fixture that parks nothing needs no override.
    countPending: require('../../pending-store').countPending,
    // The rest of the pending seam, for one reason: every OTHER caller of these
    // sits inside `try { … } catch { return; }`, so an unwired seam is a swallowed
    // TypeError — both drains become a silent no-op and any test written against
    // them passes vacuously. (Third time this family bit us: countPending above,
    // MSG_MAX_AGE below.) All three are pure leaves over the fixture's own
    // PENDING_DIR and answer "nothing parked" for the undefined one most fixtures
    // have, so wiring them here changes no behaviour — it only stops the silence.
    isDraftOpen: require('../../proxy-util').isDraftOpen,
    drainPending: require('../../pending-store').drainPending,
    hasActivePending: require('../../pending-store').hasActivePending,
    // Every rejecting ticket verb calls this. Undefined here would make each one
    // run its catch branch and report the failure wording, so a host that stopped
    // wiring the seam would degrade silently instead of failing a test.
    spillToFile: () => '/tmp/spill-stub.txt',
    // The PRODUCTION value (engine.js), not a token: the spill bounce divides by it,
    // so an unset seam renders "NaN minutes" — a sentence no user can ever see, which
    // every assertion about that bounce would still pass against.
    MSG_MAX_AGE: 1800,
    // Real pure leaf, and deliberately NOT guarded for truthiness at the call
    // site: _handleTermIntent asks it whether the seat has a terminal at all, so
    // an unwired seam must throw rather than wave every session type through to
    // a shell it should not reach.
    termAvailableFor: require('../../drawer-avail').termAvailableFor,
    ...overrides,
  };
  const SessionManager = createSessionManager(deps);
  return new SessionManager();
}

// A busy agent's DM parks to the on-disk pending store (where the out-of-process
// PostToolUse hook can drain it mid-loop) instead of the in-memory _injectQueue;
// the idle-edge Node drain is the turn-end fallback for a pure-text (no-tool)
// turn. Real pending-store fns + isDraftOpen injected over a temp PENDING_DIR;
// _injectText captured (no PTY). One atomic rename-claim = exactly-once.
function mkPark(overrides = {}) {
  const PENDING_DIR = mkTmpRoot('clodex-pend-');
  const injected = [];
  const m = mk({
    PENDING_DIR, parkDelivery, drainPending, hasActivePending, isDraftOpen: isDraftOpenReal,
    INJECT_QUIET_MS: 4000, INJECT_QUIET_MAXWAIT: 3_600_000, // maxwait large: park cap won't fire mid-test
    // Same reason as the maxwait above, and NOT decorative: _deliverParkedActive
    // arms the parked-drain fallback with this, so leaving it undefined arms a 1ms
    // timer against a NaN deadline. Every caller empties the store before it
    // fires, so today that is invisible — which is exactly why it is pinned by
    // construction rather than by luck.
    INJECT_BOOT_MAXWAIT: 60_000,
    findProjectRoot: () => null, // teams: default = no project anywhere; retire tests override
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    ...overrides,
  });
  // Models the QUEUE: a producer is evaluated at WRITE time. The real queue
  // claims inside _drain, so a stub that pushed the placeholder text would record
  // '' for every produce-based drain and assert nothing about the payload.
  m._injectText = (s, text, opts) => {
    const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    // The queue WRITES NOTHING for a null/empty producer (inject-queue _drain
    // returns before the write), so recording one would invent an injection that
    // never happens — and every "nothing was delivered" assertion would see a
    // phantom entry. A producer returns null whenever its claim came up empty:
    // another drainer won, or every entry failed the born check.
    if (out == null || out === '') return;
    injected.push(out);
  };
  m._broadcast = () => {};
  return { m, PENDING_DIR, injected };
}

// The mint front door for agents. The writer is the REAL createTeamManifest over
// a temp clodexHome: the assertion that matters is team.json ON DISK carrying the
// root and lead, and a stub would let a handler that forwarded nothing still look
// right.
// makeRepo (t780): the root starts as a repo with one commit, i.e. the TAKEOVER
// case. Without it the root is an empty directory, which create now git-inits —
// so a test asserting the reply's root clause has to say which case it wants.
// created (t782): create now spawns the lead itself, so the fixture stubs
// m.create and captures its argv the way mkLeadSpawn does — with the real
// library lead template on listAllTemplates and a resolveTeam that answers the
// team create just wrote, since that resolution is what picks the template up.
function mkTeamCreate({
  intents = ['team-create'], refreshThrows = false, noRefreshDep = false, wrapFs = null,
  makeRepo = false, createThrows = null, noLeadTemplate = false,
} = {}) {
  const home = mkTmpRoot('clodex-t751-');
  const projectRoot = mkTmpRoot('clodex-t751-proj-');
  if (makeRepo) {
    const run = (...a) => execFileSync('git', ['-C', projectRoot, ...a], { stdio: 'ignore' });
    run('init', '-q');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 'Test');
    run('commit', '-q', '--allow-empty', '-m', 'init');
  }
  const tm = createTeamManifestReal({ fs: fsReal, clodexHome: home });
  const refreshes = [];
  const created = [];
  const shippedLead = JSON.parse(fsReal.readFileSync(
    pathReal.join(__dirname, '..', '..', 'resources', 'library', 'templates', 'clodex-team-lead.json'), 'utf-8'));
  const { m, injected } = mkPark({
    fs: wrapFs ? wrapFs(fsReal, home) : fsReal,
    path: pathReal,
    os: require('os'),
    REGISTRY_DIR: home,
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
    ensureDir: () => {},
    listAllTemplates: () => (noLeadTemplate ? [] : [{ ...shippedLead, id: 'clodex-team-lead' }]),
    getPersistence: () => ({
      list: () => [], get: (n) => (n === 'a' ? { intents } : null),
      setStripLevel() {}, setAutoCompact() {}, setPlugins() {}, setWorktree() {},
    }),
    createTeam: tm.createTeam,
    teamsDir: tm.teamsDir,
    // teamPromptPath refuses any team listTeams does not name, so the brief has
    // nowhere to go without this — a stub would make every kickstart create fail.
    listTeams: tm.listTeams,
    // The REAL module over the fixture's real temp root (t780): create classifies
    // and git-inits through it, so a stub would answer about a shape the shipped
    // handler never meets — and an unwired seam is a TypeError the dispatcher's
    // .catch swallows, leaving every create silently doing nothing.
    gitWorktree: require('../../git-worktree'),
    // The REAL resolver over the fixture's home (t782): the internal lead spawn
    // picks up clodex-team-lead only by resolving the team that owns the spawn's
    // cwd, so a `() => null` stub would silently spawn every lead bare and the
    // template pin would assert about a resolution that never ran.
    resolveTeam: tm.resolveTeam,
    refreshAppMenu: noRefreshDep ? undefined : () => { refreshes.push(1); if (refreshThrows) throw new Error('menu boom'); },
  });
  m._broadcast = () => {};
  m._sendToSession = () => {};
  // Which SEAT each injection went to. mkPark's stub records the text only, and
  // the whole point after t782 is that the caller's line and the new lead's
  // opener are two injections to two different seats.
  const perSeat = [];
  const injectBase = m._injectText;
  m._injectText = (s, text, opts) => {
    const before = injected.length;
    injectBase(s, text, opts);
    if (injected.length > before) perSeat.push({ seat: s && s.name, text: injected[injected.length - 1] });
  };
  // Mints a session entry as the real create() does: the opener is injected into
  // the seat looked up from the map, so a stub that only recorded argv would make
  // every opener assertion vacuous.
  m.create = async (...args) => {
    if (createThrows) throw new Error(createThrows);
    created.push(args);
    m.sessions.set(args[0], {
      name: args[0], type: args[1], agentType: args[1], cwd: args[2], activityState: 'idle',
    });
  };
  const seat = { name: 'a', type: 'claude', agentType: 'claude', cwd: projectRoot, activityState: 'idle', workspaceId: 'ws1' };
  m.sessions.set('a', seat);
  const readTeam = (name) => JSON.parse(fsReal.readFileSync(pathReal.join(home, 'teams', name, 'team.json'), 'utf-8'));
  const teamExists = (name) => fsReal.existsSync(pathReal.join(home, 'teams', name, 'team.json'));
  const toSeat = (name) => perSeat.filter((e) => e.seat === name).map((e) => e.text);
  return { m, injected, toSeat, created, refreshes, seat, home, projectRoot, readTeam, teamExists, tm };
}

module.exports = { mk, mkPark, mkTeamCreate };
