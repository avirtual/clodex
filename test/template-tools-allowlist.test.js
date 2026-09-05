'use strict';
// template-tools-allowlist.test.js — t674: the template editor's `tools` control.
//
// `tools` is the reviewer ALLOWLIST (`disabledTools`, drawn right above it in the
// same section, is the unrelated per-session denylist). It was saved-only: the
// editor rendered no control for it, so an operator who ticked Bash in the
// reviewer template's Tools section changed the denylist and nothing read it.
//
// THE ROUND TRIP IS THE SUBJECT, and its two ends fail differently. The DRAW end
// fails by checking the wrong boxes, which an operator sees. The COLLECT end
// fails by writing `[]` or `null` where the key should be absent, which nobody
// sees until a reviewer refuses to spawn — absent accepts the full cap, `[]` and
// (since t674) null are both refused. So the collect assertion is a
// deepStrictEqual on the built object rather than a check of the value under the
// key: the failing direction is a key that EXISTS, and an assertion on its value
// cannot see it.
//
// WHY THE SHIPPED SOURCE IS EXTRACTED AND RUN. Both statements live in
// renderer.js, which no test can require (DOM-bound, window.api at load). The
// idiom is test/plugin-dialog-snapshot.test.js's: capture the statement, evaluate
// it against the REAL leaves out of renderer/lib/checklists.js. A source-shape
// grep would pass over a control that renders from the wrong field, and a
// re-typed copy of the statement would assert only that this file agrees with
// itself.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');

function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false,
    children: [], dataset: {}, style: {},
    appendChild(c) { e.children.push(c); return c; },
    querySelectorAll(sel) {
      assert.strictEqual(sel, 'input[type="checkbox"]:checked',
        'ENTER: the only selector collectToolAllowChecklist passes');
      return e.children
        .flatMap((row) => row.children || [])
        .filter((c) => c.type === 'checkbox' && c.checked);
    },
  };
  let html = '';
  Object.defineProperty(e, 'innerHTML', {
    get: () => html,
    set(v) { html = v == null ? '' : String(v); if (html === '') e.children = []; },
  });
  let text = '';
  Object.defineProperty(e, 'textContent', { get: () => text, set(v) { text = v == null ? '' : String(v); } });
  return e;
}

function withDom(fn) {
  const had = global.document;
  global.document = { createElement: el, addEventListener() {} };
  try { return fn(); } finally { global.document = had; }
}

const checklists = withDom(() => require('../renderer/lib/checklists'));
const { renderToolAllowChecklist, collectToolAllowChecklist, setClaudeToolsCache } = checklists;

// The catalog the control draws over. Deliberately wider than the reviewer cap:
// the editor renders every known tool, and the cap is applied at the reviewer,
// not here.
const CATALOG = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'];

function extract(re, what) {
  const m = re.exec(rendererSrc);
  assert.ok(m, `ENTER: ${what} was not found in renderer.js — every assertion below would be vacuous`);
  return m[1];
}

const DRAW_STMT = extract(
  /\n(\s*renderToolAllowChecklist\(inputToolsAllowList,[^\n]*?\);)\n/,
  "openTemplateEditor's allowlist draw",
);
const COLLECT_STMT = extract(
  /\n(  const toolsAllow = [\s\S]*?;)\n/,
  "collectFormConfig's toolsAllow expression",
);
const SPREAD_EXPR = extract(
  /\n\s*(\.\.\.\(toolsAllow\.length \? \{ tools: toolsAllow \} : \{\}\)),\n/,
  "collectFormConfig's conditional tools spread",
);

function draw(tpl) {
  const inputToolsAllowList = el('div');
  new Function('renderToolAllowChecklist', 'inputToolsAllowList', 'tpl', DRAW_STMT)(
    renderToolAllowChecklist, inputToolsAllowList, tpl,
  );
  return inputToolsAllowList;
}

function boxes(container) {
  return container.children.flatMap((r) => (r.children || []).filter((c) => c.type === 'checkbox'));
}

// Runs the SHIPPED collect statement and the SHIPPED spread, and returns the
// object a save would carry — the spread is what decides key presence.
function save(inputToolsAllowList, { dialogMode = 'template', type = 'claude' } = {}) {
  const names = ['dialogMode', 'type', 'collectToolAllowChecklist', 'inputToolsAllowList'];
  const vals = [dialogMode, type, collectToolAllowChecklist, inputToolsAllowList];
  return new Function(...names, `${COLLECT_STMT}\nreturn { name: 'rv', ${SPREAD_EXPR} };`)(...vals);
}

test('t674: opening a template with tools: [Read, Grep] checks exactly those', () => withDom(() => {
  setClaudeToolsCache(CATALOG);
  const list = draw({ tools: ['Read', 'Grep'] });
  assert.deepStrictEqual(boxes(list).map((c) => c.value), CATALOG,
    'ENTER: a row is drawn for every catalog tool, so an unticked one is a real answer');
  assert.deepStrictEqual(boxes(list).filter((c) => c.checked).map((c) => c.value), ['Read', 'Grep'],
    'exactly the template\'s list is ticked');
  // The anti-degenerate half: "tick everything" satisfies the assertion above
  // only if nothing is expected unticked, so name the ones that must not be.
  assert.deepStrictEqual(boxes(list).filter((c) => !c.checked).map((c) => c.value), ['Glob', 'Bash', 'Edit', 'Write'],
    'and nothing else is — including Glob, which is IN the cap but not in the template');
}));

test('t674: saving with none checked emits NO tools key — not [] and not null', () => withDom(() => {
  setClaudeToolsCache(CATALOG);
  const list = draw({});
  assert.deepStrictEqual(boxes(list).filter((c) => c.checked), [],
    'ENTER: a template with no tools key opens with an empty control');
  // deepStrictEqual on the whole object: `tools: []` and `tools: null` both pass
  // any assertion written about the value, and both are REFUSED at the reviewer
  // while absent takes the full cap.
  assert.deepStrictEqual(save(list), { name: 'rv' },
    'the key is absent, which is the only value that means "accept the full cap"');
}));

test('t674: the ticked set round-trips back out through the save', () => withDom(() => {
  setClaudeToolsCache(CATALOG);
  const list = draw({ tools: ['Read', 'Grep'] });
  assert.deepStrictEqual(save(list), { name: 'rv', tools: ['Read', 'Grep'] },
    'what was drawn is what is saved — the control is not write-only');

  // CONTROL: unticking one really removes it, so the round trip above is not
  // satisfied by a collect that echoes the template it was drawn from.
  for (const c of boxes(list)) if (c.value === 'Grep') c.checked = false;
  assert.deepStrictEqual(save(list), { name: 'rv', tools: ['Read'] },
    'CONTROL: the operator\'s untick reaches the saved object');

  // And a tool the cap does not hold is savable: the editor writes what was
  // ticked and the REVIEWER applies the cap. Narrowing here would hide the
  // beyond-cap warning the resolver exists to raise.
  for (const c of boxes(list)) if (c.value === 'Edit') c.checked = true;
  assert.deepStrictEqual(save(list), { name: 'rv', tools: ['Read', 'Edit'] },
    'the editor does not pre-apply the reviewer cap');
}));

// The gate the draw/collect pair hangs on. In create mode the control is hidden
// and never rendered, so a collect that ran there would read an empty checklist
// and — before the conditional spread — write a `tools` onto a SESSION template
// the operator never touched.
test('t674: create mode collects no allowlist at all', () => withDom(() => {
  setClaudeToolsCache(CATALOG);
  const list = draw({ tools: ['Read', 'Grep'] });
  assert.deepStrictEqual(save(list, { dialogMode: 'create' }), { name: 'rv' },
    'even with boxes ticked, a create-mode save carries no tools key');
  assert.deepStrictEqual(save(list, { type: 'codex' }), { name: 'rv' },
    'and neither does a non-claude template, which has no Tools section');
}));

// The HTML half: the control needs a row of its own with the bulk toggles, and
// the label must distinguish it from the denylist sitting immediately above it
// in the same <details>. Two controls over the same catalog with the same widget,
// one meaning "off" and one meaning "allowed", is the confusion this names away.
test('t674: the allowlist row exists in the dialog markup, labelled apart from the denylist', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const row = html.slice(html.indexOf('<label id="tools-allow-row"'));
  assert.ok(row.startsWith('<label id="tools-allow-row"'), 'ENTER: the allowlist row was located');
  const body = row.slice(0, row.indexOf('</label>'));
  assert.match(body, /id="input-tools-allow-list"/, 'the list container the renderer draws into');
  assert.match(body, /Allowed tools \(allowlist; reviewer seats intersect it with the read-only cap\)/,
    'the label says allowlist, says who reads it, and says it is capped');
  assert.match(body, /data-bulk="all"/, 'the bulk toggles, like every sibling checklist');
  assert.match(body, /style="display:none;"/,
    'hidden by default: applyTypeDefaults shows it only while authoring a template');
});
