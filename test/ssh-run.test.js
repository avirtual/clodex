'use strict';

// ssh-run: one-shot remote command runner for the peer-deploy wizard. spawn is
// faked — no real ssh runs. Covers arg construction, stdin script feed, line
// streaming, and the success / nonzero / stderr / timeout / spawn-error outcomes.

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { sshRun } = require('../ssh-run');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdinData = [];
  child._stdin = stdinData;
  child.stdin = { write: (d) => stdinData.push(d), end: () => { child.stdin.ended = true; }, ended: false };
  child.killed = false;
  child.kill = (sig) => { child.killed = true; child.killSig = sig; };
  return child;
}

test('sshRun spawns ssh with batchmode/connect-timeout, host + bash -s, and feeds the script on stdin', async () => {
  let captured;
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => { captured = { cmd, args, opts }; return child; };
  const p = sshRun('user@box', 'echo hi\n', { spawnFn });
  assert.equal(captured.cmd, 'ssh');
  assert.ok(captured.args.includes('BatchMode=yes'), 'BatchMode=yes present');
  assert.ok(captured.args.includes('ConnectTimeout=10'), 'ConnectTimeout present');
  assert.equal(captured.args[captured.args.length - 2], 'user@box', 'host is penultimate arg');
  assert.equal(captured.args[captured.args.length - 1], 'bash -s', 'bash -s is last arg');
  assert.equal(child._stdin.join(''), 'echo hi\n', 'script fed to stdin');
  assert.equal(child.stdin.ended, true, 'stdin closed');
  child.stdout.emit('data', Buffer.from('out\n'));
  child.emit('exit', 0, null);
  const res = await p;
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'out\n');
  assert.equal(res.timedOut, false);
});

test('sshRun streams complete stdout lines to onLine, flushing a trailing partial on exit', async () => {
  const child = fakeChild();
  const lines = [];
  const p = sshRun('h', 's', { spawnFn: () => child, onLine: (l) => lines.push(l) });
  child.stdout.emit('data', Buffer.from('::step a\n::ok a\npar'));
  child.stdout.emit('data', Buffer.from('tial'));   // no newline
  child.emit('exit', 0);
  await p;
  assert.deepStrictEqual(lines, ['::step a', '::ok a', 'partial']);
});

test('sshRun resolves a nonzero exit with captured stderr', async () => {
  const child = fakeChild();
  const p = sshRun('h', 's', { spawnFn: () => child });
  child.stderr.emit('data', Buffer.from('boom'));
  child.emit('exit', 1);
  const res = await p;
  assert.equal(res.code, 1);
  assert.equal(res.stderr, 'boom');
  assert.equal(res.timedOut, false);
});

test('sshRun kills the child and flags timedOut past timeoutMs', async () => {
  const child = fakeChild();
  // A real SIGKILLed process emits exit; model that so the promise settles.
  child.kill = (sig) => { child.killed = true; child.emit('exit', null, sig); };
  const res = await sshRun('h', 's', { spawnFn: () => child, timeoutMs: 15 });
  assert.equal(res.timedOut, true);
  assert.equal(res.code, null);
  assert.equal(child.killed, true);
});

test('sshRun rejects when ssh cannot be spawned', async () => {
  const child = fakeChild();
  const p = sshRun('h', 's', { spawnFn: () => child });
  child.emit('error', new Error('spawn ssh ENOENT'));
  await assert.rejects(p, /ENOENT/);
});
