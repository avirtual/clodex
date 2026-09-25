'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

test('the voice arm of the bar click handler is exactly openVoicePopover(action)', () => {
  const arms = SRC.match(/else if \(action\.dataset\.act === 'voice'\)[^\n]*/g) || [];
  assert.deepStrictEqual(arms, ["else if (action.dataset.act === 'voice') openVoicePopover(action);"]);
});

test('the voice button has no contextmenu listener and no hold recording', () => {
  assert.ok(!/contextmenu[\s\S]{0,200}data-act="voice"/.test(SRC), 'a right-click handler on the voice button is back');
  assert.ok(!/data-act="voice"/.test(SRC), 'nothing in renderer.js addresses the voice button by selector');
  assert.ok(!/\bvoiceHeld\b/.test(SRC));
  assert.ok(!/\breleaseVoiceHold\b/.test(SRC));
  assert.ok(!/seatVoiceMode\([^)]*'hold'\)/.test(SRC));
});
