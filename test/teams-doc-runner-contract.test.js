'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'teams.md'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'team-tickets.js'), 'utf8');

function loopTotalsRegex() {
  const m = /matchAll\(\/(TOTALS: [^\n]*?)\/g\)/.exec(SRC);
  assert.ok(m, 'team-tickets.js no longer carries the TOTALS matchAll literal');
  return new RegExp(m[1], 'g');
}

function docTotalsLines() {
  return [...DOC.matchAll(/`(TOTALS: \d+ pass, \d+ fail, \d+ tests)`/g)].map((m) => m[1]);
}

test('docs/teams.md states the TOTALS contract, not TAP', () => {
  assert.ok(!/emits TAP|emitting TAP|parses TAP/.test(DOC));
  const lines = docTotalsLines();
  assert.deepStrictEqual(lines, ['TOTALS: 12 pass, 0 fail, 12 tests', 'TOTALS: 0 pass, 0 fail, 0 tests']);
});

test('a runner built from the doc\'s TOTALS sentence satisfies the loop\'s parser', () => {
  const [real] = docTotalsLines();
  const dir = mkTmpRoot('clodex-doc-runner-');
  fs.mkdirSync(path.join(dir, 'scripts'));
  const runner = path.join(dir, 'scripts', 'run-tests.js');
  fs.writeFileSync(runner, `console.error("noise");\nconsole.log(${JSON.stringify(real)});\nprocess.exit(0);\n`);
  const stdout = execFileSync(process.execPath, [runner, '--reporter=dot'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const all = [...stdout.matchAll(loopTotalsRegex())];
  assert.strictEqual(all.length, 1);
  const [, pass, failed, tests] = all[0];
  assert.deepStrictEqual([pass, failed, tests], ['12', '0', '12']);
  assert.ok(Number(tests) > 0);
});

test('the doc\'s failure-line shapes are the ones the loop\'s parser reads', () => {
  assert.ok(DOC.includes('`✖ <test name> (<n>ms)`'));
  assert.ok(SRC.includes("const { localHalf, failingNames } = require('./suite-client');"));
  assert.ok(SRC.includes('const names = failingNames(text);'));
  const { failingNames } = require('../suite-client');
  const docShapes = [...DOC.matchAll(/`((?:✖|not ok|FAIL|FAILED:|✗) [^`]*<test name>[^`]*)`/g)].map((m) => m[1]);
  assert.deepStrictEqual(docShapes, ['✖ <test name> (<n>ms)', 'not ok <n> - <test name>', 'FAIL <test name>', 'FAILED: <test name>', '✗ <test name>']);
  assert.deepStrictEqual(failingNames('✖ the thing (3ms)\nnot ok 2 - tap one\nFAIL plain one\nFAILED: colon one\n✗ cross one'),
    ['the thing', 'tap one', 'plain one', 'colon one', 'cross one']);
});
