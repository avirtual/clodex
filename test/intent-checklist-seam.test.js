'use strict';

// R-INT-4 / MUST-FIX 2: the renderer's intent checklist must not read a STATIC
// copy of the catalog.
//
// Two failure modes this closes, both real:
//   * a plugin registers a verb at runtime → a static require can never show it;
//   * the WEB bundle freezes its copy of intent-catalog.js at build time → a
//     served renderer shows whatever the row set was on build day, forever.
//
// So the rows come over IPC into a cache with a setter (the `setExecLibCache`
// pattern), and the ALLOWLIST COLLAPSE moved engine-side. What stays in the
// renderer is the checked-state decision, which is why its equivalence to the
// engine's gate is pinned here rather than assumed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { intentRowChecked, collectIntentChecklist, setIntentCatalogCache } = require('../renderer/lib/checklists');
const { GATEABLE_INTENTS, PRIVILEGED_INTENTS, intentEnabled, intentsAllowlistFromChecked } = require('../intent-catalog');
const registry = require('../intent-registry');

test('checklists.js no longer statically requires intent-catalog', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'lib', 'checklists.js'), 'utf8');
  // Comments in that file DO mention intent-catalog by name (they explain why the
  // require left), so match the require itself, not the word.
  assert.ok(!/require\(\s*['"][^'"]*intent-catalog['"]\s*\)/.test(src),
    'a static intent-catalog require is exactly the stale-copy bug R-INT-4 removes');
  assert.match(src, /setIntentCatalogCache/, 'the served-rows seam must be present');
});

test("the renderer's checked-state matches the engine's gate for every core row", () => {
  const lists = [
    null,
    undefined,
    [],
    ['dm'],
    ['dm', 'reboot'],
    GATEABLE_INTENTS.map((i) => i.type),
    GATEABLE_INTENTS.filter((i) => !PRIVILEGED_INTENTS.has(i.type)).map((i) => i.type),
  ];
  for (const row of registry.catalogRows()) {
    for (const list of lists) {
      assert.strictEqual(
        intentRowChecked(row, list),
        intentEnabled(row.type, list),
        `row ${row.type} with list ${JSON.stringify(list)}`,
      );
    }
  }
});

test('a PLUGIN row is unchecked under an absent list — where intent-catalog would say true', () => {
  // The whole reason the renderer reads the SERVED row's `privileged` flag rather
  // than calling intentEnabled: a plugin verb is not in the leaf's catalog, so the
  // leaf answers TRUE for it ("ungateable by omission") — which on the checklist
  // would render as a granted box for a seat that was never granted anything.
  const row = { type: 'branch', label: 'Report git branch (branch)', privileged: true };
  assert.strictEqual(intentRowChecked(row, null), false);
  assert.strictEqual(intentRowChecked(row, []), false);
  assert.strictEqual(intentRowChecked(row, ['dm']), false);
  assert.strictEqual(intentRowChecked(row, ['branch']), true);
  assert.strictEqual(intentEnabled('branch', null), true, 'the leaf really would say true — this is the trap');
});

test('collectIntentChecklist returns the RAW checked set, uncollapsed', () => {
  // The collapse is the engine's call now. A renderer that still collapsed would
  // decide "all boxes checked" against its own row set — the stale-copy class.
  const container = {
    querySelectorAll: () => [{ value: 'dm' }, { value: 'who' }],
  };
  assert.deepStrictEqual(collectIntentChecklist(container), ['dm', 'who']);
  const allCore = GATEABLE_INTENTS.filter((i) => !PRIVILEGED_INTENTS.has(i.type)).map((i) => i.type);
  const allContainer = { querySelectorAll: () => allCore.map((v) => ({ value: v })) };
  assert.deepStrictEqual(collectIntentChecklist(allContainer), allCore,
    'the all-checked case must reach the engine as an ARRAY, not as a pre-collapsed null');
  // ...and the engine is what turns it into the persisted null.
  assert.strictEqual(registry.allowlistFromChecked(collectIntentChecklist(allContainer)), null);
  assert.strictEqual(intentsAllowlistFromChecked(allCore), null, 'same answer the core leaf gives');
});

test('setIntentCatalogCache tolerates a failed fetch without throwing', () => {
  // Every call site is `setIntentCatalogCache((await window.api.getIntentCatalog()) || [])`,
  // but a null slipping through must degrade to an empty checklist, not a crash
  // inside the render loop.
  assert.doesNotThrow(() => setIntentCatalogCache(null));
  assert.doesNotThrow(() => setIntentCatalogCache(undefined));
  assert.doesNotThrow(() => setIntentCatalogCache('nonsense'));
  setIntentCatalogCache(registry.catalogRows());
});

test('the served catalog carries exactly the three fields the checklist needs', () => {
  for (const row of registry.catalogRows()) {
    assert.deepStrictEqual(Object.keys(row).sort(), ['label', 'privileged', 'source', 'type']);
    assert.strictEqual(typeof row.label, 'string');
    assert.strictEqual(typeof row.privileged, 'boolean');
  }
});
