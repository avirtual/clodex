'use strict';

// new-session-modes.test.js — the New Session dialog's Mode selector and the
// Advanced accordion that holds everything the selector writes.
//
// The subject is a PRESET: `optimized` and `standard` write the same fields the
// operator can reach by hand, so nothing new is persisted and collectFormConfig
// keeps its shape. That makes the whole feature invisible to a config-level
// assertion — what can break is which literals the preset writes, and whether a
// hand edit still wins over the preset that ran before it.
//
// WHY THE SHIPPED SOURCE IS EXTRACTED AND RUN. These statements live in
// renderer.js, which no test can require (DOM-bound, window.api at load). The
// idiom is test/template-tools-allowlist.test.js's: capture the statement, run it
// against recording stubs. A source-shape grep would pass over a preset that
// calls the right function with the wrong set, and a re-typed copy of the body
// would assert only that this file agrees with itself.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

function extract(re, what) {
  const m = re.exec(rendererSrc);
  assert.ok(m, `ENTER: ${what} was not found in renderer.js — every assertion below would be vacuous`);
  return m[1];
}

// --- markup ---------------------------------------------------------------

const ADV_OPEN = '      <details id="advanced-section" class="dialog-section">';

test('the Advanced accordion wraps system-prompt through resume, and ships closed', () => {
  const at = htmlSrc.indexOf(ADV_OPEN);
  assert.ok(at > 0,
    'ENTER: the accordion opens with exactly this tag — no `open` attribute, class dialog-section');
  // The closing tag at the SAME indent. Inner <details> (tools/skills/other/env)
  // are nested deeper, so this finds the accordion's own end and not theirs.
  const close = htmlSrc.indexOf('\n      </details>', at);
  assert.ok(close > at, 'ENTER: the accordion closes at dialog indent');
  const inside = htmlSrc.slice(at, close);
  for (const id of ['system-prompt-row', 'append-prompts-row', 'tools-section', 'skills-section',
    'other-section', 'model-row', 'env-section', 'proxy-row', 'resume-row']) {
    assert.ok(inside.includes(`id="${id}"`), `#${id} is inside the accordion`);
  }
  // The anti-degenerate half: "wrap the whole dialog" satisfies every assertion
  // above, so name what must stay OUT of it.
  for (const id of ['placement-row', 'template-row', 'mode-row', 'worktree-row', 'team-row',
    'new-session-tool-notice']) {
    assert.ok(!inside.includes(`id="${id}"`), `#${id} stays outside the accordion`);
  }
});

test('#mode-row is a first-contact field: after Working directory, before #worktree-row', () => {
  const mode = htmlSrc.indexOf('id="mode-row"');
  const cwd = htmlSrc.indexOf('id="input-cwd"');
  const worktree = htmlSrc.indexOf('id="worktree-row"');
  assert.ok(mode > 0 && cwd > 0 && worktree > 0, 'ENTER: all three rows exist');
  assert.ok(cwd < mode, 'Mode follows Working directory');
  assert.ok(mode < worktree, 'Mode precedes the worktree row');
  assert.match(htmlSrc.slice(mode, worktree),
    /<option value="optimized">[\s\S]*<option value="standard">[\s\S]*<option value="custom" hidden>/,
    'optimized is the first option, and Custom ships hidden');
});

// --- the preset -----------------------------------------------------------

const APPLY_FN = extract(/\n(function applyModeFields\([\s\S]*?\n\})\n/, 'applyModeFields');
const SET_PROXY_FN = extract(/\n(function setProxyControls\([\s\S]*?\n\})\n/, 'setProxyControls');

const DENY_CACHE = ['Bash', 'WebFetch', 'NotebookEdit'];
const SKILL_DENY_CACHE = ['code-review', 'deep-research'];
const BUILTIN_DENY_CACHE = ['Plan', 'statusline-setup'];

function runApply(mode, { type = 'claude', catalogsFresh = false } = {}) {
  const calls = { tools: [], skills: [], builtins: [], plugins: 0, intents: 0 };
  const inputStripLevel = { value: 'untouched' };
  const inputAutoCompact = { checked: false };
  const inputNoWire = { checked: true };
  const inputProxyMode = { value: 'off' };
  const inputProxyUrl = { value: 'http://127.0.0.1:9999', style: {} };
  const env = {
    inputType: { value: type },
    refreshNewSessionTools: (s) => calls.tools.push(s),
    getDefaultToolDenyCache: () => DENY_CACHE,
    refreshNewSessionSkills: (s) => calls.skills.push(s),
    getDefaultSkillDenyCache: () => SKILL_DENY_CACHE,
    getDefaultBuiltinDenyCache: () => BUILTIN_DENY_CACHE,
    renderBuiltinChecklist: (_el, s) => calls.builtins.push(s),
    inputBuiltinsList: {},
    // The SHIPPED refresh pair, stubbed: it is what fills
    // `newSessionPluginsRendered` before drawing (t671, pinned in
    // test/plugin-dialog-snapshot.test.js). A mode that drew the checklist
    // directly would leave that snapshot unfilled.
    refreshNewSessionPlugins: () => { calls.plugins++; return Promise.resolve(); },
    refreshNewSessionIntents: () => { calls.intents++; },
    inputStripLevel, inputAutoCompact, inputNoWire,
    newSessionIsAgent: () => type === 'claude' || type === 'codex',
    inputProxyMode, inputProxyUrl,
  };
  const names = Object.keys(env);
  const opts = JSON.stringify({ catalogsFresh });
  new Function(...names,
    `${SET_PROXY_FN}\n${APPLY_FN}\napplyModeFields(${JSON.stringify(mode)}, ${opts});`)(
    ...names.map((n) => env[n]));
  return { calls, inputStripLevel, inputAutoCompact, inputNoWire, inputProxyMode, inputProxyUrl };
}

test('standard writes the CLI-as-is fields: nothing denied, stripping off', () => {
  const r = runApply('standard');
  assert.strictEqual(r.calls.tools.length, 1, 'ENTER: the tool checklist was redrawn exactly once');
  assert.deepStrictEqual([...r.calls.tools[0]], [],
    'no tool is denied — the deny cache must NOT reach the checklist in standard');
  assert.strictEqual(r.calls.skills.length, 1, 'ENTER: the skill checklist was redrawn exactly once');
  assert.deepStrictEqual([...r.calls.skills[0]], [],
    'no skill is denied — the skill deny cache must NOT reach the checklist in standard');
  assert.strictEqual(r.inputStripLevel.value, '0', 'wire stripping off');
  assert.strictEqual(r.inputAutoCompact.checked, true);
  assert.strictEqual(r.inputNoWire.checked, false);
  assert.strictEqual(r.inputProxyMode.value, '', 'proxy back to the app default');
});

test('optimized writes the trimmed fields: the default deny set, strip level 2', () => {
  const r = runApply('optimized');
  assert.strictEqual(r.calls.tools.length, 1, 'ENTER: the tool checklist was redrawn exactly once');
  assert.deepStrictEqual([...r.calls.tools[0]], DENY_CACHE,
    'the denied set is getDefaultToolDenyCache() — the dialog\'s own default, not a second list');
  assert.strictEqual(r.calls.skills.length, 1, 'ENTER: the skill checklist was redrawn exactly once');
  assert.deepStrictEqual([...r.calls.skills[0]], SKILL_DENY_CACHE,
    'the denied skills are getDefaultSkillDenyCache() — the same tri-state store the tools come from');
  assert.strictEqual(r.inputStripLevel.value, '2', 'level 2, the literal the mode promises');
  assert.strictEqual(r.inputAutoCompact.checked, true);
  assert.strictEqual(r.inputNoWire.checked, false);
  assert.strictEqual(r.inputProxyMode.value, '', 'proxy back to the app default');
});

test('each mode writes its own built-in deny set, and redraws plugins through the shipped refresh', async () => {
  // Per-mode, not shared: standard means "the CLI as installed", so it must
  // clear the denies a previous optimized apply wrote; optimized means the
  // stored default set. One expectation for both modes would be true of a
  // build that ignored the mode entirely.
  const expected = { standard: [], optimized: BUILTIN_DENY_CACHE };
  for (const mode of ['standard', 'optimized']) {
    const r = runApply(mode);
    // The intent refresh is chained off the plugin refresh's promise, so it
    // lands a microtask later — asserting synchronously reads 0 every time.
    await Promise.resolve();
    assert.deepStrictEqual([...r.calls.builtins[0]], expected[mode],
      `${mode}: the built-in deny set the mode promises`);
    // Not renderPluginChecklist directly: refreshNewSessionPlugins is what
    // assigns `newSessionPluginsRendered` before it draws, and a draw that
    // skips the fill silently drops a carried-forward plugin at save (t671).
    assert.strictEqual(r.calls.plugins, 1, `${mode}: the plugin catalog is refreshed, not redrawn by hand`);
    assert.strictEqual(r.calls.intents, 1, `${mode}: and the intent rows follow it, as everywhere else`);
  }
});

test('catalogsFresh skips the two refreshes the caller has already run', () => {
  // Both flagged call sites run right after something that just refreshed the
  // tool and plugin catalogs; re-running them here races the same redraw.
  const r = runApply('optimized', { catalogsFresh: true });
  assert.deepStrictEqual(r.calls.tools, [], 'no second tool redraw');
  assert.strictEqual(r.calls.plugins, 0, 'no second plugin refresh');
  // The anti-degenerate half: the flag must skip ONLY the catalog redraws, so
  // name a field that must still be written.
  assert.deepStrictEqual(r.calls.skills, [], 'no second skill redraw');
  assert.strictEqual(r.inputStripLevel.value, '2', 'the mode still writes its own fields');
  assert.deepStrictEqual([...r.calls.builtins[0]], BUILTIN_DENY_CACHE,
    'and still writes the built-in deny set — the flag skips only the catalog redraws');
});

test('custom applies nothing at all — a hand-configured form is never overwritten', () => {
  const r = runApply('custom');
  assert.deepStrictEqual(r.calls.tools, []);
  assert.deepStrictEqual(r.calls.skills, []);
  assert.deepStrictEqual(r.calls.builtins, []);
  assert.strictEqual(r.inputStripLevel.value, 'untouched');
  assert.strictEqual(r.inputNoWire.checked, true, 'the pre-set value survives');
  assert.strictEqual(r.inputProxyMode.value, 'off', 'and so does the proxy choice');
});

test('a non-claude type gets no claude-only writes, but still gets the proxy default', () => {
  const r = runApply('optimized', { type: 'codex' });
  assert.deepStrictEqual(r.calls.tools, [], 'no tool checklist exists for codex');
  assert.deepStrictEqual(r.calls.skills, [], 'nor a skill checklist');
  assert.strictEqual(r.inputStripLevel.value, 'untouched');
  assert.strictEqual(r.inputProxyMode.value, '', 'proxy is an agent-wide row, so it is still reset');
});

// --- drift ----------------------------------------------------------------

const SET_MODE_FN = extract(/\n(function setModeSelect\([\s\S]*?\n\})\n/, 'setModeSelect');
const DRIFT_WIRING = extract(/\n(if \(advancedSection\) \{[\s\S]*?\n\})\n/, 'the advanced-section drift listener');
const SELECT_WIRING = extract(/\n(if \(inputMode\) \{\n  inputMode\.addEventListener[\s\S]*?\n\})\n/,
  "the mode select's change listener");

function wireDialog() {
  const listeners = { advanced: [], mode: [] };
  const customOpt = { value: 'custom', hidden: true };
  const inputMode = {
    value: 'optimized',
    querySelector: (sel) => {
      assert.strictEqual(sel, 'option[value="custom"]', 'ENTER: the only selector setModeSelect uses');
      return customOpt;
    },
    addEventListener: (ev, fn) => listeners.mode.push([ev, fn]),
  };
  const advancedSection = {
    open: false,
    addEventListener: (ev, fn) => listeners.advanced.push([ev, fn]),
  };
  const modeHint = { textContent: '' };
  const applied = [];
  const env = {
    inputMode, advancedSection, modeHint,
    applyModeFields: (m) => applied.push(m),
    MODE_HINTS: { optimized: 'opt', standard: 'std', custom: 'cus' },
  };
  const names = Object.keys(env);
  new Function(...names, `${SET_MODE_FN}\n${DRIFT_WIRING}\n${SELECT_WIRING}\nreturn setModeSelect;`)(
    ...names.map((n) => env[n]));
  assert.deepStrictEqual(listeners.advanced.map(([ev]) => ev), ['input', 'change', 'click'],
    'ENTER: all three edit signals inside Advanced are listened for — a text field fires input, a '
    + 'checkbox fires change, and a bulk toggle fires only click (setChecklistAll assigns .checked directly)');
  assert.deepStrictEqual(listeners.mode.map(([ev]) => ev), ['change'],
    'ENTER: the select is listened for');
  return { listeners, inputMode, advancedSection, customOpt, applied };
}

test('editing anything inside Advanced flips the selector to Custom and reveals the option', () => {
  for (const evName of ['input', 'change']) {
    const d = wireDialog();
    d.inputMode.value = 'optimized';
    assert.strictEqual(d.customOpt.hidden, true, 'ENTER: Custom starts hidden');
    d.listeners.advanced.find(([ev]) => ev === evName)[1]();
    assert.strictEqual(d.inputMode.value, 'custom', `a ${evName} inside Advanced is a hand edit`);
    assert.strictEqual(d.customOpt.hidden, false, 'and Custom becomes selectable');
    assert.deepStrictEqual(d.applied, [],
      'drift must NOT re-apply a preset — that would undo the edit that caused it');
  }
});

test("a Tools/Skills bulk toggle drifts too — it fires only click", () => {
  const d = wireDialog();
  const click = d.listeners.advanced.find(([ev]) => ev === 'click')[1];
  const asked = [];
  click({ target: { closest: (sel) => { asked.push(sel); return { dataset: { bulk: 'all' } }; } } });
  assert.deepStrictEqual(asked, ['.popover-bulk [data-bulk]'],
    'ENTER: the listener matches the selector wireBulkToggles renders, not the button label');
  assert.strictEqual(d.inputMode.value, 'custom', '"Check All" is a hand edit like any other');
  assert.strictEqual(d.customOpt.hidden, false, 'and Custom becomes selectable');
  assert.deepStrictEqual(d.applied, [], 'no re-apply — that would undo the bulk edit');
});

test('a click on anything else inside Advanced does NOT drift', () => {
  // The negative half: without it the subject above passes on a listener that
  // flips for EVERY click, which would drift on opening a <summary>.
  const d = wireDialog();
  const click = d.listeners.advanced.find(([ev]) => ev === 'click')[1];
  click({ target: { closest: () => null } });
  assert.strictEqual(d.inputMode.value, 'optimized', 'expanding a section is not an edit');
  assert.strictEqual(d.customOpt.hidden, true, 'and Custom stays hidden');
  // A synthetic event with no element target must not throw either.
  click({ target: {} });
  click({});
  assert.strictEqual(d.inputMode.value, 'optimized');
});

test('choosing a named mode again re-applies it and re-hides Custom', () => {
  const d = wireDialog();
  d.listeners.advanced[0][1]();
  assert.strictEqual(d.inputMode.value, 'custom', 'ENTER: the form drifted first');
  d.inputMode.value = 'standard';
  d.listeners.mode[0][1]();
  assert.deepStrictEqual(d.applied, ['standard'], 'the chosen mode re-writes its fields');
  assert.strictEqual(d.customOpt.hidden, true, 'and Custom goes back into hiding');
});

test('landing on custom opens Advanced, so a configured form is never hidden', () => {
  const d = wireDialog();
  assert.strictEqual(d.advancedSection.open, false, 'ENTER: it starts closed');
  d.listeners.advanced[0][1]();
  assert.strictEqual(d.advancedSection.open, true);
});

// --- open-time defaults ---------------------------------------------------

// Captured by SHAPE, not by the literals it decides: a regex naming 'optimized'
// would fail to extract when the default changes, and every assertion below
// would report a missing statement rather than the wrong default.
const OPEN_STMTS = extract(
  /\n(  const hostSettings = await [^\n]*;\n  setModeSelect\([^\n]*\);\n  if \(advancedSection\) advancedSection\.open = [^\n]*;)\n/,
  "openDialog's mode reset",
);
const MODE_OF_FN = extract(/\n(function defaultSessionMode\([\s\S]*?\n\})\n/, 'defaultSessionMode');

function runOpen(prefill, settings) {
  const seen = [];
  const advancedSection = { open: 'untouched' };
  return new Function('setModeSelect', 'advancedSection', 'prefill', 'settingsFetch',
    `${MODE_OF_FN}\nreturn (async () => {\n${OPEN_STMTS}\n})();`)(
    (m) => seen.push(m), advancedSection, prefill, Promise.resolve(settings))
    .then(() => ({ mode: seen[0], open: advancedSection.open }));
}

test('a fresh create-mode open starts on the stored default', async () => {
  assert.deepStrictEqual(await runOpen(null, { defaultSessionMode: 'standard' }),
    { mode: 'standard', open: false },
    'the Settings ▸ Sessions choice is what the dialog opens on');
  assert.deepStrictEqual(await runOpen(null, { defaultSessionMode: 'optimized' }),
    { mode: 'optimized', open: false });
});

test('an absent or unknown stored mode falls back to optimized', async () => {
  // The web client against an older host sends no such key, and the store can be
  // hand-edited. Neither may reach setModeSelect: an unknown value would land in
  // the selector as a mode with no <option>, blanking it.
  for (const settings of [{}, undefined, { defaultSessionMode: 'custom' },
    { defaultSessionMode: 'bogus' }, { defaultSessionMode: 42 }]) {
    assert.deepStrictEqual(await runOpen(null, settings), { mode: 'optimized', open: false },
      `${JSON.stringify(settings)} falls back`);
  }
});

test('a prefill open shows Custom and expands Advanced, whatever the default is', async () => {
  assert.deepStrictEqual(await runOpen({ name: 'adopted' }, { defaultSessionMode: 'standard' }),
    { mode: 'custom', open: true },
    'an adopt prefill arrives with the form already populated — the preference must not override it');
  // openDialog cannot be reached in template mode — setDialogMode('create') runs
  // unconditionally above this. The template editor gets Custom + Advanced open
  // from its own setModeSelect('custom') call, pinned by the populate subject
  // below; asserting it here would pin a state production cannot produce.
});

test('the settings the mode reads are fetched per open, and fetched once', () => {
  const body = slice('async function openDialog(', '\nfunction populateHostCatalogs(', 'openDialog');
  assert.match(body, /^\s*const settingsFetch = window\.api\.getSettings\(\);/m,
    'the fetch is inside openDialog — a module-level cache would keep serving the value from '
    + 'before the operator changed it in Settings');
  assert.strictEqual((body.match(/window\.api\.getSettings\(\)/g) || []).length, 1,
    'and the later Promise.all awaits that same promise rather than asking a second time');
  assert.match(body, /^\s*settingsFetch,$/m, 'ENTER: the Promise.all reuses it');
});

// --- the two order-bound call sites --------------------------------------
//
// Position pins, in the idiom of test/plugin-dialog-snapshot.test.js: both
// orderings are invisible at the call site and produce a stale or raced tool
// checklist rather than an exception, so nothing else would catch a move.

function slice(fromNeedle, toNeedle, what) {
  const a = rendererSrc.indexOf(fromNeedle);
  assert.ok(a > 0, `ENTER: ${what} starts at ${fromNeedle} — a rename makes every assertion below vacuous`);
  const b = rendererSrc.indexOf(toNeedle, a + fromNeedle.length);
  assert.ok(b > a, `ENTER: ${what} ends at ${toNeedle}`);
  return rendererSrc.slice(a, b);
}

test("openDialog applies the mode AFTER populateHostCatalogs lands the deny cache", () => {
  const body = slice('async function openDialog(', '\nfunction populateHostCatalogs(', 'openDialog');
  const cat = body.indexOf('populateHostCatalogs(settings, dialogHostAgentLib)');
  const apply = body.indexOf('applyModeFields(inputMode.value,');
  assert.ok(cat > 0 && apply > 0, 'ENTER: both calls are in openDialog');
  assert.ok(cat < apply,
    'setDefaultToolDenyCache runs inside populateHostCatalogs — applying earlier trims against the PREVIOUS open\'s cache');
});

test("the type-change mode re-apply is catalogsFresh, and registered after applyTypeDefaults'", () => {
  const block = slice("inputName.addEventListener('input'", "inputPlacement.addEventListener('change'",
    'the dialog field listeners');
  const defaults = block.indexOf('applyTypeDefaults()');
  const reapply = block.indexOf('applyModeFields(inputMode.value, { catalogsFresh: true })');
  assert.ok(defaults > 0 && reapply > 0, 'ENTER: both change listeners are registered here');
  assert.ok(defaults < reapply,
    'listeners fire in registration order, and applyTypeDefaults already redrew the tool checklist from this mode');
});

test('every tool-checklist draw in the dialog goes through modeToolDenySet()', () => {
  // Including the SANDBOX path: it draws from the box's catalogs, and a bare
  // `new Set()` there ships an untrimmed roster under a label promising a trim.
  const sandbox = slice('function populateChecklistsFromCatalogs(', '\nasync function restoreHostCatalogs(',
    'the sandbox catalog fill');
  assert.match(sandbox, /renderToolChecklist\(inputToolsList, modeToolDenySet\(\)\)/,
    'a box-placed seat must honour the selected mode like a host one');
  const host = slice('function populateHostCatalogs(', "\ninputName.addEventListener('input'",
    'the host catalog fill');
  assert.match(host, /renderToolChecklist\(inputToolsList, modeToolDenySet\(\)\)/);
});

// --- programmatic populates ----------------------------------------------

test('no New Session path draws the skill or built-in checklist with a bare default', () => {
  // The tool pin above, for the two sets t730 added. The bug this forbids is
  // silent in the other direction from a wrong literal: a bare
  // `refreshNewSessionSkills()` defaults to an EMPTY set, so every skill comes
  // back ticked the moment the operator changes cwd — the dialog still says
  // "Clodex optimized" while offering the untrimmed roster.
  const dialogPaths = [
    ['function applyTypeDefaults(', '\nfunction applyNewSessionToolOverlay(', 'applyTypeDefaults'],
    ['function populateHostCatalogs(', "\ninputName.addEventListener('input'", 'the host catalog fill'],
    ['function populateChecklistsFromCatalogs(', '\nasync function restoreHostCatalogs(', 'the sandbox catalog fill'],
    ['function adoptSession(', '\nfunction renderDiscovery(', 'adoptSession'],
  ];
  let sawSkillDraw = 0;
  for (const [from, to, what] of dialogPaths) {
    const body = slice(from, to, what);
    // ENTER: a body that mentions neither call would satisfy the absence
    // assertions below without exercising anything.
    const draws = (body.match(/refreshNewSessionSkills\s*\(/g) || []).length
      + (body.match(/renderSkillChecklist\(inputSkillsList/g) || []).length;
    sawSkillDraw += draws;
    assert.ok(!/refreshNewSessionSkills\(\)/.test(body),
      `${what}: a bare refreshNewSessionSkills() re-enables every skill, ignoring the mode`);
    assert.ok(!/renderBuiltinChecklist\(inputBuiltinsList, new Set\(\)\)/.test(body),
      `${what}: a bare new Set() re-enables every built-in agent, ignoring the mode`);
  }
  assert.ok(sawSkillDraw >= 3,
    `ENTER: found only ${sawSkillDraw} skill draws across the dialog paths — the slices are wrong`);

  // The cwd listener is a one-liner outside any function body.
  const cwdListener = slice("inputCwd.addEventListener('change', () => refreshNewSessionSkills",
    "inputCwd.addEventListener('change', () => refreshWorktreeForCwd", 'the cwd change listeners');
  assert.match(cwdListener, /refreshNewSessionSkills\(modeSkillDenySet\(\)\)/,
    'a cwd change in optimized mode must re-apply the defaults, not re-enable everything');
});

test('every path that fills the form by script marks it Custom itself', () => {
  // A scripted `.value =` fires no input/change event, so the drift listener on
  // #advanced-section is blind to all three of these.
  const sites = [
    ["inputTemplate.addEventListener('change'", '\nbtnTemplateDelete.addEventListener', 'the template picker'],
    ['async function openTemplateEditor(', '\nasync function saveTemplateFromForm(', 'the template editor'],
    ['function adoptSession(', '\nfunction renderDiscovery(', 'adoptSession'],
  ];
  for (const [from, to, what] of sites) {
    assert.match(slice(from, to, what), /setModeSelect\('custom'\)/,
      `${what} populates the form by script, so it must set Custom itself`);
  }
});
