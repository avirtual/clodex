'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { nameOfSubagent, subqHookOutput, resolveSubagent, id8Of } = require('../subq');
const { execFileSync } = require('node:child_process');
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
  subqHookOutput(JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: ID }), { dir, pendingRoot: path.join(path.dirname(dir), 'pending'), seat: 'h1' });
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

const SUBQ = path.join(__dirname, '..', 'subq.js');
const CHILD = `const s = require(process.argv[1]); const [mode, dir, id] = process.argv.slice(2);
const out = mode === 'name' ? s.nameOfSubagent(dir, id) : mode === 'resolve' ? s.resolveSubagent(dir, id)
  : s.subqHookOutput(JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: id }), { dir, pendingRoot: dir + '-pending', seat: 'h1' });
process.stdout.write(JSON.stringify(out) + '\\n');`;
const inChild = (mode, dir, arg) => execFileSync(process.execPath, ['-e', CHILD, SUBQ, mode, dir, arg], { timeout: 5000, encoding: 'utf8', env: process.env });

function withFifo() {
  const dir = seat();
  const fifo = path.join(dir, 'names', 'aaa');
  execFileSync('mkfifo', [fifo]);
  fs.writeFileSync(path.join(dir, 'names', 'alice'), ID);
  return { dir, fifo };
}

test('nameOfSubagent: a reader-less FIFO in names/ never blocks the open (real fs, child process)', () => {
  const { dir } = withFifo();
  assert.strictEqual(inChild('name', dir, ID), '"alice"\n');
});

test('nameOfSubagent: a FIFO in names/ is opened but its fd is never read; the valid name still resolves', () => {
  const { dir, fifo } = withFifo();
  const realOpen = fs.openSync;
  const realRead = fs.readFileSync;
  const opened = [];
  const fdPath = new Map();
  const readPaths = [];
  fs.openSync = (p, ...rest) => { const fd = realOpen.call(fs, p, ...rest); opened.push(String(p)); fdPath.set(fd, String(p)); return fd; };
  fs.readFileSync = (p, ...rest) => { if (typeof p === 'number') readPaths.push(fdPath.get(p)); return realRead.call(fs, p, ...rest); };
  try {
    assert.strictEqual(nameOfSubagent(dir, ID), 'alice');
  } finally { fs.openSync = realOpen; fs.readFileSync = realRead; }
  assert.ok(opened.includes(fifo), 'ENTER: the FIFO was opened');
  assert.ok(!readPaths.includes(fifo));
  assert.ok(readPaths.includes(path.join(dir, 'names', 'alice')));
});

test('resolveSubagent and retireSubagent skip a planted FIFO without blocking', () => {
  const { dir } = withFifo();
  assert.strictEqual(inChild('resolve', dir, 'aaa'), 'null\n');
  assert.strictEqual(inChild('retire', dir, ID), '""\n');
  assert.strictEqual(fs.existsSync(path.join(dir, 'names', 'alice')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'names', 'aaa')), true);
});

test('nameOfSubagent: a symlink in names/ is not followed; the real entry still names the id', () => {
  const dir = seat();
  fs.writeFileSync(path.join(dir, 'names', 'alice'), ID);
  fs.symlinkSync(path.join(dir, 'names', 'alice'), path.join(dir, 'names', 'aaa'));
  assert.strictEqual(nameOfSubagent(dir, ID), 'alice');
});

test('resolveSubagent: agent-<id8> resolves a unique live id by its tail, null when ambiguous', () => {
  const dir = seat();
  assert.strictEqual(resolveSubagent(dir, 'agent-89abcdef'), ID);
  fs.writeFileSync(path.join(dir, 'aother-ffffffff89abcdef.nonce'), 'n');
  assert.strictEqual(resolveSubagent(dir, 'agent-89abcdef'), null);
});

test('id8Of: one rule for mint and match', () => {
  for (const [id, want] of [['ageneral-purpose-0123456789abcdef', '89abcdef'], ['a606bb8c5bfa9764e', 'a606bb8c'], ['x', 'x']]) {
    assert.strictEqual(id8Of(id), want);
  }
  for (const id of ['ageneral-purpose-0123456789abcdef', 'a606bb8c5bfa9764e']) assert.strictEqual(subagentLabel('h1', id, null), `h1/agent-${id8Of(id)}`);
});

test('nameOfSubagent: a reserved agent or agent-… name is never a label; agentic is', () => {
  for (const n of ['agent', 'agent-89abcdef', 'agent-x']) {
    const dir = seat();
    fs.writeFileSync(path.join(dir, 'names', n), ID);
    assert.strictEqual(nameOfSubagent(dir, ID), null, n);
    assert.strictEqual(subagentLabel('h1', ID, nameOfSubagent(dir, ID)), 'h1/agent-89abcdef');
  }
  const dir = seat();
  fs.writeFileSync(path.join(dir, 'names', 'agentic'), ID);
  assert.strictEqual(nameOfSubagent(dir, ID), 'agentic');
});

test('resolveSubagent: a reserved names/agent-<id8> entry is ignored in favour of the id tail', () => {
  const dir = seat();
  fs.writeFileSync(path.join(dir, 'aother-ffffffffffffffff.nonce'), 'n');
  fs.writeFileSync(path.join(dir, 'names', 'agent-89abcdef'), 'aother-ffffffffffffffff');
  assert.strictEqual(resolveSubagent(dir, 'agent-89abcdef'), ID);
});
