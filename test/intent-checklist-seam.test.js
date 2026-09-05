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
  // CORE rows only, and the filter is load-bearing rather than defensive: for a
  // PLUGIN row these two deliberately DISAGREE, which is the point of the very
  // next test. Plugin verbs are forced privileged on the registry row, while
  // intent-catalog's PRIVILEGED_INTENTS knows nothing about registry rows and
  // answers "ungateable by omission" — so an ungranted plugin verb is `false`
  // here and `true` there, by design. Iterating every row would assert an
  // equivalence that only ever held for core, and it held today only because
  // this file loads no plugins and registers no verb. The intent registry is a
  // module-level table; the day a sibling test in this file registers one, an
  // unfiltered loop goes red for a correctness property nobody broke.
  const coreRows = registry.catalogRows().filter((r) => r.source === 'core');
  assert.ok(coreRows.length > 5, 'the core rows must actually be there to iterate');
  for (const row of coreRows) {
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

test('a REGISTERED plugin verb diverges the same way — which is why the seam test filters to core', () => {
  // The test above uses a synthetic row literal, so it pins the divergence
  // without ever putting a row in the module-level registry. This one registers
  // for real, and exists to keep the `source === 'core'` filter above honest:
  // without the filter, this registration alone turns that test red, and the
  // failure would look like a broken seam rather than a plugin row being served.
  // The registry is a module-level table shared by every test in the process.
  registry.registerIntent({ verb: 'seamprobe', label: 'Seam probe', parse: () => null }, 'seam-fake', { shipped: true });
  try {
    const row = registry.catalogRows().find((r) => r.type === 'seamprobe');
    assert.ok(row, 'the verb really is served in the catalog');
    assert.strictEqual(row.source, 'seam-fake', 'and it carries a non-core source the filter can see');
    assert.strictEqual(row.privileged, true, 'plugin verbs are forced privileged on the ROW (§7)');

    // The divergence, on a real row: the checklist says no, the leaf says yes.
    assert.strictEqual(intentRowChecked(row, null), false, 'ungranted seat: no box');
    assert.strictEqual(intentEnabled('seamprobe', null), true, 'the leaf is blind to registry rows');

    // Core rows are untouched by the presence of a plugin row.
    for (const core of registry.catalogRows().filter((r) => r.source === 'core')) {
      assert.strictEqual(intentRowChecked(core, ['dm']), intentEnabled(core.type, ['dm']), core.type);
    }

    // And the filter's necessity, proven rather than argued. Asserting it HERE
    // rather than by reverting the filter above is deliberate: node runs tests
    // in file order, so the seam test executes before this registration and a
    // reverted filter would pass by accident of ordering. Running the unfiltered
    // loop at a moment when a plugin row IS registered is the same proof with no
    // dependence on which test happens to run first.
    assert.throws(
      () => {
        for (const row of registry.catalogRows()) {
          assert.strictEqual(intentRowChecked(row, null), intentEnabled(row.type, null), row.type);
        }
      },
      /seamprobe/,
      'the unfiltered equivalence loop must fail on a plugin row — that is what the filter is for',
    );
  } finally {
    registry._resetPluginRows();
  }
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
  // Deliberately NOT filtered to core, unlike the equivalence loop above. Row
  // SHAPE is a property every served row must satisfy — a plugin row that
  // carried an extra field would be a real defect, and this is the gate that
  // would catch it. Only the checked-state equivalence is core-only.
  for (const row of registry.catalogRows()) {
    assert.deepStrictEqual(Object.keys(row).sort(), ['label', 'privileged', 'source', 'type']);
    assert.strictEqual(typeof row.label, 'string');
    assert.strictEqual(typeof row.privileged, 'boolean');
  }
});

// ── t654: the plugin checklist, and the EDITOR_OWNED trap ───────────────────
// `plugins` joins EDITOR_OWNED, where an OMITTED owned key on save means "the
// user cleared it". Cleared here means ABSENT, and absent means EVERY plugin —
// so a session type whose branch omits the key hands that seat every plugin
// installed, silently and forever. That is the one direction this field can
// fail in without anything looking wrong, which is why the assertion is on the
// SOURCE of collectFormConfig rather than on a value: the bug is a `type ===
// 'claude' ? … : (nothing)` shape, and no runtime fixture can see the branch it
// never takes.
test('t654: collectFormConfig writes `plugins` UNCONDITIONALLY, for every session type', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const body = src.slice(src.indexOf('function collectFormConfig()'));
  const end = body.indexOf('\nfunction ');
  const fn = body.slice(0, end === -1 ? body.length : end);
  assert.ok(fn.includes('collectFormConfig'), 'ENTER: the function body was actually located');

  // The conditional keys in this object are written `...(cond ? { k } : {})`.
  // `plugins` must be a PLAIN key in the returned literal — a spread would make
  // it omittable, and omitted is the failing direction.
  assert.match(fn, /^\s{4}plugins,\s*$/m,
    'plugins must be a plain key in the returned object, never a conditional spread');
  assert.ok(!/\.\.\.\([^)]*\?\s*\{\s*plugins/.test(fn),
    'and never wrapped in a conditional spread the way intents/autoCompact are');

  // A seat whose dialog has no Plugins section gets the materialised
  // globally-enabled set. Not `null` — that reads as absent at every consumer,
  // and this key is EDITOR_OWNED so it is written either way. Not `[]` either:
  // there is no UI to reopen a seat closed to every plugin, and the closure
  // takes its onAgentText feed with it.
  assert.match(fn, /:\s*defaultPluginTicks\(\);/,
    'a non-claude seat writes the globally-enabled set, not null and not []');
});

test('t654: `plugins` is in EDITOR_OWNED — the maintained pair collectFormConfig names', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'stores.js'), 'utf8');
  const owned = src.slice(src.indexOf('const EDITOR_OWNED = new Set(['));
  const list = owned.slice(0, owned.indexOf(']);'));
  assert.ok(list.includes("'intents'"), 'ENTER: the EDITOR_OWNED literal was located');
  assert.ok(list.includes("'plugins'"),
    'an owned key missing here is resurrected by merge-preserve after the operator clears it');
});

// ── t674: the tools ALLOWLIST, same maintained pair, opposite default ────────
// `tools` is the reviewer allowlist (`disabledTools` is the unrelated denylist).
// It is EDITOR_OWNED for the clear direction — an emptied control must remove the
// stored list — but unlike `plugins` it is written CONDITIONALLY, because absent
// and `[]` mean different things at the reviewer: absent accepts the full cap,
// `[]` is refused. So the shape assertions run the other way, and a plain key
// here would be the defect.
test('t674: collectFormConfig writes `tools` only when something is ticked — never [] and never null', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const body = src.slice(src.indexOf('function collectFormConfig()'));
  const end = body.indexOf('\nfunction ');
  const fn = body.slice(0, end === -1 ? body.length : end);
  assert.ok(fn.includes('collectFormConfig'), 'ENTER: the function body was actually located');

  assert.match(fn, /\.\.\.\(toolsAllow\.length \? \{ tools: toolsAllow \} : \{\}\)/,
    'the conditional-spread shape: an empty allowlist omits the key entirely');
  assert.ok(!/^\s{4}tools,\s*$/m.test(fn),
    'and never a plain key — that would write [] on every save and refuse every reviewer');
  assert.ok(!/tools:\s*null/.test(fn),
    'nor null, which since t674 is refused as a type fault rather than read as absent');

  // The collect is gated on authoring mode: the control is drawn only in the
  // template editor, so a create-mode collect would read an unrendered checklist.
  assert.match(fn, /dialogMode === 'template'[^\n]*\n?[^\n]*collectToolAllowChecklist/,
    'the allowlist is collected only while authoring a template');
});

test('t674: `tools` is in EDITOR_OWNED — an emptied control must CLEAR, not preserve', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'stores.js'), 'utf8');
  const owned = src.slice(src.indexOf('const EDITOR_OWNED = new Set(['));
  const list = owned.slice(0, owned.indexOf(']);'));
  assert.ok(list.includes("'intents'"), 'ENTER: the EDITOR_OWNED literal was located');
  assert.ok(list.includes("'tools'"),
    'without it, merge-preserve resurrects a narrowed reviewer list the operator just cleared');
});
