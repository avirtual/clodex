// Run: node --test
// Covers the Preferences dialog's group structure. A reorganization that drops
// a control is invisible to every other test here: the id simply stops existing,
// openPrefs' `getElementById` returns null, and the setting silently stops being
// saved. This file is the inventory that makes that fail loudly.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

function prefsMarkup() {
  const start = html.indexOf('<div id="prefs-overlay"');
  const end = html.indexOf('<!-- No Plugins section here');
  assert.ok(start >= 0 && end > start, 'prefs dialog markup not found');
  return html.slice(start, end);
}

// Captured from the markup BEFORE the grouping rewrite. Adding a setting means
// adding it here on purpose; losing one to a careless move fails.
const CONTROLS = [
  'prefs-overlay', 'prefs-dialog', 'prefs-theme',
  'prefs-voice-mode', 'prefs-voice-state',
  'prefs-voice-submit', 'prefs-voice-submit-phrase', 'prefs-voice-submit-composition',
  'prefs-voice-submit-rearm',
  'prefs-speak-replies', 'prefs-speak-voice', 'prefs-speak-rate',
  'prefs-claude-components', 'prefs-claude-sl-cmd', 'prefs-codex-components',
  'prefs-proxy-enabled', 'ws-dot', 'ws-status-text', 'ws-restart-btn',
  'prefs-compact-on-resume', 'prefs-compact-on-resume-why',
  'prefs-ctx-nudge', 'prefs-ctx-escalate', 'prefs-ctx-models',
  'prefs-context-hints', 'prefs-context-hints-why',
  'prefs-semantic-hints', 'prefs-semantic-hints-why',
  'prefs-selection-hints', 'prefs-terminal-reports',
  'ws-logs-block', 'ws-logs-size', 'ws-logs-age', 'ws-logs-clear-btn',
  'prefs-remote-enabled', 'remote-dot', 'remote-status-text',
  'prefs-remote-token', 'prefs-remote-token-save', 'prefs-remote-token-clear',
  'prefs-remote-token-state', 'prefs-peer-shell',
  'prefs-env-scope', 'prefs-env-list', 'prefs-env-key', 'prefs-env-value',
  'prefs-env-secret', 'prefs-env-add', 'prefs-env-restore-row', 'prefs-env-restore', 'prefs-env-state',
  'prefs-accounts-list', 'prefs-account-label', 'prefs-account-email', 'prefs-account-plan',
  'prefs-account-dir', 'prefs-account-add', 'prefs-account-model', 'prefs-accounts-state',
  'prefs-default-mode', 'prefs-run-setup', 'prefs-discover-on-startup', 'prefs-disable-design-mcp',
  'prefs-tools-row', 'prefs-tools-list',
  'prefs-skills-row', 'prefs-skills-list',
  'prefs-agents-row', 'prefs-agents-list',
];

test('every Preferences control survives the grouping', () => {
  const found = [...prefsMarkup().matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual([...found].sort(), [...CONTROLS].sort());
});

test('every group is collapsible and named', () => {
  const groups = [...prefsMarkup().matchAll(/<details class="prefs-group" data-group="([^"]+)"/g)]
    .map((m) => m[1]);
  assert.deepStrictEqual(groups, [
    'appearance', 'voice', 'statusline', 'new-sessions', 'env', 'accounts', 'traffic', 'phone', 'discovery',
  ], 'group set/order changed — update this list deliberately');
  // One summary per group, or a group has no header to click.
  assert.strictEqual((prefsMarkup().match(/<summary>/g) || []).length, groups.length);
});

// <details> keeps its subtree in the DOM when closed, so a collapsed group's
// controls still answer getElementById and still ride into Save. If a future
// change swaps this for conditional rendering, saving from a fresh dialog would
// silently write defaults over every collapsed section.
test('collapsing hides controls without removing them', () => {
  // Attribute order is not fixed, so match the TAG and test its attributes —
  // an order-sensitive regex silently passes on the reversed spelling.
  for (const tag of prefsMarkup().match(/<details[^>]*class="prefs-group"[^>]*>/g) || []) {
    assert.ok(!/display:\s*none/.test(tag), `a group must collapse via <details>, not display:none: ${tag}`);
  }
  for (const id of ['prefs-theme', 'prefs-tools-list', 'prefs-env-key']) {
    assert.ok(prefsMarkup().includes(`id="${id}"`), `${id} must be present regardless of group state`);
  }
});

test('open groups are remembered across reopens', () => {
  assert.match(js, /restorePrefsGroups\(\)/, 'openPrefs must restore the open set');
  assert.match(js, /clodex-prefs-open/, 'the open set must be persisted');
});

// The gate greys a checkbox's LABEL via el.parentElement, so a wrapper element
// between them would grey nothing.
test('a gated checkbox is still a direct child of its label', () => {
  for (const id of ['prefs-compact-on-resume', 'prefs-context-hints', 'prefs-semantic-hints']) {
    const re = new RegExp(`<label class="prefs-check">\\s*<input type="checkbox" id="${id}">`);
    assert.match(prefsMarkup(), re, `${id} must sit directly inside its label`);
  }
});

// The point of the class is that .prefs-row/.prefs-check can be overridden by a
// later rule; an inline style cannot be.
test('shared row layout is a class, not repeated inline styles', () => {
  assert.match(css, /\.prefs-row\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.prefs-check\s*\{[^}]*display:\s*flex/);
  const inline = (prefsMarkup().match(/style="display: flex; align-items: center; gap: 8px;"/g) || []).length;
  assert.strictEqual(inline, 0, 'the duplicated inline flex row must be gone');
});

function accountsGroup() {
  const m = prefsMarkup().match(/<details class="prefs-group" data-group="accounts">[\s\S]*?<\/details>/);
  assert.ok(m, 'ENTER: the accounts group is still found by this anchor');
  return m[0];
}

// `flex: none` plus the `width: 100%` that #prefs-dialog puts on every input and
// select makes a field demand the whole row: its siblings collapse to ~10px and
// the trailing button leaves the dialog. The CSS rule below is what a row select
// takes its sizing from now, so an inline one here would be the defect again.
test('no account field sizes itself out of its row', () => {
  for (const tag of accountsGroup().match(/<(?:input|select)[^>]*>/g) || []) {
    assert.ok(!/flex:\s*none/.test(tag), `an accounts field must not pin flex: none inline: ${tag}`);
  }
  assert.match(
    accountsGroup(),
    /<label for="prefs-account-model"[^>]*>/,
    'the model select needs a <label for> — it is the row\'s only name for it',
  );
});

// Comments are stripped first: they quote the very declarations asserted about
// below, so a body/selector read out of the raw text matches the prose instead.
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')
  .map((chunk) => {
    const i = chunk.indexOf('{');
    return i < 0 ? null : { sel: chunk.slice(0, i).trim(), body: chunk.slice(i + 1).trim() };
  })
  .filter(Boolean);

test('a select in a prefs row sizes to its content, and prefs controls are dark', () => {
  assert.match(css, /#prefs-dialog \.prefs-row select \{[^}]*width:\s*auto/);
  const dark = cssRules.filter((r) => /(^|,)\s*#dialog select\s*(,|$)/.test(r.sel) && /padding:\s*8px 10px/.test(r.body));
  assert.strictEqual(dark.length, 1, 'ENTER: exactly one dark control block styles #dialog select');
  for (const sel of ['#prefs-dialog input[type="text"]', '#prefs-dialog select']) {
    assert.ok(dark[0].sel.includes(sel), `${sel} must share the dark control treatment: ${dark[0].sel}`);
  }
  assert.ok(
    !/display:\s*block|margin-top/.test(dark[0].body),
    `the prefs rows are flex — the stacked-field declarations must stay out of the shared block: ${dark[0].body}`,
  );
});
