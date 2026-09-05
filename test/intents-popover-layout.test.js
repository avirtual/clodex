'use strict';

// The Intents popover is a flex column capped at 70vh whose only direct
// scrollable child is #popover-intents-list; the Plugins, Exec Grants and
// Plugin Access blocks sit in wrapper divs that cannot shrink below their
// content. With the shell on overflow:hidden and the list on flex:1 (basis 0),
// every pixel the four sections overrun the cap is taken from the intents list
// alone — it collapsed to a one-row sliver and the Apply row was clipped off the
// bottom. The shell must scroll as a whole and the list must keep its own
// height (it still scrolls internally under .agent-checklist's max-height).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer/styles.css'), 'utf-8');

function rules(selectorRe) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => sel.split(',').some((s) => selectorRe.test(s.trim())))
    .map(([, sel, body]) => ({ sel: sel.trim(), body }));
}

function lastDeclaration(selectorRe, prop) {
  let value = null;
  for (const r of rules(selectorRe)) {
    const m = r.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
    if (m) value = m[1].trim();
  }
  return value;
}

test('the Intents popover shell scrolls instead of clipping its four sections', () => {
  const shell = rules(/^#intents-popover$/);
  assert.ok(shell.length >= 2, 'ENTER: the #intents-popover shell rules were found');
  assert.strictEqual(lastDeclaration(/^#intents-popover$/, 'overflow-y'), 'auto');
  assert.notStrictEqual(lastDeclaration(/^#intents-popover$/, 'overflow'), 'hidden',
    'a later overflow:hidden on the shell re-clips the Apply row');
  assert.strictEqual(lastDeclaration(/^#intents-popover$/, 'resize'), 'both',
    'the resize handle must survive (it needs overflow != visible, which auto satisfies)');
});

test('the intents list keeps its own height instead of absorbing the overrun', () => {
  const list = rules(/^#intents-popover #popover-intents-list$/);
  assert.ok(list.length >= 2, 'ENTER: both the shared flex:1 rule and the override were found');
  assert.strictEqual(lastDeclaration(/^#intents-popover #popover-intents-list$/, 'flex'), '0 0 auto');
});
