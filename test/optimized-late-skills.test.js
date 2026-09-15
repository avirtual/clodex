'use strict';

// optimized-late-skills.test.js — t918. "Clodex optimized" must deny the skills
// that only appear AFTER the seat is created.
//
// THE SUBJECT IS THE SPAWN, NOT THE DIALOG. A pin that inspects the checkbox
// list passes while the bug is fully present: the list renders what is known NOW
// in both shapes. What differs is the `disabledSkills` the dialog persists and
// what create() makes of it, so these read `settings.skillOverrides` — the file
// the CLI itself reads — after a real create() through the real setupClaudeHook.
// The renderer half runs as SHIPPED SOURCE for the same reason
// test/optimized-mode-subset.test.js does: a re-typed copy of the collect would
// assert only that this file agrees with itself.

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
      const OFF = 'input[type="checkbox"]:not(:checked):not(:disabled)';
      const TOGGLEABLE = 'input[type="checkbox"]:not(:disabled)';
      assert.ok(sel === OFF || sel === TOGGLEABLE, `unexpected selector: ${sel}`);
      const flat = [];
      const walk = (n) => { for (const c of n.children) { flat.push(c); walk(c); } };
      walk(e);
      return flat.filter((c) => c.tagName === 'input' && c.type === 'checkbox' && !c.disabled
        && (sel === TOGGLEABLE || !c.checked));
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
  extract(/\n(function resetNewSessionSkillCollector\([\s\S]*?\n\})\n/, 'resetNewSessionSkillCollector'),
  extract(/\n(async function refreshNewSessionSkills\([\s\S]*?\n\})\n/, 'refreshNewSessionSkills'),
  extract(/\n(function newSessionSkillDenyList\([\s\S]*?\n\})\n/, 'newSessionSkillDenyList'),
  extract(/\n(function populateChecklistsFromCatalogs\([\s\S]*?\n\})\n/, 'populateChecklistsFromCatalogs'),
].join('\n');

// What the New Session dialog would persist as `disabledSkills` for a claude
// seat in this mode. The settings payload and catalog come from the given
// engine, so no literal here can stand in for what the app would store.
async function dialogDisabledSkills(engine, mode, {
  thenPlaceInSandbox = false, lowerLayerOff = null, afterRender = null, allReadOnly = false,
} = {}) {
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
  // a skill off there renders read-only and never enters clodex's off list —
  // correct in the product, and here it would make the pins depend on whose box
  // runs them. Only `effective` is dropped; the names stay as served.
  const catalog = {
    ...served,
    effective: allReadOnly
      ? Object.fromEntries(served.names.map((n) => [n, { value: 'off', source: 'global' }]))
      : (lowerLayerOff ? { [lowerLayerOff]: { value: 'off', source: 'global' } } : {}),
    canReenable: false,
  };
  if (lowerLayerOff) {
    assert.ok(served.names.includes(lowerLayerOff),
      `ENTER: '${lowerLayerOff}' is in the served catalog — a read-only row that never draws pins nothing`);
  }
  const settings = handlers.get('settings:get')();

  const had = global.document;
  global.document = { createElement: el, addEventListener() {} };
  try {
    const inputSkillsList = el('div');
    const noop = () => {};
    const { skillOffSetFor, deferredSkillDeny, skillDenyIsDeferred, skillDenyKeepList } = require('../skills-off');
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
      skillOffSetFor, deferredSkillDeny, skillDenyIsDeferred, skillDenyKeepList,
      newSessionSkillsDeferred: false,
      newSessionSkillsDrawn: [],
      newSessionSkillsAsked: [],
      window: { api: { getSkillCatalogFor: async () => catalog } },
      // The rest of populateChecklistsFromCatalogs — only its skill arm is real.
      setAgentLibCache: noop, renderAgentChecklist: noop,
      setSkillLibCache: noop, renderInjectChecklist: noop,
      setClaudeToolsCache: noop, renderToolChecklist: noop, renderBuiltinChecklist: noop,
      modeToolDenySet: () => new Set(), modeBuiltinDenySet: () => new Set(),
      refreshNewSessionExecCommands: noop,
      refreshNewSessionPlugins: () => Promise.resolve(),
      refreshNewSessionIntents: noop,
      setPromptLibCache: noop, libraryPromptCache: (p) => p,
      fillSystemPromptSelect: noop, renderAppendChecklist: noop,
      setProxyControls: noop, newSessionSeat: () => ({ plugins: [] }),
      inputAgentsList: el('div'), inputInjectSkillsList: el('div'),
      inputToolsList: el('div'), inputBuiltinsList: el('div'),
      inputAppendList: el('div'), inputSystemPrompt: { value: '' },
      inputProxyMode: { value: '' }, inputProxyUrl: { value: '' },
      afterRender: afterRender || noop,
    };
    const names = Object.keys(env);
    const run = new Function(...names, `${SHIPPED}
      return (async () => {
        await refreshNewSessionSkills(modeSkillDenySet());
        ${thenPlaceInSandbox ? 'populateChecklistsFromCatalogs({ skills: [], claudeTools: [] });' : ''}
        afterRender(inputSkillsList);
        return { persisted: newSessionSkillDenyList(), rows: inputSkillsList.children.map((r) => {
          const cb = r.children.find((x) => x.tagName === 'input');
          return { name: cb.value, checked: cb.checked };
        }) };
      })();`);
    return await run(...names.map((n) => env[n]));
  } finally { global.document = had; }
}

// The Preferences default, through the SHIPPED pair.
async function prefsSkillDefault(engine, stored, { afterRender = null, lowerLayerOff = null } = {}) {
  const handlers = new Map();
  registerIpcHandlers({
    ...engine, ...engine.stores,
    handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn), log: silent,
  });
  const served = handlers.get('settings:skillCatalogFor')(null, null);
  assert.ok(served.ok && served.names.length, 'ENTER: the engine served a non-empty skill catalog');

  const had = global.document;
  global.document = { createElement: el, addEventListener() {} };
  try {
    const prefsSkillsList = el('div');
    const mod = require('../skills-off');
    const env = {
      prefsSkillsList,
      homeDir: os.homedir(),
      renderSkillChecklist: checklists.renderSkillChecklist,
      collectSkillChecklist: checklists.collectSkillChecklist,
      skillOffSetFor: mod.skillOffSetFor,
      deferredSkillDeny: mod.deferredSkillDeny,
      skillDenyIsDeferred: mod.skillDenyIsDeferred,
      skillDenyKeepList: mod.skillDenyKeepList,
      prefsSkillDenyStored: [],
      prefsSkillNamesDrawn: [],
      window: {
        api: {
          getSkillCatalogFor: async () => ({
            ...served,
            // Every row read-only: a global-settings off clodex cannot re-enable.
            effective: lowerLayerOff
              ? Object.fromEntries(served.names.map((n) => [n, { value: 'off', source: 'global' }]))
              : {},
            canReenable: false,
          }),
        },
      },
      afterRender: afterRender || (() => {}),
    };
    const names = Object.keys(env);
    const shipped = [
      extract(/\n(async function renderPrefsSkillDefaults\([\s\S]*?\n\})\n/, 'renderPrefsSkillDefaults'),
      extract(/\n(function collectPrefsSkillDefaults\([\s\S]*?\n\})\n/, 'collectPrefsSkillDefaults'),
    ].join('\n');
    const run = new Function(...names, `${shipped}
      return (async () => {
        await renderPrefsSkillDefaults(${JSON.stringify(stored)});
        afterRender(prefsSkillsList);
        return { saved: collectPrefsSkillDefaults(), rows: prefsSkillsList.children.map((r) => {
          const cb = r.children.find((x) => x.tagName === 'input');
          return { name: cb.value, checked: cb.checked };
        }) };
      })();`);
    return await run(...names.map((n) => env[n]));
  } finally { global.document = had; }
}

// A session-manager wired to the REAL setupClaudeHook, so the assertion lands on
// the settings file the CLI reads, and to the engine's own `knownSkillNames` —
// the same dep the app passes, read at spawn.
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

// A root with nothing on it: no agent-defaults.json (the floor's tri-state
// ABSENT case) and no skills-seen.json (the seed is then all `*` can expand
// against). This IS the new-install case the operator hits.
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

  // Named literally: deriving the expectation from the catalog the product read
  // would pass on any curation, including 5.68.0's inverted one.
  for (const denied of ['design', 'artifact-design', 'artifact-capabilities']) {
    assert.strictEqual(settings.skillOverrides[denied], 'off',
      `optimized must spawn with '${denied}' off — it is an Artifact-publishing flow, not repo work`);
  }
  for (const kept of ['dataviz', 'artifact-diagramming', 'code-review']) {
    assert.ok(!(kept in settings.skillOverrides),
      `optimized must NOT deny '${kept}' — the keep list is what makes this a curated subset rather than "no skills"`);
  }
  // A directive is not a skill name, so one reaching the file turns off nothing.
  assert.ok(!Object.keys(settings.skillOverrides).some((k) => k === '*' || k.startsWith('!')),
    'the directives must be resolved away before the settings file is written');
});

test('t918 pin 2: a skill that becomes known only AFTER the choice was made is denied at spawn', async () => {
  const box = freshBox();
  const { persisted, rows } = await dialogDisabledSkills(box.engine, 'optimized');
  // ENTER: the name really was invisible when the operator chose. Without this a
  // snapshot that happened to contain it would satisfy the assertion below.
  assert.ok(!rows.some((r) => r.name === 'announced-on-first-turn'),
    'ENTER: the late skill was NOT in the dialog — otherwise this is not the deferred case');
  assert.ok(!persisted.includes('announced-on-first-turn'),
    'ENTER: and the persisted list does not name it either');

  // The seat runs its first turn and the CLI announces a skill nobody had seen.
  // `skillsSeen.record` is the write `readSkillCatalog` makes off a transcript.
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
  // explicitly chose to deny NOTHING must not have it resurrected for them.
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

test('t918 pin 4: switching Placement to a sandbox re-asks for the floor, never this Mac\'s names', async () => {
  const box = freshBox();
  const host = await dialogDisabledSkills(box.engine, 'optimized');
  assert.ok(host.rows.length >= 5,
    'ENTER: the host render drew rows — a collector that never held names cannot go stale');

  const { persisted, rows } = await dialogDisabledSkills(box.engine, 'optimized',
    { thenPlaceInSandbox: true });
  assert.deepStrictEqual(rows, [],
    'ENTER: the sandbox fill empties the container — the box serves its own catalog and has none yet');

  // The failure this forbids: the host render's names survive as the KEEP list,
  // so the far box denies (its catalog − this Mac's) — exempting the skills
  // optimized means to deny and denying ones the operator never saw.
  const floor = box.engine.stores.agentDefaults.getDefaultSkillDeny();
  const asKeep = new Set(floor.filter((n) => n.startsWith('!')).map((n) => n.slice(1)));
  const localOnly = host.rows.map((r) => r.name).filter((n) => !asKeep.has(n));
  assert.ok(localOnly.length >= 3,
    'ENTER: this Mac drew names the floor does not keep — otherwise a stale collector would be indistinguishable');
  for (const local of localOnly) {
    assert.ok(!persisted.includes(`!${local}`),
      `'${local}' was drawn from THIS Mac's catalog — exempting it on the far box inverts the denial`);
  }
  assert.deepStrictEqual([...persisted].sort(), [...floor].sort(),
    'the floor passes through unresolved, for the far box to resolve against its own catalog');
});

test('t918 pin 5: a box create sends a plain list, because an old peer reads `!x` as a skill name', async () => {
  const { skillDenyForPeer, expandSkillsOff } = require('../skills-off');
  const floor = require('../catalogs').DEFAULT_SKILL_DENY_FLOOR;
  assert.ok(floor.includes('*') && floor.some((n) => n.startsWith('!')),
    'ENTER: the floor really is a directive list — otherwise this pin is about nothing');

  assert.deepStrictEqual(skillDenyForPeer(floor), [],
    'a directive list must not cross the create-on-peer wire: pre-t918 that path sent no denial at all');
  assert.deepStrictEqual(skillDenyForPeer(['review', 'init']), ['review', 'init'],
    'a plain list is understood by every version and passes through');

  // The pre-t918 expandSkillsOff, which reads `!dataviz` as an ordinary name.
  const oldPeerExpand = (list, known) => (!list.includes('*') ? list
    : [...new Set([...list, ...known])].filter((n) => n !== '*').sort());
  const onOldPeer = oldPeerExpand(floor, ['dataviz', 'design', 'box-only-skill']);
  assert.ok(onOldPeer.includes('box-only-skill') && onOldPeer.includes('!dataviz'),
    'ENTER: an old peer denies every known name and writes the exemption as a literal — the shape being avoided');
  assert.ok(!expandSkillsOff(floor, { known: ['dataviz', 'design'] }).includes('dataviz'),
    'a t918 peer would have honoured it — the send-plain choice is about versions, not about the shape being wrong');

  // assert.ok, not assert.match: a failing match serializes the whole 336KB
  // renderer source as `actual`, which takes node minutes to diff.
  const renderer = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  assert.ok(/disabledSkills: skillDenyForPeer\(disabledSkills\)/.test(renderer),
    'the box-create spec must route through it — the host spawn arm keeps the directives');
});

test('t918 pin 7: a lean `["*"]` template loaded into the dialog saves as `*` again, not as this box\'s names', async () => {
  // The divergence docs/teams.md asserts in prose: a popover save collapses the
  // sentinel to names (t769), the template editor and New Session keep it.
  const box = freshBox();
  box.engine.stores.agentDefaults.setDefaultSkillDeny(['*']);
  const { persisted, rows } = await dialogDisabledSkills(box.engine, 'optimized');
  assert.ok(rows.length && rows.every((r) => !r.checked),
    'ENTER: `*` renders as every row unticked — that is what the seat runs with');
  assert.strictEqual(persisted[0], '*',
    'a save must stay portable: names frozen here are this box\'s catalog, not "whatever the box knows"');
  assert.deepStrictEqual(persisted, ['*'],
    'nothing was re-ticked, so there is no exemption to carry');

  // And re-ticking one row narrows the sweep rather than collapsing it.
  const narrowed = await dialogDisabledSkills(box.engine, 'optimized', {
    afterRender: (list) => {
      const cb = list.children
        .map((r) => r.children.find((x) => x.tagName === 'input'))
        .find((c) => c && c.value === 'dataviz' && !c.disabled);
      assert.ok(cb, 'ENTER: the row to re-tick drew and is toggleable');
      cb.checked = true;
    },
  });
  assert.deepStrictEqual(narrowed.persisted, ['*', '!dataviz'],
    'one tick is one exemption — every other skill, including ones announced later, stays denied');
});

test('t918 pin 6: a read-only row never becomes a keep', async () => {
  const box = freshBox();
  // The floor DENIES `design`, so no keep asks for it; a lower-layer off makes
  // its row read-only, which takes it out of the collected off list — and an
  // unfiltered collector reads that absence as "still ticked".
  const locked = await dialogDisabledSkills(box.engine, 'optimized', { lowerLayerOff: 'design' });
  const row = locked.rows.find((r) => r.name === 'design');
  assert.ok(row && !row.checked,
    'ENTER: the read-only row drew unticked — clodex cannot re-enable a lower-layer off');
  assert.ok(!locked.persisted.includes('!design'),
    "a row this box owns from a LOWER layer must not travel as a keep: on another box it would read as 'turn it on'");
  assert.ok(locked.persisted.includes('*'),
    'and the denial is still deferred — dropping the read-only row is not dropping the mechanism');
});

test('t918 pin 8: Check All means deny nothing, not "deny whatever arrives later"', async () => {
  // Separate from pin 6 deliberately: both guard the same collector, and a
  // shared test stops at the first assert, masking the second defect.
  const box = freshBox();
  const all = await dialogDisabledSkills(box.engine, 'optimized', {
    afterRender: (list) => {
      for (const r of list.children) {
        const cb = r.children.find((x) => x.tagName === 'input');
        if (cb && !cb.disabled) cb.checked = true;
      }
    },
  });
  assert.ok(all.rows.length, 'ENTER: rows drew, so there was something to tick');
  assert.deepStrictEqual(all.persisted, [],
    'the ticks say "deny nothing"; re-emitting `*` would still deny whatever the CLI announces later');
});

test('t918 pin 9: Preferences can still express "deny nothing", and the floor is not a dead end', async () => {
  const box = freshBox();
  const floor = box.engine.stores.agentDefaults.getDefaultSkillDeny();
  assert.ok(require('../skills-off').skillDenyIsDeferred(floor),
    'ENTER: the shipped floor really is deferred — against a plain list this collector never branched');

  // Check All in Preferences: one click, and it means "deny nothing by default".
  const all = await prefsSkillDefault(box.engine, floor, {
    afterRender: (list) => {
      for (const r of list.children) {
        const cb = r.children.find((x) => x.tagName === 'input');
        if (cb && !cb.disabled) cb.checked = true;
      }
    },
  });
  assert.ok(all.rows.length, 'ENTER: rows drew, so there was something to tick');
  assert.deepStrictEqual(all.saved, [],
    'every row ticked must save [], not `*` plus today\'s names: the latter denies every skill announced '
    + 'later AND is sticky — the deferred list comes back next visit, so [] becomes unreachable from the UI');

  // The rest of the collector is unchanged: untick one row and the deferral and
  // its keep list survive.
  const one = await prefsSkillDefault(box.engine, floor, {
    afterRender: (list) => {
      const cb = list.children
        .map((r) => r.children.find((x) => x.tagName === 'input'))
        .find((c) => c && c.value === 'dataviz' && !c.disabled);
      assert.ok(cb, 'ENTER: a toggleable row to untick');
      cb.checked = false;
    },
  });
  assert.ok(one.saved.includes('*'),
    'one row off still means "deny everything at spawn, except the ones left ticked"');
  assert.deepStrictEqual(
    require('../skills-off').skillDenyKeepList(one.saved).sort(),
    require('../skills-off').skillDenyKeepList(floor).filter((n) => n !== 'dataviz').sort(),
    'exactly the floor\'s keeps minus the one just unticked — a collector that dropped every exemption '
    + 'and returned a bare `["*"]` would satisfy a "does not include !dataviz" check');
});

test('t918 pin 10: an all-read-only render saves the stored floor, not an empty default', async () => {
  // `off` is [] when nothing COULD be ticked, not only when the operator ticked
  // everything — collectSkillChecklist skips disabled rows. Storing [] there is
  // unrecoverable: stores.js reads an explicit [] as "deny nothing" forever, and
  // the shipped floor cannot be got back from this UI.
  const box = freshBox();
  const floor = box.engine.stores.agentDefaults.getDefaultSkillDeny();
  const locked = await prefsSkillDefault(box.engine, floor, { lowerLayerOff: true });
  assert.ok(locked.rows.length && locked.rows.every((r) => !r.checked),
    'ENTER: rows drew and every one is read-only, so the collect is empty for the other reason');
  assert.deepStrictEqual(locked.saved, floor,
    'a render clodex owns no row in must save the stored list back verbatim');
});

test('t918 pin 11: the New Session collector keeps the asked floor when no row is toggleable', async () => {
  // The twin of pin 10. `newSessionSkillsDrawn.length` guards the UNPAINTED
  // container; an all-read-only one is painted and still collects [].
  const box = freshBox();
  const locked = await dialogDisabledSkills(box.engine, 'optimized', { allReadOnly: true });
  assert.ok(locked.rows.length && locked.rows.every((r) => !r.checked),
    'ENTER: rows drew and none is clodex\'s to toggle');
  assert.deepStrictEqual([...locked.persisted].sort(),
    [...box.engine.stores.agentDefaults.getDefaultSkillDeny()].sort(),
    'the asked floor rides through, rather than collapsing to "deny nothing"');
});

// createEngine leaves background timers running; the same force-exit every other
// createEngine file uses.
test('done', () => { setImmediate(() => process.exit(0)); });
