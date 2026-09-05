'use strict';
// plugin-prompt-checklist.test.js — t679: a plugin's append prompts draw in the
// append checklist as read-only rows grouped under the plugin, and its system
// prompts fill the system <select> — but only for a seat that holds the plugin.
//
// Two properties carry the file, and they are the same fact from both ends. The
// TICK SOURCE: an append row is ticked by the seat's own appendPromptFiles, NOT
// by reach — unlike a skill, which the CLI loads whether or not anything selects
// it — so a row ticked on reach alone would claim a prompt the seat never reads.
// And the COLLECT ROUND TRIP: because the tick comes from that list, the bundle
// row is the ONLY representation of a `pluginId:stem` in the form, so the
// collector must return it. Filtering it out (as the skills collector correctly
// does for its own rows) sends `appendPromptFiles: []` and silently drops every
// plugin append prompt on save — including back into the plugin folder.
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
      // selector with everything would make the collect assertions vacuous. The
      // equality below is what makes this stub fail loudly if the collector's
      // selector changes, rather than quietly answering the wrong set — it is
      // how the `:not(:disabled)` regression was caught on the way OUT.
      if (sel === '.check-group, .bundle-row') {
        return flat.filter((c) => c.className === 'check-group'
          || String(c.className).split(' ').includes('bundle-row'));
      }
      if (sel === '.hint-text') {
        return flat.filter((c) => String(c.className).split(' ').includes('hint-text'));
      }
      assert.strictEqual(sel, 'input[type="checkbox"]:checked',
        'the append collector must NOT filter disabled rows — a bundle row is the only '
        + 'representation of a pluginId:stem in the form');
      return flat.filter((c) => c.tagName === 'input' && c.type === 'checkbox' && c.checked);
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

test('t679: APPEND: collect RETURNS the namespaced stems, or every dialog drops them', () => withDom(() => {
  // The opposite of the skills and agents collectors, and the asymmetry is the
  // whole point. A bundle SKILL row is informational — the CLI loads it with the
  // plugin, and `injectSkills` is a flat-library list where `p:skill` names
  // nothing — so those collectors filter disabled rows out. A bundle APPEND row
  // is the ONLY representation of a `pluginId:stem` in the form, and
  // `readAppendBodies` composes exactly the stems it is handed. Filtering it out
  // therefore sends `appendPromptFiles: []`: a New Session started from a plugin
  // template never boots its own prompt, an Edit Session save silently clears a
  // namespaced entry the seat already holds, and saving a plugin template
  // through the drawer writes the empty list back INTO the plugin folder,
  // destroying the author's list.
  setPluginCatalogCache(CATALOG);
  setPromptLibCache(LIB);

  const held = el('div');
  renderAppendChecklist(held, new Set(['lib-a', 'rev:rules']), { plugins: ['rev'] });
  // ENTER: assert the row is on screen AND ticked before asserting it collects —
  // an unticked row would satisfy the absence below for the wrong reason.
  const rules = rowsOf(held).find((r) => r.name === 'rev:rules');
  assert.ok(rules && rules.checked, 'ENTER: the bundle row drew ticked for the holder');

  assert.deepStrictEqual(collectAppendChecklist(held), ['lib-a', 'rev:rules'],
    'the namespaced stem survives the round trip, so a save writes back what the form showed');

  // Idempotent by construction: a bundle row is checked only when the set handed
  // in already named it, so collecting it back can never ADD a stem the seat did
  // not have. The unticked sibling is what proves that.
  assert.ok(rowsOf(held).some((r) => r.name === 'rev:extra' && !r.checked),
    'ENTER: the plugin also ships an append prompt this seat did NOT select');
  assert.ok(!collectAppendChecklist(held).includes('rev:extra'),
    'and reach alone does not put it in the list');

  // A NON-holder's row is drawn unticked, so nothing collects it — the seat
  // cannot be saved holding a prompt it has no way to read.
  const outsider = el('div');
  renderAppendChecklist(outsider, new Set(['lib-a']), { plugins: [] });
  assert.ok(rowsOf(outsider).map((r) => r.name).includes('rev:rules'),
    'ENTER: the bundle row is on screen for the non-holder too');
  assert.deepStrictEqual(collectAppendChecklist(outsider), ['lib-a']);

  // A seat that HOLDS the stem but no longer the plugin (Edit Session with `rev`
  // unticked): the row must draw unticked so the save drops the stem, or the
  // next start is refused "does not hold".
  const unheld = el('div');
  renderAppendChecklist(unheld, new Set(['lib-a', 'rev:rules']), { plugins: [] });
  const stale = rowsOf(unheld).find((r) => r.name === 'rev:rules');
  assert.ok(stale, 'ENTER: the row is on screen for the un-holder');
  assert.strictEqual(stale.checked, false, 'named by the seat but unreachable: NOT ticked');
  assert.deepStrictEqual(collectAppendChecklist(unheld), ['lib-a'],
    'un-holding the plugin drops its prompts at save');
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
