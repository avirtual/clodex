'use strict';
// Run: node --test test/dialog-checklist-align.test.js
//
// t729 — the New Session dialog's tool/skill/agent checklist rows are
// `<label class="agent-check">`, and `#dialog label { display: block }` outranks
// `.agent-check { display: flex }` on specificity (id+element beats one class),
// so every checkbox rendered ABOVE its label instead of beside it. The fix is an
// equally-specific `#dialog label.agent-check` rule, which wins only because it
// comes LATER in the file — so source ORDER is load-bearing here and a reorder
// silently reintroduces the bug. Both facts are what this pins; neither is
// observable without a browser, which is why the assertions read the CSS text.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

const DIALOG_LABEL = '#dialog label {';
const OVERRIDE_RE = /#dialog\s+label\.agent-check\s*\{[^}]*display:\s*flex/;

test('#dialog label is still the block rule the override exists to beat', () => {
  const at = css.indexOf(DIALOG_LABEL);
  assert.ok(at !== -1, `ENTER: found the \`${DIALOG_LABEL}\` rule in styles.css`);
  const body = css.slice(at, css.indexOf('}', at));
  assert.match(body, /display:\s*block/,
    '`#dialog label` must still declare display:block — if it no longer does, '
    + 'the override below is pinning a fix for a bug that is gone');
});

test('#dialog label.agent-check restores flex, and does so after #dialog label', () => {
  assert.ok(OVERRIDE_RE.test(css),
    'styles.css must carry `#dialog label.agent-check { display: flex }`');
  const override = css.search(OVERRIDE_RE);
  const generic = css.indexOf(DIALOG_LABEL);
  assert.ok(override > generic,
    'the `#dialog label.agent-check` rule must appear AFTER `#dialog label` — '
    + `equal specificity, so order decides (override at ${override}, generic at ${generic})`);
});
