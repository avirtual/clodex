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
  'prefs-env-secret', 'prefs-env-add', 'prefs-env-restore', 'prefs-env-state',
  'prefs-discover-on-startup', 'prefs-disable-design-mcp',
  'prefs-tools-row', 'prefs-tools-list',
];

test('every Preferences control survives the grouping', () => {
  const found = [...prefsMarkup().matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual([...found].sort(), [...CONTROLS].sort());
});

test('every group is collapsible and named', () => {
  const groups = [...prefsMarkup().matchAll(/<details class="prefs-group" data-group="([^"]+)"/g)]
    .map((m) => m[1]);
  assert.deepStrictEqual(groups, [
    'appearance', 'voice', 'statusline', 'new-sessions', 'env', 'traffic', 'phone', 'discovery',
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
