'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'resources', 'library');

for (const name of [
  'prompts/system/clodex-team-reviewer.md',
  'prompts/system/clodex-team-reviewer-shell.md',
  'kits/default/prompts/system/reviewer.md',
]) {
  test(`${name}: asks for every actionable finding, without suppression or MUST emphasis`, () => {
    const text = fs.readFileSync(path.join(LIB, name), 'utf-8');
    assert.ok(text.trim().length > 0, `ENTER: ${name} was read and is non-empty`);
    assert.ok(text.includes('Report every finding you would act on'), `${name} asks for every actionable finding`);
    assert.ok(!text.includes('nitpicks'), `${name} no longer tells the reviewer to skip nitpicks`);
    assert.ok(!text.includes('You MUST end'), `${name} drops the MUST emphasis on the verdict`);
  });
}
