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

function runApply(mode, { type = 'claude' } = {}) {
  const calls = { tools: [], builtins: [], plugins: [], repaints: 0 };
  const ticks = ['clodex-team'];
  const inputStripLevel = { value: 'untouched' };
  const inputAutoCompact = { checked: false };
  const inputNoWire = { checked: true };
  const inputProxyMode = { value: 'off' };
  const inputProxyUrl = { value: 'http://127.0.0.1:9999', style: {} };
  const env = {
    inputType: { value: type },
    refreshNewSessionTools: (s) => calls.tools.push(s),
    getDefaultToolDenyCache: () => DENY_CACHE,
    renderBuiltinChecklist: (_el, s) => calls.builtins.push(s),
    inputBuiltinsList: {},
    renderPluginChecklist: (_el, list) => calls.plugins.push(list),
    inputPluginList: {},
    defaultPluginTicks: () => ticks,
    repaintNewSessionBundleRows: () => { calls.repaints++; },
    inputStripLevel, inputAutoCompact, inputNoWire,
    newSessionIsAgent: () => type === 'claude' || type === 'codex',
    inputProxyMode, inputProxyUrl,
  };
  const names = Object.keys(env);
  new Function(...names, `${SET_PROXY_FN}\n${APPLY_FN}\napplyModeFields(${JSON.stringify(mode)});`)(
    ...names.map((n) => env[n]));
  return { calls, ticks, inputStripLevel, inputAutoCompact, inputNoWire, inputProxyMode, inputProxyUrl };
}

test('standard writes the CLI-as-is fields: nothing denied, stripping off', () => {
  const r = runApply('standard');
  assert.strictEqual(r.calls.tools.length, 1, 'ENTER: the tool checklist was redrawn exactly once');
  assert.deepStrictEqual([...r.calls.tools[0]], [],
    'no tool is denied — the deny cache must NOT reach the checklist in standard');
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
  assert.strictEqual(r.inputStripLevel.value, '2', 'level 2, the literal the mode promises');
  assert.strictEqual(r.inputAutoCompact.checked, true);
  assert.strictEqual(r.inputNoWire.checked, false);
  assert.strictEqual(r.inputProxyMode.value, '', 'proxy back to the app default');
});

test('both modes reset the builtins and plugin checklists to their defaults', () => {
  for (const mode of ['standard', 'optimized']) {
    const r = runApply(mode);
    assert.deepStrictEqual([...r.calls.builtins[0]], [], `${mode}: no built-in agent denied`);
    assert.strictEqual(r.calls.plugins[0], r.ticks,
      `${mode}: the plugin ticks come from defaultPluginTicks(), not from a frozen list`);
    assert.strictEqual(r.calls.repaints, 1, `${mode}: bundle rows repainted after the plugin redraw`);
  }
});

test('custom applies nothing at all — a hand-configured form is never overwritten', () => {
  const r = runApply('custom');
  assert.deepStrictEqual(r.calls.tools, []);
  assert.deepStrictEqual(r.calls.builtins, []);
  assert.strictEqual(r.inputStripLevel.value, 'untouched');
  assert.strictEqual(r.inputNoWire.checked, true, 'the pre-set value survives');
  assert.strictEqual(r.inputProxyMode.value, 'off', 'and so does the proxy choice');
});

test('a non-claude type gets no claude-only writes, but still gets the proxy default', () => {
  const r = runApply('optimized', { type: 'codex' });
  assert.deepStrictEqual(r.calls.tools, [], 'no tool checklist exists for codex');
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
  assert.deepStrictEqual(listeners.advanced.map(([ev]) => ev), ['input', 'change'],
    'ENTER: both edit events inside Advanced are listened for — a checkbox fires change, a text field fires input');
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
  /\n(  setModeSelect\([^\n]*\);\n  if \(advancedSection\) advancedSection\.open = [^\n]*;)\n/,
  "openDialog's mode reset",
);

function runOpen(prefill, dialogMode) {
  const seen = [];
  const advancedSection = { open: 'untouched' };
  new Function('setModeSelect', 'advancedSection', 'prefill', 'dialogMode', OPEN_STMTS)(
    (m) => seen.push(m), advancedSection, prefill, dialogMode);
  return { mode: seen[0], open: advancedSection.open };
}

test('a fresh create-mode open defaults to optimized with Advanced collapsed', () => {
  assert.deepStrictEqual(runOpen(null, 'create'), { mode: 'optimized', open: false });
});

test('a prefill or a non-create open shows Custom / opens Advanced instead', () => {
  assert.deepStrictEqual(runOpen({ name: 'adopted' }, 'create'), { mode: 'custom', open: true },
    'an adopt prefill arrives with the form already populated');
  assert.strictEqual(runOpen(null, 'template').open, true,
    'editing a template must show what is set');
});
