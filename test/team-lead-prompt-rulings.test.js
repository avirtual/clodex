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
  ['G9 ticket-bound dispatch reminder', 'remind for <ticketId>'],
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
