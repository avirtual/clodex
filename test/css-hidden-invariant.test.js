'use strict';

// Guards the project's `.hidden` gotcha (CLAUDE.md / styles.css): there is NO
// generic `.hidden { display:none }` rule — every element that ships with
// class="hidden" is hidden by a PER-ID `#<id>.hidden` rule (standalone or in a
// grouped selector list). Miss the rule and the element renders ALWAYS-VISIBLE
// and unstyled — exactly the bug that shipped the intents popover in U7 before
// this test existed (and bit the exec drawer before that). This makes the whole
// class un-reintroducible: add a hidden id to index.html without wiring it into
// styles.css's grouped selectors and this fails.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf-8');
const css = fs.readFileSync(path.join(ROOT, 'renderer/styles.css'), 'utf-8');

// Every opening tag in index.html that carries BOTH an id and a class list
// containing the `hidden` token → the id must have a display:none .hidden rule.
function hiddenIdsInHtml(src) {
  const ids = [];
  for (const tag of src.match(/<[a-zA-Z][^>]*>/g) || []) {
    const idM = tag.match(/\bid="([^"]+)"/);
    const clsM = tag.match(/\bclass="([^"]*)"/);
    if (!idM || !clsM) continue;
    if (clsM[1].split(/\s+/).includes('hidden')) ids.push(idM[1]);
  }
  return ids;
}

// Flat-CSS parse: every `selectorList { body }` block whose body sets
// display:none contributes its `#id.hidden` selectors to the covered set.
function idsWithHiddenRule(src) {
  const covered = new Set();
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selectors, body] = m;
    if (!/display\s*:\s*none/.test(body)) continue;
    for (const sm of selectors.matchAll(/#([A-Za-z0-9_-]+)\.hidden\b/g)) covered.add(sm[1]);
  }
  return covered;
}

test('every class="hidden" id in index.html has a #id.hidden display:none rule', () => {
  const hiddenIds = hiddenIdsInHtml(html);
  // Sanity: the parse actually found the hidden elements (guards a broken regex
  // silently passing) and includes the id this test was born from.
  assert.ok(hiddenIds.length >= 20, `expected many hidden ids, found ${hiddenIds.length}`);
  assert.ok(hiddenIds.includes('intents-popover'), 'intents-popover should be a hidden id');

  const covered = idsWithHiddenRule(css);
  const missing = hiddenIds.filter((id) => !covered.has(id));
  assert.deepStrictEqual(missing, [],
    `hidden ids with no #id.hidden{display:none} rule in styles.css (always-visible bug): ${missing.join(', ')}`);
});
