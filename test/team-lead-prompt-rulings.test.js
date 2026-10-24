'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LEAD = path.join(__dirname, '..', 'resources', 'library', 'prompts', 'system', 'clodex-team-lead.md');

function read() {
  return fs.readFileSync(LEAD, 'utf-8').replace(/\s+/g, ' ');
}

const PINS = [
  ['G3 REWORK verdict auto-rejects', 'A REWORK verdict rejects the ticket itself'],
  ['C12 only worktree hands commit', 'A worktree hand commits'],
  ['G6 append reach is per template', 'whose template lists the append'],
  ['C7 shout list defers to the harness', 'blocked permission dialog is one such case'],
];

for (const [name, needle] of PINS) {
  test(`lead prompt ruling ${name}`, () => {
    assert.ok(read().includes(needle), `missing: ${needle}`);
  });
}

test('lead prompt no longer says every hand commits', () => {
  assert.ok(!read().includes('The hand commits to its own branch'));
});

const LEAD_PROMPTS = [
  LEAD,
  path.join(__dirname, '..', 'resources', 'library', 'kits', 'clodex', 'prompts', 'system', 'clodex-team-lead.md'),
  path.join(__dirname, '..', 'resources', 'library', 'kits', 'default', 'prompts', 'system', 'lead.md'),
];

for (const file of LEAD_PROMPTS) {
  test(`lead prompt ${path.relative(path.join(__dirname, '..'), file)} defers the per-ticket reminder to the loop's ticket watch`, () => {
    const text = fs.readFileSync(file, 'utf-8').replace(/\s+/g, ' ');
    assert.ok(text.includes('ticket watch'), 'missing: ticket watch');
    assert.ok(!text.includes('set a self-reminder'), 'still tells the lead to set a self-reminder');
  });
}
