'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { effortOptions } = require('../renderer/lib/effort-options');

const values = (rows) => rows.map((r) => r.value);

test('claude lists the default then its five levels', () => {
  assert.deepStrictEqual(values(effortOptions('claude', '')), ['', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(effortOptions('claude', '')[0], { value: '', label: '(CLI default)' });
});

test('codex lists the default then its eight levels', () => {
  assert.deepStrictEqual(values(effortOptions('codex', '')),
    ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});

test('muse lists the same nine rows as codex', () => {
  assert.deepStrictEqual(values(effortOptions('muse', '')),
    ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});

test('bash and an unknown type get the default row only', () => {
  assert.deepStrictEqual(effortOptions('bash', ''), [{ value: '', label: '(CLI default)' }]);
  assert.deepStrictEqual(effortOptions('nope', 'high'), [{ value: '', label: '(CLI default)' }]);
});

test('a valid current value adds no extra row', () => {
  assert.deepStrictEqual(values(effortOptions('codex', 'xhigh')),
    ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});

test('a stale current value is appended once and marked with the adapter label', () => {
  const rows = effortOptions('claude', 'ultra');
  assert.strictEqual(rows.length, 7);
  assert.deepStrictEqual(rows[6], { value: 'ultra', label: 'ultra (not valid for Claude Code)' });
});

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

function fakeSelect() {
  const options = [];
  let value = '';
  return {
    options,
    set innerHTML(v) { assert.strictEqual(v, ''); options.length = 0; value = ''; },
    appendChild(o) { options.push(o); if (options.length === 1) value = o.value; },
    get value() { return value; },
    set value(v) { const hit = options.find((o) => o.value === v); value = hit ? hit.value : ''; },
  };
}

test('opening Edit Session on a codex seat with effort ultra selects ultra', () => {
  const fill = rendererSrc.match(/\n(function fillEffort\([\s\S]*?\n\})\n/);
  assert.ok(fill, 'ENTER: fillEffort located');
  const at = rendererSrc.indexOf('async function openArgsDialog(');
  const body = rendererSrc.slice(at, rendererSrc.indexOf('\nfunction closeArgsDialog', at));
  const line = body.match(/\n(\s*if \(argsEffort\)[^\n]*)\n/);
  assert.ok(line, 'ENTER: the Edit Session effort line located');
  const argsEffort = fakeSelect();
  const document = { createElement: (tag) => ({ tag }) };
  const res = { type: 'codex', effort: 'ultra' };
  new Function('effortOptions', 'document', 'argsEffort', 'res', `${fill[1]}\n${line[1]}`)(effortOptions, document, argsEffort, res);
  assert.strictEqual(argsEffort.value, 'ultra');
  assert.deepStrictEqual(argsEffort.options.map((o) => o.value),
    ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.ok(argsEffort.options.every((o) => o.tag === 'option'));
});

test('applyTypeDefaults refills the effort list for the chosen type, and a type change runs it', () => {
  const at = rendererSrc.indexOf('function applyTypeDefaults(');
  const fn = rendererSrc.slice(at, rendererSrc.indexOf('\nlet lastToolCheck', at));
  assert.match(fn, /if \(inputEffort\) fillEffort\(inputEffort, type, skipAsyncRefresh \? inputEffort\.value : ''\);/);
  assert.match(rendererSrc, /inputType\.addEventListener\('change', \(\) => applyTypeDefaults\(\)\);/);
});
