'use strict';
// plugin-prompt-checklist.test.js — t679: a plugin's append prompts draw in the
// append checklist as read-only rows grouped under the plugin, and its system
// prompts fill the system <select> — but only for a seat that holds the plugin.
//
// Two properties carry the file. The COLLECT exclusion, for the reason
// plugin-bundle-checklist.test.js states about skills: a bundle row is drawn
// checked, and collecting it would write `p:stem` into appendPromptFiles a
// second time, composing the same body twice at spawn. And the TICK SOURCE: an
// append row is ticked by the seat's appendPromptFiles, NOT by reach — unlike a
// skill, which the CLI loads whether or not anything selects it. A row ticked on
// reach alone would tell the operator the seat reads a prompt it does not.
//
// jsdom is not a dependency; the DOM here is the minimum the render functions
// touch, the same shape test/plugin-bundle-checklist.test.js uses.

const test = require('node:test');
const assert = require('node:assert');

function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false, disabled: false,
    innerHTML: '', children: [],
    appendChild(c) { c.parent = e; e.children.push(c); return c; },
    querySelectorAll(sel) {
      const flat = [];
      const walk = (n) => { for (const c of n.children) { flat.push(c); walk(c); } };
      walk(e);
      // Spelled out rather than pattern-matched: a stub that answered every
      // selector with everything would make the collect assertion vacuous, and
      // the `:not(:disabled)` clause IS the fix under test.
      if (sel === '.check-group, .bundle-row') {
        return flat.filter((c) => c.className === 'check-group'
          || String(c.className).split(' ').includes('bundle-row'));
      }
      assert.strictEqual(sel, 'input[type="checkbox"]:checked:not(:disabled)');
      return flat.filter((c) => c.tagName === 'input' && c.type === 'checkbox'
        && c.checked && !c.disabled);
    },
    remove() { const i = e.parent ? e.parent.children.indexOf(e) : -1; if (i >= 0) e.parent.children.splice(i, 1); },
  };
  let text = '';
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
  renderAppendChecklist, collectAppendChecklist,
  setPromptLibCache, setPluginCatalogCache, bundleSectionsOf, repaintBundleSections,
} = withDom(() => require('../renderer/lib/checklists'));

// The catalog shape plugin-host-engine's catalog() serves: prompts are
// `{name, kind}` because a system and an append prompt may share a stem and the
// two feed different UI.
const CATALOG = [
  {
    id: 'rev', name: 'Reviewer', shipped: false, editable: true, dir: '/p/rev',
    skills: [], agents: [], templates: ['audit'],
    prompts: [
      { name: 'strict', kind: 'system' },
      { name: 'rules', kind: 'append' },
      { name: 'extra', kind: 'append' },
    ],
  },
  {
    id: 'plain', name: 'No Prompts', shipped: false,
    skills: ['s'], agents: [], prompts: [], templates: [],
  },
];

const laidOut = (c) => c.children.map((n) => (n.className === 'check-group'
  ? ['head', n.textContent]
  : ['row', n.children.find((x) => x.tagName === 'input').value]));

const rowsOf = (c) => c.children
  .filter((n) => n.className !== 'check-group')
  .map((row) => {
    const cb = row.children.find((x) => x.tagName === 'input');
    return {
      name: cb.value, checked: cb.checked, disabled: cb.disabled, cls: row.className,
      html: row.children.find((x) => x.tagName === 'span').innerHTML,
    };
  });

const LIB = { system: [{ name: 'lib-sys', body: 'S' }], append: [{ name: 'lib-a', body: 'Library append.\n' }] };

test('t679: bundleSectionsOf splits the ONE prompts field by kind', () => withDom(() => {
  // The two rails are different UI, so a single `prompts` section would put a
  // system prompt in the append checklist — where ticking it would compose the
  // CLI-replacing prompt as an extra body.
  setPluginCatalogCache(CATALOG);

  assert.deepStrictEqual(bundleSectionsOf('prompts/append').map((s) => [s.id, s.name, s.names]),
    [['rev', 'Reviewer', ['rules', 'extra']]],
    'only the append-kind entries, and the plugin carrying none contributes no section');
  assert.deepStrictEqual(bundleSectionsOf('prompts/system').map((s) => s.names), [['strict']]);
  assert.deepStrictEqual(bundleSectionsOf('templates').map((s) => s.names), [['audit']]);

  // The ownership flag must survive to the drawers, which is the only place it
  // decides anything.
  assert.strictEqual(bundleSectionsOf('prompts/append')[0].editable, true);
  assert.strictEqual(bundleSectionsOf('prompts/append')[0].dir, '/p/rev');
}));

test('t679: APPEND: a held plugin\'s prompts draw under it, ticked by the seat\'s list not by reach', () => withDom(() => {
  setPluginCatalogCache(CATALOG);
  setPromptLibCache(LIB);
  const c = el('div');
  renderAppendChecklist(c, new Set(['lib-a', 'rev:rules']), { plugins: ['rev'] });

  assert.deepStrictEqual(laidOut(c), [
    ['row', 'lib-a'],
    ['head', 'Reviewer'],
    ['row', 'rev:rules'],
    ['row', 'rev:extra'],
  ], 'flat rows first, then ONE header per contributing plugin');

  const rows = new Map(rowsOf(c).map((r) => [r.name, r]));
  assert.deepStrictEqual(
    { checked: rows.get('rev:rules').checked, disabled: rows.get('rev:rules').disabled },
    { checked: true, disabled: true },
    'named by the seat, so it is ticked — and read-only, since the plugin tick is the switch');
  assert.strictEqual(rows.get('rev:extra').checked, false,
    'NOT named by the seat, so NOT ticked: reach alone does not mean the seat composes it, '
    + 'which is where an append prompt differs from a skill');
  assert.match(rows.get('rev:extra').html, /· via Reviewer/,
    'and it still reads as reachable — the greyed hint is keyed on reach, which is unchanged');
}));

test('t679: APPEND: a seat WITHOUT the plugin gets greyed rows telling it how to get them', () => withDom(() => {
  setPluginCatalogCache(CATALOG);
  setPromptLibCache(LIB);
  const c = el('div');
  renderAppendChecklist(c, new Set(), { plugins: [] });

  const rules = rowsOf(c).find((r) => r.name === 'rev:rules');
  assert.ok(rules, 'ENTER: the bundle row drew for a NON-member seat too — the hint is the point');
  assert.deepStrictEqual(
    { checked: rules.checked, disabled: rules.disabled, greyed: rules.cls.includes('skill-readonly') },
    { checked: false, disabled: true, greyed: true });
  assert.match(rules.html, /enable the Reviewer plugin for this session/);
}));

test('t679: APPEND: collect returns ONLY library stems, in both membership states', () => withDom(() => {
  setPluginCatalogCache(CATALOG);
  setPromptLibCache(LIB);

  for (const plugins of [['rev'], []]) {
    const c = el('div');
    renderAppendChecklist(c, new Set(['lib-a', 'rev:rules']), { plugins });

    // ENTER, and the reason this test exists: assert the bundle row DREW before
    // asserting it is absent from collect. A checklist that drew none satisfies
    // the absence vacuously, which is the green a missing render would produce.
    assert.ok(rowsOf(c).map((r) => r.name).includes('rev:rules'),
      `ENTER: the bundle row is on screen for plugins=${JSON.stringify(plugins)}`);

    assert.deepStrictEqual(collectAppendChecklist(c), ['lib-a'],
      'a bundle stem collected here would be written into appendPromptFiles a SECOND time, '
      + 'and the spawn would compose the same body twice');
  }
}));

test('t679: APPEND: no seat argument draws no bundle rows at all', () => withDom(() => {
  // A peer row's plugins are its own box's, so a surface that was not told which
  // seat it edits must not guess — the absent-list default would otherwise claim
  // reach on THIS box's shipped plugins.
  setPluginCatalogCache(CATALOG);
  setPromptLibCache(LIB);
  const c = el('div');
  renderAppendChecklist(c, new Set(['lib-a']));
  assert.deepStrictEqual(laidOut(c), [['row', 'lib-a']]);
}));

test('t679: APPEND: an empty library still draws the bundle section, not the add-some hint', () => withDom(() => {
  // The hint short-circuits before any row is drawn, so a plugin's prompts would
  // be invisible to an operator who keeps no library of their own.
  setPluginCatalogCache(CATALOG);
  setPromptLibCache({ system: [], append: [] });
  const c = el('div');
  renderAppendChecklist(c, new Set(), { plugins: ['rev'] });
  assert.strictEqual(c.innerHTML, '', 'the "No append prompts" hint must not have replaced the list');
  assert.deepStrictEqual(laidOut(c), [
    ['head', 'Reviewer'], ['row', 'rev:rules'], ['row', 'rev:extra'],
  ]);

  // CONTROL: with neither a library nor a bundle, the hint is still what shows.
  setPluginCatalogCache([]);
  const empty = el('div');
  renderAppendChecklist(empty, new Set(), { plugins: [] });
  assert.match(empty.innerHTML, /No append prompts in library/);
}));

test('t679: APPEND: repaint preserves the operator\'s ticks across a plugin toggle', () => withDom(() => {
  // The repaint runs on every plugin tick, and the checked set it is handed is
  // the LIVE one collected off the DOM. Without that, re-ticking a plugin would
  // silently clear whichever of its prompts the operator had selected — or,
  // ticking on reach, silently select every one of them.
  setPluginCatalogCache(CATALOG);
  setPromptLibCache(LIB);
  const c = el('div');
  renderAppendChecklist(c, new Set(['lib-a']), { plugins: [] });

  const flatBefore = c.children.find((n) => n.className === 'agent-check');
  assert.ok(flatBefore, 'ENTER: a flat row exists to be preserved');
  assert.ok(rowsOf(c).some((r) => r.name === 'rev:rules' && !r.checked),
    'ENTER: the bundle row drew unticked for the non-member seat');

  repaintBundleSections(c, 'prompts/append', { plugins: ['rev'] }, new Set(['rev:rules']));

  assert.strictEqual(c.children.find((n) => n.className === 'agent-check'), flatBefore,
    'the flat row is the SAME node — re-creating it is what loses scroll and focus');
  const rows = new Map(rowsOf(c).map((r) => [r.name, r]));
  assert.strictEqual(rows.get('rev:rules').checked, true, 'the passed tick survived the repaint');
  assert.strictEqual(rows.get('rev:extra').checked, false,
    'and reach did NOT tick the other one, which is the whole distinction');
  assert.deepStrictEqual(laidOut(c), [
    ['row', 'lib-a'], ['head', 'Reviewer'], ['row', 'rev:rules'], ['row', 'rev:extra'],
  ], 'exactly one bundle section after the swap, not two');
}));

// ── The system rail is a <select>, so it is pinned at source ────────────────
// fillSystemPromptSelect lives in renderer.js among ~6,400 lines of dialog
// wiring that no fixture here constructs. The properties below are real and
// invisible from the code being edited.

const fs = require('node:fs');
const path = require('node:path');

test('t679: fillSystemPromptSelect offers a plugin option only to a seat that HOLDS the plugin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf('function fillSystemPromptSelect');
  assert.ok(at > 0, 'ENTER: fillSystemPromptSelect was found');
  const body = src.slice(at, src.indexOf('\n}', at));

  assert.match(body, /bundleSectionsOf\('prompts\/system'\)/,
    'the plugin half reads the SYSTEM rail, not the append one');
  assert.match(body, /if \(!seat \|\| !seatHasPlugin\(sec\.id, seat\.plugins, sec\.shipped\)\) continue;/,
    'an option the seat cannot reach is a trap, not a hint: create() refuses that spawn outright');
  assert.match(body, /if \(current && !values\.includes\(current\)\)/,
    'an already-persisted ref survives an offering that no longer contains it, or opening the '
    + 'dialog while the plugin is disabled would silently clear the session\'s system prompt');
});

test('t679: both prompt rails are painted BELOW the plugin catalog fetch in each dialog', () => {
  // Same property plugin-bundle-checklist.test.js pins for the agents render:
  // the rails group their rows off pluginCatalogCache and read the seat off the
  // plugin checklist, so a paint above the fetch groups this dialog's rows under
  // the PREVIOUS dialog's plugin set.
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

  for (const [fn, end, seedRe, selectCall, appendCall] of [
    ['async function openArgsDialog', '\nfunction closeArgsDialog',
      /setPluginCatalogCache\(\(await window\.api\.pluginCatalog\(\)\)/,
      'fillSystemPromptSelect(argsSystemPrompt', 'renderAppendChecklist(argsAppendList'],
    ['async function openTemplateEditor', '\nasync function saveTemplateFromForm',
      /await refreshNewSessionPlugins\(/,
      'fillSystemPromptSelect(inputSystemPrompt', 'renderAppendChecklist(inputAppendList'],
  ]) {
    const at = src.indexOf(fn);
    assert.ok(at > 0, `ENTER: ${fn} was found`);
    const body = src.slice(at, src.indexOf(end, at));

    const seedAt = body.search(seedRe);
    const selectAt = body.indexOf(selectCall);
    const appendAt = body.indexOf(appendCall);
    assert.ok(seedAt > 0, `ENTER: the catalog seed is in ${fn}`);
    assert.ok(selectAt > 0 && appendAt > 0, `ENTER: and both rails are painted in ${fn}`);
    assert.ok(seedAt < selectAt && seedAt < appendAt,
      `${fn}: both prompt rails must draw off a FRESH plugin catalog and the ticks just painted`);
  }
});
