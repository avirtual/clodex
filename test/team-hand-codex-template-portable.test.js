'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { usesTeamRoot } = require('../team-root-expand');

const TPL_DIR = path.join(__dirname, '..', 'resources', 'library', 'templates');
const read = (stem) => JSON.parse(fs.readFileSync(path.join(TPL_DIR, `${stem}.json`), 'utf-8'));

const PLATFORM_OWNED = ['agents', 'disabledTools', 'tools', 'disabledSkills', 'denyBuiltins', 'stripLevel', 'noWire', 'injectSkills'];

for (const [stem, twin] of [['clodex-team-hand-codex', 'clodex-team-hand'], ['clodex-team-lead-codex', 'clodex-team-lead']]) {
  const tpl = read(stem);
  const claude = read(twin);

  test(`${stem}: type codex, name matches its stem, cwd is the team root token`, () => {
    assert.strictEqual(tpl.type, 'codex');
    assert.strictEqual(tpl.name, stem);
    assert.strictEqual(tpl.cwd, '${TEAM_ROOT}');
    assert.ok(usesTeamRoot(tpl.cwd));
  });

  test(`${stem}: carries none of the Claude-owned keys`, () => {
    const present = PLATFORM_OWNED.filter((k) => Object.prototype.hasOwnProperty.call(tpl, k));
    assert.deepStrictEqual(present, []);
  });

  test(`${stem}: env carries no CLAUDE_* key, and the Claude twin's CLODEX_* keys survive`, () => {
    const keys = Object.keys(tpl.env || {});
    assert.deepStrictEqual(keys.filter((k) => k.startsWith('CLAUDE_')), []);
    assert.deepStrictEqual(keys, Object.keys(claude.env || {}).filter((k) => !k.startsWith('CLAUDE_')));
  });

  test(`${stem}: same intents, exec grants and prompt stems as ${twin}; no model pinned`, () => {
    assert.deepStrictEqual(tpl.intents, claude.intents);
    assert.deepStrictEqual(tpl.execCommands, claude.execCommands);
    assert.deepStrictEqual(tpl.systemPromptFile, claude.systemPromptFile);
    assert.deepStrictEqual(tpl.appendPromptFiles, claude.appendPromptFiles);
    assert.deepStrictEqual(tpl.extraArgs, []);
    assert.deepStrictEqual(tpl.plugins, []);
  });
}
