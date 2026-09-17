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

// The extent of the element opening at `open`, by tag depth — a non-greedy scan
// to the first `</div>` would stop at a nested one and report a head that
// swallowed half the dialog as if it were two lines long.
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

function fakeTarget({ btnOverlayId, isButton = true }) {
  const overlay = btnOverlayId === null ? null : { id: btnOverlayId };
  const btn = isButton
    ? { closest: (sel) => (sel === '[id$="-overlay"]' ? overlay : null) }
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
  // The owners subject above resolves only the TOP-LEVEL div, so a ✕ dropped
  // anywhere in the dialog body — under the fields, inside an actions row —
  // still names the right owner and passes. What makes it read as chrome is its
  // position: in the flex head row, opposite the h3. Nothing else pins that.
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
  // `#dialog h3, #prefs-dialog h3, …` is (1,0,1) and outranks a bare
  // `.dialog-head h3 { margin: 0 }` at (0,1,1), so the title kept its bottom
  // margin inside the flex head and the ✕ sat visibly high against it. Present,
  // correct, outranked — which a substring pin on the rule cannot see.
  for (const [overlayId] of tableRows()) {
    const dialogId = overlayId.replace(/-overlay$/, '-dialog').replace(/^dialog-dialog$/, 'dialog');
    if (!htmlSrc.includes(`id="${dialogId}"`)) continue;
    const chain = [
      { tag: 'div', id: dialogId, classes: [], attrs: {} },
      { tag: 'div', id: null, classes: ['dialog-head'], attrs: {} },
      { tag: 'h3', id: null, classes: [], attrs: {} },
    ];
    const win = winningDeclaration(cssSrc, chain, 'margin');
    assert.ok(win, `ENTER: no margin rule resolves onto #${dialogId} .dialog-head h3`);
    assert.strictEqual(win.value, '0',
      `\`${win.selector}\` wins margin on #${dialogId}'s head title with \`${win.value}\` — `
      + 'the h3 keeps a bottom margin inside the flex row and the ✕ rides high against it');
    // The shorthand only reaches margin-bottom if it also outranks every
    // LONGHAND that matches: #args-dialog h3 sets margin-bottom directly, and
    // the cascade is resolved per longhand, not per rule.
    const bottom = winningDeclaration(cssSrc, chain, 'margin-bottom');
    if (bottom) {
      assert.ok(bottom.score < win.score || (bottom.score === win.score && bottom.at < win.at),
        `\`${bottom.selector}\` sets margin-bottom: ${bottom.value} on #${dialogId}'s head `
        + `title and outranks the \`${win.selector}\` shorthand — the title keeps the gap`);
    }
  }
});

test('every dialog the table closes ships a ✕ of its own', () => {
  const owners = new Set(closeButtonOwners());
  for (const [id] of tableRows()) {
    assert.ok(owners.has(id), `#${id} closes on Escape but ships no .dialog-close`);
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
