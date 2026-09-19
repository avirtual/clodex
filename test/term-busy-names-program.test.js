'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { mkTmpRoot } = require('./lib/tmp-roots');

let engine = null;
let stub = null;
let deps = null;

function boot() {
  if (engine) return engine;
  const dp = require('../drawer-pty');
  const orig = dp.createDrawerPtys;
  stub = { exec: () => stub.answer, dispose() {} };
  dp.createDrawerPtys = (d) => { deps = d; return stub; };
  const tmp = mkTmpRoot('clx-term-busy-');
  try {
    engine = require('../engine').createEngine({
      userDataPath: tmp,
      seams: { registryDir: path.join(tmp, 'clodex-home') },
      log: { info() {}, warn() {}, error() {} },
    });
  } finally { dp.createDrawerPtys = orig; }
  engine.manager._broadcast = () => {};
  return engine;
}

function reports(value) {
  boot().stores.uiSettings.set({ terminalReports: value });
  assert.strictEqual(engine.stores.uiSettings.get().terminalReports, value,
    `ENTER: the reporting pref really reads \`${value}\``);
}

function refusal(execResult) {
  boot();
  stub.answer = execResult;
  const injected = [];
  engine.manager._injectText = (s, t) => injected.push(t);
  engine.manager._handleTermIntent(
    { name: 'alice', type: 'claude', agentType: 'claude', workspaceId: 'ws-1' }, 'exec', 'ls');
  assert.strictEqual(injected.length, 1,
    'ENTER: _handleTermIntent is the seam session-manager calls, and it answered the agent once');
  return injected[0];
}

function result(res) {
  boot();
  const delivered = [];
  engine.manager._gatedDeliver = (seat, tag, text) => { delivered.push(text); return { queued: true }; };
  assert.strictEqual(typeof deps.onExecResult, 'function',
    'ENTER: engine wired an onExecResult into createDrawerPtys');
  deps.onExecResult('alice', res);
  assert.strictEqual(delivered.length, 1, 'ENTER: exactly one delivery for one ending');
  return delivered[0];
}

test('engine names the program in a busy refusal, backticked', () => {
  reports('all');
  const msg = refusal({ ok: false, code: 'busy', running: 'ssh bogdan@example' });
  assert.match(msg, /`ssh bogdan@example` is still running in it/,
    'the unnamed wording was printed at an operator sitting idle inside `ssh host`, who answered "not busy though"');
  assert.match(msg, /such as an ssh session/,
    'ssh is named in the prose too: it is the case an operator reads as not-busy');
  assert.match(msg, /Nothing was queued/);
});

test('engine truncates a long program name to 80 characters with an ellipsis', () => {
  reports('all');
  const long = `ssh ${'a'.repeat(200)}`;
  const msg = refusal({ ok: false, code: 'busy', running: long });
  const m = msg.match(/`([^`]+)`/);
  assert.ok(m, 'ENTER: the message carries a backticked name');
  assert.strictEqual(m[1].length, 80, 'the agent is not handed the whole 204-byte line back');
  assert.ok(m[1].endsWith('…'), 'and the cut is marked');
  assert.ok(!msg.includes(long), 'the untruncated command does not also appear');
});

test('under `asked` the refusal names the program WORD, never the operator’s line', () => {
  reports('asked');
  const msg = refusal({ ok: false, code: 'busy', running: 'mysql -u root -pS3cret' });
  assert.match(msg, /`mysql` is still running/,
    'the agent still learns which program holds the tab — "a command" is what t1001 found useless');
  assert.ok(!msg.includes('S3cret'),
    'an operator who declined to disclose their commands has not disclosed this one either');
  assert.ok(!msg.includes('-u root'));
});

test('a line the tokeniser cannot read falls back to the unnamed wording under `asked`', () => {
  reports('asked');
  const msg = refusal({ ok: false, code: 'busy', running: 'ssh a && rm -rf /' });
  assert.match(msg, /a command is running, or a full-screen program/,
    'a compound line has no single program word, and guessing one would name the wrong half');
  assert.ok(!msg.includes('rm -rf'));
});

test('engine keeps the old wording when the busy refusal carries no name', () => {
  reports('all');
  const msg = refusal({ ok: false, code: 'busy', running: '' });
  assert.match(msg, /a command is running, or a full-screen program \(an editor, a pager, a REPL\) has it/,
    'a C mark whose base64 did not decode still holds the terminal, under no name');
  assert.ok(!msg.includes('`'),
    'and nothing is backticked: an empty backtick pair reads as our bug, not as "we do not know which"');
});

test('the Settings sentence rides ONLY a refusal flagged remoteOffer', () => {
  reports('all');
  const offered = refusal({ ok: false, code: 'busy', running: 'ssh host', remoteOffer: true });
  assert.match(offered, /switches on remote terminal commands in Settings ▸ Terminal/,
    'the agent is told what to ask for, which is the only thing that can unblock it');

  const plain = refusal({ ok: false, code: 'busy', running: 'vim notes.txt' });
  assert.ok(!plain.includes('Settings ▸ Terminal'),
    'an unrecognised program is not a pref away from working, and saying so would send the operator to flip a switch that changes nothing');
});

test('an inner-busy refusal names the far command AND the session holding the tab', () => {
  reports('all');
  const msg = refusal({ ok: false, code: 'busy', running: 'tail -f log', inside: 'ssh host' });
  assert.match(msg, /`tail -f log` is still running inside `ssh host`/,
    'both halves: which command, and where — "busy" alone cannot be acted on from one hop away');
});

test('the full-screen refusal says nothing was typed', () => {
  reports('all');
  const msg = refusal({ ok: false, code: 'full-screen', running: 'ssh host' });
  assert.match(msg, /a full-screen program has the remote session; nothing was typed/);
  assert.match(msg, /`ssh host`/, 'and names the session, so the agent knows which tab to wait on');
});

test('a remote-unsupported refusal is rendered verbatim, not re-authored', () => {
  reports('all');
  const reason = 'the remote shell is neither bash 4.4+ nor zsh (a POSIX sh, busybox, or ksh), so it cannot report results back. Nothing was run there.';
  const msg = refusal({ ok: false, code: 'remote-unsupported', reason });
  assert.strictEqual(msg, `[agent:term] ${reason}`,
    'the reason is a whole sentence ending "Nothing was run there." — a wrapper would contradict it in the same breath');
});

test('every result branch carries the session when there is one', () => {
  reports('all');
  for (const res of [
    { status: 'abandoned', command: 'ls', inside: 'ssh host' },
    { status: 'timeout', command: 'ls', afterMs: 120000, inside: 'ssh host' },
    { status: 'lost', command: 'ls', inside: 'ssh host' },
    { status: 'shell-exit', command: 'ls', exitCode: 1, inside: 'ssh host' },
    { status: 'shell-gone', command: 'ls', reason: 'the session ended', inside: 'ssh host' },
  ]) {
    assert.match(result(res), /\nran inside `ssh host`\n/,
      `${res.status} must say where it ran — "abandoned" alone reads as the local shell`);
  }
});

test('the two branches that DENY anything ran name the session in the future tense', () => {
  reports('all');
  for (const res of [
    { status: 'write-failed', command: 'ls', reason: 'EPIPE', inside: 'ssh host' },
    { status: 'remote-unsupported', command: 'ls', inside: 'ssh host', reason: 'the remote shell is neither bash 4.4+ nor zsh (a POSIX sh, busybox, or ksh), so it cannot report results back. Nothing was run there.' },
  ]) {
    const msg = result(res);
    assert.match(msg, /\nit was meant for `ssh host`\n/,
      `${res.status} asserts in its next sentence that nothing ran — "ran inside" would contradict it one line up`);
    assert.ok(!msg.includes('ran inside'),
      `${res.status} must not say the command ran anywhere`);
  }
});

test('an outer session that died without a readable status says so rather than printing null', () => {
  reports('all');
  const msg = result({ status: 'session-ended', command: 'uptime', inside: 'ssh host', outerExit: null });
  assert.match(msg, /the session ended \(ssh exited, status unknown\)/,
    'an unparseable local D leaves outerExit null, and "exited null" reads as our bug');
  assert.ok(!msg.includes('null'));
});

test('engine wires the four remote deps into drawer-pty, not just the callbacks', () => {
  boot();
  for (const k of ['remoteAllowed', 'shellHost', 'remoteInstallLine', 'remoteUnsupportedReason']) {
    assert.ok(k in deps, `createDrawerPtys was handed \`${k}\` — drawer-pty requires nothing, so an unwired dep is a silently dead remote path`);
  }
  assert.strictEqual(typeof deps.shellHost, 'function');
  assert.strictEqual(typeof deps.remoteUnsupportedReason, 'function');
  assert.ok(String(deps.remoteInstallLine).length > 0);
});

test('a program word carrying control bytes is sanitised on the `asked` path too', () => {
  reports('asked');
  const msg = refusal({ ok: false, code: 'busy', running: `my${String.fromCharCode(0x1b)}[31msql` });
  assert.ok(!msg.includes(String.fromCharCode(0x1b)),
    'programOf keeps whatever argv[0] held, and under `asked` it is the ONLY name path — an ESC would reach the agent unfiltered');
  assert.match(msg, /`my\[31msql` is still running/);
});

test('an ok result renders the session through formatCommand’s own line', () => {
  reports('all');
  const msg = result({
    status: 'ok', command: 'ls', inside: 'ssh host',
    record: { command: 'ls', exitCode: 0, output: 'a.txt\n' },
  });
  assert.match(msg, /^\[terminal\] ls\nran inside `ssh host`\nexit 0\n/);
});

test('a session-ended result carries the OUTER exit code, the only status there is', () => {
  reports('all');
  const msg = result({ status: 'session-ended', command: 'uptime', inside: 'ssh host', outerExit: 0 });
  assert.match(msg, /ran inside `ssh host` — the session ended \(ssh exited 0\)/,
    'the far shell died with the session, so the command it carried never reported one of its own');
  assert.match(msg, /there is no exit code for it/);
  assert.match(msg, /back at its local shell/);
  assert.ok(!msg.includes('Whether it ran is unknown'),
    'the catch-all’s hedge would contradict a message that names exactly what happened');
});

test('a remote-unsupported result does not also claim the terminal went away', () => {
  reports('all');
  const msg = result({
    status: 'remote-unsupported', command: 'ls', inside: 'ssh host',
    reason: 'the remote bash is older than 4.4 (no PS0), so it cannot report results back. Nothing was run there.',
  });
  assert.ok(msg.endsWith('Nothing was run there.'),
    'the reason is the whole message; the catch-all would append "before the command reported back"');
});

test('a status this file has never heard of names ITSELF rather than blaming the terminal', () => {
  reports('all');
  const msg = result({ status: 'teleported', command: 'ls' });
  assert.match(msg, /the terminal reported `teleported`/,
    'a wrong cause stated confidently is what sends an agent looking in the wrong place');
  assert.ok(!msg.includes('the terminal went away'));
});

after(() => {
  try { engine.shutdown(); } catch {}
  setImmediate(() => process.exit(0));
});
