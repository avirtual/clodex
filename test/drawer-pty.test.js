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
    env: { PATH: '/usr/bin' },
    log: { info() {}, warn() {}, error() {} },
  });
  return { w, sent, spawn };
}

test('spawn: a real login shell in the workspace cwd', () => {
  const { w, spawn } = mk();
  const res = w.spawn('ws-1', { cols: 100, rows: 30 });

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
  const first = w.spawn('ws-1', {});
  spawn.spawned[0].emit('some output');
  spawn.spawned[0].exit(0);

  const after = w.spawn('ws-1', {});
  assert.strictEqual(after.ok, true, 'ENTER: the post-exit spawn succeeded');
  assert.strictEqual(spawn.spawned.length, 2, 'a NEW shell, not the dead record');
  assert.strictEqual(after.fresh, true, 'and it is reported fresh');
  assert.strictEqual(after.scrollback, '', 'the dead shell\'s output is not replayed under the new one');
  assert.strictEqual(w.write('ws-1', 'usable'), true, 'and the tab is usable again');
});

test('one shell per WINDOW — two workspaces do not share', () => {
  const { w, spawn, sent } = mk();
  w.spawn('ws-1', {});
  w.spawn('ws-2', {});
  assert.strictEqual(spawn.spawned.length, 2, 'ENTER: two distinct shells');

  spawn.spawned[0].emit('from-one');
  w.write('ws-2', 'typed-into-two');

  assert.deepStrictEqual(sent, [['ws-1', 'wterm:data', 'from-one']],
    'output is delivered to the window that owns the shell, and only that one');
  assert.deepStrictEqual(spawn.spawned[0].written, [], 'ws-1 never saw ws-2 input');
  assert.deepStrictEqual(spawn.spawned[1].written, ['typed-into-two']);
});

test('the scrollback ring is capped and keeps the TAIL', () => {
  const { w, spawn } = mk({ scrollbackMax: 10 });
  w.spawn('ws-1', {});
  spawn.spawned[0].emit('abcdefgh');
  spawn.spawned[0].emit('IJKLMNOP');

  const res = w.spawn('ws-1', {});
  assert.strictEqual(res.scrollback.length, 10, 'capped');
  // The tail, not the head: a terminal's useful history is the most recent
  // output, and slicing the other end would replay a stale screen.
  assert.strictEqual(res.scrollback, 'ghIJKLMNOP');
});

test('write/resize on an unspawned window are refused, not crashes', () => {
  const { w } = mk();
  assert.strictEqual(w.write('nope', 'x'), false);
  assert.strictEqual(w.resize('nope', 80, 24), false);
});

test('resize: clamps zero dims and skips the no-op SIGWINCH', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', { cols: 80, rows: 24 });
  const p = spawn.spawned[0];

  assert.strictEqual(w.resize('ws-1', 80, 24), true, 'ENTER: the call was accepted');
  assert.deepStrictEqual(p.resizes, [], 'same dims: no SIGWINCH into whatever is running');

  w.resize('ws-1', 120, 40);
  assert.deepStrictEqual(p.resizes, [[120, 40]], 'a real change does resize');

  // The renderer legitimately reports 0 when it measures a pane mid-transition;
  // a 0-row PTY breaks the child's ioctl arithmetic.
  w.resize('ws-1', 0, 0);
  assert.deepStrictEqual(p.resizes, [[120, 40]], 'a zero dimension is ignored, not forwarded');
});

test('a spawn failure is reported, not thrown', () => {
  const spawn = () => { throw new Error('posix_spawnp failed'); };
  spawn.spawned = [];
  const { w } = mk({ spawn });
  const res = w.spawn('ws-1', {});
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

  w.spawn('ws-1', {});
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

  w.spawn('ws-1', {});
  const stale = spawn.spawned[0];
  w.kill('ws-1');                       // window closed; SIGHUP sent, proc lingers

  w.spawn('ws-1', {});                  // workspace reopened, same id
  const live = spawn.spawned[1];
  assert.strictEqual(spawn.spawned.length, 2, 'ENTER: a successor really was spawned at the same key');

  stale.exit(0);                        // the old shell finally dies

  assert.strictEqual(w._count(), 1, 'the successor is still mapped');
  assert.strictEqual(w.write('ws-1', 'still alive'), true, 'and still reachable');
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

  w.spawn('ws-1', {});
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
  w.spawn('ws-1', {});
  w.spawn('ws-2', {});

  assert.strictEqual(w.kill('ws-1'), true);
  assert.strictEqual(spawn.spawned[0].killed, true);
  assert.strictEqual(spawn.spawned[1].killed, false, 'the other window is untouched');
  assert.strictEqual(w._count(), 1);
  assert.strictEqual(w.kill('ws-1'), false, 'killing twice is a no-op, not a throw');
});

test('dispose kills every shell and latches', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', {});
  w.spawn('ws-2', {});
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
