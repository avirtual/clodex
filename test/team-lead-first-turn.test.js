// Run: node --test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_TEAMLEAD = path.join(__dirname, '..', 'resources', 'library', 'prompts', 'system', 'clodex-team-lead.md');
const HEADING = '## First turn on a fresh team';

function read() {
  return fs.readFileSync(REPO_TEAMLEAD, 'utf-8');
}

function section(text) {
  const start = text.indexOf(HEADING);
  if (start === -1) return '';
  const rest = text.slice(start + HEADING.length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

test('the lead prompt carries exactly one "First turn on a fresh team" heading', () => {
  // The two first-turn openers a fresh lead receives quote this heading string
  // verbatim, so a rename or a duplicate breaks the pairing they depend on.
  const matches = read().match(/^## First turn on a fresh team$/gm) || [];
  assert.strictEqual(matches.length, 1);
});

test('the section is non-empty and carries NEW then TAKEOVER', () => {
  const body = section(read());
  assert.ok(body.trim().length > 0, 'section body is non-empty');
  const iNew = body.indexOf('**NEW**');
  const iTakeover = body.indexOf('**TAKEOVER**');
  assert.ok(iNew !== -1, 'NEW arm present');
  assert.ok(iTakeover !== -1, 'TAKEOVER arm present');
  assert.ok(iNew < iTakeover, 'NEW arm precedes TAKEOVER arm');
});

test('the section names the runner, the brief file and the notify channel', () => {
  const body = section(read());
  assert.ok(body.includes('scripts/run-tests.js'), 'names scripts/run-tests.js');
  assert.ok(body.includes('team-project'), 'names team-project');
  assert.ok(body.includes('notify-user'), 'names notify-user');
});

test('the TAKEOVER arm names the files it must read before asking anything', () => {
  const body = section(read());
  const start = body.indexOf('**TAKEOVER**');
  const end = body.indexOf('Either arm');
  assert.ok(start !== -1 && end > start, 'TAKEOVER arm is bounded by the "Either arm" paragraph');
  const takeover = body.slice(start, end);
  assert.ok(takeover.includes('README'), 'names README');
  assert.ok(takeover.includes('package.json'), 'names package.json');
  assert.ok(takeover.includes('CHANGELOG.md'), 'names CHANGELOG.md');
  assert.ok(takeover.includes('before asking anything'), 'names before asking anything');
});

test('the NEW arm names the empty-suite contract and the question budget', () => {
  const body = section(read());
  const start = body.indexOf('**NEW**');
  const end = body.indexOf('**TAKEOVER**');
  assert.ok(start !== -1 && end > start, 'NEW arm is bounded by the TAKEOVER arm');
  const arm = body.slice(start, end);
  assert.ok(arm.includes('TOTALS:'), 'names TOTALS:');
  assert.ok(arm.includes('at most three'), 'names at most three');
});

test('Team lifecycle still occurs once and precedes the new section', () => {
  const text = read();
  const lifecycle = text.match(/^## Team lifecycle$/gm) || [];
  assert.strictEqual(lifecycle.length, 1);
  assert.ok(text.indexOf('## Team lifecycle') < text.indexOf(HEADING));
});
