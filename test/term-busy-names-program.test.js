'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');

let engine = null;
let stub = null;

function refusal(execResult) {
  if (!engine) {
    const dp = require('../drawer-pty');
    const orig = dp.createDrawerPtys;
    stub = { exec: () => stub.answer, dispose() {} };
    dp.createDrawerPtys = () => stub;
    const tmp = mkTmpRoot('clx-term-busy-');
    try {
      engine = require('../engine').createEngine({
        userDataPath: tmp,
        seams: { registryDir: path.join(tmp, 'clodex-home') },
        log: { info() {}, warn() {}, error() {} },
      });
    } finally { dp.createDrawerPtys = orig; }
    engine.manager._broadcast = () => {};
  }
  stub.answer = execResult;
  const injected = [];
  engine.manager._injectText = (s, t) => injected.push(t);
  engine.manager._handleTermIntent(
    { name: 'alice', type: 'claude', agentType: 'claude', workspaceId: 'ws-1' }, 'exec', 'ls');
  assert.strictEqual(injected.length, 1,
    'ENTER: _handleTermIntent is the seam session-manager calls, and it answered the agent once');
  return injected[0];
}

test('engine names the program in a busy refusal, backticked', () => {
  const msg = refusal({ ok: false, code: 'busy', running: 'ssh bogdan@example' });
  assert.match(msg, /`ssh bogdan@example` is still running in it/,
    'the unnamed wording was printed at an operator sitting idle inside `ssh host`, who answered "not busy though"');
  assert.match(msg, /such as an ssh session/,
    'ssh is named in the prose too: it is the case an operator reads as not-busy');
  assert.match(msg, /Nothing was queued/);
});

test('engine truncates a long program name to 80 characters with an ellipsis', () => {
  const long = `ssh ${'a'.repeat(200)}`;
  const msg = refusal({ ok: false, code: 'busy', running: long });
  const m = msg.match(/`([^`]+)`/);
  assert.ok(m, 'ENTER: the message carries a backticked name');
  assert.strictEqual(m[1].length, 80, 'the agent is not handed the whole 204-byte line back');
  assert.ok(m[1].endsWith('…'), 'and the cut is marked');
  assert.ok(!msg.includes(long), 'the untruncated command does not also appear');
});

test('engine keeps the old wording when the busy refusal carries no name', () => {
  const msg = refusal({ ok: false, code: 'busy', running: '' });
  assert.match(msg, /a command is running, or a full-screen program \(an editor, a pager, a REPL\) has it/,
    'a C mark whose base64 did not decode still holds the tab, under no name');
  assert.ok(!msg.includes('`'),
    'and nothing is backticked: an empty backtick pair reads as our bug, not as "we do not know which"');
});

after(() => {
  try { engine.shutdown(); } catch {}
  setImmediate(() => process.exit(0));
});
