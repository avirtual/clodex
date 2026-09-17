'use strict';
// The peer header's action strip is invisible at rest (opacity 0) and only
// paints on hover. Invisible is not absent: the strip kept its width, so a long
// host label ellipsized to make room for five buttons nobody
// could see. These pins hold the strip at ZERO width until it is shown, so the
// label gets the row.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseRules } = require('./lib/css-cascade');

const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

function decls(body) {
  const out = {};
  for (const d of body.split(';')) {
    const i = d.indexOf(':');
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return out;
}

function lastRuleWith(selector) {
  const hits = parseRules(cssSrc).filter((r) => r.selector
    .split(',').map((s) => s.trim()).includes(selector));
  assert.ok(hits.length >= 1, `ENTER: a rule carries the literal selector \`${selector}\``);
  return decls(hits[hits.length - 1].body);
}

test('the hidden peer action strip takes no width, so the host label is not ellipsized for buttons nobody sees', () => {
  const rest = lastRuleWith('.peer-actions');
  assert.strictEqual(rest.opacity, '0', 'the strip is hidden at rest — the premise of the width rule');
  assert.strictEqual(rest.width, '0');
  assert.strictEqual(rest['margin-left'], '0');
  assert.strictEqual(rest.overflow, 'hidden');
});

test('hover and keyboard focus give the strip its width back along with its opacity', () => {
  for (const selector of ['.peer-header:hover .peer-actions', '.peer-actions:focus-within']) {
    const shown = lastRuleWith(selector);
    assert.strictEqual(shown.opacity, '1', selector);
    assert.strictEqual(shown.width, 'auto', `${selector}: opacity alone would show a strip with no room to paint in`);
    assert.strictEqual(shown.overflow, 'visible', `${selector}: the tooltips hang outside the strip`);
  }
});

test('the label still ellipsizes when the strip IS shown, rather than pushing the row wider', () => {
  const label = lastRuleWith('.peer-label');
  assert.strictEqual(label['min-width'], '0');
  assert.strictEqual(label['text-overflow'], 'ellipsis');
});
