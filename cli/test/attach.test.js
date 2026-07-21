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
  const t = {
    isInTTY: true, isOutTTY: true,
    size: () => ({ cols, rows }),
    setRawMode: (on) => rawLog.push(on),
    onData: (fn) => { dataL.add(fn); return () => dataL.delete(fn); },
    onResize: (fn) => { resizeL.add(fn); return () => resizeL.delete(fn); },
    onSignal: (fn) => { sigL.add(fn); return () => sigL.delete(fn); },
    resume: () => {}, pause: () => {},
    writeOut: (s) => outChunks.push(s),
    writeErr: (s) => errChunks.push(s),
  };
  return {
    tty: t,
    push: (buf) => dataL.forEach((fn) => fn(Buffer.isBuffer(buf) ? buf : Buffer.from(buf))),
    resize: (c, r) => { cols = c; rows = r; resizeL.forEach((fn) => fn()); },
    signal: () => [...sigL].forEach((fn) => fn()),
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

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
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

test('attach: replay resets + writes scrollback, output streams, acquire+resize on entry, release on detach', async () => {
  const { server, seen } = attachStub({
    scrollback: 'PRIOR OUTPUT\n',
    onAttach: (state) => { setTimeout(() => pushOutput(state.attach, 'live line\r\n'), 30); },
  });
  const port = await listen(server);
  const tty = fakeTty();
  // Detach shortly after the live output lands.
  setTimeout(() => tty.push(Buffer.from([0x1c])), 90);
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
  server.close();
});

test('attach: keystrokes before the escape are forwarded with the token; escape is not', async () => {
  const { server, seen } = attachStub({});
  const port = await listen(server);
  const tty = fakeTty();
  setTimeout(() => tty.push(Buffer.from([0x6c, 0x73, 0x0d, 0x1c])), 40); // "ls\r" then Ctrl-\
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0);
  const input = seen.find((s) => s.url.startsWith('/api/input/'));
  assert.ok(input, 'input forwarded');
  assert.strictEqual(input.body.data, 'ls\r');       // escape byte dropped
  assert.strictEqual(input.body.token, 'ctl-1');
  server.close();
});

test('attach --read-only: never acquires control or forwards input; still detaches on Ctrl-\\', async () => {
  const { server, seen } = attachStub({ holder: 'someone' });
  const port = await listen(server);
  const tty = fakeTty();
  setTimeout(() => tty.push(Buffer.from('xyz')), 30);       // typed but must NOT forward
  setTimeout(() => tty.push(Buffer.from([0x1c])), 60);
  const { code } = await attachCli('bash', ['--read-only'], port, tty.tty);
  assert.strictEqual(code, 0);
  assert.ok(!seen.some((s) => s.url.startsWith('/api/control/')), 'no control in read-only');
  assert.ok(!seen.some((s) => s.url.startsWith('/api/input/')), 'no input in read-only');
  assert.match(tty.err(), /\(read-only\)/);
  assert.deepStrictEqual(tty.rawLog, [true, false]);        // raw mode still restored
  server.close();
});

test('attach: banner notes taking control from the current holder', async () => {
  const { server } = attachStub({ holder: 'gui@laptop' });
  const port = await listen(server);
  const tty = fakeTty();
  setTimeout(() => tty.push(Buffer.from([0x1c])), 40);
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0);
  assert.match(tty.err(), /taking control from gui@laptop/);
  server.close();
});

test('attach: SIGINT/SIGTERM is treated as a detach (exit 0, terminal restored)', async () => {
  const { server, seen } = attachStub({});
  const port = await listen(server);
  const tty = fakeTty();
  setTimeout(() => tty.signal(), 40);
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(tty.rawLog, [true, false]);
  assert.ok(seen.some((s) => s.url.startsWith('/api/control/') && s.body && s.body.action === 'release'));
  server.close();
});

test('attach: reconnect on a dropped stream does reset + re-replay + re-acquire', async () => {
  let attaches = 0;
  const { server, seen } = attachStub({
    onAttach: (state, all, res) => {
      attaches++;
      if (attaches === 1) { setTimeout(() => { try { res.end(); } catch {} }, 30); } // drop it
    },
  });
  const port = await listen(server);
  const tty = fakeTty();
  setTimeout(() => tty.push(Buffer.from([0x1c])), 2500); // detach after the reconnect
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0);
  const attachCount = seen.filter((s) => s.url.startsWith('/api/attach/')).length;
  assert.ok(attachCount >= 2, `re-opened the attach stream (saw ${attachCount})`);
  const acquires = seen.filter((s) => s.url.startsWith('/api/control/') && s.body && s.body.action === 'acquire').length;
  assert.ok(acquires >= 2, `re-acquired control on reconnect (saw ${acquires})`);
  assert.match(tty.err(), /reconnecting \(attempt 1\)/);
  server.close();
});

test('attach: a keystroke during the reconnect gap is not fatal — attach reconnects, re-acquires, later input flows', async () => {
  // MF1: a clean SSE close makes the server auto-release control, so a keystroke
  // typed in the gap posts with a stale token and 403s. That must NOT tear down
  // the attach — the guard reconnects + re-acquires and later input flows again.
  let attaches = 0;
  const { server, seen, state } = attachStub({
    autoRelease: true,
    onAttach: (st, all, res) => {
      attaches++;
      if (attaches === 1) setTimeout(() => { try { res.end(); } catch {} }, 30); // drop → gap
    },
  });
  const port = await listen(server);
  const tty = fakeTty();
  setTimeout(() => tty.push(Buffer.from('a')), 400);   // in the reconnect gap → 403, swallowed
  setTimeout(() => tty.push(Buffer.from('b')), 1500);  // after re-acquire → 200
  setTimeout(() => tty.push(Buffer.from([0x1c])), 2500);
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0, 'survived the gap keystroke (no exit 4)');
  const attachCount = seen.filter((s) => s.url.startsWith('/api/attach/')).length;
  assert.ok(attachCount >= 2, `reconnected (saw ${attachCount})`);
  assert.ok(state.inputStatuses.includes(403), 'gap keystroke 403d');
  assert.ok(state.inputStatuses.includes(200), 'post-reconnect keystroke flowed');
  server.close();
});

test('attach: a stale-token 403 on input is swallowed (not fatal)', async () => {
  // MF1: every /api/input 403s (holder changed underneath us). A viewer typing
  // into a stolen session sees silent no-ops, matching the GUI — never exit 4.
  const { server, state } = attachStub({ input403: true });
  const port = await listen(server);
  const tty = fakeTty();
  setTimeout(() => tty.push(Buffer.from('ls\r')), 40);   // 403, swallowed
  setTimeout(() => tty.push(Buffer.from([0x1c])), 120);  // then detach cleanly
  const { code } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 0, 'a 403 input did not tear down the attach');
  assert.ok(state.inputStatuses.includes(403), 'input actually 403d');
  server.close();
});

test('attach: a 404 on the session → give up, terminal restored, exit 5', async () => {
  const { server } = attachStub({ attach404: true });
  const port = await listen(server);
  const tty = fakeTty();
  const { code } = await attachCli('ghost', [], port, tty.tty);
  assert.strictEqual(code, 5); // NOTFOUND — no endless reconnect on a definitive 404
  // Raw mode is never entered (no replay ever arrived), so nothing to restore.
  server.close();
});

test('attach: non-TTY stdin/stdout → USAGE with a scripting hint', async () => {
  const { server } = attachStub({});
  const port = await listen(server);
  const tty = fakeTty();
  tty.tty.isInTTY = false;
  const { code, stderr } = await attachCli('bash', [], port, tty.tty);
  assert.strictEqual(code, 2);
  assert.match(stderr, /attach needs a terminal/);
  server.close();
});

test('attach: detach exits 0 and kills the tunnel child (real proxy child)', async () => {
  const fs = require('node:fs');
  const { server } = attachStub({});
  const stubPort = await listen(server);
  // A REAL detached tunnel child: a TCP proxy that listens on the substituted
  // {port} and forwards to the stub, so the wire genuinely rides the tunnel and
  // we can assert the child is reaped on detach. A tunnel transport is a STORED
  // context (not a --tunnel flag), so seed a temp contexts file.
  const proxy = `const net=require('net');const local=+process.argv[1],remote=${stubPort};`
    + `net.createServer(c=>{const u=net.connect(remote,'127.0.0.1');c.pipe(u);u.pipe(c);c.on('error',()=>{});u.on('error',()=>{});})`
    + `.listen(local,'127.0.0.1');setInterval(()=>{},1000);`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-attach-'));
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
  let stdout = '', stderr = '';
  const code = await run(['attach', 'bash', '--ctx', 'tun'], {
    stdout: (s) => (stdout += s), stderr: (s) => (stderr += s),
    env: {}, contextsFile: cf, tty: tty.tty, spawnFn,
  });
  assert.strictEqual(code, 0);
  assert.match(tty.err(), /attached to bash/);
  assert.deepStrictEqual(tty.rawLog, [true, false]);   // raw mode restored
  // withWire's finally group-killed the tunnel child on detach.
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(child && (child.killed === true || child.exitCode != null || child.signalCode != null),
    'tunnel child was reaped on detach');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  server.close();
});
