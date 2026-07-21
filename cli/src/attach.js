// attach.js — `clodexctl attach NAME` — ssh-for-agents: a live terminal on any
// session, on any node, through any transport. Reads the attach SSE (scrollback
// replay + raw output frames), forwards local keystrokes to /api/input, and
// mirrors the terminal geometry. Ctrl-\ (0x1c) detaches and is NEVER forwarded.
//
// The one rule that makes this safe: EVERY terminal-state mutation (raw mode,
// SGR reset) is paired with its restoration in a finally that runs on every exit
// path — detach, signal, server drop, or throw. The tunnel child is reaped by
// main.js's withWire finally; we only own the local TTY and the wire streams.
//
// Zero deps: raw mode via process.stdin.setRawMode (node:tty), no keypress lib.
'use strict';

const os = require('os');
const { CliError, EXIT } = require('./errors');
const { openGuarded } = require('./sse-guard');

const DETACH = 0x1c; // Ctrl-\ — SIGQUIT byte; nobody types it on purpose, so we
                     // claim it as the detach escape (documented: unavailable
                     // to the remote — a single-byte escape, no chord state).

// Reset the local screen without a full RIS (\x1bc), which would clobber the
// operator's terminal modes harder than we need. Clear screen + scrollback.
const RESET = '\x1b[H\x1b[2J\x1b[3J';
const SGR_RESET = '\x1b[0m';

// Wire resize bounds (remote.js /api/resize): 20≤cols≤500, 5≤rows≤300.
function clampDims(cols, rows) {
  const c = Math.max(20, Math.min(500, cols | 0));
  const r = Math.max(5, Math.min(300, rows | 0));
  return { cols: c, rows: r };
}

// Split a stdin chunk at the FIRST detach byte. Bytes before it are forwarded;
// the escape itself is dropped; `hit` signals a detach. Byte-level on purpose:
// 0x1c never appears inside a UTF-8 multibyte sequence (continuation bytes are
// 0x80–0xBF, leads 0xC0+), so multibyte input straddling the scan survives.
function scanEscape(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const idx = b.indexOf(DETACH);
  if (idx === -1) return { before: b, hit: false };
  return { before: b.slice(0, idx), hit: true };
}

// A trailing-debounce, dedup-last resize sender. SIGWINCH can burst; we only
// send after it settles, and never re-send an unchanged geometry.
function makeResizeSender({ send, timers = { setTimeout, clearTimeout }, delayMs = 150 } = {}) {
  let handle = null;
  let lastKey = null;
  let pending = null;
  const trigger = (cols, rows) => {
    pending = clampDims(cols, rows);
    if (handle != null) timers.clearTimeout(handle);
    handle = timers.setTimeout(() => {
      handle = null;
      const key = `${pending.cols}x${pending.rows}`;
      if (key === lastKey) return;
      lastKey = key;
      send(pending.cols, pending.rows);
    }, delayMs);
  };
  const stop = () => { if (handle != null) { timers.clearTimeout(handle); handle = null; } };
  // Reset the dedup memory so a reconnect re-sends geometry even if unchanged.
  const forget = () => { lastKey = null; };
  return { trigger, stop, forget };
}

// A terminal seam over process.* — io.tty overrides it wholesale for tests.
function makeTerm(io = {}) {
  if (io.tty) return io.tty;
  const stdin = process.stdin;
  const stdout = process.stdout;
  return {
    isInTTY: !!stdin.isTTY,
    isOutTTY: !!stdout.isTTY,
    size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
    setRawMode: (on) => { if (stdin.setRawMode) stdin.setRawMode(on); },
    onData: (fn) => { stdin.on('data', fn); return () => stdin.off('data', fn); },
    onResize: (fn) => { stdout.on('resize', fn); return () => stdout.off('resize', fn); },
    onSignal: (fn) => {
      process.on('SIGINT', fn); process.on('SIGTERM', fn);
      return () => { process.off('SIGINT', fn); process.off('SIGTERM', fn); };
    },
    resume: () => { if (stdin.resume) stdin.resume(); },
    pause: () => { if (stdin.pause) stdin.pause(); },
    writeOut: (s) => stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
  };
}

// The attach verb. Dispatched through main.withWire, so `client` is a ready
// WireClient (transport open) and the tunnel child dies in withWire's finally.
async function attach({ client, ctx, flags, args, io = {} }) {
  const name = requireAttachName(args && args[0]);
  const term = makeTerm(io);
  const readOnly = !!flags['read-only'];
  const ctxLabel = (ctx && ctx.name) || 'context';
  const clientLabel = `clodexctl@${os.hostname()}`;

  // 1. Preconditions — attach is for a human at a keyboard; scripting uses run/logs.
  if (!term.isInTTY || !term.isOutTTY) {
    throw new CliError(EXIT.USAGE, 'attach needs a terminal — use `run` or `logs` for scripting');
  }

  let rawOn = false;
  let token = null;         // control token while we hold it
  let bannerShown = false;
  let offData = null, offResize = null, offSignal = null;
  let resizer = null;
  let guard = null;
  let detaching = false;

  // Acquire control + push our geometry. Runs on first connect and every
  // reconnect (server contract: re-acquire, re-resize). A failure here bubbles
  // to openGuarded's onOpen catch → treated as a retryable drop.
  const acquireAndResize = async () => {
    if (readOnly) return;
    const acq = await client.post(`/api/control/${encodeURIComponent(name)}`, 'attach (acquire control)', { action: 'acquire', client: clientLabel });
    token = acq.token;
    const { cols, rows } = clampDims(term.size().cols, term.size().rows);
    await client.post(`/api/resize/${encodeURIComponent(name)}`, 'attach (resize)', { token, cols, rows });
    if (resizer) resizer.forget(); // force the next SIGWINCH to re-send
  };

  const releaseControl = async () => {
    if (!token) return;
    const t = token; token = null;
    try { await client.post(`/api/control/${encodeURIComponent(name)}`, 'attach (release control)', { action: 'release', token: t }); } catch {}
  };

  // The single teardown. Idempotent; restores EVERY terminal mutation first,
  // then releases control, then resolves. Reached on Ctrl-\, a signal, server
  // give-up, or an error — one path, always.
  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  const teardown = (err) => {
    if (detaching) return;
    detaching = true;
    try { if (offData) offData(); } catch {}
    try { if (offResize) offResize(); } catch {}
    try { if (offSignal) offSignal(); } catch {}
    try { if (resizer) resizer.stop(); } catch {}
    try { if (guard) guard.close(); } catch {}
    // Restore the terminal BEFORE anything that could throw/await further.
    try { if (rawOn) { term.setRawMode(false); rawOn = false; } } catch {}
    try { term.writeOut(SGR_RESET); term.writeOut('\n'); } catch {}
    try { term.pause(); } catch {}
    // Release is best-effort and async — don't block the exit on it.
    releaseControl().finally(() => {
      if (err) { rejectDone(err); }
      else { try { term.writeErr(`detached from ${name}\n`); } catch {} resolveDone(); }
    });
  };

  // stdin → wire. Scan for the detach escape; forward the bytes before it (only
  // when we hold control), drop the escape, detach on hit. In --read-only we
  // still scan (so Ctrl-\ detaches) but never forward.
  //
  // The input POST is failure-tolerant, exactly like the resize sender: a
  // transport blip (CONNECT) or a stale-token 403 (the server auto-releases
  // control on a clean SSE close — remote.js:493-498) must NOT be fatal. The
  // guard owns stream health; it reconnects + re-acquires and later keystrokes
  // flow again. We swallow the failure silently (a stderr note would corrupt
  // the raw screen) and drop the keystroke — v1: the user retypes.
  const onStdin = (chunk) => {
    const { before, hit } = scanEscape(chunk);
    if (before.length && !readOnly && token) {
      client.post(`/api/input/${encodeURIComponent(name)}`, 'attach (input)', { token, data: before.toString('utf8') })
        .catch(() => {});
    }
    if (hit) teardown(null);
  };

  // Wire the local terminal ONCE (first connect). Raw mode goes on only after
  // the banner is printed.
  const wireTerminal = () => {
    if (offData) return;
    resizer = makeResizeSender({
      send: (cols, rows) => {
        if (!token) return;
        client.post(`/api/resize/${encodeURIComponent(name)}`, 'attach (resize)', { token, cols, rows }).catch(() => {});
      },
    });
    term.setRawMode(true); rawOn = true;
    term.resume();
    offData = term.onData(onStdin);
    offResize = term.onResize(() => { const s = term.size(); resizer.trigger(s.cols, s.rows); });
    offSignal = term.onSignal(() => teardown(null));
  };

  guard = openGuarded(client, `/api/attach/${encodeURIComponent(name)}`, 'attach', {
    onEvent: (event, data) => {
      if (event === 'replay') {
        // 3. Banner (once, before raw mode). 4. Reset + scrollback on every replay.
        if (!bannerShown) {
          bannerShown = true;
          const suffix = readOnly ? ' (read-only)'
            : (data && data.holder != null ? ` (taking control from ${data.holder})` : '');
          term.writeErr(`attached to ${name} on ${ctxLabel} — Ctrl-\\ detaches${suffix}\n`);
        }
        try { term.writeOut(RESET); } catch {}
        if (data && typeof data.b64 === 'string') { try { term.writeOut(Buffer.from(data.b64, 'base64').toString('utf8')); } catch {} }
        // Arm the local terminal once, after the first banner.
        if (!offData) wireTerminal();
        return;
      }
      if (event === 'output' && data && typeof data.b64 === 'string') {
        try { term.writeOut(Buffer.from(data.b64, 'base64').toString('utf8')); } catch {}
        return;
      }
      // telemetry + anything else: ignored in v1.
    },
    onOpen: acquireAndResize,     // acquire+resize on connect AND each reconnect
    onNotice: (attemptNo) => { try { term.writeErr(`\r\nclodexctl: attach connection lost — reconnecting (attempt ${attemptNo})…\r\n`); } catch {} },
    onGiveUp: (err) => teardown(err),
  });

  return done;
}

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
function requireAttachName(name) {
  if (name == null || name === '') throw new CliError(EXIT.USAGE, 'attach needs a session name');
  if (!NAME_RE.test(name)) throw new CliError(EXIT.USAGE, `bad session name "${name}" — allowed [a-zA-Z0-9._-], 1-64 chars`);
  return name;
}

module.exports = { attach, scanEscape, clampDims, makeResizeSender, makeTerm };
