'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classifySender, SYSTEM_GLYPHS } = require('../renderer/lib/sender-class');

const TABLE = [
  ['reminder', { cls: 'system', label: 'reminder', glyph: '◷' }],
  ['reboot', { cls: 'system', label: 'reboot', glyph: '↻' }],
  ['ticket-loop', { cls: 'system', label: 'ticket-loop', glyph: '⇄' }],
  ['ticket-watchdog', { cls: 'system', label: 'ticket-watchdog', glyph: '◉' }],
  ['monitor', { cls: 'system', label: 'monitor', glyph: '▣' }],
  ['memory', { cls: 'system', label: 'memory', glyph: '◈' }],
  ['exec', { cls: 'system', label: 'exec', glyph: '▸' }],
  ['terminal', { cls: 'system', label: 'terminal', glyph: '▤' }],
  ['team', { cls: 'system', label: 'team', glyph: '⊞' }],
  ['clodex-team', { cls: 'system', label: 'clodex-team', glyph: '⊞' }],
  ['wirescope', { cls: 'system', label: 'wirescope', glyph: '∿' }],
  ['clodex', { cls: 'system', label: 'clodex', glyph: '◆' }],
  ['review-loop', { cls: 'system', label: 'review-loop', glyph: '⇄' }],
  ['merge-watchdog', { cls: 'system', label: 'merge-watchdog', glyph: '◉' }],
  ['user', { cls: 'operator', label: 'you', glyph: '●' }],
  ['clodex-hand-1138-r2', { cls: 'seat', label: 'hand-1138-r2', glyph: 'H' }],
  ['clodex-reviewer-1138-r1', { cls: 'seat', label: 'reviewer-1138-r1', glyph: 'R' }],
  ['clodex-designer', { cls: 'seat', label: 'designer', glyph: 'D' }],
  ['Codex', { cls: 'seat', label: 'Codex', glyph: 'C' }],
  ['alice@peer', { cls: 'peer', label: 'alice@peer', glyph: '⇢' }],
];

for (const [from, want] of TABLE) {
  test(`classifySender(${JSON.stringify(from)})`, () => {
    assert.deepStrictEqual(classifySender(from), want);
  });
}

test('SYSTEM_GLYPHS names exactly the known system senders', () => {
  assert.deepStrictEqual(Object.keys(SYSTEM_GLYPHS), ['reminder', 'reboot', 'ticket-loop', 'ticket-watchdog', 'monitor', 'memory', 'exec', 'terminal', 'team', 'clodex-team', 'wirescope', 'clodex']);
});
