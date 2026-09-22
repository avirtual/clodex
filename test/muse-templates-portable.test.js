'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TPL_DIR = path.join(__dirname, '..', 'resources', 'library', 'templates');
const read = (stem) => JSON.parse(fs.readFileSync(path.join(TPL_DIR, `${stem}.json`), 'utf-8'));

const PLATFORM_OWNED = ['agents', 'disabledTools', 'tools', 'disabledSkills', 'denyBuiltins', 'stripLevel', 'noWire', 'injectSkills', 'model'];

for (const role of ['hand', 'lead']) {
  const stem = `clodex-team-${role}-muse`;
  const twin = `clodex-team-${role}-codex`;
  const tpl = read(stem);
  const codex = read(twin);

  test(`${stem}: type muse, name matches its stem, and is the codex twin with only name and type changed`, () => {
    assert.strictEqual(tpl.type, 'muse');
    assert.strictEqual(tpl.name, stem);
    assert.deepStrictEqual({ ...tpl, name: codex.name, type: codex.type }, codex);
  });

  test(`${stem}: carries none of the Claude-owned keys, no model, empty extraArgs and env`, () => {
    const present = PLATFORM_OWNED.filter((k) => Object.prototype.hasOwnProperty.call(tpl, k));
    assert.deepStrictEqual(present, []);
    assert.deepStrictEqual(tpl.extraArgs, []);
    assert.deepStrictEqual(tpl.env, {});
  });
}
