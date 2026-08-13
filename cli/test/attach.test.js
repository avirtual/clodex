'use strict';
// attach.test.js — two layers. LEAF: the pure decisions (scanEscape byte-split,
// clampDims, makeResizeSender debounce/dedup). INTEGRATION: attach() end-to-end
// through main.run against a stub SSE server that plays remote.js's attach/
// control/input/resize routes, with a fake TTY seam (io.tty) standing in for
// process.stdin/stdout so raw mode + keystrokes are driven deterministically.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const A = require('../src/attach');
const { run } = require('../src/main');

// ── leaf: scanEscape ─────────────────────────────────────────────────────────

test('scanEscape: no escape → whole chunk passes through, byte-identical', () => {
  const b = Buffer.from('hello world\r');
  const { before, hit } = A.scanEscape(b);
  assert.strictEqual(hit, false);
  assert.deepStrictEqual(before, b);
});

test('scanEscape: 0x1c mid-chunk → before forwarded, escape dropped, hit', () => {
  const b = Buffer.from([0x61, 0x62, 0x1c, 0x63, 0x64]); // ab<Ctrl-\>cd
  const { before, hit } = A.scanEscape(b);
  assert.strictEqual(hit, true);
  assert.deepStrictEqual(before, Buffer.from('ab'));
});

test('scanEscape: leading 0x1c → empty before, hit', () => {
  const { before, hit } = A.scanEscape(Buffer.from([0x1c, 0x78]));
  assert.strictEqual(hit, true);
  assert.strictEqual(before.length, 0);
});

test('scanEscape: multibyte UTF-8 around a real detach survives', () => {
  // "é" = 0xC3 0xA9; put it before the escape — no continuation byte is 0x1c.
  const b = Buffer.concat([Buffer.from('é'), Buffer.from([0x1c])]);
  const { before, hit } = A.scanEscape(b);
  assert.strictEqual(hit, true);
  assert.strictEqual(before.toString('utf8'), 'é');
});

// ── leaf: clampDims ──────────────────────────────────────────────────────────

test('clampDims: clamps to wire bounds 20..500 × 5..300', () => {
  assert.deepStrictEqual(A.clampDims(80, 24), { cols: 80, rows: 24 });
  assert.deepStrictEqual(A.clampDims(10, 2), { cols: 20, rows: 5 });
  assert.deepStrictEqual(A.clampDims(9999, 9999), { cols: 500, rows: 300 });
});

// ── leaf: makeResizeSender ───────────────────────────────────────────────────

function fakeTimers() {
  let now = 0, seq = 0;
  const pend = new Map();
  return {
    timers: {
      setTimeout: (fn, ms) => { const id = ++seq; pend.set(id, { fn, at: now + (ms || 0) }); return id; },
      clearTimeout: (id) => pend.delete(id),
    },
    advance(ms) { now += ms; for (const [id, t] of [...pend.entries()].sort((a, b) => a[1].at - b[1].at)) { if (t.at <= now) { pend.delete(id); t.fn(); } } },
  };
}

test('makeResizeSender: coalesces a burst into one send (trailing debounce)', () => {
  const clk = fakeTimers();
  const sent = [];
  const rs = A.makeResizeSender({ send: (c, r) => sent.push([c, r]), timers: clk.timers, delayMs: 150 });
  rs.trigger(80, 24); rs.trigger(100, 30); rs.trigger(120, 40);
  clk.advance(149);
  assert.strictEqual(sent.length, 0);
  clk.advance(2);
  assert.deepStrictEqual(sent, [[120, 40]]);
});

test('makeResizeSender: dedups an unchanged geometry; forget() re-arms', () => {
  const clk = fakeTimers();
  const sent = [];
  const rs = A.makeResizeSender({ send: (c, r) => sent.push([c, r]), timers: clk.timers, delayMs: 150 });
  rs.trigger(80, 24); clk.advance(200);
  rs.trigger(80, 24); clk.advance(200);        // identical → dropped
  assert.deepStrictEqual(sent, [[80, 24]]);
  rs.forget(); rs.trigger(80, 24); clk.advance(200);  // forget → re-sends
  assert.deepStrictEqual(sent, [[80, 24], [80, 24]]);
});

// ── integration: a fake TTY + a stub SSE server ──────────────────────────────

// A TTY double matching attach.makeTerm's io.tty seam. push()/resize()/signal()
// drive it; captures writeOut/writeErr and setRawMode transitions.
function fakeTty({ cols = 80, rows = 24 } = {}) {
  const dataL = new Set(), resizeL = new Set(), sigL = new Set();
  const outChunks = [], errChunks = [], rawLog = [];
  // An event delivered before attach() arms its listener is HELD, not dropped.
  // Every driver below is scheduled on a wall clock, but the listeners are armed
  // only once the SSE `replay` event arrives (attach.js: the replay handler calls
  // wireTerminal) — a spawn + waitForPort + HTTP + SSE handshake away, and
  // waitForPort polls on a 150ms tick, so one missed poll outruns the timer.
  // Losing a detach (Ctrl-\ or a signal) is a LOST WAKEUP, not a failed
  // assertion: attach() resolves only through teardown, so the run blocks
  // forever at 0% CPU with no error and no timeout. That is the t153 wedge, and
  // it reproduces deterministically if the replay is delayed past the timer.
  // Queueing per listener-set turns the race into ordinary delivery.
  const pending = new Map();
  const arm = (set, fn) => {
    set.add(fn);
    const q = pending.get(set);
    if (q) { pending.delete(set); for (const emit of q) emit(fn); }
    return () => set.delete(fn);
  };
  const fire = (set, emit) => {
    if (!set.size) {
      if (!pending.has(set)) pending.set(set, []);
      pending.get(set).push(emit);
      return;
    }
    [...set].forEach(emit);
  };
  const t = {
    isInTTY: true, isOutTTY: true,
    size: () => ({ cols, rows }),
    setRawMode: (on) => rawLog.push(on),
    onData: (fn) => arm(dataL, fn),
    onResize: (fn) => arm(resizeL, fn),
    onSignal: (fn) => arm(sigL, fn),
    resume: () => {}, pause: () => {},
    writeOut: (s) => outChunks.push(s),
    writeErr: (s) => errChunks.push(s),
  };
  return {
    tty: t,
    push: (buf) => fire(dataL, (fn) => fn(Buffer.isBuffer(buf) ? buf : Buffer.from(buf))),
    resize: (c, r) => { cols = c; rows = r; fire(resizeL, (fn) => fn()); },
    signal: () => fire(sigL, (fn) => fn()),
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
    rawLog,
  };
}

const TOKEN = 'sekret';
const b64 = (s) => Buffer.from(s).toString('base64');

// Stub attach server. opts.holder seeds the replay holder; opts.onAttach lets a
// test push output frames on the live attach res. Records every request.
function attachStub(opts = {}) {
  const seen = [];
  const state = { attach: null, live: false, inputStatuses: [] };
  const server = http.createServer((req, res) => {
    if ((req.headers['authorization'] || '') !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null };
      seen.push(rec);
      const p = req.url.split('?')[0];
      if (req.method === 'GET' && p.startsWith('/api/attach/')) {
        if (opts.attach404) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'no such session' })); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(': connected\n\n');
        res.write(`event: replay\ndata: ${JSON.stringify({ b64: b64(opts.scrollback || 'SCROLLBACK\n'), cols: 80, rows: 24, holder: opts.holder != null ? opts.holder : null })}\n\n`);
        state.attach = res;
        state.live = true;
        res.on('close', () => { state.live = false; }); // clean SSE close = server auto-releases control
        if (opts.onAttach) opts.onAttach(state, seen, res);
        return;
      }
      if (p.startsWith('/api/control/')) {
        if (rec.body && rec.body.action === 'acquire') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, token: 'ctl-1' })); }
        res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
      }
      if (p.startsWith('/api/input/')) {
        // Model remote.js's holder check: input needs the current control token.
        // opts.input403 forces a stale-token 403; opts.autoRelease 403s whenever
        // no attach stream is live (the reconnect-gap case).
        const ok = !opts.input403 && (!opts.autoRelease || state.live);
        state.inputStatuses.push(ok ? 200 : 403);
        if (!ok) { res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: 'not holder' })); }
        res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
      }
      if (p.startsWith('/api/resize/')) { res.writeHead(200); return res.end(JSON.stringify({ ok: true })); }
      res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'no route' }));
    });
  });
  return { server, seen, state };
}

// Start a stub and register its teardown as an UNCONDITIONAL after-hook.
//
// Teardown must NEVER be a trailing statement in a test body. A listening server
// is a live handle, so an assertion that throws above the close skips it and
// `node --test` then never exits: the run sits at 0% CPU holding the port, with
// no summary and no exit code, and a FAILED assertion presents as a hang. That
// is the t205 wedge — a hang is a coin flip on the operator's patience, a
// failure is information. An after-hook runs on the throwing path too.
//
// closeAllConnections() is load-bearing next to close(): these tests hold an SSE
// response open on purpose, and close() only stops ACCEPTING — it then waits for
// live sockets, so on its own it preserves the very hang it is here to end.
async function startStub(t, opts = {}) {
  const stub = attachStub(opts);
  const port = await new Promise((r) => stub.server.listen(0, '127.0.0.1', () => r(stub.server.address().port)));
  t.after(() => {
    try { stub.server.closeAllConnections(); } catch {}
    try { stub.server.close(); } catch {}
  });
  return { ...stub, port };
}

// The after-hooks above close the handle-leak route into a hang. This closes the
// OTHER one, and both are needed: a never-settling await hangs with the hooks in
// place, because nothing ever ends the test that would run them (measured — the
// hooks fire only once the timeout kills the test).
//
// The route is real and named in this file already: attach() resolves ONLY
// through teardown, so any path that loses the detach wakeup — the queueing at
// fakeTty's `arm`/`fire` fixes the one we know about — blocks forever at 0% CPU
// with no error and no timeout. Node's default per-test timeout is INFINITE, so
// "no timeout" is a choice this file was making by omission.
//
// 30s against a 2.5s worst case: wide enough that a loaded machine cannot reach
// it (measured 6s wall for the file under 2× CPU oversubscription, unchanged),
// tight enough that the answer arrives inside a human's attention. It is a
// backstop for a hang, NOT a margin for slow — a test that needs more than this
// is broken, and a green run must never come near it.
const T = { timeout: 30000 };

function pushOutput(res, s) { res.write(`event: output\ndata: ${JSON.stringify({ b64: b64(s) })}\n\n`); }

async function attachCli(name, extraArgs, port, tty, spawnFn) {
  let stdout = '', stderr = '';
  const argv = ['attach', name, ...extraArgs, '--url', `http://127.0.0.1:${port}`, '--token', TOKEN];
  const code = await run(argv, {
    stdout: (s) => (stdout += s), stderr: (s) => (stderr += s),
    env: {}, contextsFile: path.join(os.tmpdir(), 'nonexistent-clodexctl', 'contexts.json'),
    tty, spawnFn,
  });
  return { code, stdout, stderr };
}

// Wait for a REQUEST to reach the stub rather than for a wall clock to elapse.
// The drivers below must fire against attach()'s progress, not against a
// deadline: fakeTty queues an early keystroke until the listener arms, but
// arming happens on the SSE replay while the control token is still one
// unresolved POST away — and onStdin drops input when `token` is unset, so a
// keystroke delivered in that window is silently NOT forwarded and the test
// sees no /api/input at all. Reproduced 8/12 with 12 copies of this file in
// parallel; a larger constant only moves the window.
// Resolves false on timeout rather than rejecting: a broken gate then degrades
// into the caller's own named assertion failure instead of the hang this file
// is built around (see the fakeTty header). The tick is cleared and unref'd so
// a run that throws downstream is not held open by a pending poll.
const until = (pred, ms = 10000) => new Promise((resolve) => {
  const end = Date.now() + ms;
  let timer = null;
  const stop = (v) => { if (timer) clearTimeout(timer); resolve(v); };
  const tick = () => {
    let v; try { v = pred(); } catch { v = false; }
    if (v) return stop(true);
    if (Date.now() > end) return stop(false);
    timer = setTimeout(tick, 5);
    if (timer.unref) timer.unref();
  };
  tick();
});
const whenSeen = (seen, pred, ms) => until(() => seen.some(pred), ms);
const sawAcquire = (seen) => whenSeen(seen, (s) =>
  s.url.startsWith('/api/control/') && s.body && s.body.action === 'acquire');
// The resize carries the control token, so seeing it proves the acquire
// RESPONSE was processed — not merely that the request was sent. Arming happens
// on the replay frame, which the server writes before the acquire POST exists,
// so `token` is null at arm time in EVERY run; anything token-dependent must
// wait for this, not for a wall clock.
const sawTokenedResize = (seen) => whenSeen(seen, (s) =>
  s.url.startsWith('/api/resize/') && s.body && s.body.token);

// Wait for text the attach has actually written to the local terminal.
const whenOut = (tty, re, ms) => until(() => re.test(tty.out()), ms);

test('attach: replay resets + writes scrollback, output streams, acquire+resize on entry, release on detach', T, async (t) => {
  const { seen, port } = await startStub(t, {
    scrollback: 'PRIOR OUTPUT\n',
    // Delayed so the output frame arrives as a SEPARATE read after the replay
    // rather than riding the same TCP chunk — the decoder handles both, and
    // only this one is covered here. The gate below makes it deterministic, so
    // the delay costs nothing.
    onAttach: (state) => { setTimeout(() => pushOutput(state.attach, 'live line\r\n'), 30); },
  });
  const tty = fakeTty();
  // Detach only once BOTH things this test asserts have actually happened: the
  // live output reached the terminal, and the entry acquire+resize reached the
  // server. On a 90ms deadline the detach outran the SSE frame under load and
  // the run asserted on a terminal holding only the scrollback (measured with
  // 12 copies of this file in parallel); detaching purely on the output races
  // the other way, ending the run before acquire lands.
  Promise.all([
    whenOut(tty, /live line/),
    sawAcquire(seen),
    whenSeen(seen, (s) => s.url.startsWith('/api/resize/')),
  ]).then(() => tty.push(Buffer.from([0x1c])));
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0);
  // Reset sequence written before the scrollback.
  const out = tty.out();
  assert.ok(out.includes('\x1b[H\x1b[2J\x1b[3J'), 'terminal reset written');
  assert.ok(out.indexOf('PRIOR OUTPUT') > out.indexOf('\x1b[2J'), 'scrollback after reset');
  assert.match(out, /live line/);
  // Banner on stderr; raw mode entered then restored.
  assert.match(tty.err(), /attached to bash on .* — Ctrl-\\ detaches/);
  assert.match(tty.err(), /detached from bash/);
  assert.deepStrictEqual(tty.rawLog, [true, false]);
  // Server saw acquire + resize on entry, release on detach.
  const acq = seen.find((s) => s.url.startsWith('/api/control/') && s.body && s.body.action === 'acquire');
  const rz = seen.find((s) => s.url.startsWith('/api/resize/'));
  const rel = seen.find((s) => s.url.startsWith('/api/control/') && s.body && s.body.action === 'release');
  assert.ok(acq, 'acquire sent'); assert.ok(rz, 'resize sent'); assert.ok(rel, 'release sent');
  assert.strictEqual(rz.body.token, 'ctl-1');
  assert.ok(rz.body.cols >= 20 && rz.body.rows >= 5);
});

test('attach: keystrokes before the escape are forwarded with the token; escape is not', T, async (t) => {
  const { seen, port } = await startStub(t);
  const tty = fakeTty();
  // Gate on the RESIZE, not the acquire: the client sets `token` only when the
  // acquire RESPONSE resolves, and resize is sent after that with the token on
  // it. Seeing the acquire request still leaves a window where onStdin's token
  // guard silently drops the keystroke and no /api/input is ever sent.
  whenSeen(seen, (s) => s.url.startsWith('/api/resize/') && s.body && s.body.token)
    .then(() => tty.push(Buffer.from([0x6c, 0x73, 0x0d, 0x1c]))); // "ls\r" then Ctrl-\
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0);
  // The input POST is deliberately fire-and-forget (attach.js swallows its
  // failures), so teardown resolves the run without waiting for it to land.
  // Asserting straight off `seen` therefore races the wire.
  await whenSeen(seen, (s) => s.url.startsWith('/api/input/'));
  const input = seen.find((s) => s.url.startsWith('/api/input/'));
  assert.ok(input, 'input forwarded');
  assert.strictEqual(input.body.data, 'ls\r');       // escape byte dropped
  assert.strictEqual(input.body.token, 'ctl-1');
});

test('attach --read-only: never acquires control or forwards input; still detaches on Ctrl-\\', T, async (t) => {
  const { seen, port } = await startStub(t, { holder: 'someone' });
  const tty = fakeTty();
  setTimeout(() => tty.push(Buffer.from('xyz')), 30);       // typed but must NOT forward
  setTimeout(() => tty.push(Buffer.from([0x1c])), 60);
  const { code } = await attachCli('bash', ['--read-only'], port, tty.tty);
  assert.strictEqual(code, 0);
  assert.ok(!seen.some((s) => s.url.startsWith('/api/control/')), 'no control in read-only');
  assert.ok(!seen.some((s) => s.url.startsWith('/api/input/')), 'no input in read-only');
  assert.match(tty.err(), /\(read-only\)/);
  assert.deepStrictEqual(tty.rawLog, [true, false]);        // raw mode still restored
});

test('attach: banner notes taking control from the current holder', T, async (t) => {
  const { port } = await startStub(t, { holder: 'gui@laptop' });
  const tty = fakeTty();
  setTimeout(() => tty.push(Buffer.from([0x1c])), 40);
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0);
  assert.match(tty.err(), /taking control from gui@laptop/);
});

test('attach: SIGINT/SIGTERM is treated as a detach (exit 0, terminal restored)', T, async (t) => {
  const { seen, port } = await startStub(t);
  const tty = fakeTty();
  // Gate on the RESIZE, which carries the control token, so it proves the
  // acquire RESPONSE was processed. releaseControl() returns early when `token`
  // is unset, so a signal landing between the acquire request and its response
  // tears down with no release to find and this test fails on timing alone.
  whenSeen(seen, (s) => s.url.startsWith('/api/resize/') && s.body && s.body.token)
    .then(() => tty.signal());
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(tty.rawLog, [true, false]);
  assert.ok(seen.some((s) => s.url.startsWith('/api/control/') && s.body && s.body.action === 'release'));
});

test('attach: reconnect on a dropped stream does reset + re-replay + re-acquire', T, async (t) => {
  let attaches = 0;
  const { seen, port } = await startStub(t, {
    onAttach: (state, all, res) => {
      attaches++;
      if (attaches === 1) { setTimeout(() => { try { res.end(); } catch {} }, 30); } // drop it
    },
  });
  const tty = fakeTty();
  setTimeout(() => tty.push(Buffer.from([0x1c])), 2500); // detach after the reconnect
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0);
  const attachCount = seen.filter((s) => s.url.startsWith('/api/attach/')).length;
  assert.ok(attachCount >= 2, `re-opened the attach stream (saw ${attachCount})`);
  const acquires = seen.filter((s) => s.url.startsWith('/api/control/') && s.body && s.body.action === 'acquire').length;
  assert.ok(acquires >= 2, `re-acquired control on reconnect (saw ${acquires})`);
  assert.match(tty.err(), /reconnecting \(attempt 1\)/);
});

test('attach: a keystroke during the reconnect gap is not fatal — attach reconnects, re-acquires, later input flows', T, async (t) => {
  // MF1: a clean SSE close makes the server auto-release control, so a keystroke
  // typed in the gap posts with a stale token and 403s. That must NOT tear down
  // the attach — the guard reconnects + re-acquires and later input flows again.
  let attaches = 0;
  const { seen, state, port } = await startStub(t, {
    autoRelease: true,
    onAttach: (st, all, res) => {
      attaches++;
      if (attaches === 1) setTimeout(() => { try { res.end(); } catch {} }, 30); // drop → gap
    },
  });
  const tty = fakeTty();
  const tokenedResizes = () => seen.filter((s) =>
    s.url.startsWith('/api/resize/') && s.body && s.body.token).length;
  // THE GAP IS: control token already held (first acquire done, so the POST is
  // actually sent) AND no attach stream live (the stub auto-releases while
  // dead, which is what makes it 403). Both halves are load-bearing — waiting
  // only for the drop fires before the first acquire, where `token` is null and
  // onStdin drops the keystroke silently instead of 403ing it.
  sawTokenedResize(seen)
    .then(() => until(() => state.live === false))
    .then(() => tty.push(Buffer.from('a')));           // in the gap → 403, swallowed
  // The second must land after the re-acquire RESPONSE, or it 403s too and
  // `inputStatuses` never sees a 200. Every reconnect re-acquires and then
  // re-resizes with the new token (attach.js acquireAndResize), so a SECOND
  // tokened resize is the marker; the acquire request alone is not.
  until(() => tokenedResizes() >= 2)
    .then(() => tty.push(Buffer.from('b')))            // after re-acquire → 200
    .then(() => until(() => state.inputStatuses.includes(200)))
    .then(() => tty.push(Buffer.from([0x1c])));
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0, 'survived the gap keystroke (no exit 4)');
  const attachCount = seen.filter((s) => s.url.startsWith('/api/attach/')).length;
  assert.ok(attachCount >= 2, `reconnected (saw ${attachCount})`);
  assert.ok(state.inputStatuses.includes(403), 'gap keystroke 403d');
  assert.ok(state.inputStatuses.includes(200), 'post-reconnect keystroke flowed');
});

test('attach: a stale-token 403 on input is swallowed (not fatal)', T, async (t) => {
  // MF1: every /api/input 403s (holder changed underneath us). A viewer typing
  // into a stolen session sees silent no-ops, matching the GUI — never exit 4.
  const { seen, state, port } = await startStub(t, { input403: true });
  const tty = fakeTty();
  // Token-dependent exactly like the two tests above: on a bare timer the
  // keystroke can land before the acquire response, where onStdin's `token`
  // guard drops it, no /api/input is sent and inputStatuses stays empty.
  sawTokenedResize(seen).then(() => {
    tty.push(Buffer.from('ls\r'));                       // 403, swallowed
    // Queue the detach behind the input REQUEST so teardown cannot outrun it.
    whenSeen(seen, (s) => s.url.startsWith('/api/input/'))
      .then(() => tty.push(Buffer.from([0x1c])));        // then detach cleanly
  });
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0, 'a 403 input did not tear down the attach');
  // The input POST is fired unawaited and teardown does not wait for it, so the
  // status can be recorded after the run resolves.
  await until(() => state.inputStatuses.length > 0);
  assert.ok(state.inputStatuses.includes(403), 'input actually 403d');
});

test('attach: a 404 on the session → give up, terminal restored, exit 5', T, async (t) => {
  const { port } = await startStub(t, { attach404: true });
  const tty = fakeTty();
  const { code } = await attachCli('ghost', [], port, tty.tty);
  assert.strictEqual(code, 5); // NOTFOUND — no endless reconnect on a definitive 404
  // Raw mode is never entered (no replay ever arrived), so nothing to restore.
});

test('attach: non-TTY stdin/stdout → USAGE with a scripting hint', T, async (t) => {
  const { port } = await startStub(t);
  const tty = fakeTty();
  tty.tty.isInTTY = false;
  const { code, stderr } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 2);
  assert.match(stderr, /attach needs a terminal/);
});

test('attach: detach exits 0 and kills the tunnel child (real proxy child)', T, async (t) => {
  const fs = require('node:fs');
  const { port: stubPort } = await startStub(t);
  // A REAL detached tunnel child: a TCP proxy that listens on the substituted
  // {port} and forwards to the stub, so the wire genuinely rides the tunnel and
  // we can assert the child is reaped on detach. A tunnel transport is a STORED
  // context (not a --tunnel flag), so seed a temp contexts file.
  const proxy = `const net=require('net');const local=+process.argv[1],remote=${stubPort};`
    + `net.createServer(c=>{const u=net.connect(remote,'127.0.0.1');c.pipe(u);u.pipe(c);c.on('error',()=>{});u.on('error',()=>{});})`
    + `.listen(local,'127.0.0.1');setInterval(()=>{},1000);`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-attach-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const cf = path.join(dir, 'contexts.json');
  fs.writeFileSync(cf, JSON.stringify({
    current: 'tun',
    contexts: { tun: { tunnel: [process.execPath, '-e', proxy, '{port}'], token: TOKEN } },
  }), { mode: 0o600 });

  const tty = fakeTty();
  setTimeout(() => tty.push(Buffer.from([0x1c])), 200);
  const spawnReal = require('node:child_process').spawn;
  let child = null;
  const spawnFn = (cmd, args, opts) => { child = spawnReal(cmd, args, opts); return child; };
  // The backstop for the case this test is ABOUT. The child is spawned detached
  // and listens on a port, so if the assertions below throw — i.e. the reap the
  // test exists to prove did not happen — nothing else would ever kill it, and a
  // failing run would leak a live listener into every later run on this machine.
  // Group-kill, matching transport.js's own close(); ESRCH is the good outcome.
  t.after(() => {
    if (!child || !child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  });
  let stdout = '', stderr = '';
  const code = await run(['attach', 'bash', '--ctx', 'tun'], {
    stdout: (s) => (stdout += s), stderr: (s) => (stderr += s),
    env: {}, contextsFile: cf, tty: tty.tty, spawnFn,
  });
  assert.strictEqual(code, 0);
  assert.match(tty.err(), /attached to bash/);
  assert.deepStrictEqual(tty.rawLog, [true, false]);   // raw mode restored
  // withWire's finally group-killed the tunnel child on detach. The child is
  // spawned DETACHED (transport.js: it leads its own process group so kill(-pid)
  // sweeps helpers), which is exactly what lets it outlive this process — so
  // "reaped" has to mean the process is GONE, not that a signal was dispatched
  // at it. `child.killed` is only "a signal was sent successfully" and is true
  // even if the target ignored it; asserting on it lets a survivor pass.
  assert.ok(child && child.pid > 0, 'ENTER: a real pid, or there is no process to prove dead');
  const pid = child.pid;
  for (let i = 0; i < 100 && child.exitCode == null && child.signalCode == null; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(child.exitCode != null || child.signalCode != null,
    'the tunnel child must have EXITED on detach — a detached child that merely received a signal and kept '
    + 'running outlives the test run and leaks a listening port into every later one');
  // Independent of the child handle: signal 0 tests existence only, and throws
  // ESRCH once the pid is gone. The handle could report an exit while a forked
  // helper in the same group survived; this asks the OS directly.
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' },
    'and the pid must be gone from the process table, not merely reported exited by its own handle');
});
