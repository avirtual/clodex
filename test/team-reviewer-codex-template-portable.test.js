'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ADAPTERS } = require('../cli-adapters');

const TPL_DIR = path.join(__dirname, '..', 'resources', 'library', 'templates');
const read = (stem) => JSON.parse(fs.readFileSync(path.join(TPL_DIR, `${stem}.json`), 'utf-8'));

const PLATFORM_OWNED = ['agents', 'disabledTools', 'tools', 'disabledSkills', 'denyBuiltins', 'stripLevel', 'noWire', 'injectSkills'];

const stem = 'clodex-team-reviewer-codex';
const twin = 'clodex-team-reviewer';
const tpl = read(stem);
const claude = read(twin);

test(`${stem}: type codex, name matches its stem, and its platform declares a read-only cap`, () => {
  assert.strictEqual(tpl.type, 'codex');
  assert.strictEqual(tpl.name, stem);
  assert.ok(ADAPTERS[tpl.type].readOnlyCap, 'a platform without a cap cannot seat a reviewer');
});

test(`${stem}: carries none of the Claude-owned keys, no extraArgs, no model`, () => {
  const present = PLATFORM_OWNED.filter((k) => Object.prototype.hasOwnProperty.call(tpl, k));
  assert.deepStrictEqual(present, []);
  assert.ok(!Object.prototype.hasOwnProperty.call(tpl, 'extraArgs'));
});

test(`${stem}: env carries no CLAUDE_* key, and the Claude twin's other keys survive`, () => {
  const keys = Object.keys(tpl.env || {});
  assert.deepStrictEqual(keys.filter((k) => k.startsWith('CLAUDE_')), []);
  assert.deepStrictEqual(keys, Object.keys(claude.env || {}).filter((k) => !k.startsWith('CLAUDE_')));
  assert.strictEqual(tpl.env.CLODEX_DISABLE_IPC_PROMPT, '1');
});

test(`${stem}: same intents and prompt stem as ${twin}`, () => {
  assert.deepStrictEqual(tpl.intents, []);
  assert.deepStrictEqual(tpl.intents, claude.intents);
  assert.strictEqual(tpl.systemPromptFile, claude.systemPromptFile);
});

test('no Codex twin of the shell reviewer ships: the shell split has no Codex meaning', () => {
  assert.ok(!fs.existsSync(path.join(TPL_DIR, 'clodex-team-reviewer-shell-codex.json')));
});
