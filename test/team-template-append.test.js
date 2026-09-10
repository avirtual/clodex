'use strict';
// team-template-append.test.js — t809: editing a TEAM template in the template
// editor must not empty its `appendPromptFiles`.
//
// The reported failure: `~/.clodex/teams/clodex-ios/templates/hand.json` had
// `["team-project"]`, an operator changed only the args, and the save wrote
// `[]` — every hand spawned after it had no team brief. libraryPromptCache keeps
// only rows with no `team` (right for the new-session dialog), so a team-only
// stem had NO checkbox in the editor, and collectAppendChecklist rebuilds the
// list from checked boxes alone. An absent row and an unticked one were the same
// observation, and the absent one won.
//
// The round trip is asserted through the REAL render + collect pair, not off a
// cache shape: what harms a seat is the collected list, and a render that drew
// the row under the wrong value (`teamName:stem`, say, the shape a bundle row
// uses) would pass any assertion made about row COUNT while still writing a stem
// no composer resolves.
//
// The renderer.js half — openTemplateEditor actually FETCHING those rows and
// passing them — is DOM- and IPC-bound and reachable by no fixture here, so it
// is pinned by source shape, in the style of test/echo-rewrite-wiring.test.js.
// Without that pin the functional half above stays green while the editor keeps
// passing nothing and the defect returns whole.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false, disabled: false,
    innerHTML: '', children: [],
    appendChild(c) { c.parent = e; e.children.push(c); return c; },
    querySelectorAll(sel) {
      const flat = [];
      const walk = (n) => { for (const c of n.children) { flat.push(c); walk(c); } };
      walk(e);
      if (sel === '.check-group, .bundle-row') {
        return flat.filter((c) => c.className === 'check-group'
          || String(c.className).split(' ').includes('bundle-row'));
      }
      if (sel === '.hint-text') return flat.filter((c) => String(c.className).split(' ').includes('hint-text'));
      if (sel === 'input[type="checkbox"]') {
        return flat.filter((c) => c.tagName === 'input' && c.type === 'checkbox');
      }
      assert.strictEqual(sel, 'input[type="checkbox"]:checked', `unexpected selector ${sel}`);
      return flat.filter((c) => c.tagName === 'input' && c.type === 'checkbox' && c.checked);
    },
    remove() { const i = e.parent ? e.parent.children.indexOf(e) : -1; if (i >= 0) e.parent.children.splice(i, 1); },
  };
  let text = '';
  Object.defineProperty(e, 'textContent', {
    get: () => text,
    set(v) { text = v == null ? '' : String(v); e.innerHTML = text; },
  });
  return e;
}

function withDom(fn) {
  const had = global.document;
  global.document = { createElement: el, addEventListener() {} };
  try { return fn(); } finally { global.document = had; }
}

const {
  renderAppendChecklist, collectAppendChecklist, mergeUnrendered,
  libraryPromptCache, setPromptLibCache, setPluginCatalogCache,
} = withDom(() => require('../renderer/lib/checklists'));

const TEAM = 'clodex-ios';
// The row shapes listPrompts really hands the editor: a library row has no
// `team`, a team row carries one. `a` exists on both sides — the shadow case.
const LIBRARY_A = { name: 'a', kind: 'append', body: 'library a' };
const TEAM_PROJECT = { name: 'team-project', kind: 'append', body: 'the team brief', team: TEAM, teamName: TEAM };
const TEAM_A = { name: 'a', kind: 'append', body: 'team copy of a', team: TEAM, teamName: TEAM };

function checkboxes(container) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (c.tagName === 'input') out.push(c); walk(c); } };
  walk(container);
  return out;
}

function heads(container) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (c.className === 'check-group') out.push(c.textContent); walk(c); } };
  walk(container);
  return out;
}

function render(rows, enabled, teamRows) {
  return withDom(() => {
    setPluginCatalogCache([]);
    setPromptLibCache(libraryPromptCache(rows));
    const container = el('div');
    renderAppendChecklist(container, new Set(enabled), null, teamRows);
    return container;
  });
}

test('a team template editor draws the team\'s own append prompts, and a stem the team shadows draws once', () => {
  const container = render([LIBRARY_A, TEAM_PROJECT, TEAM_A], ['team-project'], [TEAM_PROJECT, TEAM_A]);

  assert.deepStrictEqual(checkboxes(container).map((cb) => cb.value), ['team-project', 'a'],
    'the bare stems, team section only — a library `a` row beside the team copy would collect twice');
  assert.deepStrictEqual(heads(container), [`team ${TEAM}`]);
  const teamHeadIndex = container.children.findIndex((c) => c.className === 'check-group');
  assert.ok(teamHeadIndex === 0, 'the shadowed library row is suppressed, so the head opens the list');

  assert.deepStrictEqual(collectAppendChecklist(container), ['team-project']);
});

test('the library rows a team does NOT shadow still draw, above the team head', () => {
  const other = { name: 'b', kind: 'append', body: 'library b' };
  const container = render([other, TEAM_PROJECT], ['b', 'team-project'], [TEAM_PROJECT]);

  assert.deepStrictEqual(checkboxes(container).map((cb) => cb.value), ['b', 'team-project']);
  assert.deepStrictEqual(heads(container), [`team ${TEAM}`]);
  assert.deepStrictEqual(collectAppendChecklist(container), ['b', 'team-project']);
});

// The regression itself, in the operator's shape: the ios team had no library
// append prompts at all, so before the fix the checklist was EMPTY and the save
// collected [].
test('a team template whose only append prompt is team-owned survives a round trip', () => {
  const container = render([TEAM_PROJECT], ['team-project'], [TEAM_PROJECT]);
  assert.deepStrictEqual(collectAppendChecklist(container), ['team-project'],
    'saving after an unrelated edit must not empty appendPromptFiles');
});

// Passing no teamRows is what every non-team caller does; the new-session dialog
// must stay library-only (test/library-prompt-cache.test.js pins the same fact
// from the duplicate-compose end).
test('with no teamRows the checklist is library-only', () => {
  const container = render([LIBRARY_A, TEAM_PROJECT], ['a'], undefined);
  assert.deepStrictEqual(checkboxes(container).map((cb) => cb.value), ['a']);
  assert.deepStrictEqual(heads(container), []);
});

test('mergeUnrendered keeps only names the form could not offer', () => {
  assert.deepStrictEqual(mergeUnrendered(['team-project', 'x'], ['x'], []), ['team-project']);
  assert.deepStrictEqual(mergeUnrendered(['team-project'], ['team-project'], []), [],
    'a stem the operator could see and unticked is a deliberate removal');
  assert.deepStrictEqual(mergeUnrendered([], ['x'], ['x']), ['x']);
  assert.deepStrictEqual(mergeUnrendered(['x'], ['x'], ['x']), ['x'], 'no duplicate for a checked name');
});

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

function openTemplateEditorSrc() {
  const m = SRC.match(/async function openTemplateEditor\([\s\S]*?\n\}\n/);
  return m ? m[0] : null;
}

test('openTemplateEditor fetches the editing team\'s append rows and passes them to the checklist', () => {
  const src = openTemplateEditorSrc();
  assert.ok(src, 'ENTER: openTemplateEditor is still found by this anchor');
  assert.ok(/editingTemplateTeam[\s\S]*?listPrompts\(\)/.test(src),
    'the fetch is gated on editingTemplateTeam — the new-session dialog must not gain team rows');
  assert.ok(/p\.kind === 'append' && p\.team === editingTemplateTeam/.test(src),
    'only the OWNING team\'s append rows; another team\'s stem resolves nowhere for this seat');
  assert.ok(/renderAppendChecklist\(inputAppendList,[^\n]*newSessionSeat\(\), teamAppendRows\)/.test(src),
    'the rows actually reach the render call');
});

test('a team template\'s save preserves append names the form never rendered', () => {
  assert.ok(/appendPromptFiles: agentType \? collectAppendPromptFiles\(\) : \[\]/.test(SRC),
    'collectFormConfig routes through the merge, not collectAppendChecklist alone');
  const fn = SRC.match(/function collectAppendPromptFiles\(\)[\s\S]*?\n\}\n/);
  assert.ok(fn, 'ENTER: collectAppendPromptFiles is still found by this anchor');
  assert.ok(/if \(!editingTemplateTeam\) return checked;/.test(fn[0]),
    'library-only dialogs collect unchanged');
  assert.ok(/mergeUnrendered\(editingTemplateAppendPrev, rendered, checked\)/.test(fn[0]));
});
