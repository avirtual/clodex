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

test('renderOutbox in renderer.js tags every outbox row with a literal queued state', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { fakeDocument, textOf } = require('./lib/fake-dom');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const body = src.match(/const renderOutbox = (\(items\) => \{[\s\S]*?\n  \});\n/);
  assert.ok(body, 'ENTER: renderOutbox is still found by this anchor');
  const document = fakeDocument();
  const outboxEl = document.createElement('div');
  const renderOutbox = new Function('document', 'outboxEl', 'outboxRowOf', `return ${body[1]};`)(document, outboxEl, outboxRowOf);
  renderOutbox([{ text: 'typed', origin: 'operator', images: 0 }, { text: '[agent:from lead] hi', origin: 'system', images: 0 }]);
  assert.strictEqual(outboxEl.childNodes.length, 2);
  for (const row of outboxEl.childNodes) {
    const state = row.childNodes[row.childNodes.length - 1];
    assert.strictEqual(state.className, 'seat-outbox-state');
    assert.strictEqual(textOf(state), 'queued');
  }
});
