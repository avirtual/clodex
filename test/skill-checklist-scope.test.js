'use strict';
// skill-checklist-scope.test.js — an OUT-OF-SCOPE skill must not render as a
// plain toggleable row.
//
// Unchecking one wrote a `disabledSkills` entry that disabled nothing: the
// skill isn't loaded in this session, so clodex's layer-4 off list cannot
// reach it. It reuses the read-only affordance the settings-layer overrides
// already use, and the assertion that matters is the COLLECT one — a row that
// merely looks greyed but still enters the off list has fixed nothing.
//
// jsdom is not a dependency; the DOM here is the minimum the renderer touches,
// the same shape test/activity-tab-badge-order.test.js uses.

const test = require('node:test');
const assert = require('node:assert');

function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false, disabled: false,
    innerHTML: '', children: [],
    appendChild(c) { e.children.push(c); return c; },

    querySelectorAll(sel) {
      // Only the collector's selector is honoured, spelled out rather than
      // pattern-matched: a stub that answered every selector with everything
      // would make the collect assertions below vacuous.
      assert.strictEqual(sel, 'input[type="checkbox"]:not(:checked):not(:disabled)');
      const flat = [];
      const walk = (n) => { for (const c of n.children) { flat.push(c); walk(c); } };
      walk(e);
      return flat.filter((c) => c.tagName === 'input' && c.type === 'checkbox' && !c.checked && !c.disabled);
    },
  };
  // format.js's `esc` escapes by round-tripping through textContent/innerHTML,
  // so the stub has to model that pair or every escaped label reads as empty.
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

const { renderSkillChecklist, collectSkillChecklist } = withDom(() => require('../renderer/lib/checklists'));

// The measured shape: the roster plus the app/-scoped names, as readSkillCatalog
// now unions and marks them.
const NAMES = ['assess', 'compare', 'dataviz', 'loop', 'warm-cache'];
const OOS = [{ name: 'assess', dir: 'app/' }, { name: 'compare', dir: 'app/' }];

const rowsOf = (c) => c.children.map((row) => {
  const cb = row.children.find((x) => x.tagName === 'input');
  return { name: cb.value, checked: cb.checked, disabled: cb.disabled, cls: row.className, html: row.children.find((x) => x.tagName === 'span').innerHTML };
});

test('out-of-scope rows render read-only, named with their dir; roster rows stay toggleable', () => withDom(() => {
  const c = el('div');
  renderSkillChecklist(c, NAMES, new Set(), {}, { canReenable: false, outOfScope: OOS });
  const rows = rowsOf(c);
  assert.deepStrictEqual(rows.map((r) => r.name), NAMES, 'ENTER: every catalog name must render');

  const assess = rows.find((r) => r.name === 'assess');
  assert.deepStrictEqual(
    { checked: assess.checked, disabled: assess.disabled, greyed: assess.cls.includes('skill-readonly') },
    { checked: false, disabled: true, greyed: true });
  assert.match(assess.html, /only under app\//);

  // A genuinely loaded skill is untouched by the change.
  const loop = rows.find((r) => r.name === 'loop');
  assert.deepStrictEqual(
    { checked: loop.checked, disabled: loop.disabled, greyed: loop.cls.includes('skill-readonly') },
    { checked: true, disabled: false, greyed: false });
  assert.doesNotMatch(loop.html, /only under|not loaded/);
}));

test('unchecking cannot write an out-of-scope skill into the off list', () => withDom(() => {
  // The bug's user-visible half: this entry disabled nothing.
  const c = el('div');
  renderSkillChecklist(c, NAMES, new Set(), {}, { canReenable: false, outOfScope: OOS });
  assert.deepStrictEqual(collectSkillChecklist(c), [],
    'nothing is unchecked-and-enabled, so the off list must be empty');

  // And a real off list still collects — otherwise the assertion above would
  // pass for a collector that always returned [].
  const c2 = el('div');
  renderSkillChecklist(c2, NAMES, new Set(['loop']), {}, { canReenable: false, outOfScope: OOS });
  assert.deepStrictEqual(collectSkillChecklist(c2), ['loop']);
}));

test('a dirless out-of-scope skill says so rather than rendering a blank label', () => withDom(() => {
  const c = el('div');
  renderSkillChecklist(c, ['mystery'], new Set(), {}, { outOfScope: [{ name: 'mystery', dir: null }] });
  const row = rowsOf(c)[0];
  assert.strictEqual(row.disabled, true);
  assert.match(row.html, /not loaded here/);
  assert.doesNotMatch(row.html, /null|undefined/);
}));

test('policy lock and a lower-layer off still win the label over out-of-scope', () => withDom(() => {
  // Precedence matters: "only under app/" would understate a policy lock.
  const locked = el('div');
  renderSkillChecklist(locked, ['assess'], new Set(), {}, { skillsLocked: true, outOfScope: OOS });
  assert.match(rowsOf(locked)[0].html, /locked by policy/);

  const lower = el('div');
  renderSkillChecklist(lower, ['assess'], new Set(),
    { assess: { value: 'off', source: 'project' } }, { outOfScope: OOS });
  assert.match(rowsOf(lower)[0].html, /off via project settings/);
}));

test('template editor: a lower-layer off row stays toggleable and collects', () => withDom(() => {
  // A template travels to any cwd, so the deny read from the cwd in the form
  // describes a directory the saved template is not bound to. Greying the row
  // made it uncollectable, and the save silently dropped the name.
  const eff = { loop: { value: 'off', source: 'project', advisory: true } };

  const c = el('div');
  renderSkillChecklist(c, NAMES, new Set(), eff, { canReenable: false });
  const loop = rowsOf(c).find((r) => r.name === 'loop');
  assert.deepStrictEqual(
    { checked: loop.checked, disabled: loop.disabled, greyed: loop.cls.includes('skill-readonly') },
    { checked: true, disabled: false, greyed: false });
  assert.match(loop.html, /off via project settings/, 'the provenance note survives as information');
  assert.deepStrictEqual(collectSkillChecklist(c), []);

  const c2 = el('div');
  renderSkillChecklist(c2, NAMES, new Set(['loop']), eff, { canReenable: false });
  const off = rowsOf(c2).find((r) => r.name === 'loop');
  assert.strictEqual(off.checked, false, 'the template\'s own list drives the tick');
  assert.deepStrictEqual(collectSkillChecklist(c2), ['loop'],
    'the name the save path dropped must round-trip');
}));

test('advisory does not leak past the entry that carries it', () => withDom(() => {
  // Only the marked entries are advisory: a policy lock and an out-of-scope row
  // are still facts about the seat, not about one cwd.
  const c = el('div');
  renderSkillChecklist(c, ['assess', 'loop'], new Set(),
    { loop: { value: 'off', source: 'project', advisory: true } },
    { skillsLocked: true, outOfScope: OOS });
  const rows = rowsOf(c);
  assert.strictEqual(rows.find((r) => r.name === 'loop').disabled, true, 'a policy lock still wins');

  const c2 = el('div');
  renderSkillChecklist(c2, ['assess'], new Set(),
    { assess: { value: 'off', source: 'project', advisory: true } }, { outOfScope: OOS });
  assert.strictEqual(rowsOf(c2)[0].disabled, true, 'out-of-scope still wins');
}));

test('omitting outOfScope leaves every row toggleable', () => withDom(() => {
  // The peer/new-session paths that do not supply it must not grey out.
  const c = el('div');
  renderSkillChecklist(c, NAMES, new Set(), {}, { canReenable: false });
  assert.ok(rowsOf(c).every((r) => !r.disabled && r.checked), 'ENTER: no row may be read-only here');
  assert.deepStrictEqual(collectSkillChecklist(c), []);
}));

// t769 r2: the peer Edit-settings dialog (renderer.js openArgsDialog). A peer
// seat carrying the `*` sentinel serves `allOff: true` with `*` stripped out of
// `names`, so an off-set built from `disabledSkills` matches no row: every skill
// drew ON, and the save at btn-args-save then wrote `[]` TO THE PEER — turning
// the remote seat's whole roster back on from a dialog the operator only opened.
//
// The shipped statement is RUN, not grepped: what can break is which names the
// off-set holds, and a source-shape match cannot see it. The block is sliced out
// of openArgsDialog, which no test can require.
const fsReal = require('node:fs');
const pathReal = require('node:path');

function peerSkillBlock() {
  const src = fsReal.readFileSync(pathReal.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf('  const isSkillsEditable = (caps.injectSkills || caps.skillRoster)');
  assert.ok(at > 0, 'ENTER: the args dialog\'s skills gate was located — a moved anchor makes this vacuous');
  const from = src.indexOf('    if (caps.skillRoster) {', at);
  const to = src.indexOf('    setSkillLibCache(sc.skillLib', at);
  assert.ok(from > 0 && to > from, 'ENTER: the roster render block was located inside it');
  return src.slice(from, to);
}

function drawPeerRoster(sc) {
  return withDom(() => {
    const argsSkillsList = el('div');
    const env = {
      caps: { skillRoster: true },
      sc,
      argsSkillsList,
      renderSkillChecklist,
    };
    const names = Object.keys(env);
    new Function(...names, peerSkillBlock())(...names.map((n) => env[n]));
    return argsSkillsList;
  });
}

test('t769: a peer seat reporting allOff draws every row off and collects the explicit list', () => withDom(() => {
  const c = drawPeerRoster({ ok: true, names: [...NAMES], effective: {}, allOff: true, disabledSkills: ['*'] });
  assert.deepStrictEqual(rowsOf(c).map((r) => r.name), NAMES,
    'ENTER: the peer catalog painted its rows — with none the collect below is vacuously []');
  assert.deepStrictEqual(rowsOf(c).filter((r) => r.checked).map((r) => r.name), [],
    'the sentinel means the remote seat boots with every skill off; a ticked row states the opposite');
  assert.deepStrictEqual(collectSkillChecklist(c), NAMES,
    'and the save must carry the explicit full-off list, never `[]` — `[]` re-enables the peer\'s roster');
}));

test('t769: a peer seat with an ordinary off-list is unaffected', () => withDom(() => {
  // The anti-degenerate half: "always draw everything off" passes the subject above.
  const c = drawPeerRoster({ ok: true, names: [...NAMES], effective: {}, disabledSkills: ['loop'] });
  assert.deepStrictEqual(rowsOf(c).filter((r) => !r.checked).map((r) => r.name), ['loop']);
  assert.deepStrictEqual(collectSkillChecklist(c), ['loop']);
}));
