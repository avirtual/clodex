// web.js — `clodexctl web [ctx]` — the headline verb for the node's browser GUI.
// A dedicated, friendly wrapper over the SAME foreground-tunnel machinery
// port-forward uses (T42): it opens a tunnel to the node's web-GUI port
// (ctx.webPort saved by a part-2 deploy, else wire-port+1), binds a local port,
// prints http://127.0.0.1:PORT prominently, and best-effort pops your browser.
//
// It does NOT duplicate the tunnel/hold logic — it calls portForward() with a
// `LOCAL:web` spec (reusing its `web` sugar + foreground hold + signal handling)
// and only overrides the "it's up" announcement via the io.onBound seam. The URL
// is the contract; the browser pop is sugar (silent on failure, skipped under
// --no-open or when stdout is not a TTY, e.g. a script holding the tunnel open).
//
// Standalone by construction: node:* + sibling modules only, never an app file.
'use strict';

const net = require('net');
const { spawn } = require('child_process');
const { CliError, EXIT } = require('./errors');
const { portForward } = require('./port-forward');

// Local-port policy: --port pins it (honest failure if taken); otherwise the
// first free port in 8080..8090, falling back to 8080 if the whole range is
// busy (openTransport then surfaces the real EADDRINUSE).
const LOCAL_RANGE_START = 8080;
const LOCAL_RANGE_END = 8090;

// Probe a single 127.0.0.1:port for availability by trying to listen on it.
function portFree(port, listenFn = defaultListen) {
  return listenFn(port);
}
function defaultListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function pickLocalPort(io) {
  const listenFn = io.probeListen || defaultListen;
  for (let p = LOCAL_RANGE_START; p <= LOCAL_RANGE_END; p++) {
    if (await portFree(p, listenFn)) return p;
  }
  return LOCAL_RANGE_START; // range busy — let openTransport report the conflict
}

// Best-effort browser pop. darwin → `open`, linux → `xdg-open`; anything else is
// a no-op. Fully detached + swallowed: the URL is already printed, the pop is
// sugar and must never fail the hold or leak a spawn error onto the trail.
function openBrowser(url, io = {}) {
  const platform = io.platform || process.platform;
  const cmd = platform === 'darwin' ? 'open' : (platform === 'linux' ? 'xdg-open' : null);
  if (!cmd) return;
  try {
    const spawnFn = io.spawnFn || spawn;
    const child = spawnFn(cmd, [url], { stdio: 'ignore', detached: true });
    if (child && typeof child.unref === 'function') child.unref();
    if (child && typeof child.on === 'function') child.on('error', () => {});
  } catch { /* best-effort */ }
}

// The verb. Picks the local port, then delegates to portForward with a
// `LOCAL:web` spec and an onBound announcement that prints the URL + pops the
// browser. --no-open (or a non-TTY stdout) suppresses only the pop.
async function web({ flags, args, printer, io = {} }) {
  // `web` takes an optional ctx positional (args[0]); the ctx itself is resolved
  // by portForward from --ctx/flags, so a positional ctx maps to --ctx.
  const ctxName = (args && args[0]) || flags.ctx || null;

  let local;
  if (flags.port != null) {
    const n = Number(flags.port);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new CliError(EXIT.USAGE, `--port must be an integer 1-65535, got "${flags.port}"`);
    }
    local = n;
  } else {
    local = await pickLocalPort(io);
  }

  // stdout TTY gate for the browser pop (a script holding the tunnel open must
  // not spawn a browser). io.isTTY is the test seam; else process.stdout.isTTY.
  const isTTY = io.isTTY != null ? io.isTTY : !!(process.stdout && process.stdout.isTTY);
  const wantOpen = !flags['no-open'] && isTTY;

  const onBound = ({ bound }) => {
    const url = `http://127.0.0.1:${bound}`;
    printer.line('');
    printer.line(`  Clodex web GUI:  ${url}`);
    printer.line('');
    printer.line('  Ctrl-C to stop the tunnel.');
    if (wantOpen) openBrowser(url, io);
  };

  // Reuse portForward wholesale: the `web` sugar resolves REMOTE = ctx.webPort ||
  // wire+1, and its foreground hold + signal handling are exactly what we want.
  // probe: the remote IS an HTTP GUI, so the silent-death keep-alive probe is
  // always on — a dead data channel ends the hold honestly instead of leaving a
  // browser tab pointed at a zombie tunnel. io.probe passes through for tests.
  await portForward({
    flags: { ...flags, ctx: ctxName },
    args: [`${local}:web`],
    printer,
    io: { ...io, onBound, probe: io.probe != null ? io.probe : true },
  });
}

module.exports = { web, pickLocalPort, openBrowser, LOCAL_RANGE_START, LOCAL_RANGE_END };
