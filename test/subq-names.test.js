'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { nameOfSubagent, subqHookOutput } = require('../subq');
const { subagentLabel } = require('../intent-socket');

const ID = 'ageneral-purpose-0123456789abcdef';

function seat() {
  const dir = path.join(mkTmpRoot('subq-names-'), 'subq');
  fs.mkdirSync(path.join(dir, 'names'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${ID}.nonce`), 'fedcba9876543210');
  return dir;
}

test('nameOfSubagent: a valid name pointing at a live id is its name', () => {
  const dir = seat();
  fs.writeFileSync(path.join(dir, 'names', 'alice'), ID);
  assert.strictEqual(nameOfSubagent(dir, ID), 'alice');
  assert.match(subagentLabel('h1', ID, nameOfSubagent(dir, ID)), /^[^@[\n]+$/);
});

test('nameOfSubagent: planted names outside the name alphabet never produce a label', () => {
  const dir = seat();
  for (const bad of ['bad@x', 'bad[agent:', 'bad\nline']) fs.writeFileSync(path.join(dir, 'names', bad), ID);
  assert.strictEqual(nameOfSubagent(dir, ID), null);
  const label = subagentLabel('h1', ID, nameOfSubagent(dir, ID));
  assert.strictEqual(label, 'h1/agent-89abcdef');
  assert.match(label, /^[^@[\n]+$/);
});

test('nameOfSubagent: no nonce, a retired id, or another id answers null', () => {
  const dir = seat();
  fs.writeFileSync(path.join(dir, 'names', 'alice'), ID);
  assert.strictEqual(nameOfSubagent(dir, 'aother-0123456789abcdef'), null);
  subqHookOutput(JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: ID }), { dir, pendingRoot: mkTmpRoot('subq-names-p-'), seat: 'h1' });
  assert.strictEqual(fs.existsSync(path.join(dir, 'names', 'alice')), false);
  assert.strictEqual(nameOfSubagent(dir, ID), null);
  fs.writeFileSync(path.join(dir, 'names', 'alice'), ID);
  assert.strictEqual(nameOfSubagent(dir, ID), null, 'a name with no live nonce');
});

test('subagentLabel: a name, else the last 8 of the hex tail, else the first 8 — never the shared tag', () => {
  assert.strictEqual(subagentLabel('h1', ID, 'alice'), 'h1/alice');
  assert.strictEqual(subagentLabel('h1', ID, null), 'h1/agent-89abcdef');
  assert.strictEqual(subagentLabel('h1', 'a606bb8c5bfa9764e', null), 'h1/agent-a606bb8c');
  for (const id of [ID, 'x', '']) assert.notStrictEqual(subagentLabel('h1', id, null), 'h1/agent');
});
