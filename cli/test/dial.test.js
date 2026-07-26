'use strict';
// dial.test.js — the shared dial (t42/L1).
//
// This module exists because three copies of one spawn-and-kill had DRIFTED
// apart without anyone noticing. So the tests that matter here are not "does it
// spawn" — they are the ones that pin each drift AS A PARAMETER, because the
// refactor's whole claim is that the differences between the three callers are
// parameter values and nothing else. If a parameter silently stopped mattering,
// two callers would quietly converge on a third one's behaviour, which is the
// exact bug class the module was written to end.
//
// Each test names the WINDOW it enters, separately from any revert proof: a
// parameter test that never exercises both sides of its parameter is green
// while asserting nothing.

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const {
  spawnDial, killDial, classifySpawnError, sshTunnelArgv, STDERR_TAIL_BYTES,
} = require('../src/dial');

// A fake child: an EventEmitter with a stderr stream and a recordable kill.
// pid defaults to null so nothing here can signal a real process group — the
// group-kill tests swap process.kill for a recorder anyway, but a fake with a
// plausible pid and a live process.kill is how a test suite kills its own
// runner, so the default stays harmless.
function fakeChild({ pid = null } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stderr = new EventEmitter();
  child.killed = [];
  child.kill = (sig) => { child.killed.push(sig || 'default'); };
  return child;
}

function recorder(child) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return child; };
  return { calls, spawnFn };
}

// ── the `detached` parameter (drift D1) ──────────────────────────────────────
//
// WINDOW: both sides of the parameter, in one test. The GUI supervisors pass
// false for ssh and true for cloud kinds; openTransport passes true always. The
// assertion is on the KEY'S PRESENCE, not its truthiness, because that is what
// peer-tunnel.test.js:173 and web-tunnel.test.js:280 already pin at their own
// layer — `detached: false` would satisfy a falsy check and break both.
test('detached is a parameter: absent when false, present when true', () => {
  const off = recorder(fakeChild());
  spawnDial(['ssh', '-N', 'host'], { spawnFn: off.spawnFn, detached: false });
  assert.ok(!('detached' in off.calls[0].opts),
    'detached:false omits the key entirely — the supervisors assert absence, not falsiness');

  const on = recorder(fakeChild());
  spawnDial(['aws', 'ssm'], { spawnFn: on.spawnFn, detached: true });
  assert.strictEqual(on.calls[0].opts.detached, true, 'detached:true sets the key');
});

// WINDOW: the stdio shape all three callers shared verbatim. Cheap, but it is
// the one thing no caller passes and therefore the one thing a future edit could
// change for all three at once without any caller's test noticing.
test('stdio is the shared shape: stderr piped, stdin and stdout ignored', () => {
  const r = recorder(fakeChild());
  spawnDial(['ssh', 'host'], { spawnFn: r.spawnFn });
  assert.deepStrictEqual(r.calls[0].opts.stdio, ['ignore', 'ignore', 'pipe']);
});

// WINDOW: argv splitting — the command word leaves the array and becomes the
// spawn's first argument. A dial handed a one-element argv (no args at all) is
// the edge that an off-by-one in the split would break.
test('argv splits into cmd + rest, and a bare command survives it', () => {
  const r = recorder(fakeChild());
  const d = spawnDial(['kubectl', 'port-forward', 'svc/x', '9-:7900'], { spawnFn: r.spawnFn });
  assert.strictEqual(r.calls[0].cmd, 'kubectl');
  assert.deepStrictEqual(r.calls[0].args, ['port-forward', 'svc/x', '9-:7900']);
  assert.strictEqual(d.cmd, 'kubectl', 'the handle reports the command it ran');

  const bare = recorder(fakeChild());
  spawnDial(['ssh'], { spawnFn: bare.spawnFn });
  assert.deepStrictEqual(bare.calls[0].args, [], 'a command with no args spawns with an empty argv tail');
});

// ── the `stderrLimit` parameter (drift D2) ───────────────────────────────────
//
// WINDOW: both sides again, and specifically the boundary. The GUI keeps a
// 500-byte TAIL (so the newest bytes survive and the oldest are dropped);
// openTransport passes 0 and keeps everything. A test that only fed a few bytes
// would pass under either policy — so this feeds well past the bound and asserts
// on WHICH end was kept.
test('stderrLimit is a parameter: a bound keeps the TAIL, zero keeps everything', () => {
  const bounded = fakeChild();
  const b = spawnDial(['ssh'], { spawnFn: recorder(bounded).spawnFn, stderrLimit: STDERR_TAIL_BYTES });
  bounded.stderr.emit('data', Buffer.from('A'.repeat(400)));
  bounded.stderr.emit('data', Buffer.from('B'.repeat(400)));
  const kept = b.stderr();
  assert.strictEqual(kept.length, STDERR_TAIL_BYTES, 'capped at the bound');
  assert.ok(kept.endsWith('B'), 'the NEWEST bytes are the ones kept');
  assert.ok(!kept.includes('A'.repeat(200)), 'and the oldest are dropped');

  const open = fakeChild();
  const u = spawnDial(['aws'], { spawnFn: recorder(open).spawnFn, stderrLimit: 0 });
  open.stderr.emit('data', Buffer.from('A'.repeat(400)));
  open.stderr.emit('data', Buffer.from('B'.repeat(400)));
  assert.strictEqual(u.stderr().length, 800, 'zero means unbounded — nothing is trimmed');
});

// WINDOW: a child with NO stderr stream at all. Every caller guards with
// `if (child.stderr)`, which means some spawn shape somewhere produces a child
// without one; the dial must not throw on it.
test('a child with no stderr stream is survivable', () => {
  const child = fakeChild();
  child.stderr = null;
  const d = spawnDial(['ssh'], { spawnFn: recorder(child).spawnFn });
  assert.strictEqual(d.stderr(), '', 'no stream, no bytes, no throw');
});

// WINDOW: appendStderr under a bound. openTransport folds its diagnosis INTO the
// stderr buffer (unbounded, so the sentence always survives); the same call
// under the GUI's 500-byte tail must still respect the bound rather than growing
// past it. Only openTransport uses this today — the test pins the contract for
// the caller that does not.
test('appendStderr respects the same bound as the stream', () => {
  const child = fakeChild();
  const d = spawnDial(['aws'], { spawnFn: recorder(child).spawnFn, stderrLimit: 50 });
  child.stderr.emit('data', Buffer.from('X'.repeat(50)));
  d.appendStderr('\naws: command not found');
  const s = d.stderr();
  assert.strictEqual(s.length, 50, 'the append is trimmed to the bound like any other bytes');
  assert.ok(s.endsWith('aws: command not found'), 'and the appended sentence is what survives');
});

// ── the ENOENT diagnosis ─────────────────────────────────────────────────────
//
// WINDOW: both branches of the classification, plus the shape each caller
// renders from. The GUI shows `diagnosis || message`; the CLI appends the same
// thing to stderr. One classifier, two renderings — so a wrong `reason` or a
// null diagnosis on a real ENOENT changes what BOTH surfaces say.
test('classifySpawnError names the missing binary, by code and by message', () => {
  const byCode = classifySpawnError(Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' }), 'aws');
  assert.strictEqual(byCode.reason, 'not-found');
  assert.strictEqual(byCode.diagnosis, 'aws: command not found — is aws installed and on PATH?');

  // No `code`, ENOENT only in the text — the message-regex arm all three copies
  // carried. A classifier that only checked `code` would return the wrong reason
  // here and the GUI would render a bare 'spawn kubectl ENOENT'.
  const byMessage = classifySpawnError(new Error('spawn kubectl ENOENT'), 'kubectl');
  assert.strictEqual(byMessage.reason, 'not-found');
  assert.strictEqual(byMessage.diagnosis, 'kubectl: command not found — is kubectl installed and on PATH?');

  const other = classifySpawnError(new Error('EACCES: permission denied'), 'gcloud');
  assert.strictEqual(other.reason, 'spawn-failed');
  assert.strictEqual(other.diagnosis, null, 'nothing to add, so nothing is invented');
  assert.strictEqual(other.message, 'EACCES: permission denied', 'the raw message is passed through unaltered');
});

// WINDOW: the handle's failure() carrying the stderr collected SO FAR. A spawn
// error and prior child output can both be present, and the structured failure
// is the only place a caller can see both together.
test('failure() carries the accumulated stderr alongside the diagnosis', () => {
  const child = fakeChild();
  const d = spawnDial(['aws', 'ssm'], { spawnFn: recorder(child).spawnFn });
  child.stderr.emit('data', Buffer.from('partial output\n'));
  const f = d.failure(Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' }));
  assert.strictEqual(f.stderr, 'partial output\n');
  assert.strictEqual(f.diagnosis, 'aws: command not found — is aws installed and on PATH?');
});

// ── the kill matrix (drift D3) ───────────────────────────────────────────────
//
// WINDOW: every cell of {group, fallbackKill} x {usable pid, no pid}. This is
// the drift that motivated the whole ticket — the GUI supervisors fall back to a
// plain child.kill() where openTransport signals NOTHING — so each cell is
// asserted rather than inferred. process.kill is swapped for a recorder: a real
// kill(-pid) with a fake pid would signal this test runner's own process group.
test('killDial: the full group/fallback matrix, including the cell that signals nothing', () => {
  const orig = process.kill;
  const signalled = [];
  process.kill = (pid, sig) => { signalled.push([pid, sig]); };
  try {
    // group + usable pid → the whole group, negative pid.
    const a = fakeChild({ pid: 4242 });
    killDial(a, { group: true });
    assert.deepStrictEqual(signalled, [[-4242, 'SIGTERM']], 'negative pid = the whole group');
    assert.deepStrictEqual(a.killed, [], 'and the child is not separately killed');

    // group requested but NO usable pid, fallback on (the GUI) → plain kill.
    signalled.length = 0;
    const b = fakeChild({ pid: null });
    killDial(b, { group: true, fallbackKill: true });
    assert.deepStrictEqual(signalled, [], 'no group to signal');
    assert.deepStrictEqual(b.killed, ['default'], 'the GUI still kills the child directly');

    // group requested, no usable pid, fallback OFF (openTransport) → NOTHING is
    // signalled. This is drift D3 preserved, and it is the cell a reader would
    // most likely assume does not exist.
    const c = fakeChild({ pid: null });
    killDial(c, { group: true, fallbackKill: false });
    assert.deepStrictEqual(signalled, [], 'still no group');
    assert.deepStrictEqual(c.killed, [], 'and NO fallback — this child is never signalled at all');

    // not detached (ssh, in both supervisors) → plain kill, never a group.
    const d = fakeChild({ pid: 4242 });
    killDial(d, { group: false });
    assert.deepStrictEqual(signalled, [], 'a non-detached child is never group-killed even with a real pid');
    assert.deepStrictEqual(d.killed, ['default']);

    // pid 0 is the trap the `> 0` guard exists for: kill(-0) signals OUR OWN
    // process group. It must take the fallback, never the group branch.
    const e = fakeChild({ pid: 0 });
    killDial(e, { group: true });
    assert.deepStrictEqual(signalled, [], 'pid 0 never reaches kill(-0)');
    assert.deepStrictEqual(e.killed, ['default']);
  } finally { process.kill = orig; }
});

// WINDOW: the group-kill's own failure. process.kill throwing (the group is
// already gone) must fall through to a direct SIGTERM rather than escaping — all
// three copies had this inner try/catch and it is invisible in the happy path.
test('killDial falls back to a direct SIGTERM when the group kill throws', () => {
  const orig = process.kill;
  process.kill = () => { throw new Error('ESRCH'); };
  try {
    const child = fakeChild({ pid: 4242 });
    killDial(child, { group: true });
    assert.deepStrictEqual(child.killed, ['SIGTERM'], 'the child is signalled directly instead');
  } finally { process.kill = orig; }
});

// WINDOW: killDial on nothing, and on a child whose kill() throws. Both
// supervisors call this during stop()/teardown where an exception would strand
// the supervisor mid-shutdown.
test('killDial is total: a null child and a throwing kill are both survivable', () => {
  assert.doesNotThrow(() => killDial(null));
  assert.doesNotThrow(() => killDial(undefined, { group: true }));
  const child = fakeChild();
  child.kill = () => { throw new Error('already dead'); };
  assert.doesNotThrow(() => killDial(child), 'a throwing kill never escapes teardown');
});

// ── the ssh argv ─────────────────────────────────────────────────────────────
//
// WINDOW: the bytes both GUI supervisors used to define separately and now
// share. Pinned literally because these are the options that decide whether a
// forward blocks on a prompt (BatchMode), fails honestly on a taken local port
// (ExitOnForwardFailure) or notices a dead far end at all (ServerAlive*).
test('sshTunnelArgv is the supervised forward, keepalive included', () => {
  const argv = sshTunnelArgv('box.example', 7900, 51234);
  assert.deepStrictEqual(argv, [
    'ssh', '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'ConnectTimeout=10',
    '-L', '51234:127.0.0.1:7900',
    'box.example',
  ]);
});

// WINDOW: the keepalive specifically, as its own statement. The deepStrictEqual
// above would fail for any reason at all; this one fails for exactly one, and it
// is the property drift D4 found missing from cli/src/transport.js's sshArgv —
// the only ssh invocation in the repo without it. Stated here so that if the two
// are ever unified, the direction of the merge is visible in a test name.
test('the supervised forward probes a dead far end (the keepalive drift D4 names)', () => {
  const argv = sshTunnelArgv('h', 1, 2);
  assert.ok(argv.includes('ServerAliveInterval=15'), 'a silent far end is detected, not believed');
  assert.ok(argv.includes('ServerAliveCountMax=2'));
});

// WINDOW: argv assembly from DATA. The dial takes a host and two numbers and
// builds an executable argv at spawn time — nothing here is ever persisted, and
// the local/remote ends must not be transposed (a swap forwards the wrong way
// and is silent until nothing answers).
test('the -L mapping is local:127.0.0.1:remote, in that order', () => {
  const argv = sshTunnelArgv('h', 7900, 51234);
  assert.strictEqual(argv[argv.indexOf('-L') + 1], '51234:127.0.0.1:7900');
  assert.strictEqual(argv[argv.length - 1], 'h', 'the host is last, as ssh expects');
});
