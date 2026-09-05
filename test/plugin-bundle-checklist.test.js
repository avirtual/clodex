'use strict';
// plugin-bundle-checklist.test.js — t675 phase B: a plugin's own skills and
// agents draw in the session checklists, grouped under the plugin, READ-ONLY.
//
// The CLI loads every skill in a bundle the seat holds, so the row is
// informational rather than a toggle. That makes the COLLECT assertion the one
// that matters: a bundle row is `checked`, and the collectors used to return
// every checked box — so drawing these rows without narrowing the selector
// writes `pluginId:skill` into `injectSkills`, a flat-library list whose names
// scaffold into a --plugin-dir. Nothing would have refused it.
//
// jsdom is not a dependency; the DOM here is the minimum the render functions
// touch, the same shape test/skill-checklist-scope.test.js uses.

const test = require('node:test');
const assert = require('node:assert');

function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false, disabled: false,
    innerHTML: '', children: [],
    appendChild(c) { e.children.push(c); return c; },

    querySelectorAll(sel) {
      // Spelled out, not pattern-matched: a stub answering every selector with
      // everything would make the collect assertions below vacuous — and the
      // `:not(:disabled)` clause IS the fix under test, so a stub that ignored
      // it would pass against the unfixed collector.
      assert.strictEqual(sel, 'input[type="checkbox"]:checked:not(:disabled)');
      const flat = [];
      const walk = (n) => { for (const c of n.children) { flat.push(c); walk(c); } };
      walk(e);
      return flat.filter((c) => c.tagName === 'input' && c.type === 'checkbox'
        && c.checked && !c.disabled);
    },
  };
  let text = '';
  // format.js's `esc` round-trips through textContent/innerHTML, so the stub has
  // to model that pair or every label reads as empty.
  Object.defineProperty(e, 'textContent', {
    get: () => text,
    set(v) {
      text = v == null ? '' : String(v);
      e.innerHTML = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  });
  return e;
}

function withDom(fn) {
  const had = global.document;
  global.document = { createElement: el, addEventListener() {} };
  try { return fn(); } finally { global.document = had; }
}

const {
  renderInjectChecklist, collectInjectChecklist,
  renderAgentChecklist, collectAgentChecklist,
  setSkillLibCache, setAgentLibCache, setPluginCatalogCache, bundleSectionsOf,
} = withDom(() => require('../renderer/lib/checklists'));

const CATALOG = [
  { id: 'stocks', name: 'Stock Assessments', shipped: false, skills: ['assess', 'compare'], agents: ['screener'] },
  { id: 'plain', name: 'No Bundle', shipped: false, skills: [], agents: [] },
];

// Headers and rows are both direct children, so one flat list keeps their
// INTERLEAVING visible: a header count alone would pass a render that drew every
// header up front, detached from the rows it names.
const laidOut = (c) => c.children.map((n) => (n.className === 'check-group'
  ? ['head', n.textContent]
  : ['row', n.children.find((x) => x.tagName === 'input').value]));

const rowsOf = (c) => c.children
  .filter((n) => n.className !== 'check-group')
  .map((row) => {
    const cb = row.children.find((x) => x.tagName === 'input');
    return {
      name: cb.value,
      checked: cb.checked,
      disabled: cb.disabled,
      cls: row.className,
      html: row.children.find((x) => x.tagName === 'span').innerHTML,
    };
  });

test('SKILLS: a seat WITH the plugin gets checked+disabled bundle rows flagged via the plugin', () => withDom(() => {
  setPluginCatalogCache(CATALOG);
  setSkillLibCache([{ name: 'my-skill', description: 'mine' }]);
  const c = el('div');
  renderInjectChecklist(c, new Set(['my-skill']), null, { plugins: ['stocks'] });

  assert.deepStrictEqual(laidOut(c), [
    ['row', 'my-skill'],
    ['head', 'Stock Assessments'],
    ['row', 'stocks:assess'],
    ['row', 'stocks:compare'],
  ], 'flat rows first, then ONE header per contributing plugin — and a plugin carrying no skills gets no header');

  const assess = rowsOf(c).find((r) => r.name === 'stocks:assess');
  assert.deepStrictEqual(
    { checked: assess.checked, disabled: assess.disabled },
    { checked: true, disabled: true },
    'the CLI loads it whether or not a box is ticked, so the row states that instead of offering a toggle');
  assert.match(assess.html, /· via Stock Assessments/);
  assert.match(assess.html, /<strong>assess<\/strong>/, 'labeled by its bare name, under the plugin heading');
}));

test('SKILLS: a seat WITHOUT the plugin gets greyed rows telling it how to get them', () => withDom(() => {
  setPluginCatalogCache(CATALOG);
  setSkillLibCache([{ name: 'my-skill', description: 'mine' }]);
  const c = el('div');
  renderInjectChecklist(c, new Set(), null, { plugins: [] });

  const assess = rowsOf(c).find((r) => r.name === 'stocks:assess');
  assert.ok(assess, 'ENTER: the bundle row drew for a NON-member seat too — it is the hint that is the point');
  assert.deepStrictEqual(
    { checked: assess.checked, disabled: assess.disabled, greyed: assess.cls.includes('skill-readonly') },
    { checked: false, disabled: true, greyed: true });
  assert.match(assess.html, /enable the Stock Assessments plugin for this session/);
}));

test('SKILLS: collect returns ONLY flat library names, in both membership states', () => withDom(() => {
  setPluginCatalogCache(CATALOG);
  setSkillLibCache([{ name: 'my-skill' }, { name: 'other' }]);

  for (const plugins of [['stocks'], []]) {
    const c = el('div');
    renderInjectChecklist(c, new Set(['my-skill']), null, { plugins });

    // ENTER, and the reason this test exists: assert the bundle row DREW before
    // asserting it is absent from collect. A checklist that drew no bundle rows
    // satisfies the absence vacuously, which is exactly the green a missing
    // render would produce.
    const drawn = rowsOf(c).map((r) => r.name);
    assert.ok(drawn.includes('stocks:assess'),
      `ENTER: the bundle row must be on screen for plugins=${JSON.stringify(plugins)}`);

    assert.deepStrictEqual(collectInjectChecklist(c), ['my-skill'],
      'a bundle name in injectSkills would scaffold a flat-library skill that does not exist');
  }
}));

test('AGENTS: the same grouping, flag and collect exclusion', () => withDom(() => {
  setPluginCatalogCache(CATALOG);
  setAgentLibCache([{ name: 'explorer', description: 'reads' }]);

  const member = el('div');
  renderAgentChecklist(member, new Set(['explorer']), null, { plugins: ['stocks'] });
  assert.deepStrictEqual(laidOut(member), [
    ['row', 'explorer'],
    ['head', 'Stock Assessments'],
    ['row', 'stocks:screener'],
  ]);
  const screener = rowsOf(member).find((r) => r.name === 'stocks:screener');
  assert.deepStrictEqual({ checked: screener.checked, disabled: screener.disabled },
    { checked: true, disabled: true });
  assert.match(screener.html, /· via Stock Assessments/);
  assert.deepStrictEqual(collectAgentChecklist(member), ['explorer']);

  const outsider = el('div');
  renderAgentChecklist(outsider, new Set(['explorer']), null, { plugins: [] });
  const greyed = rowsOf(outsider).find((r) => r.name === 'stocks:screener');
  assert.match(greyed.html, /enable the Stock Assessments plugin/);
  assert.strictEqual(greyed.checked, false);
  assert.deepStrictEqual(collectAgentChecklist(outsider), ['explorer']);
}));

test('a SHIPPED plugin reaches a seat with no list at all, exactly as seatHasPlugin says', () => withDom(() => {
  // seatHasPlugin's absent case is OPPOSITE-polarity for a shipped plugin: an
  // absent list means "the shipped default", so these rows must read as held.
  // Getting this backwards would tell every pre-upgrade seat to enable a plugin
  // it already has.
  setPluginCatalogCache([{ id: 'core-p', name: 'Core Plugin', shipped: true, skills: ['warm'], agents: [] }]);
  setSkillLibCache([]);
  const c = el('div');
  renderInjectChecklist(c, new Set(), null, { plugins: null });
  const row = rowsOf(c)[0];
  assert.strictEqual(row.name, 'core-p:warm', 'ENTER: the shipped bundle row drew');
  assert.strictEqual(row.checked, true);
  assert.match(row.html, /· via Core Plugin/);
}));

test('NO seat argument draws no bundle rows at all', () => withDom(() => {
  // The surfaces that have not been told which seat they are editing (a peer
  // row, whose plugins are its own box's) must not guess. Without this the
  // absent-list default would claim reach on the shipped plugins of THIS box.
  setPluginCatalogCache(CATALOG);
  setSkillLibCache([{ name: 'my-skill' }]);
  const c = el('div');
  renderInjectChecklist(c, new Set(['my-skill']));
  assert.deepStrictEqual(laidOut(c), [['row', 'my-skill']]);
}));

test('an empty flat library still draws the bundle section rather than the add-some hint', () => withDom(() => {
  // The hint short-circuits before any row is drawn, so a plugin's skills would
  // be invisible on a box whose operator keeps no library of their own.
  setPluginCatalogCache(CATALOG);
  setSkillLibCache([]);
  const c = el('div');
  renderInjectChecklist(c, new Set(), null, { plugins: ['stocks'] });
  assert.strictEqual(c.innerHTML, '', 'the "No skills in library" hint must not have replaced the list');
  assert.deepStrictEqual(laidOut(c), [
    ['head', 'Stock Assessments'],
    ['row', 'stocks:assess'],
    ['row', 'stocks:compare'],
  ]);

  // CONTROL: with neither a library nor a bundle, the hint is still what shows.
  setPluginCatalogCache([]);
  const empty = el('div');
  renderInjectChecklist(empty, new Set(), null, { plugins: [] });
  assert.match(empty.innerHTML, /No skills in library/);
}));

test('bundleSectionsOf lists every contributing plugin, seat-independently', () => withDom(() => {
  // The drawers' source: a library view has no seat to scope to, so this half
  // must NOT filter by membership.
  setPluginCatalogCache(CATALOG);
  assert.deepStrictEqual(bundleSectionsOf('skills').map((s) => [s.id, s.name, s.names]),
    [['stocks', 'Stock Assessments', ['assess', 'compare']]],
    'the plugin carrying no skills contributes no section');
  assert.deepStrictEqual(bundleSectionsOf('agents').map((s) => s.names), [['screener']]);
}));

// ── The args dialog's fetch/render ORDERING ─────────────────────────────────
// A source-shape pin, because no runtime fixture here drives openArgsDialog: it
// awaits five IPC reads and paints ~15 sections. The property is real and
// invisible from the code being edited — the agents render draws bundle rows off
// pluginCatalogCache, so a catalog fetch BELOW it groups this session's rows
// under whatever plugin set the previously-opened dialog left behind.
const fs = require('node:fs');
const path = require('node:path');

test('openArgsDialog seeds the plugin catalog BEFORE it renders the agents checklist', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf('async function openArgsDialog');
  assert.ok(at > 0, 'ENTER: openArgsDialog was found');
  const end = src.indexOf('\n}', at);
  assert.ok(end > at, 'ENTER: the function body slice is bounded');
  const body = src.slice(at, end);

  const fetchAt = body.indexOf('setPluginCatalogCache((await window.api.pluginCatalog())');
  const agentsAt = body.indexOf('renderAgentChecklist(argsAgentsList');
  assert.ok(fetchAt > 0, 'ENTER: the catalog fetch is in this function');
  assert.ok(agentsAt > 0, 'ENTER: and the agents render is too');
  assert.ok(fetchAt < agentsAt,
    'the catalog must be fresh before the agents checklist draws its bundle rows, or they are '
    + 'grouped by the previous dialog\'s plugin set');

  // The skills render is inside a later conditional block and reads the same
  // cache; it is below the fetch by construction, and this asserts it stays so.
  const skillsAt = body.indexOf('renderInjectChecklist(argsInjectSkillsList');
  assert.ok(skillsAt > fetchAt, 'the inject checklist draws off the same fresh catalog');
});
