'use strict';
// drawer-pty.test.js — the drawer's terminal tab, main side. What is
// pinned here is everything that is NOT xterm: the per-window keying, the
// lazy-and-idempotent spawn, the scrollback ring, the resize contract, and the
// lifecycle that keeps a shell from outliving its window.
//
// The one claim worth stating loudest: a workbench terminal is not a session.
// There is no assertion for "it does not appear in `sessions`" because this
// module has no access to the session map at all — that is the design, and the
// test that would prove it is the absence of a require.

const { test } = require('node:test');
const assert = require('node:assert');

const { createDrawerPtys } = require('../drawer-pty');

// A fake node-pty. Records what it was constructed with and lets a test drive
// the data/exit callbacks, which is the whole surface the real one provides.
function fakePty() {
  const spawned = [];
  const spawn = (file, args, opts) => {
    const proc = {
      file, args, opts,
      pid: 1000 + spawned.length,
      written: [], resizes: [], killed: false,
      _onData: null, _onExit: null,
      onData(fn) { proc._onData = fn; },
      onExit(fn) { proc._onExit = fn; },
      write(d) { proc.written.push(d); },
      resize(c, r) { proc.resizes.push([c, r]); },
      kill() { proc.killed = true; },
      emit(d) { proc._onData(d); },
      exit(code) { proc._onExit({ exitCode: code }); },
    };
    spawned.push(proc);
    return proc;
  };
  spawn.spawned = spawned;
  return spawn;
}

function mk(over = {}) {
  const sent = [];
  const spawn = over.spawn || fakePty();
  // What a PEER watching a seat is told about its shell ending. Collected by
  // default rather than opt-in: this is the only channel that distinguishes a
  // shell that ended from a stream that went quiet, and a test that forgot to
  // wire it would read a silent end as correct.
  const ended = [];
  const w = createDrawerPtys({
    spawn,
    // `onSend` makes send RE-ENTRANT: the ordering claims below are only
    // observable from inside a send, because that is the moment the map is
    // half-updated.
    send: (id, ch, ...args) => {
      sent.push([id, ch, ...args]);
      if (over.onSend) over.onSend(w, id, ch, ...args);
    },
    shell: '/bin/testsh',
    cwdFor: over.cwdFor || (() => '/tmp/ws'),
    scrollbackMax: over.scrollbackMax,
    setTimeout: over.setTimeout,
    killPid: over.killPid,
    shimEnv: over.shimEnv,
    onCommand: over.onCommand,
    // The real parser, injected — drawer-pty requires nothing (see the
    // not-a-session test below), so the wiring tests exercise the same one
    // engine.js wires rather than a stand-in that could drift from it.
    makeMarkParser: over.makeMarkParser || require('../term-marks').createMarkParser,
    onShellEnd: over.onShellEnd || ((seat, why) => ended.push([seat, why])),
    env: { PATH: '/usr/bin' },
    log: { info() {}, warn() {}, error() {} },
  });
  return { w, sent, spawn, ended };
}

test('spawn: a real login shell in the workspace cwd', () => {
  const { w, spawn } = mk();
  const res = w.spawn('ws-1', null, { cols: 100, rows: 30 });

  assert.strictEqual(res.ok, true, `ENTER: the spawn succeeded (${res.error})`);
  assert.strictEqual(spawn.spawned.length, 1, 'ENTER: the fake really was called');

  const p = spawn.spawned[0];
  assert.strictEqual(p.file, '/bin/testsh');
  // A login shell, deliberately: the operator's PATH and aliases are the point
  // of this tab, and the aws-cli/nvm debugging case needs them.
  assert.deepStrictEqual(p.args, ['-l']);
  // The whole options object, not a field probe: an unwired dep arrives as
  // undefined and a `cwd: undefined` silently spawns in the app's own cwd.
  assert.deepStrictEqual(p.opts, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: '/tmp/ws',
    env: { PATH: '/usr/bin', TERM: 'xterm-256color' },
  });
});

test('spawn is lazy and idempotent — one shell per window, not one per onShow', () => {
  const { w, spawn } = mk();
  assert.strictEqual(spawn.spawned.length, 0, 'nothing spawns before the tab is shown');

  const first = w.spawn('ws-1', { cols: 80, rows: 24 });
  spawn.spawned[0].emit('hello');
  const second = w.spawn('ws-1', { cols: 80, rows: 24 });

  assert.strictEqual(spawn.spawned.length, 1, 'the tenant calls spawn on every onShow — it must not stack shells');
  assert.strictEqual(first.ok && second.ok, true, 'ENTER: both calls succeeded');
  // The second call is what a re-entering tab replays, so it must carry what
  // ran while the tab was hidden.
  assert.strictEqual(second.scrollback, 'hello', 'the re-entry replay carries the hidden-tab output');

  // `fresh` is the whole reason the tenant can drop its "already spawned"
  // latch: with no latch it calls spawn on EVERY show, so this flag is what
  // tells it whether the scrollback it just received is news (a shell it has
  // never drawn) or a replay of what is already on its screen.
  assert.strictEqual(first.fresh, true, 'the first call started the shell');
  assert.strictEqual(second.fresh, false, 'the repeat call did not');
});

test('after an exit, the next spawn is FRESH — the tab is recoverable', () => {
  // MF1's main-side half. The renderer is never told the shell died (the exit
  // notice is opaque bytes on wterm:data), so its only route back is calling
  // spawn again on the next show and being handed a new shell. A latch on
  // either side makes Ctrl-D — the ordinary way anyone ends a shell — the
  // permanent end state of the tab.
  const { w, spawn } = mk();
  const first = w.spawn('ws-1', null, {});
  spawn.spawned[0].emit('some output');
  spawn.spawned[0].exit(0);

  const after = w.spawn('ws-1', null, {});
  assert.strictEqual(after.ok, true, 'ENTER: the post-exit spawn succeeded');
  assert.strictEqual(spawn.spawned.length, 2, 'a NEW shell, not the dead record');
  assert.strictEqual(after.fresh, true, 'and it is reported fresh');
  assert.strictEqual(after.scrollback, '', 'the dead shell\'s output is not replayed under the new one');
  assert.strictEqual(w.write('ws-1', null, 'usable'), true, 'and the tab is usable again');
});

test('one shell per WINDOW — two workspaces do not share', () => {
  const { w, spawn, sent } = mk();
  w.spawn('ws-1', null, {});
  w.spawn('ws-2', null, {});
  assert.strictEqual(spawn.spawned.length, 2, 'ENTER: two distinct shells');

  spawn.spawned[0].emit('from-one');
  w.write('ws-2', null, 'typed-into-two');

  // The seat rides as the 4th arg so the renderer can drop bytes for a shell it
  // is not showing; a seatless shell reports null.
  assert.deepStrictEqual(sent, [['ws-1', 'wterm:data', 'from-one', null, 1]],
    'output is delivered to the window that owns the shell, and only that one');
  assert.deepStrictEqual(spawn.spawned[0].written, [], 'ws-1 never saw ws-2 input');
  assert.deepStrictEqual(spawn.spawned[1].written, ['typed-into-two']);
});

test('the scrollback ring is capped and keeps the TAIL', () => {
  const { w, spawn } = mk({ scrollbackMax: 10 });
  w.spawn('ws-1', null, {});
  spawn.spawned[0].emit('abcdefgh');
  spawn.spawned[0].emit('IJKLMNOP');

  const res = w.spawn('ws-1', null, {});
  assert.strictEqual(res.scrollback.length, 10, 'capped');
  // The tail, not the head: a terminal's useful history is the most recent
  // output, and slicing the other end would replay a stale screen.
  assert.strictEqual(res.scrollback, 'ghIJKLMNOP');
});

test('write/resize on an unspawned window are refused, not crashes', () => {
  const { w } = mk();
  assert.strictEqual(w.write('nope', null, 'x'), false);
  assert.strictEqual(w.resize('nope', null, 80, 24), false);
});

test('resize: clamps zero dims and skips the no-op SIGWINCH', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', null, { cols: 80, rows: 24 });
  const p = spawn.spawned[0];

  assert.strictEqual(w.resize('ws-1', null, 80, 24), true, 'ENTER: the call was accepted');
  assert.deepStrictEqual(p.resizes, [], 'same dims: no SIGWINCH into whatever is running');

  w.resize('ws-1', null, 120, 40);
  assert.deepStrictEqual(p.resizes, [[120, 40]], 'a real change does resize');

  // The renderer legitimately reports 0 when it measures a pane mid-transition;
  // a 0-row PTY breaks the child's ioctl arithmetic.
  w.resize('ws-1', null, 0, 0);
  assert.deepStrictEqual(p.resizes, [[120, 40]], 'a zero dimension is ignored, not forwarded');
});

test('a spawn failure is reported, not thrown', () => {
  const spawn = () => { throw new Error('posix_spawnp failed'); };
  spawn.spawned = [];
  const { w } = mk({ spawn });
  const res = w.spawn('ws-1', null, {});
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /posix_spawnp/);
});

test('exit drops the record BEFORE announcing — observed from inside the send', () => {
  // The ordering is only checkable RE-ENTRANTLY. Asserting after the exit
  // returns passes identically for an implementation that sends first and
  // deletes after, because by then both have happened — which is exactly what
  // the previous version of this test failed to distinguish.
  const spawn = fakePty();
  let observed = null;
  const { w } = mk({
    spawn,
    onSend: (svc, _id, ch, data) => {
      if (ch !== 'wterm:data' || !/shell exited/.test(data)) return;
      // The renderer respawns on seeing the tab is dead. At THIS moment the
      // record must already be gone, or it gets the corpse handed back.
      observed = svc.spawn('ws-1', {});
    },
  });

  w.spawn('ws-1', null, {});
  spawn.spawned[0].exit(0);

  assert.ok(observed, 'ENTER: the exit notice was sent and the re-entrant spawn ran');
  assert.strictEqual(observed.ok, true, 'the respawn succeeded');
  assert.strictEqual(observed.fresh, true, 'it got a NEW shell, not the record that just died');
  assert.strictEqual(spawn.spawned.length, 2, 'a second shell really was started');
});

test('exit unmaps only its OWN record — never a live successor', () => {
  // The interleaving: a window closes and kill() SIGHUPs, but the shell's
  // foreground child traps HUP and lingers. The operator reopens that workspace
  // (same ws-… id) and a NEW shell is spawned at the same key. THEN the old
  // proc finally exits. Deleting by key would unmap the live successor — which
  // is then unreachable by write/resize/kill, invisible to dispose(), and
  // survives app exit as an orphaned $SHELL.
  const spawn = fakePty();
  const { w, sent } = mk({ spawn });

  w.spawn('ws-1', null, {});
  const stale = spawn.spawned[0];
  w.kill('ws-1');                       // window closed; SIGHUP sent, proc lingers

  w.spawn('ws-1', null, {});                  // workspace reopened, same id
  const live = spawn.spawned[1];
  assert.strictEqual(spawn.spawned.length, 2, 'ENTER: a successor really was spawned at the same key');

  stale.exit(0);                        // the old shell finally dies

  assert.strictEqual(w._count(), 1, 'the successor is still mapped');
  assert.strictEqual(w.write('ws-1', null, 'still alive'), true, 'and still reachable');
  assert.deepStrictEqual(live.written, ['still alive']);

  // No spurious death notice for a shell that is running.
  const notices = sent.filter(([, ch, data]) => ch === 'wterm:data' && /shell exited/.test(data));
  assert.deepStrictEqual(notices, [], 'a stale exit must not report the LIVE shell as dead');

  // And the successor is still visible to the teardown that must not leak it.
  w.dispose();
  assert.strictEqual(live.killed, true, 'quit must reach the successor — otherwise it orphans');
});

test('kill escalates to SIGKILL, and the escalation cannot hold the loop open', () => {
  // Parity with session-manager.js's kill/archive paths: pty.kill() is SIGHUP,
  // which a child trapping or ignoring HUP survives indefinitely. The 5s
  // escalation is what bounds the window in which a lingering proc can still be
  // holding its old key.
  const spawn = fakePty();
  const timers = [];
  const killed = [];
  const { w } = mk({
    spawn,
    setTimeout: (fn, ms) => { const t = { fn, ms, unrefd: false, unref() { t.unrefd = true; return t; } }; timers.push(t); return t; },
    killPid: (pid, sig) => killed.push([pid, sig]),
  });

  w.spawn('ws-1', null, {});
  spawn.spawned[0].pid = 4242;
  w.kill('ws-1');

  assert.strictEqual(spawn.spawned[0].killed, true, 'ENTER: SIGHUP went first');
  assert.strictEqual(timers.length, 1, 'an escalation was scheduled');
  assert.strictEqual(timers[0].ms, 5000, 'same 5s as session-manager');
  // unref: a quit must not be held open for five seconds by a shell that is
  // already gone.
  assert.strictEqual(timers[0].unrefd, true, 'the escalation timer is unref\'d');

  timers[0].fn();
  assert.deepStrictEqual(killed, [[4242, 'SIGKILL']], 'the pid captured BEFORE the delete');
});

test('kill: the shell dies with its window and leaves no record', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', null, {});
  w.spawn('ws-2', null, {});

  assert.strictEqual(w.kill('ws-1'), true);
  assert.strictEqual(spawn.spawned[0].killed, true);
  assert.strictEqual(spawn.spawned[1].killed, false, 'the other window is untouched');
  assert.strictEqual(w._count(), 1);
  assert.strictEqual(w.kill('ws-1'), false, 'killing twice is a no-op, not a throw');
});

test('dispose kills every shell and latches', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', null, {});
  w.spawn('ws-2', null, {});
  w.dispose();

  assert.ok(spawn.spawned.every((p) => p.killed), 'quit must not orphan a workbench shell');
  assert.strictEqual(w._count(), 0);

  // Latched: a spawn racing shutdown would otherwise start a child after the
  // teardown that was supposed to end them all.
  const res = w.spawn('ws-3', {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(spawn.spawned.length, 2, 'no new shell after dispose');
});

test('a workbench terminal is not a session — the module cannot reach one', () => {
  // The privacy claim in the design rests on this file not being wired to the
  // session machinery. A `require('./session-manager')` here would be the
  // change that quietly makes a workbench terminal registry-visible.
  const src = require('fs').readFileSync(require.resolve('../drawer-pty.js'), 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires, [], 'drawer-pty takes every dependency by injection');

  // Comments stripped before matching: the file's own header explains at length
  // that it is not a session, and scanning the prose would fail on the
  // documentation of the very property being asserted.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.match(code, /createDrawerPtys/, 'ENTER: stripping left the actual code');
  assert.doesNotMatch(code, /session-manager|agent-transport|registry|sessions\b/,
    'no session machinery: no registry entry, no socket, invisible to [agent:who]');
});

// ── per-SEAT keying ──────────────────────────────────────────────────────────
// The tab was one shell per window, so switching seats left the operator in the
// previous seat's shell and, more often than not, the wrong directory. Keying by
// (window, seat) is the fix; what follows pins the parts of it that are not
// obvious from the key itself — the routing, the reaping, and the cwd.

test('two seats in ONE window get two shells, each in its own cwd', () => {
  const cwds = { alpha: '/repo/alpha', beta: '/repo/beta' };
  const { w, spawn } = mk({ cwdFor: (_ws, seat) => cwds[seat] || '/fallback' });
  w.spawn('ws-1', 'alpha', {});
  w.spawn('ws-1', 'beta', {});

  // ENTER: two shells really were built. Without this the cwd assertions below
  // would also hold for a single shell spawned once.
  assert.strictEqual(spawn.spawned.length, 2, 'ENTER: one shell per seat');
  assert.strictEqual(spawn.spawned[0].opts.cwd, '/repo/alpha');
  assert.strictEqual(spawn.spawned[1].opts.cwd, '/repo/beta',
    "the second seat opens in ITS directory, not the first seat's");
});

test('re-showing the same seat returns the SAME shell, not a second one', () => {
  const { w, spawn } = mk();
  const first = w.spawn('ws-1', 'alpha', {});
  const again = w.spawn('ws-1', 'alpha', {});
  assert.strictEqual(spawn.spawned.length, 1, 'the tenant calls spawn on every show');
  assert.strictEqual(first.fresh, true);
  assert.strictEqual(again.fresh, false, 'the second call is a re-attach, not a new shell');
  assert.strictEqual(again.seat, 'alpha', 'the answer names the seat it is for');
});

test('a seat and the seatless workspace shell are different shells', () => {
  // The drawer opened with no session selected has nowhere to belong, so the
  // seatless key stays valid — and must not alias a real seat's shell.
  const { w, spawn } = mk();
  w.spawn('ws-1', null, {});
  w.spawn('ws-1', 'alpha', {});
  assert.strictEqual(spawn.spawned.length, 2);
  assert.strictEqual(w._count(), 2);
});

test('output carries its seat so the renderer can drop what it is not showing', () => {
  const { w, spawn, sent } = mk();
  w.spawn('ws-1', 'alpha', {});
  w.spawn('ws-1', 'beta', {});
  spawn.spawned[1].emit('from-beta');

  assert.strictEqual(sent.length, 1, 'ENTER: exactly one send landed');
  // Both shells send to the SAME window — the window is the only thing `send`
  // can address — so without the seat tag the renderer cannot tell them apart
  // and would interleave two shells into one buffer.
  assert.deepStrictEqual(sent[0], ['ws-1', 'wterm:data', 'from-beta', 'beta', 1]);
});

test('input reaches the addressed seat and no other', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alpha', {});
  w.spawn('ws-1', 'beta', {});

  assert.strictEqual(w.write('ws-1', 'beta', 'typed'), true);
  assert.deepStrictEqual(spawn.spawned[0].written, [], "alpha never saw beta's keystrokes");
  assert.deepStrictEqual(spawn.spawned[1].written, ['typed']);
  // An unspawned seat is a refusal, not a fallback to the window's other shell.
  assert.strictEqual(w.write('ws-1', 'gamma', 'x'), false);
  assert.deepStrictEqual(spawn.spawned[1].written, ['typed'], 'the refusal wrote nothing anywhere');
});

test('closing a window kills EVERY seat shell in it', () => {
  // The pre-seat kill() looked up one record because there could only be one.
  // Left as a lookup it would strand every shell but the first as an orphan the
  // operator has no UI to reach.
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alpha', {});
  w.spawn('ws-1', 'beta', {});
  w.spawn('ws-2', 'gamma', {});
  assert.strictEqual(w._count(), 3, 'ENTER: three shells across two windows');

  assert.strictEqual(w.kill('ws-1'), true);
  assert.strictEqual(spawn.spawned[0].killed, true, 'alpha died with its window');
  assert.strictEqual(spawn.spawned[1].killed, true, 'and so did beta');
  assert.strictEqual(spawn.spawned[2].killed, false, 'the other window is untouched');
  assert.strictEqual(w._count(), 1);
  assert.strictEqual(w.kill('ws-1'), false, 'killing an emptied window is a no-op');
});

test("killSeat ends one seat's shell and leaves its neighbours running", () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alpha', {});
  w.spawn('ws-1', 'beta', {});

  assert.strictEqual(w.killSeat('ws-1', 'alpha'), true);
  assert.strictEqual(spawn.spawned[0].killed, true);
  assert.strictEqual(spawn.spawned[1].killed, false);
  assert.strictEqual(w._count(), 1);
  assert.strictEqual(w.killSeat('ws-1', 'alpha'), false, 'twice is a no-op, not a throw');
});

test('killSeat escalates to SIGKILL like every other end-of-shell path', () => {
  // The escalation was inline in kill() before there were three ways to end a
  // shell. A path missing it leaks a HUP-ignoring child forever.
  const timers = [];
  const kills = [];
  const { w } = mk({
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    killPid: (pid, sig) => kills.push([pid, sig]),
  });
  w.spawn('ws-1', 'alpha', {});
  w.killSeat('ws-1', 'alpha');

  assert.strictEqual(timers.length, 1, 'ENTER: an escalation was armed');
  assert.strictEqual(timers[0].ms, 5000);
  timers[0].fn();
  assert.deepStrictEqual(kills, [[1000, 'SIGKILL']]);
});

// A shell killed by its WINDOW closing (main.js's win 'closed' → kill) is the
// one end a peer cannot infer: no exit frame, no close frame, the output just
// stops. And the announcement cannot ride the PTY's own onExit, because both
// kill paths delete the record first and that handler's identity guard then
// returns before reaching it.
test('the window kill tells a watching peer, once per seat', () => {
  const { w, ended, spawn } = mk();
  w.spawn('ws-1', 'alpha', {});
  w.spawn('ws-1', 'beta', {});
  w.spawn('ws-2', 'gamma', {});
  assert.deepStrictEqual(ended, [], 'ENTER: nothing was announced by the spawns');

  w.kill('ws-1');
  assert.deepStrictEqual(ended.slice().sort(), [['alpha', 'closed'], ['beta', 'closed']],
    'both seats in the window were announced, and neither was the other window\'s');

  // The SIGHUP lands and the fake shell exits afterwards, as a real one would.
  // The record is gone, so the identity guard stops the second announcement —
  // a peer that is told twice reconnects into the gap between them.
  spawn.spawned[0].exit(0);
  assert.strictEqual(ended.length, 2, 'the late exit did not announce a second time');
});

test('killSeat tells a watching peer about that seat only', () => {
  const { w, ended } = mk();
  w.spawn('ws-1', 'alpha', {});
  w.spawn('ws-1', 'beta', {});

  w.killSeat('ws-1', 'alpha');
  assert.deepStrictEqual(ended, [['alpha', 'closed']], 'one seat ended, one announcement');
});

// The seatless workspace shell has no seat to name, so there is nobody to tell:
// a peer terminal is per-seat by construction. Guarded rather than sent as a
// null, which the serving side would route to... the seatless shell.
test('the seatless shell announces nothing', () => {
  const { w, ended } = mk();
  w.spawn('ws-1', null, {});
  w.kill('ws-1');
  assert.deepStrictEqual(ended, [], 'no seat, no announcement');
});

test('a seat name cannot alias another pair through the key separator', () => {
  // The key joins two attacker-adjacent strings. A separator either half could
  // contain would let one (window, seat) pair resolve to another's shell. NUL is
  // the one byte neither a minted workspace id nor a [a-zA-Z0-9._-] session name
  // can hold, which is why it is the join.
  const { w, spawn } = mk();
  w.spawn('ws-1', 'a', {});
  w.spawn('ws-1 a', null, {});
  assert.strictEqual(spawn.spawned.length, 2, 'ENTER: two spawns were attempted');
  assert.strictEqual(w._count(), 2, 'the two pairs stayed distinct');
});

test('the scrollback snapshot carries the seq it reflects', () => {
  // The renderer receives live bytes and the snapshot over two different IPC
  // paths, so their order is not guaranteed. The seq is what lets it drop the
  // overlap instead of double-printing it or losing the tail.
  const { w, spawn, sent } = mk();
  w.spawn('ws-1', 'alpha', {});
  const p = spawn.spawned[0];
  p.emit('one');
  p.emit('two');

  const res = w.spawn('ws-1', 'alpha', {});
  assert.strictEqual(res.fresh, false, 'ENTER: this is the re-attach path, not a new shell');
  assert.strictEqual(res.scrollback, 'onetwo', 'ENTER: the snapshot really holds both writes');
  assert.strictEqual(res.seq, 2, 'the snapshot names how many writes it contains');
  // Every live send carried its own seq, so a byte that arrives after the
  // snapshot is distinguishable from one already inside it.
  assert.deepStrictEqual(sent.map((s) => s[4]), [1, 2]);
});

// --- OSC 133 command reporting ------------------------------------------
// The parser itself is pinned in term-marks.test.js; what belongs here is the
// WIRING: which shells get one, that the bytes still reach the renderer, and
// that a seatless shell reports nothing.

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const MARKED = (cmd, out, code) =>
  `\x1b]133;C;${b64(cmd)}\x07${out}\x1b]133;D;${code}\x07`;

test('marks: a seat shell reports its finished commands', () => {
  const got = [];
  const { w, spawn } = mk({ onCommand: (seat, rec) => got.push([seat, rec]) });
  w.spawn('ws-1', 'alice', {});
  spawn.spawned[0].emit(MARKED('npm test', 'ok\n', 0));

  assert.strictEqual(got.length, 1, 'ENTER: one command was reported');
  assert.strictEqual(got[0][0], 'alice', 'reported against the seat that ran it');
  assert.deepStrictEqual(got[0][1], { command: 'npm test', exitCode: 0, output: 'ok\n' });
});

// There is nobody to report a workspace-wide shell's commands TO.
test('marks: a SEATLESS shell reports nothing', () => {
  const got = [];
  const { w, spawn } = mk({ onCommand: (seat, rec) => got.push([seat, rec]) });
  w.spawn('ws-1', null, {});
  spawn.spawned[0].emit(MARKED('ls', 'x\n', 0));

  assert.strictEqual(got.length, 0, 'the shared terminal belongs to no agent');
});

// One parser per shell. A shared one would attribute one seat's output to
// another seat's command whenever the two interleave.
test('marks: each seat is framed by its OWN parser', () => {
  const got = [];
  const { w, spawn } = mk({ onCommand: (seat, rec) => got.push([seat, rec.command, rec.output]) });
  w.spawn('ws-1', 'alice', {});
  w.spawn('ws-1', 'bob', {});
  const [a, b] = spawn.spawned;

  // Interleaved: both commands open before either closes.
  a.emit(`\x1b]133;C;${b64('a-cmd')}\x07`);
  b.emit(`\x1b]133;C;${b64('b-cmd')}\x07`);
  a.emit('from-a\n');
  b.emit('from-b\n');
  a.emit('\x1b]133;D;0\x07');
  b.emit('\x1b]133;D;1\x07');

  assert.strictEqual(got.length, 2, 'ENTER: both commands were framed');
  assert.deepStrictEqual(got, [
    ['alice', 'a-cmd', 'from-a\n'],
    ['bob', 'b-cmd', 'from-b\n'],
  ]);
});

// The renderer must receive the bytes UNCHANGED — xterm ignores an unknown OSC,
// and a stripped copy here would diverge from the scrollback.
test('marks: the renderer still receives the raw bytes', () => {
  const { w, sent, spawn } = mk({ onCommand: () => {} });
  w.spawn('ws-1', 'alice', {});
  const raw = MARKED('ls', 'out\n', 0);
  spawn.spawned[0].emit(raw);

  const data = sent.filter((s) => s[1] === 'wterm:data').map((s) => s[2]).join('');
  assert.strictEqual(data, raw, 'the bytes are forwarded, not consumed');
});

test('marks: a throwing reporter cannot break the terminal', () => {
  const { w, sent, spawn } = mk({ onCommand: () => { throw new Error('boom'); } });
  w.spawn('ws-1', 'alice', {});
  spawn.spawned[0].emit(MARKED('ls', 'out\n', 0));

  const data = sent.filter((s) => s[1] === 'wterm:data').map((s) => s[2]).join('');
  assert.ok(data.length > 0, 'ENTER: output still reached the renderer');
  assert.strictEqual(w._count(), 1, 'the shell is still alive');
});

// --- the shell shim seam -------------------------------------------------

test('shim: its env additions reach the spawned shell', () => {
  const { w, spawn } = mk({ shimEnv: (seat) => ({ env: { ZDOTDIR: `/run/${seat}/zsh` }, args: ['-l'] }) });
  w.spawn('ws-1', 'alice', {});

  assert.strictEqual(spawn.spawned[0].opts.env.ZDOTDIR, '/run/alice/zsh');
  assert.strictEqual(spawn.spawned[0].opts.env.PATH, '/usr/bin', 'the base env survives');
});

// A host that cannot build a shim must still get an ORDINARY terminal.
test('shim: a null shim leaves the environment untouched', () => {
  const { w, spawn } = mk({ shimEnv: () => null });
  w.spawn('ws-1', 'alice', {});

  assert.ok(!('ZDOTDIR' in spawn.spawned[0].opts.env), 'no redirect');
  assert.strictEqual(spawn.spawned[0].opts.env.TERM, 'xterm-256color', 'ENTER: a real shell spawned');
});

// TERM is set AFTER the shim spread, so a shim cannot break xterm's rendering.
test('shim: it cannot override TERM', () => {
  const { w, spawn } = mk({ shimEnv: () => ({ env: { TERM: 'dumb' }, args: ['-l'] }) });
  w.spawn('ws-1', 'alice', {});
  assert.strictEqual(spawn.spawned[0].opts.env.TERM, 'xterm-256color');
});

// bash's whole mechanism is the argv (--rcfile, and NO -l), so a shim that
// could only add env would generate a file the shell never reads. Pinned as a
// pair with the default below: the interesting half is that a shim can REPLACE
// the argv, and asserting only the default would be true of a build that
// ignores `shim.args` entirely.
test('shim: a shim can replace the spawn argv', () => {
  const { w, spawn } = mk({ shimEnv: () => ({ env: {}, args: ['--rcfile', '/run/alice/zsh/bashrc', '-i'] }) });
  w.spawn('ws-1', 'alice', {});
  assert.deepStrictEqual(spawn.spawned[0].args, ['--rcfile', '/run/alice/zsh/bashrc', '-i']);
});

test('shim: an unshimmed shell still spawns as a LOGIN shell', () => {
  const { w, spawn } = mk({ shimEnv: () => null });
  w.spawn('ws-1', 'alice', {});
  assert.deepStrictEqual(spawn.spawned[0].args, ['-l'],
    'the operator PATH and aliases are the point of the tab');
});

// A bash shim adds no environment at all. `shimmed` is what exec() consults
// before agreeing to run anything, so deriving it from the env half would
// refuse every command on a correctly shimmed bash.
test('shim: a shim with no env additions still counts as shimmed', () => {
  const { w } = mk({ shimEnv: () => ({ env: {}, args: ['--rcfile', '/x/bashrc', '-i'] }) });
  w.spawn('ws-1', 'alice', {});
  assert.strictEqual(w._execState('ws-1', 'alice').shimmed, true);
});

test('shim: the seat is what decides which shim is built', () => {
  const asked = [];
  const { w } = mk({ shimEnv: (seat) => { asked.push(seat); return null; } });
  w.spawn('ws-1', 'alice', {});
  w.spawn('ws-1', 'bob', {});
  assert.deepStrictEqual(asked, ['alice', 'bob']);
});
