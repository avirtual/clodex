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
const DIALOG_INPUT = '#dialog input,';
const OVERRIDE_RE = /#dialog\s+label\.agent-check\s*\{[^}]*display:\s*flex/;
const COLOUR_RE = /#dialog\s+label\.agent-check\s*\{[^}]*color:\s*var\(--text\)/;
const INPUT_OVERRIDE_RE =
  /#dialog\s+label\.agent-check\s+input\s*\{[^}]*width:\s*auto[^}]*padding:\s*0/;

test('#dialog label is still the block rule the override exists to beat', () => {
  const at = css.indexOf(DIALOG_LABEL);
  assert.ok(at !== -1, `ENTER: found the \`${DIALOG_LABEL}\` rule in styles.css`);
  const body = css.slice(at, css.indexOf('}', at));
  assert.match(body, /display:\s*block/,
    '`#dialog label` must still declare display:block — if it no longer does, '
    + 'the override below is pinning a fix for a bug that is gone');
});

test('#dialog label.agent-check input un-stretches the checkbox, after #dialog input', () => {
  const generic = css.indexOf(DIALOG_INPUT);
  assert.ok(generic !== -1, `ENTER: found the \`${DIALOG_INPUT}\` rule in styles.css`);
  const genericBody = css.slice(generic, css.indexOf('}', generic));
  assert.match(genericBody, /width:\s*100%/,
    '`#dialog input, #dialog select` must still declare width:100% — if it no '
    + 'longer does, the override below is pinning a fix for a bug that is gone');
  assert.ok(INPUT_OVERRIDE_RE.test(css),
    'styles.css must carry `#dialog label.agent-check input` with width:auto and padding:0');
  const override = css.search(INPUT_OVERRIDE_RE);
  assert.ok(override > generic,
    'the `#dialog label.agent-check input` rule must appear AFTER `#dialog input,` — '
    + `(override at ${override}, generic at ${generic})`);
});

test('#dialog label.agent-check carries the full text colour', () => {
  assert.ok(COLOUR_RE.test(css),
    '`#dialog label.agent-check` must declare color: var(--text) — `#dialog label` '
    + 'sets var(--text-dim) at higher specificity than the bare .agent-check rule');
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
