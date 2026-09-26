'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spinnerText } = require('../renderer/lib/working-row');

const RULE = '─'.repeat(40);

const CASES = [
  ['claude thinking', 'claude', ['✽ Percolating… (7s · thinking)', '', RULE, '❯ '], 2, 'Percolating… · thinking'],
  ['claude streaming', 'claude', ['✻ Bloviating… (2s · ↓ 253 tokens · thinking)', '', RULE, '❯ '], 2, 'Bloviating… · ↓ 253 tokens · thinking'],
  ['claude with a tip under the spinner', 'claude', ['✳ Enchanting… (1m 6s · ↓ 14 tokens)', '  ⎿  Tip: use /clear', '', RULE, '❯ '], 3, 'Enchanting… · ↓ 14 tokens'],
  ['codex', 'codex', ['• Working (4s • esc to interrupt) · 1 background terminal running · /ps to view', '', '› Ask Codex to do anything'], 2, 'Working'],
  ['muse', 'muse', ['◈ Thinking (8s · esc to interrupt)', '  Drafting a self-contained history', '── Voice input (⌥ + v to start) ──', '❯ '], 2, 'Thinking'],
  ['ENTER: no spinner on screen', 'claude', ['⏺ Canals are among the oldest works', '', RULE, '❯ '], 2, null],
  ['claude retry notice is not a spinner', 'claude', ['✻ Connection refused · Retrying in 1s · attempt 2/10', '', RULE, '❯ '], 2, null],
  ['a codex shape on a claude seat does not match', 'claude', ['• Working (4s • esc to interrupt)', '', RULE, '❯ '], 2, null],
  ['no anchor', 'claude', ['✽ Percolating… (7s · thinking)'], -1, null],
];

for (const [name, platform, rows, top, want] of CASES) {
  test(`spinnerText: ${name}`, () => {
    assert.strictEqual(spinnerText(rows, top, platform), want);
  });
}
