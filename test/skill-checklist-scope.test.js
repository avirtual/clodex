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

test('omitting outOfScope leaves every row toggleable', () => withDom(() => {
  // The peer/new-session paths that do not supply it must not grey out.
  const c = el('div');
  renderSkillChecklist(c, NAMES, new Set(), {}, { canReenable: false });
  assert.ok(rowsOf(c).every((r) => !r.disabled && r.checked), 'ENTER: no row may be read-only here');
  assert.deepStrictEqual(collectSkillChecklist(c), []);
}));
