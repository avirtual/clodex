'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseRules, winningDeclaration } = require('./lib/css-cascade');

const ROOT = path.join(__dirname, '..');
const cssSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const rules = parseRules(cssSrc);

const BUTTON = 'button';
const SELECT = 'select';
const TEXTAREA = 'textarea:where(:not(.xterm-helper-textarea):not(.seat-composer))';
const INPUT = 'input:where(:not([type="checkbox"]):not([type="radio"]):not([type="range"]))';

function selectorsOf(rule) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of rule.selector) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function stripWhere(sel) {
  let out = '';
  let i = 0;
  while (i < sel.length) {
    if (sel.startsWith(':where(', i)) {
      let depth = 0;
      let j = i + ':where'.length;
      for (; j < sel.length; j++) {
        if (sel[j] === '(') depth++;
        if (sel[j] === ')' && --depth === 0) break;
      }
      i = j + 1;
      continue;
    }
    out += sel[i++];
  }
  return out;
}

function baseRule(selector) {
  return rules.find((r) => selectorsOf(r).includes(selector)
    && /(?:^|;)\s*background\s*:/.test(r.body));
}

const DECLARATIONS = [
  [BUTTON, 'background'], [BUTTON, 'border'], [BUTTON, 'border-radius'], [BUTTON, 'height'], [BUTTON, 'color'],
  [SELECT, 'background'], [SELECT, 'border'], [SELECT, 'border-radius'], [SELECT, 'padding'], [SELECT, 'color'],
  [TEXTAREA, 'background'], [TEXTAREA, 'border'], [TEXTAREA, 'border-radius'], [TEXTAREA, 'padding'], [TEXTAREA, 'color'],
  [INPUT, 'background'], [INPUT, 'border'], [INPUT, 'border-radius'], [INPUT, 'padding'], [INPUT, 'color'],
];

for (const [selector, prop] of DECLARATIONS) {
  test(`the ${selector} base rule sets ${prop}`, () => {
    const rule = baseRule(selector);
    assert.ok(rule, `ENTER: no rule lists ${selector} with a background`);
    assert.match(rule.body, new RegExp(`(?:^|;)\\s*${prop}\\s*:`));
  });
}

test('every base control rule is a bare tag, specificity (0,0,1), so each scoped rule still wins', () => {
  const bases = rules.filter((r) => selectorsOf(r).some((s) => /^(button|select|textarea|input)\b/.test(s))
    && selectorsOf(r).every((s) => /^(button|select|textarea|input)(:where\(|\s*$)/.test(s)));
  const seen = new Set(bases.flatMap(selectorsOf));
  for (const sel of [BUTTON, SELECT, TEXTAREA, INPUT, 'button:where(:hover)']) {
    assert.ok(seen.has(sel), `ENTER: ${sel} is a base selector`);
  }
  for (const sel of seen) {
    assert.match(stripWhere(sel), /^(button|select|textarea|input)$/,
      `${sel} outranks (0,0,1): a scoped glyph or dialog rule would lose to it`);
  }
});

test('the textarea base exempts the xterm helper and the seat composer, which own their chrome', () => {
  assert.ok(baseRule(TEXTAREA), 'ENTER: the textarea base rule exists');
  assert.ok(TEXTAREA.includes(':not(.xterm-helper-textarea)'));
  assert.ok(TEXTAREA.includes(':not(.seat-composer)'));
});

test('an index.html control with no class and no id rule is a tag the base rules cover', () => {
  const idsWithRules = new Set(rules.flatMap(selectorsOf)
    .flatMap((s) => [...s.matchAll(/#([\w-]+)/g)].map((m) => m[1])));
  const bare = [...htmlSrc.matchAll(/<(button|select|textarea|input)\b([^>]*)>/g)]
    .filter(([, , attrs]) => !/\bclass="/.test(attrs))
    .filter(([, , attrs]) => { const id = /\bid="([^"]+)"/.exec(attrs); return !id || !idsWithRules.has(id[1]); })
    .filter(([, tag, attrs]) => tag !== 'input' || /\btype="(text|number|password|search)"/.test(attrs) || !/\btype=/.test(attrs));
  const ids = bare.map(([, , attrs]) => (/\bid="([^"]+)"/.exec(attrs) || [])[1]);
  assert.ok(ids.includes('sandbox-bootstrap-save'), 'ENTER: the Advanced fold buttons have no rule of their own');
  const covered = { button: BUTTON, select: SELECT, textarea: TEXTAREA, input: INPUT };
  for (const [, tag] of bare) assert.ok(baseRule(covered[tag]), `${tag} has no base rule`);
});

const GLYPHS = [
  ['#sidebar-fold', [{ tag: 'div', id: 'sidebar-toolbar' }, { tag: 'button', id: 'sidebar-fold' }], 'padding', '0'],
  ['#btn-new', [{ tag: 'div', id: 'sidebar-toolbar' }, { tag: 'button', id: 'btn-new' }], 'padding', '0'],
  ['#files-toggle', [{ tag: 'div', id: 'sidebar-footer' }, { tag: 'button', id: 'files-toggle' }], 'height', 'auto'],
  ['#inbox-open', [{ tag: 'div', id: 'sidebar-footer' }, { tag: 'button', id: 'inbox-open' }], 'height', 'auto'],
  ['.seat-status-chip', [{ tag: 'button', classes: ['seat-status-chip'] }], 'height', 'auto'],
  ['.history-item', [{ tag: 'div', classes: ['history-menu'] }, { tag: 'button', classes: ['history-item'] }], 'height', 'auto'],
  ['.transcript-mode-btn', [{ tag: 'button', classes: ['transcript-mode-btn'] }], 'height', 'auto'],
  ['.transcript-help-btn', [{ tag: 'button', classes: ['transcript-help-btn'] }], 'height', 'auto'],
  ['.transcript-terminal-btn', [{ tag: 'button', classes: ['transcript-terminal-btn'] }], 'height', 'auto'],
  ['.side-tab-close', [{ tag: 'button', classes: ['side-tab-close'] }], 'height', 'auto'],
  ['.team-role-disclose', [{ tag: 'button', classes: ['team-role-disclose'] }], 'height', 'auto'],
  ['.session-close', [{ tag: 'button', classes: ['session-close'] }], 'height', '20px'],
  ['.inbox-delete', [{ tag: 'button', classes: ['inbox-delete'] }], 'height', 'auto'],
  ['.inbox-link', [{ tag: 'button', classes: ['inbox-link'] }], 'height', 'auto'],
  ['.inbox-path', [{ tag: 'button', classes: ['inbox-path'] }], 'height', 'auto'],
];

for (const [name, chain, prop, value] of GLYPHS) {
  test(`${name} keeps its own ${prop} over the button base`, () => {
    const win = winningDeclaration(cssSrc, chain, prop);
    assert.ok(win, `ENTER: some rule sets ${prop} on ${name}`);
    assert.strictEqual(win.value, value, `${win.selector} wins with ${win.value}`);
  });
}
