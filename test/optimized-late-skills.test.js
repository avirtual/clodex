'use strict';

// optimized-late-skills.test.js — t918. "Clodex optimized" must deny the skills
// that only appear AFTER the seat is created.
//
// The defect: optimized mode resolved its denial at dialog-render time, from a
// snapshot of the names known while the dialog was open. Every skill the CLI
// announces on the seat's first turn was therefore absent from that snapshot and
// arrived ENABLED, and the operator paid create -> first turn -> edit skills ->
// reload to remove skills that were always going to appear.
//
// THE SUBJECT IS THE SPAWN, NOT THE DIALOG. A pin that inspects the checkbox
// list passes while the bug is fully present: the list is correct in both
// shapes, since it renders what is known NOW either way. What differs is the
// `disabledSkills` the dialog persists and what `create()` makes of it, so the
// assertions below read `settings.skillOverrides` — the file the CLI itself
// reads — after a real create() through the real setupClaudeHook.
//
// The renderer half runs as SHIPPED SOURCE (the idiom of
// test/optimized-mode-subset.test.js): renderer.js cannot be required, and a
// re-typed copy of the collect would assert only that this file agrees with
// itself. The engine half is the real engine over a real fresh root, because
// "fresh root" is the whole premise of pin 1 and a stubbed catalog cannot be
// fresh.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const { createEngine } = require('../engine');
const { registerIpcHandlers } = require('../ipc-handlers');
const { createSessionManager } = require('../session-manager');
const { createCliHooks } = require('../cli-hooks');
const { pathFor, runDirFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

const silent = { info() {}, warn() {}, error() {} };

function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false, disabled: false,
    children: [],
    appendChild(c) { e.children.push(c); return c; },
    querySelectorAll(sel) {
      // Spelled out rather than pattern-matched: a stub answering every selector
      // with everything would make the collect below vacuous.
      assert.strictEqual(sel, 'input[type="checkbox"]:not(:checked):not(:disabled)');
      const flat = [];
      const walk = (n) => { for (const c of n.children) { flat.push(c); walk(c); } };
      walk(e);
      return flat.filter((c) => c.tagName === 'input' && c.type === 'checkbox' && !c.checked && !c.disabled);
    },
  };
  let text = '';
  Object.defineProperty(e, 'textContent', { get: () => text, set(v) { text = v == null ? '' : String(v); } });
  let html = '';
  Object.defineProperty(e, 'innerHTML', {
    get: () => html,
    set(v) { html = v == null ? '' : String(v); e.children.length = 0; },
  });
  return e;
}

const hadDoc = global.document;
global.document = { createElement: el, addEventListener() {} };
const checklists = require('../renderer/lib/checklists');
global.document = hadDoc;

function extract(re, what) {
  const m = re.exec(rendererSrc);
  assert.ok(m, `ENTER: ${what} was not found in renderer.js — every assertion below would be vacuous`);
  return m[1];
}

const SHIPPED = [
  extract(/\n(function modeSkillDenySet\([\s\S]*?\n\})\n/, 'modeSkillDenySet'),
  extract(/\n(async function refreshNewSessionSkills\([\s\S]*?\n\})\n/, 'refreshNewSessionSkills'),
  extract(/\n(function newSessionSkillDenyList\([\s\S]*?\n\})\n/, 'newSessionSkillDenyList'),
].join('\n');

// What the New Session dialog would persist as `disabledSkills` for a claude
// seat in this mode, on this box. Runs the shipped statements against the real
// checklist renderer and the REAL settings payload + skill catalog the given
// engine serves — no name list is written here, so a test-local literal can
// never stand in for what the app would actually store.
async function dialogDisabledSkills(engine, mode) {
  const handlers = new Map();
  registerIpcHandlers({
    ...engine,
    ...engine.stores,
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: silent,
  });
  const served = handlers.get('settings:skillCatalogFor')(null, null);
  assert.ok(served.ok && served.names.length,
    'ENTER: the engine served a non-empty skill catalog — an empty one makes every row assertion vacuous');
  // The engine reads the REAL ~/.claude/settings.json for lower-layer state, and
  // a skill off there renders read-only and never enters clodex's off list. That
  // is correct product behaviour and wrong for a pin: it would make these
  // assertions depend on whose box runs them. The names stay as served.
  const catalog = { ...served, effective: {} };
  const settings = handlers.get('settings:get')();

  const had = global.document;
  global.document = { createElement: el, addEventListener() {} };
  try {
    const inputSkillsList = el('div');
    const { skillOffSetFor, deferredSkillDeny, skillDenyIsDeferred } = require('../skills-off');
    const env = {
      inputMode: { value: mode },
      inputType: { value: 'claude' },
      inputCwd: { value: '/tmp/proj' },
      inputSkillsList,
      expandPath: (p) => p,
      homeDir: os.homedir(),
      getDefaultSkillDenyCache: () => settings.defaultSkillDeny || [],
      renderSkillChecklist: checklists.renderSkillChecklist,
      collectSkillChecklist: checklists.collectSkillChecklist,
      advisoryEffective: (e) => e || {},
      skillOffSetFor, deferredSkillDeny, skillDenyIsDeferred,
      newSessionSkillsDeferred: false,
      newSessionSkillsDrawn: [],
      newSessionSkillsAsked: [],
      window: { api: { getSkillCatalogFor: async () => catalog } },
    };
    const names = Object.keys(env);
    const run = new Function(...names, `${SHIPPED}
      return (async () => {
        await refreshNewSessionSkills(modeSkillDenySet());
        return { persisted: newSessionSkillDenyList(), rows: inputSkillsList.children.map((r) => {
          const cb = r.children.find((x) => x.tagName === 'input');
          return { name: cb.value, checked: cb.checked };
        }) };
      })();`);
    return await run(...names.map((n) => env[n]));
  } finally { global.document = had; }
}

// A session-manager wired to the REAL setupClaudeHook, so what is asserted is
// the settings file the CLI reads, and to the given engine's own
// `knownSkillNames` — the same dep the app passes, read at spawn.
function mkSpawner(registryRoot, knownSkillNames) {
  const store = new Map();
  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {},
  };
  const hooks = createCliHooks({
    REGISTRY_DIR: registryRoot,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
  const SessionManager = createSessionManager({
    REGISTRY_DIR: registryRoot,
    fs, path, os, pathFor, runDirFor,
    PENDING_DIR: path.join(registryRoot, 'pending'),
    MSG_DIR: path.join(registryRoot, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: { spawn: () => ({ onData() {}, onExit() {}, pid: 999 }) },
    notifyOS: () => {},
    log: silent,
    setupClaudeHook: hooks.setupClaudeHook,
    setupCodexHook: () => {},
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkills: () => {},
    deliverSkills: () => null, skillDeliveryProviders: () => ['claude', 'codex'],
    buildIpcPrompt: () => '', writeClaudeDigestFile: () => false,
    resolveProxyAgentId: () => null,
    normalizeProxyBase: (v) => v,
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv: () => ({ ...process.env }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => os.tmpdir(),
    resolveTeam: () => null,
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: () => null,
    mergeClaudeSystemPrompt: (a) => ({ cleaned: [...a], append: null }),
    readAppendBodies: () => [],
    pluginGrammarLines: () => [],
    effectiveInjectedAgents: () => [],
    effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [],
    codexStatusLineArg: () => [],
    writeAgentPlugin: () => null,
    cleanupAgentPlugin: () => {},
    qualifiedAgentName: (n) => n,
    getPromptLibrary: () => ({ list: () => [] }),
    readSystemPromptBody: () => null,
    seatBundles: () => [],
    bundleSkills: () => [],
    writeBundles: () => null,
    bakePrompt: () => '',
    versionNoticeFor: () => null,
    enqueueNotice: () => {},
    clearNotices: () => {},
    mergeCodexInstructions: (a) => a,
    knownSkillNames,
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  return {
    persistence,
    async spawn(name, disabledSkills) {
      try {
        await m.create(name, 'claude', os.tmpdir(), [], null, 'ws', null, false, null,
          [], [], [], disabledSkills, []);
      } finally {
        const s = m.sessions.get(name);
        if (s) {
          try { if (s.sentinel) s.sentinel.stop(); } catch {}
          try { if (s.watcher) s.watcher.stop(); } catch {}
          try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
          clearTimeout(s._bootDrainTimer);
        }
      }
      const p = pathFor(registryRoot, name, 'settings');
      assert.ok(fs.existsSync(p),
        'ENTER: create() must reach setupClaudeHook — no settings file means the assertions below inspect nothing');
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    },
  };
}

// A root with nothing on it: no agent-defaults.json (so the floor is the
// tri-state ABSENT case) and no skills-seen.json (so the seed is the only thing
// `*` has to expand against). This IS the new-install case the operator hits.
function freshBox() {
  const tmp = mkTmpRoot('clx-t918-');
  const registryDir = path.join(tmp, 'clodex-home');
  fs.mkdirSync(path.join(registryDir, 'run'), { recursive: true });
  const engine = createEngine({ userDataPath: tmp, seams: { registryDir }, log: silent });
  assert.ok(!fs.existsSync(path.join(tmp, 'agent-defaults.json')),
    'ENTER: no stored defaults — otherwise this is not the shipped-floor case');
  assert.ok(!fs.existsSync(path.join(tmp, 'skills-seen.json')),
    'ENTER: no skills-seen.json — otherwise `*` has more than the seed to expand against');
  return { tmp, registryDir, engine };
}

test('t918 pin 1: on a fresh root, optimized spawns with the denied built-ins already off', async () => {
  const box = freshBox();
  const { persisted, rows } = await dialogDisabledSkills(box.engine, 'optimized');
  assert.ok(rows.length, 'ENTER: the checklist drew rows');

  const settings = await mkSpawner(box.registryDir, box.engine.knownSkillNames).spawn('opt', persisted);

  // The five built-ins a live session reported the shipping CLI offers, split by
  // the operator's curation. Named literally: the point is WHICH skills a seat
  // gets, so deriving the expectation from the same catalog the product read
  // would pass on any curation at all, including an inverted one.
  for (const denied of ['design', 'artifact-design', 'artifact-capabilities']) {
    assert.strictEqual(settings.skillOverrides[denied], 'off',
      `optimized must spawn with '${denied}' off — it is an Artifact-publishing flow, not repo work`);
  }
  for (const kept of ['dataviz', 'artifact-diagramming', 'code-review']) {
    assert.ok(!(kept in settings.skillOverrides),
      `optimized must NOT deny '${kept}' — the keep list is what makes this a curated subset rather than "no skills"`);
  }
  // And `*` itself must never reach the CLI: it is not a skill name, so a
  // settings file carrying it turns off nothing at all, silently.
  assert.ok(!Object.keys(settings.skillOverrides).some((k) => k === '*' || k.startsWith('!')),
    'the directives must be resolved away before the settings file is written');
});

test('t918 pin 2: a skill that becomes known only AFTER the choice was made is denied at spawn', async () => {
  const box = freshBox();
  const { persisted, rows } = await dialogDisabledSkills(box.engine, 'optimized');
  // ENTER: the name really was invisible when the operator chose. Without this,
  // the assertion below could be satisfied by a snapshot that happened to
  // contain it, which is exactly the shape this test exists to red on.
  assert.ok(!rows.some((r) => r.name === 'announced-on-first-turn'),
    'ENTER: the late skill was NOT in the dialog — otherwise this is not the deferred case');
  assert.ok(!persisted.includes('announced-on-first-turn'),
    'ENTER: and the persisted list does not name it either');

  // The seat runs its first turn and the CLI announces a skill nobody had seen.
  // `skillsSeen.record` is the same write `readSkillCatalog` makes off a real
  // transcript; going through the store rather than a stub keeps the spawn
  // reading the same union the app reads.
  box.engine.stores.skillsSeen.record(['announced-on-first-turn']);

  const settings = await mkSpawner(box.registryDir, box.engine.knownSkillNames).spawn('late', persisted);
  assert.strictEqual(settings.skillOverrides['announced-on-first-turn'], 'off',
    'a skill known only at spawn must be denied without a second visit to the dialog — this is the '
    + "operator's create -> first turn -> edit skills -> reload cycle, and denying it here is what removes it");
  assert.ok(!('dataviz' in settings.skillOverrides),
    'and the keep list still survives the late expansion — a deferral that forgot its exemptions is "no skills"');
});

test('t918 pin 3: standard writes no skill denial, and an explicit empty choice still wins', async () => {
  const box = freshBox();
  const { persisted } = await dialogDisabledSkills(box.engine, 'standard');
  assert.deepStrictEqual(persisted, [],
    'standard means "the CLI as-is" — any denial here, and especially a leaked `*`, is a regression');
  const settings = await mkSpawner(box.registryDir, box.engine.knownSkillNames).spawn('std', persisted);
  assert.ok(!('skillOverrides' in settings),
    'an empty off list must write no skillOverrides key at all');

  // The v5.68.0 guarantee, re-asserted against the new floor: an operator who
  // explicitly chose to deny NOTHING must not have the floor resurrected for
  // them, and their explicit choice is now what optimized reads too.
  const box2 = freshBox();
  box2.engine.stores.agentDefaults.setDefaultSkillDeny([]);
  assert.deepStrictEqual(box2.engine.stores.agentDefaults.getDefaultSkillDeny(), [],
    'an explicit [] means deny nothing — the deferred floor must not resurrect itself');
  const own = await dialogDisabledSkills(box2.engine, 'optimized');
  assert.deepStrictEqual(own.persisted, [],
    "optimized renders and persists the operator's own empty list, not the shipped floor");

  // And a non-empty explicit choice stays a plain name list: deferral is the
  // FLOOR's shape, not something imposed on a list the operator curated.
  const box3 = freshBox();
  box3.engine.stores.agentDefaults.setDefaultSkillDeny(['review', 'init']);
  const curated = await dialogDisabledSkills(box3.engine, 'optimized');
  assert.deepStrictEqual(curated.persisted.sort(), ['init', 'review'],
    "the operator's own skill list, verbatim and undeferred");
});

// createEngine leaves background timers running; the same force-exit every other
// createEngine file uses.
test('done', () => { setImmediate(() => process.exit(0)); });
