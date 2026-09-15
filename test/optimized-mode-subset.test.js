'use strict';

// optimized-mode-subset.test.js — t913. "Clodex optimized" must mean a curated
// SUBSET and "Standard" must mean all of it, end to end over a mode change.
//
// The defect this pins shipped because test/new-session-modes.test.js pins
// which mode the dialog OPENS on and which function each mode CALLS, never what
// either mode DOES to the rows. Against stub deny caches those call assertions
// pass no matter what the real floors contain — and on a root with no
// agent-defaults.json the real floors left 33 of 44 tools checked in optimized
// and made the skills category a literal no-op (the floor was `[]`, so both
// modes rendered the same empty deny set).
//
// So the subject here is the CHECKED SETS, not the calls: run the shipped
// renderer statements against the real checklists.js render functions, with the
// settings payload a FRESH root actually serves, switch the mode through the
// shipped listener, and compare the sets the operator would see. Sets, never
// counts — a count assertion passes on a render that swapped two rows.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const { capsFor } = require('../renderer/lib/provider-caps');
const {
  CLAUDE_TOOLS, OPTIMIZED_TOOLS, DEFAULT_TOOL_DENY_FLOOR,
  CLAUDE_SKILLS, OPTIMIZED_SKILLS, DEFAULT_SKILL_DENY_FLOOR,
  DEFAULT_BUILTIN_DENY_FLOOR,
} = require('../catalogs');
const { BUILTIN_AGENTS } = require('../agents-util');
const { initStores } = require('../stores');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { skillOffSetFor, skillDenyIsDeferred, expandSkillsOff } = require('../skills-off');

// --- the minimum DOM the render functions touch ---------------------------

// Same shape as test/new-session-modes.test.js's stub, plus the one behaviour
// this file depends on that it omits: `innerHTML = ''` must CLEAR the children.
// Every render function starts with that clear, so a stub that ignores it lets
// the second mode's rows accumulate on top of the first's — and then both
// "checked sets" are supersets that differ, which is the exact false GREEN this
// test exists to produce a red for.
function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false, disabled: false,
    children: [],
    appendChild(c) { e.children.push(c); return c; },
    querySelectorAll() { return []; },
  };
  let text = '';
  Object.defineProperty(e, 'textContent', {
    get: () => text,
    set(v) { text = v == null ? '' : String(v); },
  });
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
  extract(/\n(function modeToolDenySet\([\s\S]*?\n\})\n/, 'modeToolDenySet'),
  extract(/\n(function modeSkillDenySet\([\s\S]*?\n\})\n/, 'modeSkillDenySet'),
  extract(/\n(function modeBuiltinDenySet\([\s\S]*?\n\})\n/, 'modeBuiltinDenySet'),
  extract(/\n(function setModeSelect\([\s\S]*?\n\})\n/, 'setModeSelect'),
  extract(/\n(function applyModeFields\([\s\S]*?\n\})\n/, 'applyModeFields'),
  extract(/\n(function populateHostCatalogs\([\s\S]*?\n\})\n/, 'populateHostCatalogs'),
  extract(/\n(function resetNewSessionSkillCollector\([\s\S]*?\n\})\n/, 'resetNewSessionSkillCollector'),
  extract(/\n(async function refreshNewSessionSkills\([\s\S]*?\n\})\n/, 'refreshNewSessionSkills'),
  extract(/\n(async function refreshNewSessionTools\([\s\S]*?\n\})\n/, 'refreshNewSessionTools'),
].join('\n');
const MODE_LISTENER = extract(
  /\n(if \(inputMode\) \{\n  inputMode\.addEventListener[\s\S]*?\n\})\n/, "the mode select's change listener");

// The two catalog refreshers are async and the shipped call sites do not await
// them, so the harness records their promises to await before reading rows.
// Only the CALLS are wrapped, never the declarations.
function trackAsyncCalls(src) {
  return src.replace(
    /(?<!async function )\b(refreshNewSession(?:Skills|Tools))\(([^;\n]*)\);/g,
    '__track($1($2));');
}

// Drives the dialog the way the app does: open in one mode, then fire the
// shipped change listener to switch. Returns the CHECKED name lists per
// category, in catalog order.
async function runDialog(settings, { type = 'claude', openIn, switchTo } = {}) {
  const had = global.document;
  global.document = { createElement: el, addEventListener() {} };
  try {
    const inputToolsList = el('div');
    const inputSkillsList = el('div');
    const inputBuiltinsList = el('div');
    const pending = [];
    const inputMode = {
      value: openIn,
      querySelector: () => ({ hidden: true }),
      addEventListener: (ev, fn) => { inputMode._fire = fn; },
    };
    const env = {
      inputMode,
      inputType: { value: type },
      inputCwd: { value: '/tmp/proj' },
      expandPath: (p) => p,
      homeDir: '/home/x',
      inputToolsList, inputSkillsList, inputBuiltinsList,
      inputAgentsList: el('div'),
      modeHint: { textContent: '' },
      advancedSection: { open: false },
      MODE_HINTS: { optimized: 'o', standard: 's', custom: 'c' },
      // The REAL caps table and the REAL render functions: stubbing either
      // would assert only that this file agrees with itself.
      capsFor,
      renderToolChecklist: checklists.renderToolChecklist,
      renderSkillChecklist: checklists.renderSkillChecklist,
      renderBuiltinChecklist: checklists.renderBuiltinChecklist,
      setClaudeToolsCache: checklists.setClaudeToolsCache,
      setDefaultToolDenyCache: checklists.setDefaultToolDenyCache,
      setDefaultSkillDenyCache: checklists.setDefaultSkillDenyCache,
      setDefaultBuiltinDenyCache: checklists.setDefaultBuiltinDenyCache,
      getDefaultToolDenyCache: checklists.getDefaultToolDenyCache,
      getDefaultSkillDenyCache: checklists.getDefaultSkillDenyCache,
      getDefaultBuiltinDenyCache: checklists.getDefaultBuiltinDenyCache,
      setAgentLibCache: checklists.setAgentLibCache,
      // The skill catalog the renderer fetches is the STATIC seed unioned with
      // discovered names; a fresh instance with no transcript serves the seed.
      window: {
        api: {
          getToolCatalogFor: async () => ({ ok: true, effective: {} }),
          getSkillCatalogFor: async () => ({ ok: true, names: [...CLAUDE_SKILLS], effective: {} }),
        },
      },
      advisoryEffective: (e) => e || {},
      // Real module, so the rows draw from what `!name` resolves to at spawn.
      skillOffSetFor, skillDenyIsDeferred,
      newSessionSkillsDeferred: false,
      newSessionSkillsDrawn: [],
      newSessionSkillsAsked: [],
      renderAgentChecklist: () => {},
      refreshNewSessionExecCommands: () => {},
      refreshNewSessionPlugins: () => Promise.resolve(),
      refreshNewSessionIntents: () => {},
      refreshNewSessionInjectSkills: () => {},
      newSessionSeat: () => ({ plugins: [] }),
      setProxyControls: () => {},
      labelProxyDefault: () => {},
      inputProxyMode: { value: '' },
      inputProxyUrl: { value: '', style: {} },
      inputStripLevel: { value: '0' },
      inputAutoCompact: { checked: false },
      inputNoWire: { checked: true },
      newSessionIsAgent: () => false,
      __track: (p) => { pending.push(p); return p; },
    };
    const names = Object.keys(env);
    const body = trackAsyncCalls(`${SHIPPED}\n${MODE_LISTENER}`);
    const api = new Function(...names, `${body}
      return { setModeSelect, populateHostCatalogs, applyModeFields,
        fire: (v) => { inputMode.value = v; inputMode._fire(); } };`)(...names.map((n) => env[n]));

    // openDialog's order: setModeSelect, then the catalog fill, then the mode
    // apply with catalogsFresh. Pinned as an ordering in new-session-modes.
    api.setModeSelect(openIn);
    api.populateHostCatalogs(settings, []);
    api.applyModeFields(openIn, { catalogsFresh: true });
    await Promise.all(pending);
    pending.length = 0;
    const read = () => ({
      tools: checkedOf(inputToolsList),
      skills: checkedOf(inputSkillsList),
      builtins: checkedOf(inputBuiltinsList),
    });
    const opened = read();
    if (!switchTo) return { opened };
    api.fire(switchTo);
    await Promise.all(pending);
    pending.length = 0;
    return { opened, switched: read() };
  } finally { global.document = had; }
}

const checkedOf = (c) => c.children
  .map((row) => row.children.find((x) => x.tagName === 'input'))
  .filter((cb) => cb && cb.checked)
  .map((cb) => cb.value);

// --- the payload a FRESH root really serves -------------------------------

// Not hand-written: read out of a real store rooted in an empty userData dir,
// through the same three getters ipc-handlers `settings:get` calls. A literal
// here would re-encode the floors and pass against a store that returned
// anything at all — which is precisely how the `[]` skill floor survived.
function freshRootSettings() {
  const dir = mkTmpRoot('clodex-t913-fresh-');
  const { agentDefaults } = initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'),
  });
  assert.ok(!fs.existsSync(path.join(dir, 'agent-defaults.json')),
    'ENTER: a fresh root has no agent-defaults.json — otherwise this is not the tri-state ABSENT case');
  return {
    claudeTools: [...CLAUDE_TOOLS],
    defaultToolDeny: agentDefaults.getDefaultDeny(),
    defaultSkillDeny: agentDefaults.getDefaultSkillDeny(),
    defaultBuiltinDeny: agentDefaults.getDefaultBuiltinDeny(),
  };
}

test('t913: on a fresh root, every category CHANGES in both directions across a mode change', async () => {
  const settings = freshRootSettings();

  const down = await runDialog(settings, { openIn: 'standard', switchTo: 'optimized' });
  const up = await runDialog(settings, { openIn: 'optimized', switchTo: 'standard' });

  // ENTER: the rows really drew. With an empty catalog every checked set is []
  // and every assertion below compares nothing to nothing.
  for (const [what, set] of [['tools', down.opened.tools], ['skills', down.opened.skills],
    ['builtins', down.opened.builtins]]) {
    assert.ok(set.length > 0, `ENTER: the ${what} checklist drew rows in standard`);
  }

  // Standard means ALL of it — the whole catalog, checked, whichever way the
  // operator arrived at it.
  assert.deepStrictEqual(down.opened.tools, [...CLAUDE_TOOLS], 'standard: every tool');
  assert.deepStrictEqual(down.opened.skills, [...CLAUDE_SKILLS], 'standard: every skill');
  assert.deepStrictEqual(down.opened.builtins, [...BUILTIN_AGENTS], 'standard: every built-in agent');
  assert.deepStrictEqual(up.switched.tools, [...CLAUDE_TOOLS], 'switching TO standard: every tool');
  assert.deepStrictEqual(up.switched.skills, [...CLAUDE_SKILLS], 'switching TO standard: every skill');
  assert.deepStrictEqual(up.switched.builtins, [...BUILTIN_AGENTS], 'switching TO standard: every built-in');

  // Optimized means the curated subset, and NOTHING else — the actual names, so
  // a floor that drifted by one tool fails here by name.
  const KEEP_TOOLS = CLAUDE_TOOLS.filter((t) => OPTIMIZED_TOOLS.includes(t));
  const KEEP_SKILLS = CLAUDE_SKILLS.filter((s) => OPTIMIZED_SKILLS.includes(s));
  const KEEP_BUILTINS = BUILTIN_AGENTS.filter((a) => !DEFAULT_BUILTIN_DENY_FLOOR.includes(a));
  assert.deepStrictEqual(up.opened.tools, KEEP_TOOLS, 'optimized: only the curated tools');
  assert.deepStrictEqual(up.opened.skills, KEEP_SKILLS, 'optimized: only the curated skills');
  assert.deepStrictEqual(up.opened.builtins, KEEP_BUILTINS, 'optimized: only the curated built-ins');
  assert.deepStrictEqual(down.switched.tools, KEEP_TOOLS, 'switching TO optimized: only the curated tools');
  assert.deepStrictEqual(down.switched.skills, KEEP_SKILLS, 'switching TO optimized: only the curated skills');
  assert.deepStrictEqual(down.switched.builtins, KEEP_BUILTINS, 'switching TO optimized: only the curated built-ins');

  // And the two modes must not agree in ANY category. This is the assertion
  // whose absence let the skills no-op ship: the sets above could both be
  // written from the same wrong floor and still look deliberate.
  for (const cat of ['tools', 'skills', 'builtins']) {
    assert.notDeepStrictEqual(up.opened[cat], up.switched[cat],
      `${cat}: optimized and standard must differ — an equal set means the selector does nothing here`);
    assert.notDeepStrictEqual(down.opened[cat], down.switched[cat],
      `${cat}: the reverse switch must change the set too`);
  }

  // The subset relation, stated once: optimized is strictly INSIDE standard.
  for (const cat of ['tools', 'skills', 'builtins']) {
    const all = new Set(up.switched[cat]);
    assert.ok(up.opened[cat].every((n) => all.has(n)),
      `${cat}: optimized is a subset of standard`);
    assert.ok(up.opened[cat].length < all.size,
      `${cat}: and a PROPER subset — equal sizes mean the mode trimmed nothing`);
  }
});

test('t913: an operator with their own defaults keeps them — the tri-state, not the new floor', async () => {
  // The bar that outranks the floor itself. A `*` key PRESENT is the operator's
  // explicit choice and must survive untouched, including the empty array, which
  // means "deny nothing" and must NOT be read as "fall back to the floor".
  const dir = mkTmpRoot('clodex-t913-curated-');
  const { agentDefaults } = initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'),
  });
  agentDefaults.setDefaultDeny(['Bash', 'WebFetch']);
  agentDefaults.setDefaultSkillDeny(['review', 'init']);
  agentDefaults.setDefaultBuiltinDeny(['Explore']);

  assert.deepStrictEqual(agentDefaults.getDefaultDeny(), ['Bash', 'WebFetch'],
    "the operator's tool list, not DEFAULT_TOOL_DENY_FLOOR");
  assert.deepStrictEqual(agentDefaults.getDefaultSkillDeny(), ['review', 'init'],
    "the operator's skill list, not DEFAULT_SKILL_DENY_FLOOR");
  assert.deepStrictEqual(agentDefaults.getDefaultBuiltinDeny(), ['Explore'],
    "the operator's built-in list, not DEFAULT_BUILTIN_DENY_FLOOR");

  // The half a `|| []`-style fallback gets wrong, and the half that matters most
  // here: an explicitly EMPTY list must not collapse into the floor, or the new
  // skill floor becomes impossible to opt out of.
  agentDefaults.setDefaultSkillDeny([]);
  assert.deepStrictEqual(agentDefaults.getDefaultSkillDeny(), [],
    'an explicit [] means deny nothing — the new floor must not resurrect itself');
  agentDefaults.setDefaultDeny([]);
  assert.deepStrictEqual(agentDefaults.getDefaultDeny(), [], 'same for tools');

  // And end to end: a curated root's optimized mode renders THAT choice.
  const curated = await runDialog({
    claudeTools: [...CLAUDE_TOOLS],
    defaultToolDeny: ['Bash', 'WebFetch'],
    defaultSkillDeny: ['review', 'init'],
    defaultBuiltinDeny: ['Explore'],
  }, { openIn: 'optimized' });
  assert.deepStrictEqual(curated.opened.tools, CLAUDE_TOOLS.filter((t) => !['Bash', 'WebFetch'].includes(t)),
    "optimized renders the operator's own deny list, not the shipped floor");
  assert.deepStrictEqual(curated.opened.skills, CLAUDE_SKILLS.filter((s) => !['review', 'init'].includes(s)));
  assert.deepStrictEqual(curated.opened.builtins, BUILTIN_AGENTS.filter((a) => a !== 'Explore'));
});

test('t913: both floors are DERIVED from the allow lists, never re-listed by hand', () => {
  // The direction the allow-list shape buys: a tool added to CLAUDE_TOOLS is
  // off-by-default in optimized instead of silently on, which is the whole
  // reason 33-of-44 accumulated under the deny-list shape.
  //
  // This has to be a source-shape assertion, and that is not laziness. The
  // property is about a tool NOBODY HAS ADDED YET, so no value assertion over
  // today's catalog can see it — re-deriving the floor in the test with the same
  // `filter` proves only that Array.prototype.filter works. What can actually
  // regress is someone "fixing" a floor by pasting a literal back, which is
  // exactly the shape that decayed, and which the partition test above would
  // still pass on the day it was written.
  const src = fs.readFileSync(path.join(ROOT, 'catalogs.js'), 'utf8');
  assert.match(src, /const DEFAULT_TOOL_DENY_FLOOR = CLAUDE_TOOLS\.filter\(\(t\) => !OPTIMIZED_TOOLS\.includes\(t\)\);/,
    'DEFAULT_TOOL_DENY_FLOOR must be derived from OPTIMIZED_TOOLS, not listed — a hand-listed floor '
    + 'silently keeps every future tool ON in optimized');
  // The skill half derives through `deferredSkillDeny` (t918) — same property,
  // strengthened: its sentinel also covers skills in no list at all yet.
  assert.match(src, /const DEFAULT_SKILL_DENY_FLOOR = deferredSkillDeny\(OPTIMIZED_SKILLS\);/,
    'DEFAULT_SKILL_DENY_FLOOR must be derived from OPTIMIZED_SKILLS, not listed');
  assert.ok(!/const DEFAULT_SKILL_DENY_FLOOR = \[/.test(src),
    'a literal skill floor is a snapshot: it cannot name a skill the CLI has not announced yet');
});
