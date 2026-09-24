'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { outboxRowOf } = require('../renderer/lib/outbox-rows');

test('outboxRowOf: operator rows carry no badge; runtime replies take the intent reply glyph; dms name their sender', () => {
  assert.deepStrictEqual(outboxRowOf({ text: 'typed\nmore', origin: 'operator', images: 2 }),
    { origin: 'operator', badge: null, text: 'typed', images: 2 });
  assert.deepStrictEqual(outboxRowOf({ text: '[agent:exec] run #3 ok', origin: 'system', images: 0 }),
    { origin: 'system', badge: { glyph: '▸', label: 'run' }, text: 'run #3 ok', images: 0 });
  assert.deepStrictEqual(outboxRowOf({ text: '[agent:from lead] hi', origin: 'system', images: 0 }),
    { origin: 'system', badge: { glyph: null, label: 'lead' }, text: 'hi', images: 0 });
  assert.deepStrictEqual(outboxRowOf({ text: 'plain', origin: 'system', images: 0 }),
    { origin: 'system', badge: { glyph: null, label: 'system' }, text: 'plain', images: 0 });
  assert.strictEqual(outboxRowOf({ text: 'z'.repeat(400), origin: 'operator' }).text.length, 160);
});
