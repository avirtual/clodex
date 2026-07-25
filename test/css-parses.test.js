'use strict';

// Guards a bug class the other CSS tests are structurally blind to: a stylesheet
// that PARSES DIFFERENTLY than it reads.
//
// The bug that motivated this (W3, caught only by eye in the running app): the
// workbench's moved stylesheet opened with a header comment whose prose said
// "the whole wb-*/workbench-* block". That `*` followed by `/` CLOSES the
// comment. Seventeen further lines of prose then became part of a selector, and
// the rule they ran into — `#workbench-modal`, the panel's entire frame — was
// discarded by the browser. The panel rendered as unstyled markup over the
// terminal.
//
// Every existing CSS test stayed green through it, and would again: they strip
// comments and then substring-search for selector names. The names were all
// still in the file. Only their POSITION had changed — from "selector" to
// "inside a selector that no engine will ever match".
//
// So this test does the one thing those cannot: it walks the file the way a CSS
// parser does and asserts every rule it finds has a selector that could
// plausibly be one. It is cheap and total — it covers core's stylesheet and
// every plugin's, present and future, with no per-file registration.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

// Walk top-level rules the way a parser does: strip comments FIRST (non-greedy,
// so an unbalanced `*/` mis-terminates here exactly as it does in the browser),
// then take each `{`, treat the text before it as the selector, and skip to the
// matching `}`. Nested braces (@media, @supports) are stepped over by depth, so
// their at-rule preludes are what gets checked at the top level.
function topLevelSelectors(src) {
  const out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const sels = [];
  let i = 0;
  for (;;) {
    const brace = out.indexOf('{', i);
    if (brace < 0) break;
    sels.push({ text: out.slice(i, brace).trim().replace(/\s+/g, ' '), at: brace });
    let depth = 1;
    let j = brace + 1;
    while (j < out.length && depth > 0) {
      if (out[j] === '{') depth++;
      else if (out[j] === '}') depth--;
      j++;
    }
    i = j;
  }
  return sels;
}

// Every stylesheet the app ships: core's, plus one per plugin directory that
// declares a `style` in its manifest. Discovered, not listed — a new plugin is
// covered the day it lands, which is the only way a gate like this survives.
function stylesheets() {
  const files = [{ label: 'renderer/styles.css', file: path.join(ROOT, 'renderer/styles.css') }];
  let dirs = [];
  try { dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }); } catch { dirs = []; }
  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, ent.name, 'manifest.json'), 'utf-8'));
    } catch { continue; }
    if (!manifest || typeof manifest.style !== 'string') continue;
    const file = path.join(PLUGINS_DIR, ent.name, manifest.style);
    if (fs.existsSync(file)) files.push({ label: `plugins/${ent.name}/${manifest.style}`, file });
  }
  return files;
}

const SHEETS = stylesheets();

test('every shipped stylesheet is discovered by this gate', () => {
  // A silent empty sweep would make every assertion below vacuous.
  assert.ok(SHEETS.length >= 2, `expected core + at least one plugin sheet, got ${SHEETS.length}`);
  assert.ok(
    SHEETS.some((s) => s.label === 'plugins/workbench/style.css'),
    'the workbench stylesheet must be in the sweep',
  );
});

for (const { label, file } of SHEETS) {
  const src = fs.readFileSync(file, 'utf-8');

  test(`${label}: comment delimiters are balanced`, () => {
    // `/*` and `*/` counts matching is necessary but NOT sufficient (the W3 bug
    // had 9 opens and 10 closes, but a file could also have a spurious pair).
    // It is the cheapest signal and names the fault directly when it fires.
    const opens = (src.match(/\/\*/g) || []).length;
    const closes = (src.match(/\*\//g) || []).length;
    assert.strictEqual(
      closes, opens,
      `${label}: ${opens} "/*" but ${closes} "*/" — a stray terminator (often a "wb-*/" style glob written in prose) ` +
      'closes its comment early and swallows the next rule',
    );
  });

  test(`${label}: every rule has a plausible selector`, () => {
    for (const { text } of topLevelSelectors(src)) {
      assert.ok(text.length > 0, `${label}: empty selector before a "{"`);

      // A selector containing a comment delimiter means the comment stripper
      // and the author disagree about where a comment ended. That is the W3
      // bug's signature, and it is never legitimate.
      assert.ok(
        !text.includes('*/') && !text.includes('/*'),
        `${label}: selector contains a comment delimiter — prose leaked into a rule:\n    ${text.slice(0, 200)}`,
      );

      // Prose that has become a selector is long and full of characters no
      // selector uses. The real ceiling here is core's own grouped popover
      // lists (~180 chars), so 400 is a wide margin that still catches a
      // paragraph. `@media`/`@supports`/`@keyframes` preludes are exempt from
      // the character check — they legitimately carry `:` and parentheses.
      assert.ok(
        text.length <= 400,
        `${label}: selector is ${text.length} chars — almost certainly prose that escaped a comment:\n    ${text.slice(0, 200)}`,
      );
      if (text.startsWith('@')) continue;
      for (const ch of ['`', '—', '…']) {
        assert.ok(
          !text.includes(ch),
          `${label}: selector contains "${ch}", a prose character no selector uses:\n    ${text.slice(0, 200)}`,
        );
      }
    }
  });
}

test('the workbench modal frame survives as a real rule', () => {
  // The specific casualty of the W3 bug, pinned by name. `#workbench-modal`
  // carries the panel's background, border and definite size; without it the
  // workbench renders as bare markup over whatever is behind it. Asserting the
  // SELECTOR PARSES is the point — a substring search for the id passed happily
  // while the id sat inside a dead prose selector.
  const file = path.join(PLUGINS_DIR, 'workbench/style.css');
  const sels = topLevelSelectors(fs.readFileSync(file, 'utf-8')).map((s) => s.text);
  assert.ok(
    sels.includes('#workbench-modal'),
    `#workbench-modal is not a top-level rule in the workbench stylesheet; parsed selectors start with: ${sels.slice(0, 3).join(' | ')}`,
  );
});
