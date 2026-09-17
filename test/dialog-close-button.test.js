'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
const { winningDeclaration } = require('./lib/css-cascade');

function tableRows() {
  const m = rendererSrc.match(/^const ESCAPE_CLOSES = \[\n([\s\S]*?)^\];$/m);
  assert.ok(m, 'ENTER: no ESCAPE_CLOSES table found in renderer.js');
  const rows = [...m[1].matchAll(/\['([a-z-]+)', \(\) => (close[A-Za-z]*)\(\)\]/g)]
    .map((r) => [r[1], r[2]]);
  assert.ok(rows.length >= 7, `ENTER: read only ${rows.length} rows out of ESCAPE_CLOSES`);
  return rows;
}

function extractClickListener() {
  const m = rendererSrc.match(
    /^document\.addEventListener\('click', \(e\) => \{\n[\s\S]*?dialog-close[\s\S]*?^\}\);$/m);
  assert.ok(m, 'ENTER: no delegated .dialog-close click listener found in renderer.js');
  assert.doesNotMatch(m[0], /e\.key/,
    'ENTER: the capture wandered into a keydown handler');
  return m[0];
}

function closeButtonOwners() {
  const owners = [];
  const re = /class="dialog-close"/g;
  let m;
  while ((m = re.exec(htmlSrc))) {
    const before = htmlSrc.slice(0, m.index);
    const opens = [...before.matchAll(/^ {2}<div id="([a-z0-9-]+)"/gm)];
    assert.ok(opens.length,
      `a .dialog-close at offset ${m.index} sits in no top-level container`);
    owners.push(opens[opens.length - 1][1]);
  }
  return owners;
}

function elementExtent(src, open) {
  const re = /<(\/?)div\b[^>]*?(\/?)>/g;
  re.lastIndex = open;
  let depth = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m[2] === '/') continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { start: open, end: m.index + m[0].length };
  }
  return null;
}

function ancestorChain(at) {
  const stack = [];
  const re = /<(\/?)div\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(htmlSrc)) && m.index < at) {
    if (m[3] === '/') continue;
    if (m[1]) { stack.pop(); continue; }
    const id = m[2].match(/\bid="([^"]+)"/);
    const cls = m[2].match(/\bclass="([^"]+)"/);
    stack.push({
      tag: 'div',
      id: id ? id[1] : null,
      classes: cls ? cls[1].split(/\s+/).filter(Boolean) : [],
      attrs: {},
    });
  }
  assert.ok(stack.length, `ENTER: nothing is open at offset ${at} — the tag replay lost the tree`);
  return stack;
}

function dialogHeads() {
  const heads = [];
  const re = /<div class="dialog-head">/g;
  let m;
  while ((m = re.exec(htmlSrc))) {
    const extent = elementExtent(htmlSrc, m.index);
    assert.ok(extent, `a .dialog-head at offset ${m.index} is never closed`);
    heads.push({ ...extent, html: htmlSrc.slice(extent.start, extent.end) });
  }
  return heads;
}

function runListener(closeNames, { target }) {
  const docListeners = [];
  const closed = [];
  const stubs = {
    document: { addEventListener: (type, fn) => { if (type === 'click') docListeners.push(fn); } },
    ESCAPE_CLOSES: closeNames.map(([id, name]) => [id, () => closed.push(name)]),
  };
  const names = Object.keys(stubs);
  new Function(...names, extractClickListener())(...names.map((n) => stubs[n]));
  assert.strictEqual(docListeners.length, 1,
    'ENTER: the extracted block bound no single document click listener');
  for (const fn of docListeners) fn({ target });
  return closed;
}

function selectorSuffixes() {
  const block = extractClickListener();
  const sel = block.match(/closest\('([^']*\[id\$=[^']*)'\)/);
  assert.ok(sel, 'ENTER: the ✕ listener resolves no ancestor by an [id$="…"] selector');
  const suffixes = [...sel[1].matchAll(/\[id\$="([^"]+)"\]/g)].map((m) => m[1]);
  assert.ok(suffixes.length, `ENTER: no id suffix parsed out of \`${sel[1]}\``);
  return suffixes;
}

function fakeTarget({ btnOverlayId, isButton = true }) {
  const suffixes = selectorSuffixes();
  const overlay = btnOverlayId === null || !suffixes.some((s) => btnOverlayId.endsWith(s))
    ? null
    : { id: btnOverlayId };
  const btn = isButton
    ? { closest: (sel) => (sel.includes('[id$=') ? overlay : null) }
    : null;
  return { closest: (sel) => (sel === '.dialog-close' ? btn : null) };
}

test('the close button resolves its closer through the Escape table, not a second one', () => {
  const block = extractClickListener();
  assert.match(block, /ESCAPE_CLOSES\.find\(/,
    'the ✕ listener must look the closer up in ESCAPE_CLOSES');
  const tables = (rendererSrc.match(/^const [A-Z_]*CLOSES[A-Z_]* = \[/gm) || []);
  assert.strictEqual(tables.length, 1,
    `${tables.length} closer tables in renderer.js — ✕ and Escape must share the one`);
  assert.doesNotMatch(block, /getElementById|classList\.add\('hidden'\)/,
    'the ✕ listener must call the closer, not hide the overlay itself');
});

test('a ✕ press calls the same closer Escape would, for every dialog in the table', () => {
  const rows = tableRows();
  for (const [id, name] of rows) {
    const closed = runListener(rows, { target: fakeTarget({ btnOverlayId: id }) });
    assert.deepStrictEqual(closed, [name], `✕ inside ${id} must call ${name}, and only it`);
  }
});

test('a click that is not on a ✕, or on one outside any overlay, closes nothing', () => {
  const rows = tableRows();
  assert.deepStrictEqual(
    runListener(rows, { target: fakeTarget({ btnOverlayId: null, isButton: false }) }), [],
    'a click anywhere in the document must not close a dialog');
  assert.deepStrictEqual(
    runListener(rows, { target: fakeTarget({ btnOverlayId: null }) }), [],
    'a ✕ outside any overlay must not close a dialog');
  assert.deepStrictEqual(
    runListener(rows, { target: fakeTarget({ btnOverlayId: 'not-an-overlay' }) }), [],
    'an overlay with no row in the table must close nothing');
});

test('every ✕ shipped in index.html sits in an overlay the table can close', () => {
  const ids = new Set(tableRows().map(([id]) => id));
  const owners = closeButtonOwners();
  assert.ok(owners.length >= 7,
    `ENTER: found only ${owners.length} .dialog-close buttons in index.html`);
  for (const owner of owners) {
    assert.ok(ids.has(owner),
      `#${owner} ships a .dialog-close but is not a row of ESCAPE_CLOSES — its ✕ is dead`);
  }
});

test('every ✕ sits inside a .dialog-head, beside the title it belongs to', () => {
  const heads = dialogHeads();
  const buttons = [...htmlSrc.matchAll(/class="dialog-close"/g)];
  assert.ok(buttons.length >= 7,
    `ENTER: found only ${buttons.length} .dialog-close buttons in index.html`);
  assert.ok(heads.length >= buttons.length,
    `ENTER: ${buttons.length} close buttons but only ${heads.length} .dialog-head rows parsed`);
  for (const b of buttons) {
    const head = heads.find((h) => b.index > h.start && b.index < h.end);
    assert.ok(head,
      `the .dialog-close at offset ${b.index} sits outside every .dialog-head — `
      + 'it floats in the dialog body instead of the title row');
    assert.match(head.html, /<h3[ >]/,
      `the .dialog-head holding the ✕ at offset ${b.index} carries no h3 — `
      + `a close button with no title beside it:\n${head.html.slice(0, 200)}`);
  }
  for (const h of heads) {
    assert.match(h.html, /class="dialog-close"/,
      `a .dialog-head ships no ✕ — the row exists but the button is missing:\n${h.html.slice(0, 200)}`);
  }
});

test('the .dialog-head h3 rule WINS the margin cascade in every dialog', () => {
  const heads = dialogHeads();
  assert.ok(heads.length >= 7, `ENTER: parsed only ${heads.length} .dialog-head rows`);
  for (const head of heads) {
    const chain = [...ancestorChain(head.start), {
      tag: 'div', id: null, classes: ['dialog-head'], attrs: {},
    }, { tag: 'h3', id: null, classes: [], attrs: {} }];
    const where = chain.map((e) => e.id ? `#${e.id}` : (e.classes[0] ? `.${e.classes[0]}` : e.tag)).join(' ');
    const win = winningDeclaration(cssSrc, chain, 'margin');
    assert.ok(win, `ENTER: no margin rule resolves onto \`${where}\``);
    assert.strictEqual(win.value, '0',
      `\`${win.selector}\` wins margin on \`${where}\` with \`${win.value}\` — `
      + 'the h3 keeps a bottom margin inside the flex row and the ✕ rides high against it');
    const bottom = winningDeclaration(cssSrc, chain, 'margin-bottom');
    if (bottom) {
      assert.ok(bottom.score < win.score || (bottom.score === win.score && bottom.at < win.at),
        `\`${bottom.selector}\` sets margin-bottom: ${bottom.value} on \`${where}\` `
        + `and outranks the \`${win.selector}\` shorthand — the title keeps the gap`);
    }
  }
});

const POPOVER_CHROME = {
  'help-overlay': {
    why: 'popover chrome on the #report-modal idiom: .popover-title + .popover-close, not .dialog-head + h3 + .dialog-close',
    island: 'renderer/popovers/help-panel.js',
  },
};

test('every dialog the table closes ships a ✕ of its own', () => {
  const owners = new Set(closeButtonOwners());
  for (const [id] of tableRows()) {
    if (id in POPOVER_CHROME) continue;
    assert.ok(owners.has(id), `#${id} closes on Escape but ships no .dialog-close`);
  }
});

test('an overlay excused from the .dialog-close rule still ships a wired ✕', () => {
  const ids = new Set(tableRows().map(([id]) => id));
  for (const [id, { why, island: islandPath }] of Object.entries(POPOVER_CHROME)) {
    assert.ok(ids.has(id), `#${id} is excused from a table it is not in — a stale entry`);
    assert.ok(!closeButtonOwners().includes(id),
      `#${id} ships a .dialog-close after all: ${why} no longer describes it, so it needs no excuse`);
    const { start, end } = elementExtent(htmlSrc, htmlSrc.indexOf(`<div id="${id}"`));
    const overlay = htmlSrc.slice(start, end);
    const btn = overlay.match(/<button[^>]*class="popover-close"[^>]*>/);
    assert.ok(btn, `#${id} is excused from the .dialog-close rule and ships no .popover-close either — it has no ✕ at all`);
    assert.match(btn[0], /type="button"/, `#${id}'s ✕ without type=button submits its form: ${btn[0]}`);
    assert.match(btn[0], /aria-label="Close"/, `#${id}'s ✕ has no accessible name: ${btn[0]}`);
    const btnId = btn[0].match(/\bid="([^"]+)"/);
    assert.ok(btnId, `#${id}'s ✕ carries no id, so nothing can bind it`);
    const island = fs.readFileSync(path.join(ROOT, islandPath), 'utf8');
    assert.match(island, new RegExp(`getElementById\\('${btnId[1]}'\\)\\.addEventListener\\('click'`),
      `#${btnId[1]} is shipped but ${islandPath} never binds it — the ✕ the table excuses is dead`);
  }
});

test('each close button is a type=button with an accessible label', () => {
  const buttons = [...htmlSrc.matchAll(/<button[^>]*class="dialog-close"[^>]*>/g)].map((m) => m[0]);
  assert.ok(buttons.length >= 7, `ENTER: found only ${buttons.length} .dialog-close tags`);
  for (const b of buttons) {
    assert.match(b, /type="button"/, `a .dialog-close without type=button submits its form: ${b}`);
    assert.match(b, /aria-label="Close"/, `a .dialog-close with no accessible name: ${b}`);
  }
});

function idBlocks(pred) {
  const lines = cssSrc.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#[A-Za-z0-9_-]+)\s*\{\s*$/);
    if (!m) continue;
    let body = '';
    for (let j = i + 1; j < lines.length && !/^\}/.test(lines[j]); j++) body += lines[j] + '\n';
    if (pred(body, m[1])) found.push(m[1]);
  }
  return found;
}

function headChain(dialogId) {
  return [
    { tag: 'div', id: dialogId.slice(1), classes: [], attrs: {} },
    { tag: 'div', id: null, classes: ['dialog-head'], attrs: {} },
  ];
}

test('in every grid dialog the .dialog-head spans both columns', () => {
  const grids = idBlocks((body, id) => /dialog$/.test(id) && /grid-template-columns\s*:/.test(body));
  assert.deepStrictEqual(grids.sort(), ['#args-dialog', '#dialog'],
    `ENTER: the two-column dialogs are ${grids.join(', ') || '(none)'} — `
    + 'the grid set moved, so this pin is measuring the wrong dialogs');
  for (const id of grids) {
    const win = winningDeclaration(cssSrc, headChain(id), 'grid-column');
    assert.ok(win, `no grid-column reaches \`${id} .dialog-head\` — `
      + 'the head lands in the left column and the ✕ sits mid-row');
    assert.strictEqual(win.value, '1 / -1',
      `\`${win.selector}\` wins grid-column on \`${id} .dialog-head\` with \`${win.value}\``);
  }
});

test('#args-model-row and its Extra CLI args sibling are NOT .dialog-wide', () => {
  const at = htmlSrc.indexOf('<label id="args-model-row"');
  assert.ok(at > 0, 'ENTER: no <label id="args-model-row"> in index.html');
  const model = htmlSrc.slice(at, htmlSrc.indexOf('\n', at));
  const nextAt = htmlSrc.indexOf('<label', at + 1);
  assert.ok(nextAt > 0, 'ENTER: no <label follows args-model-row');
  const sibling = htmlSrc.slice(nextAt, htmlSrc.indexOf('\n', nextAt));
  assert.match(sibling, /Extra CLI args|id="args-input"/,
    `ENTER: the label after args-model-row is not the Extra CLI args row: ${sibling}`);
  for (const tag of [model, sibling]) {
    assert.doesNotMatch(tag, /\bdialog-wide\b/,
      `${tag} spans both columns — Model and Extra CLI args must pair side by side`);
  }
});

test('the dialog head is sticky in every dialog that scrolls itself', () => {
  const scrollers = idBlocks((body, id) => /dialog$/.test(id) && /overflow(-y)?:\s*auto/.test(body));
  assert.deepStrictEqual(scrollers.sort(), [
    '#args-dialog', '#dialog', '#peer-session-dialog',
    '#peers-dialog', '#prefs-dialog', '#sandbox-dialog',
  ], `ENTER: the self-scrolling dialogs are ${scrollers.join(', ')} — a dialog joined or left the `
    + 'set; add it to this literal list deliberately, after checking its head is a direct child');
  for (const id of scrollers) {
    const pos = winningDeclaration(cssSrc, headChain(id), 'position');
    assert.ok(pos, `no position reaches \`${id} .dialog-head\` — its title and ✕ scroll away`);
    assert.strictEqual(pos.value, 'sticky',
      `\`${pos.selector}\` wins position on \`${id} .dialog-head\` with \`${pos.value}\``);
    const top = winningDeclaration(cssSrc, headChain(id), 'top');
    assert.ok(top, `\`${id} .dialog-head\` is sticky with no top — sticky never engages`);
    assert.notStrictEqual(top.value, 'auto',
      `\`${top.selector}\` wins top on \`${id} .dialog-head\` with \`auto\` — sticky never engages`);
  }
});

const workbenchCss = fs.readFileSync(
  path.join(ROOT, 'plugins', 'workbench', 'style.css'), 'utf8');
const { parseRules } = require('./lib/css-cascade');

function ruleBody(css, selector) {
  const hit = parseRules(css).filter((r) => r.selector
    .split(',').map((s) => s.trim()).includes(selector));
  assert.strictEqual(hit.length, 1,
    `ENTER: ${hit.length} rules carry the literal selector \`${selector}\``);
  return hit[0].body;
}

function chainFor(selector) {
  return [selector.startsWith('#')
    ? { tag: 'div', id: selector.slice(1), classes: [], attrs: {} }
    : { tag: 'div', id: null, classes: [selector.slice(1)], attrs: {} }];
}

test('the file peek, report and tool overlay panels wear the shared neutral chrome', () => {
  const surfaces = ['#file-peek-modal', '#report-modal', '.tool-overlay-panel'];
  const selectors = new Set(parseRules(cssSrc)
    .flatMap((r) => r.selector.split(',').map((s) => s.trim())));
  for (const sel of surfaces) {
    assert.ok(selectors.has(sel), `ENTER: no \`${sel}\` rule in renderer/styles.css`);
  }
  for (const sel of surfaces) {
    const border = winningDeclaration(cssSrc, chainFor(sel), 'border');
    assert.ok(border, `ENTER: no border rule resolves onto \`${sel}\``);
    assert.strictEqual(border.value, '1px solid var(--border-strong)',
      `\`${border.selector}\` wins border on \`${sel}\` with \`${border.value}\` — `
      + 'the modal keeps the pre-chrome accent edge beside the neutral popovers');
    const bg = winningDeclaration(cssSrc, chainFor(sel), 'background');
    assert.ok(bg, `ENTER: no background rule resolves onto \`${sel}\``);
    assert.strictEqual(bg.value, 'var(--surface-overlay)',
      `\`${bg.selector}\` wins background on \`${sel}\` with \`${bg.value}\``);
  }
});

test('#workbench-modal wears the neutral border while its active tab keeps the accent', () => {
  const modal = ruleBody(workbenchCss, '#workbench-modal');
  assert.match(modal, /var\(--border-strong\)/,
    '#workbench-modal does not reach for --border-strong — it renders the old red edge');
  assert.doesNotMatch(modal, /var\(--accent\)/,
    '#workbench-modal still carries --accent chrome');
  const tab = ruleBody(workbenchCss, '.workbench-tab.active');
  assert.match(tab, /border-color:\s*var\(--accent\)/,
    "the active workbench tab lost its accent edge — that border is a signal, not chrome");
});

test('a resting 1px accent border survives only on the text inputs', () => {
  const offenders = [];
  for (const rule of parseRules(cssSrc)) {
    if (!/(?:^|;)\s*border\s*:\s*1px solid var\(--accent\)\s*(?:;|$)/.test(rule.body)) continue;
    for (const sel of rule.selector.split(',').map((s) => s.trim())) {
      if (/:focus|\.active|\.selected/.test(sel)) continue;
      offenders.push(sel);
    }
  }
  assert.ok(offenders.length,
    'ENTER: no `border: 1px solid var(--accent)` declaration parsed out of the sheet at all');
  assert.deepStrictEqual([...new Set(offenders)].sort(), ['.rename-input', '.workspace-name-input'],
    'a non-input surface takes `border: 1px solid var(--accent)` as its resting border — '
    + 'chrome edges are neutral, the accent is reserved for focus and selection');
});
