'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'resources', 'library', 'prompts', 'system');

for (const name of ['clodex-team-reviewer.md', 'clodex-team-reviewer-shell.md']) {
  test(`${name}: asks for every actionable finding, without suppression or MUST emphasis`, () => {
    const text = fs.readFileSync(path.join(DIR, name), 'utf-8');
    assert.ok(text.trim().length > 0, `ENTER: ${name} was read and is non-empty`);
    assert.ok(text.includes('Report every finding you would act on'), `${name} asks for every actionable finding`);
    assert.ok(!text.includes('nitpicks'), `${name} no longer tells the reviewer to skip nitpicks`);
    assert.ok(!text.includes('You MUST end'), `${name} drops the MUST emphasis on the verdict`);
  });
}
