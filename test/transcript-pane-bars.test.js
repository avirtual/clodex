'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
const block = (selector) => {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, selector);
  return css.slice(start, css.indexOf('}', start));
};

test('a transcript head row carries no left bar', () => {
  assert.doesNotMatch(block('.tr-head'), /border-left/);
});

test('a pane intent mark drops its bar while the terminal mark keeps it', () => {
  assert.match(block('.transcript-pane .intent-mark'), /border-left: 0/);
  assert.match(block('.intent-mark'), /border-left: 2px solid/);
});
