'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { subqHookOutput } = require('../subq');
const pendingStore = require('../pending-store');

const ID = 'a606bb8c5bfa9764e';

function seat() {
  const root = mkTmpRoot('subq-receipts-');
  const dir = path.join(root, 'subq');
  fs.mkdirSync(path.join(dir, 'names'), { recursive: true });
  fs.mkdirSync(path.join(dir, ID));
  fs.writeFileSync(path.join(dir, `${ID}.nonce`), '0123456789abcdef');
  return { dir, pendingRoot: path.join(root, 'pending') };
}

function receipts(dir) {
  return fs.readFileSync(path.join(dir, 'receipts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('retire: a park that throws leaves a park-failed receipt and returns the note to its queue', () => {
  const { dir, pendingRoot } = seat();
  fs.writeFileSync(path.join(dir, ID, '000000001'), 'late note\n');
  const real = pendingStore.parkDelivery;
  pendingStore.parkDelivery = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  try {
    assert.strictEqual(subqHookOutput(JSON.stringify({ agent_id: ID, hook_event_name: 'SubagentStop' }), { dir, pendingRoot, seat: 'agent1', now: 7, pid: 42 }), '');
  } finally { pendingStore.parkDelivery = real; }
  assert.deepStrictEqual(receipts(dir), [{ ts: 7, id: ID, ev: 'park-failed', error: 'EACCES: permission denied' }]);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, ID)), ['000000001']);
  assert.strictEqual(fs.readFileSync(path.join(dir, ID, '000000001'), 'utf8'), 'late note\n');
  assert.strictEqual(fs.existsSync(path.join(dir, `${ID}.draining.42`)), false);
});

test('claim: a note that cannot be read leaves a read-failed receipt', { skip: process.getuid && process.getuid() === 0 ? 'root reads mode 000' : false }, () => {
  const { dir, pendingRoot } = seat();
  fs.writeFileSync(path.join(dir, ID, '000000001'), 'readable\n');
  fs.writeFileSync(path.join(dir, ID, '000000002'), 'locked\n');
  fs.chmodSync(path.join(dir, ID, '000000002'), 0o000);
  const out = subqHookOutput(JSON.stringify({ agent_id: ID, hook_event_name: 'PostToolUse', tool_name: 'Bash' }), { dir, pendingRoot, seat: 'agent1', now: 9, pid: 43 });
  assert.strictEqual(JSON.parse(out).hookSpecificOutput.additionalContext, '[parent 0123456789abcdef] readable');
  assert.deepStrictEqual(receipts(dir).map(({ id, ev, name }) => ({ id, ev, name })), [
    { id: ID, ev: 'read-failed', name: '000000002' },
    { id: ID, ev: 'delivered', name: undefined },
  ]);
});
