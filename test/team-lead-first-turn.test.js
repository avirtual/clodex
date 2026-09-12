// Run: node --test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_TEAMLEAD = path.join(__dirname, '..', 'resources', 'library', 'prompts', 'system', 'clodex-team-lead.md');
const KIT_DEFAULT_LEAD = path.join(__dirname, '..', 'resources', 'library', 'kits', 'default', 'prompts', 'system', 'lead.md');
const HEADING = '## First turn on a fresh team';
const TOTALS_SHAPE = 'TOTALS: <n> pass, <n> fail, <n> tests';

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
  const end = body.indexOf('**INTERVIEW**');
  assert.ok(start !== -1 && end > start, 'TAKEOVER arm is bounded by the INTERVIEW arm');
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
  assert.ok(arm.includes(TOTALS_SHAPE), `names the literal ${TOTALS_SHAPE}`);
  assert.ok(arm.includes('at most three'), 'names at most three');
});

test('the default kit lead states the same summary shape, which nothing else pins', () => {
  const body = section(fs.readFileSync(KIT_DEFAULT_LEAD, 'utf-8'));
  const start = body.indexOf('**NEW**');
  const end = body.indexOf('**TAKEOVER**');
  assert.ok(start !== -1 && end > start, 'NEW arm is bounded by the TAKEOVER arm');
  assert.ok(body.slice(start, end).includes(TOTALS_SHAPE), `names the literal ${TOTALS_SHAPE}`);
});

// t795. The opener sent on a `mode:interview` create names the INTERVIEW arm of
// this heading by hand: the sentence is only actionable if the arm is really in
// the prompt, and the arm is only actionable if it names the verb that rewrites
// the brief. Both are strings in a markdown file no code reads, so nothing but
// this pin stands between a rename and a lead sent to a section that is gone.
test('t795: the INTERVIEW arm is present, sits last, and names the rewrite verb', () => {
  const body = section(read());
  const iTakeover = body.indexOf('**TAKEOVER**');
  const iInterview = body.indexOf('**INTERVIEW**');
  assert.ok(iInterview !== -1, 'INTERVIEW arm present');
  assert.ok(iTakeover < iInterview, 'it follows TAKEOVER — the root arms come first');
  const arm = body.slice(iInterview);
  assert.ok(arm.includes('[agent:team prompt-save append team-project]'),
    'the arm names the verb that rewrites the brief');
  assert.ok(arm.includes('File NO ticket'), 'and forbids filing before the answers land');
  assert.ok(body.includes('Every arm:'), 'the closing paragraph covers three arms, not two');
  assert.ok(!body.includes('Either arm'), 'and the two-arm wording is gone');
});

test('t795: the prompt tells the lead its team\'s prompts are its own to edit', () => {
  const text = read();
  const heading = text.match(/^## Your team's prompts are yours$/gm) || [];
  assert.strictEqual(heading.length, 1);
  assert.ok(text.indexOf('## Team lifecycle') < text.indexOf("## Your team's prompts are yours"),
    'it follows Team lifecycle');
  assert.ok(text.indexOf("## Your team's prompts are yours") < text.indexOf(HEADING),
    'and precedes the first-turn section that leans on it');
});

test('Team lifecycle still occurs once and precedes the new section', () => {
  const text = read();
  const lifecycle = text.match(/^## Team lifecycle$/gm) || [];
  assert.strictEqual(lifecycle.length, 1);
  assert.ok(text.indexOf('## Team lifecycle') < text.indexOf(HEADING));
});
