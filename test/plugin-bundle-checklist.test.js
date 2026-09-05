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
    children: [],
    appendChild(c) { c.parent = e; e.children.push(c); return c; },

    querySelectorAll(sel) {
      const flat = [];
      const walk = (n) => { for (const c of n.children) { flat.push(c); walk(c); } };
      walk(e);
      // Selectors are spelled out rather than pattern-matched: a stub that
      // answered every selector with everything would make the collect
      // assertions vacuous, and the `:not(:disabled)` clause IS the fix under
      // test, so a loose stub would pass against the unfixed collector.
      if (sel === '.check-group, .bundle-row') {
        return flat.filter((c) => c.className === 'check-group'
          || String(c.className).split(' ').includes('bundle-row'));
      }
      if (sel === '.hint-text') {
        return flat.filter((c) => String(c.className).split(' ').includes('hint-text'));
      }
      assert.strictEqual(sel, 'input[type="checkbox"]:checked:not(:disabled)');
      return flat.filter((c) => c.tagName === 'input' && c.type === 'checkbox'
        && c.checked && !c.disabled);
    },
    remove() { const i = e.parent ? e.parent.children.indexOf(e) : -1; if (i >= 0) e.parent.children.splice(i, 1); },
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
  // innerHTML is only ever SET here to '' (clear) or the literal hint-text span
  // markup, never read for its own sake — so the stub only needs to model those
  // two writes: clear children, and, for a hint span, synthesize one real child
  // so `.hint-text` cleanup/detection in repaintBundleSections has something to
  // find and remove.
  let html = '';
  Object.defineProperty(e, 'innerHTML', {
    get: () => html,
    set(v) {
      html = v == null ? '' : String(v);
      e.children.length = 0;
      if (/class="hint-text"/.test(html)) {
        const hint = el('span');
        hint.className = 'hint-text';
        e.appendChild(hint);
      }
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
  repaintBundleSections,
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

// ── The PEER refusal (r1 must-fix) ─────────────────────────────────────────
// The args dialog hides its Plugins section for a peer row, so keying the seat
// on that visibility handed back the peer's PERSISTED list — usually null, which
// seatHasPlugin resolves to THIS box's shipped default. Local bundles then drew
// onto a remote seat, off a catalog that box may not even have. Both refusals
// therefore key on the SOURCE.
//
// Source-shape, for the same reason as the ordering pin: openArgsDialog awaits
// five IPC reads and paints ~15 sections, so no runtime fixture here reaches its
// peer arm — which is exactly why the suite was green over the defect.
test('argsSeat refuses on the SOURCE before it looks at section visibility', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf('function argsSeat()');
  assert.ok(at > 0, 'ENTER: argsSeat was found');
  const end = src.indexOf('\n}', at);
  const body = src.slice(at, end);

  const sourceAt = body.indexOf('if (argsEditingSource) return null;');
  assert.ok(sourceAt > 0,
    'a peer seat must get NO seat: its plugins are its own box\'s, and the catalog here is this Mac\'s');
  const visibilityAt = body.indexOf("argsPluginsSection.style.display === 'none'");
  assert.ok(visibilityAt > 0, 'ENTER: the visibility branch is still there to be above');
  assert.ok(sourceAt < visibilityAt,
    'the source check must come FIRST — below it, the hidden-section branch answers for a peer '
    + 'with its persisted list, and a null list takes the LOCAL shipped default');

  // The bail must be reachable, so the assignment has to precede both renders
  // INSIDE openArgsDialog. Scoped to that function deliberately: the plugin-tick
  // change listener also renders, and it sits earlier in the file while running
  // strictly later — a whole-file index comparison compares the wrong pair and
  // fails on correct code, which is how this assertion first read.
  const dialogAt = src.indexOf('async function openArgsDialog');
  assert.ok(dialogAt > 0, 'ENTER: openArgsDialog was found');
  const dialog = src.slice(dialogAt, src.indexOf('\nfunction closeArgsDialog', dialogAt));
  const assignAt = dialog.indexOf('argsEditingSource = argsSource;');
  const agentsRenderAt = dialog.indexOf('renderAgentChecklist(argsAgentsList');
  const skillsRenderAt = dialog.indexOf('renderInjectChecklist(argsInjectSkillsList');
  assert.ok(assignAt > 0, 'ENTER: the dialog slice contains the assignment');
  assert.ok(agentsRenderAt > 0 && skillsRenderAt > 0, 'ENTER: and both consumers');
  assert.ok(assignAt < agentsRenderAt && assignAt < skillsRenderAt,
    'argsEditingSource is set BEFORE both consumers, or the bail reads the PREVIOUS open\'s source');
});

test('the args skills section keeps its library-only visibility rule for a peer', () => {
  // The widened gate must not OPEN a section on a peer row purely because this
  // box has a bundle-carrying plugin: the inject block runs only for a peer
  // (isSkillsEditable requires argsSource), so an ungated `bundleSectionsOf`
  // would decide the peer's section visibility off local state.
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf('const isSkillsEditable');
  assert.ok(at > 0, 'ENTER: the skills block was found');
  const body = src.slice(at, at + 1200);
  assert.match(body, /const seat = argsSeat\(\);/,
    'the seat is hoisted once, so the gate and the render cannot disagree');
  assert.match(body, /\(sc\.skillLib \|\| \[\]\)\.length \|\| \(seat && bundleSectionsOf\('skills'\)\.length\)/,
    'the bundle half of the gate is conditioned on having a seat at all');
  assert.match(body, /renderInjectChecklist\(argsInjectSkillsList, new Set\(sc\.injectSkills \|\| \[\]\), auto, seat\);/,
    'the render takes the hoisted seat, not a second argsSeat() call that could answer differently');
});

// ── The injection points (r1 nit) ──────────────────────────────────────────
// Both islands take their bundle access as INJECTED arguments, and both test
// files above drive the modules directly with their own stubs. Delete either
// argument in renderer.js and every test here stays green while the shipped UI
// draws nothing at all — the wiring is only observable at the call site.
test('renderer.js wires the bundle seams into both islands', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

  const drawersAt = src.indexOf('initLibraryDrawers({');
  assert.ok(drawersAt > 0, 'ENTER: the drawers are constructed here');
  const drawers = src.slice(drawersAt, src.indexOf('}));', drawersAt));
  assert.match(drawers, /\bbundleSectionsOf\b/,
    'without it the drawers list no bundle records, and plugin-bundle-drawer.test.js stays green on its own stub');
  assert.match(drawers, /refreshPluginCatalog:/,
    'without it the drawers read whatever the last dialog left in the catalog cache');

  const popoversAt = src.indexOf('initChecklistPopovers({');
  assert.ok(popoversAt > 0, 'ENTER: the popovers are constructed here');
  const popovers = src.slice(popoversAt, src.indexOf('});', popoversAt));
  assert.match(popovers, /seatPluginsOf:/,
    'without it seatFor returns null for every seat and the popovers silently draw no bundle rows');
});

test('repaintBundleSections swaps ONLY the bundle rows, leaving the flat list untouched', () => withDom(() => {
  // A plugin tick used to re-render the whole checklist, dropping scroll and
  // focus in a long agents list the operator is mid-way through. The swap has to
  // be exact in BOTH directions: no flat row disturbed, and no stale bundle row
  // or header left behind to double up on the next tick.
  setPluginCatalogCache(CATALOG);
  setAgentLibCache([{ name: 'explorer', description: 'reads' }]);
  const c = el('div');
  renderAgentChecklist(c, new Set(['explorer']), null, { plugins: ['stocks'] });

  const flatBefore = c.children.find((n) => n.className === 'agent-check');
  assert.ok(flatBefore, 'ENTER: a flat row exists to be preserved');
  assert.deepStrictEqual(laidOut(c), [
    ['row', 'explorer'],
    ['head', 'Stock Assessments'],
    ['row', 'stocks:screener'],
  ], 'ENTER: and the bundle section drew, so the swap below has something to replace');

  repaintBundleSections(c, 'agents', { plugins: [] });

  assert.strictEqual(c.children.find((n) => n.className === 'agent-check'), flatBefore,
    'the flat row is the SAME node — re-creating it is what loses scroll and focus');
  assert.deepStrictEqual(laidOut(c), [
    ['row', 'explorer'],
    ['head', 'Stock Assessments'],
    ['row', 'stocks:screener'],
  ], 'exactly one bundle section after the swap, not two');
  const screener = rowsOf(c).find((r) => r.name === 'stocks:screener');
  assert.strictEqual(screener.checked, false, 'and it repainted to the NEW membership');
  assert.ok(screener.cls.includes('skill-readonly'), 'greyed, as a non-member row is');

  // Repainting to a seat with NO bundles must clear the section entirely,
  // rather than leaving the previous plugin's header stranded above nothing.
  setPluginCatalogCache([]);
  repaintBundleSections(c, 'agents', { plugins: [] });
  assert.deepStrictEqual(laidOut(c), [['row', 'explorer']],
    'header and rows both gone when the catalog no longer carries a bundle');
}));

test('repaintBundleSections restores the empty-library hint when the bundle it drew was the only content', () => withDom(() => {
  // The flat library is empty, so the container's ONLY rows are the bundle's;
  // repainting that bundle away must leave the "No agents in library" hint
  // rather than a container with nothing in it and no explanation why.
  setPluginCatalogCache(CATALOG);
  setAgentLibCache([]);
  const c = el('div');
  renderAgentChecklist(c, new Set(), null, { plugins: ['stocks'] });
  assert.deepStrictEqual(laidOut(c), [['head', 'Stock Assessments'], ['row', 'stocks:screener']],
    'ENTER: the only content is the bundle row, so the repaint below can lose it entirely');

  setPluginCatalogCache([]);
  repaintBundleSections(c, 'agents', { plugins: [] });
  assert.match(c.innerHTML, /No agents in library/,
    'the container fell back to the render function\'s own empty-library hint');

  // And the reverse: gaining a bundle after that hint must remove it, or the
  // rows draw beneath a stale "No agents in library" span. Checked via
  // querySelectorAll('.hint-text') rather than c.innerHTML: unlike the real
  // DOM property, the stub's innerHTML is a plain string set on assignment,
  // not a live serialization, so it would still read the old hint markup
  // after the repaint's later appendChild calls.
  setPluginCatalogCache(CATALOG);
  repaintBundleSections(c, 'agents', { plugins: ['stocks'] });
  assert.deepStrictEqual(c.querySelectorAll('.hint-text'), [],
    'the stale hint node is removed once a bundle row exists again');
  assert.deepStrictEqual(laidOut(c), [['head', 'Stock Assessments'], ['row', 'stocks:screener']]);
}));
