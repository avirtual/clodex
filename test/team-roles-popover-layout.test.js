'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'renderer/styles.css'), 'utf-8');
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '');
const popover = fs.readFileSync(
  path.join(ROOT, 'renderer/popovers/team-roles-popover.js'), 'utf-8');

function rules(selectorRe) {
  return [...cssRules.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => sel.split(',').some((s) => selectorRe.test(s.trim())))
    .map(([, sel, body]) => ({ sel: sel.trim(), body }));
}

function lastDeclaration(selectorRe, prop) {
  let value = null;
  for (const r of rules(selectorRe)) {
    const m = r.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
    if (m) value = m[1].trim();
  }
  return value;
}

const SCROLLS = /^(auto|scroll|overlay)$/;

function scrollsItself(selectorRe) {
  return ['overflow', 'overflow-y'].some((p) => {
    const v = lastDeclaration(selectorRe, p);
    return v !== null && SCROLLS.test(v);
  });
}

function editableBodyMarkup() {
  const arm = /\} else \{([\s\S]*?)\n      \}\n/.exec(popover.slice(popover.indexOf('if (row.readOnly) {')));
  assert.ok(arm, 'ENTER: found the editable (else) arm of the row renderer');
  const m = /body\.innerHTML =\n([\s\S]*?);\n/.exec(arm[1]);
  assert.ok(m, 'ENTER: found the editable arm\'s body.innerHTML assignment');
  return m[1];
}

function reservedBodyMarkup() {
  const m = /if \(row\.readOnly\) \{[\s\S]*?body\.innerHTML =\n([\s\S]*?);\n/.exec(popover);
  assert.ok(m, 'ENTER: found the reserved arm\'s body.innerHTML assignment');
  return m[1];
}

test('t894: the roles popover is the only scroller — no role card sits at a nested fold', () => {
  assert.match(popover, /listEl = document\.getElementById\('team-roles-list'\)/,
    'ENTER: the list element is #team-roles-list');
  assert.match(popover, /el\.className = 'team-role-row';/, 'ENTER: each role is a .team-role-row');
  assert.match(popover, /body\.className = 'team-role-body';/, 'ENTER: the editor lives in .team-role-body');
  assert.match(popover, /listEl\.appendChild\(el\)/, 'ENTER: rows are appended to the list');

  assert.ok(!scrollsItself(/^#team-roles-list$/),
    'the list must not scroll: it is the ancestor whose fold clipped `cwd` mid-label, '
    + 'inside a scrollbar nested in the popover\'s own');
  for (const [name, re] of [
    ['.team-role-row', /^\.team-role-row$/],
    ['.team-role-body', /^\.team-role-body$/],
    ['.team-role-reveal', /^\.team-role-reveal$/],
  ]) {
    assert.ok(!scrollsItself(re), `${name} must not become a second scroller between the card and the shell`);
  }
  assert.strictEqual(lastDeclaration(/^#team-roles-list$/, 'max-height'), null,
    'a max-height on the list re-creates the fold even without an overflow of its own');

  assert.ok(SCROLLS.test(lastDeclaration(/^#team-roles-popover$/, 'overflow-y') || ''),
    'the shell must scroll, or its 70vh cap simply clips what the list stopped scrolling');
  assert.notStrictEqual(lastDeclaration(/^#team-roles-popover$/, 'overflow'), 'hidden',
    'a later overflow:hidden on the shell would re-clip that same content');
});

test('t894: a role field\'s select is sized to its options, its text input to the popover', () => {
  assert.ok(rules(/^\.team-role-field input$/).length > 0,
    'ENTER: found the rule sizing a role field\'s inputs');

  assert.strictEqual(lastDeclaration(/^\.team-role-field select$/, 'width'), 'auto',
    'a select holding a stem like `hand` must not span the popover');
  assert.strictEqual(lastDeclaration(/^\.team-role-field select$/, 'max-width'), '100%',
    'but a pathological stem must not widen the popover either');
  assert.strictEqual(lastDeclaration(/^\.team-role-field input$/, 'width'), '100%',
    '`brief` holds a sentence and `cwd` a path: both are typed into and stay wide');
});

test('t894: the dispatch control carries a visible caption like every field beside it', () => {
  const markup = editableBodyMarkup();
  const m = /<div class="team-role-dispatch"[^>]*>([\s\S]*?)<\/div>/.exec(markup);
  assert.ok(m, 'ENTER: found the dispatch container in the editable body markup');
  assert.match(m[1], /class="team-role-dispatch-label">dispatch</,
    'the dispatch group was the one control with no caption while every neighbour had one');

  for (const r of rules(/\.team-role-dispatch-label/)) {
    assert.ok(!/display:\s*none|visibility:\s*hidden|font-size:\s*0/.test(r.body),
      `a caption the CSS hides is the same absence with extra steps: ${r.sel}`);
  }
  assert.match(popover, /group\.setAttribute\('aria-label', 'dispatch'\)/,
    'the caption is additive: the radiogroup keeps its own accessible name');
});

test('t894: the editor body does not repeat what the summary line one row above it says', () => {
  assert.match(popover, /k\.className = 'team-role-key';\n\s*k\.textContent = summary\.key;/,
    'ENTER: the collapsed summary line is what renders the role key — without it this test '
    + 'would pass on a popover showing the key nowhere');

  for (const [arm, markup] of [['editable', editableBodyMarkup()], ['reserved', reservedBodyMarkup()]]) {
    assert.ok(!/team-role-key/.test(markup),
      `the ${arm} editor repeated the role key ~50px below the summary line that already carries it`);
  }
  assert.ok(!/team-role-editcap/.test(popover),
    'the "EDIT THIS ROLE" caption shouted a mode the operator had just chosen by clicking');
  assert.ok(!/team-role-editcap/.test(css),
    'and its rule must go with it rather than linger as dead CSS');
});

test('t894: the selected dispatch segment uses the selection treatment, not the accent slab', () => {
  const checked = rules(/^\.team-role-segment:has\(input:checked\)$/);
  assert.strictEqual(checked.length, 1, 'ENTER: found the checked-segment rule');
  const body = checked[0].body;

  assert.match(lastDeclaration(/^#btn-create$/, 'background') || '', /var\(--accent\)/,
    'ENTER: a solid --accent fill is this codebase\'s primary-BUTTON look, and --accent is a red '
    + 'under the default theme — which is why a segment must not wear it beside a Remove');
  assert.ok(!/background(-color)?:\s*var\(--accent\)/.test(body),
    'the selected segment must not wear the primary-button slab');

  assert.match(body, /background(-color)?:\s*var\(--active-bg\)/,
    'selection is an --active-bg fill, as .session-item.active uses');
  assert.match(body, /var\(--accent\)/,
    'with an --accent edge, as .drawer-tab.active uses');
});


const { ticketLine } = require('../renderer/lib/team-roles');

function fakeDom() {
  const text = (v) => ({ tag: '#text', children: [], get textContent() { return String(v); } });
  const make = (tag) => ({
    tag, className: '', children: [], _text: '',
    set textContent(v) { this._text = String(v); this.children.length = 0; },
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
    },
    appendChild(c) { this.children.push(c); return c; },
  });
  return {
    createElement: make,
    createTextNode: text,
    createDocumentFragment: () => make('#fragment'),
  };
}

function runTicketsSection(act) {
  const m = /^  function buildTicketsSection\(act\) \{\n[\s\S]*?^  \}$/m.exec(popover);
  assert.ok(m, 'ENTER: found buildTicketsSection in the popover source');
  assert.match(m[0], /ticketLine\(t, now\)/, 'ENTER: the captured function is the one building the lines');
  const build = new Function('document', 'ticketLine',
    `${m[0]}\nreturn buildTicketsSection;`)(fakeDom(), ticketLine);
  const frag = build(act);
  return frag.children.filter((n) => n.className === 'team-role-note');
}

test('t964: a ticket line reads exactly as ticketLine wrote it, with the id in its own span', () => {
  const open = { id: 't786', title: 'the roles popover', assignee: 'hand-786', step: 'working', since: null };
  const landed = { id: 't785', title: 'team:activity', at: null, outcome: 'accepted', rounds: 2 };
  const notes = runTicketsSection({ tickets: { open: [open], landed: [landed] } });
  assert.strictEqual(notes.length, 2, 'ENTER: one .team-role-note per ticket, open then landed');

  for (const [i, t] of [open, landed].entries()) {
    const line = notes[i];
    assert.strictEqual(line.textContent, ticketLine(t, Date.now()),
      `${t.id}: the rendered line must equal ticketLine byte for byte`);
    assert.strictEqual(line.children[0].className, 'team-ticket-id',
      `${t.id}: the first child must be the id span`);
    assert.strictEqual(line.children[0].textContent, t.id,
      `${t.id}: ENTER — the id text must be INSIDE the span, not beside it`);
    assert.ok(line.children.length > 1,
      `${t.id}: the rest of the line must survive as a sibling of the span`);
  }
});

test('t964: a ticket with no id renders the id ticketLine writes, not the raw field', () => {
  const t = { title: 'filed by hand', assignee: null, step: 'backlog', since: null };
  const expected = ticketLine(t, Date.now());
  assert.match(expected, /^\? · /, 'ENTER: ticketLine is the authority that an absent id reads "?"');
  const [line] = runTicketsSection({ tickets: { open: [t], landed: [] } });
  assert.strictEqual(line.textContent, expected);
  assert.strictEqual(line.children[0].textContent, '?',
    'the span must carry what ticketLine wrote, not String(t.id)');
});

test('t964: the empty-state note is a plain line, with no id span to wear', () => {
  const notes = runTicketsSection({ tickets: { open: [], landed: [] } });
  assert.deepStrictEqual(notes.map((n) => n.textContent),
    ['No open tickets.', 'Nothing landed yet.']);
  for (const n of notes) assert.strictEqual(n.children.length, 0, 'an empty-state note has no element children');
});

test('t964: the id span has a treatment of its own, keyed on the class the popover mints', () => {
  const rule = rules(/^\.team-ticket-id$/);
  assert.strictEqual(rule.length, 1, 'ENTER: exactly one .team-ticket-id rule in styles.css');
  assert.match(rule[0].body, /font-family:\s*var\(--font-mono\)/, 'an identifier renders monospace');
  assert.match(rule[0].body, /color:\s*var\(--text-tertiary\)/, 'and quieter than the prose beside it');
});
