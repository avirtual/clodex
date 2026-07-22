// port-forward.js — `clodexctl port-forward LOCAL:REMOTE` — a kubectl-style
// foreground tunnel to an ARBITRARY remote port on the node, over whatever
// transport the context carries (ssh -L, ssm StartPortForwarding, kubectl,
// gcloud IAP, az bastion, or a custom {port} argv). Generalizes the T36g tunnel
// machinery (transport.js) beyond the wire port: the wire verbs always forward
// ctx.remotePort; this forwards a remote port you name.
//
// Foreground hold: open the tunnel, print the local address once, then block
// until Ctrl-C (exit 0) or the tunnel child dies (exit CONNECT with its stderr).
// Single-shot — no reconnect: a dropped tunnel ends the session with a clear
// error rather than silently masking a dead node (attach reconnects because a
// human is mid-keystroke; a port-forward's consumer reconnects itself).
//
// url-kind (direct http) contexts have no tunnel to ride → honest USAGE error.
// The LOCAL end always binds 127.0.0.1 (transport.js's ssh -L / cloud templates
// all target loopback locals).
//
// Standalone by construction: node:* + sibling modules only, never an app file.
'use strict';

const { CliError, EXIT } = require('./errors');
const { openTransport, DEFAULT_REMOTE_PORT } = require('./transport');
const contexts = require('./contexts');
const { entryTarget } = require('./verbs');

// Parse `LOCAL:REMOTE`. LOCAL is a positive port int. REMOTE is a positive port
// int OR the keyword `web` (sugar for the node's web-GUI port). Exactly one ':'.
function parseForwardSpec(spec, ctx) {
  const s = String(spec == null ? '' : spec).trim();
  if (!s) throw new CliError(EXIT.USAGE, 'port-forward needs LOCAL:REMOTE (e.g. 8080:7900 or 8080:web)');
  const colon = s.indexOf(':');
  if (colon < 0 || colon !== s.lastIndexOf(':') || colon === 0 || colon === s.length - 1) {
    throw new CliError(EXIT.USAGE, `port-forward spec must be LOCAL:REMOTE (one colon, both halves non-empty), got "${s}"`);
  }
  const localStr = s.slice(0, colon);
  const remoteStr = s.slice(colon + 1);
  const local = toPort(localStr, 'LOCAL');
  let remote;
  if (remoteStr === 'web') {
    // The node's web GUI: an explicit ctx.webPort if a part-2 deploy saved one,
    // else the documented default of wire-port + 1.
    remote = (ctx && ctx.webPort) ? (ctx.webPort | 0) : ((ctx && ctx.remotePort ? (ctx.remotePort | 0) : DEFAULT_REMOTE_PORT) + 1);
  } else {
    remote = toPort(remoteStr, 'REMOTE');
  }
  return { local, remote, remoteLabel: remoteStr === 'web' ? `web(${remote})` : String(remote) };
}

function toPort(v, side) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new CliError(EXIT.USAGE, `${side} port must be an integer 1-65535, got "${v}"`);
  }
  return n;
}

// A signal seam over process.* — io.onSignal overrides it wholesale for tests.
// Returns an off() the caller runs in its teardown. SIGINT (Ctrl-C), SIGTERM
// (systemd/kill) and SIGHUP (controlling terminal died) all exit 0 by design: a
// foreground hold has nothing to flush, so any orderly stop is a clean shutdown.
// SIGHUP MUST be handled: its default disposition kills us without running the
// finally that closes the tunnel, so the detached child (own process group)
// reparents to init and keeps serving the forward — an orphan listener.
function installSignal(io, cb) {
  if (io && io.onSignal) return io.onSignal(cb);
  const h = () => cb();
  process.on('SIGINT', h); process.on('SIGTERM', h); process.on('SIGHUP', h);
  return () => { process.off('SIGINT', h); process.off('SIGTERM', h); process.off('SIGHUP', h); };
}

// The verb. Dispatched from main.js OUTSIDE withWire — it needs the resolved ctx
// and a foreground hold, not a WireClient (there is no request/response here,
// just a held tunnel).
async function portForward({ flags, args, printer, io = {} }) {
  const store = safeLoad(io);
  const ctx = contexts.resolve(store, { ctxName: flags.ctx || null, env: io.env || process.env, flags });

  if (ctx.url) {
    throw new CliError(EXIT.USAGE,
      'port-forward needs a tunnel context (ssh/ssm/kubectl/gcloud/az/tunnel) — a url context speaks http directly, there is nothing to forward');
  }

  const { local, remote, remoteLabel } = parseForwardSpec(args && args[0], ctx);

  // Signals are armed BEFORE the tunnel child exists: an SSM/ssh tunnel takes
  // seconds to bind, and a Ctrl-C in that window under the default disposition
  // would kill us without ever closing the (detached, own-group) child — the
  // orphan-listener leak. With the handler up first, an early signal races the
  // open below and the late-arriving transport is closed on landing.
  let offSignal = null;
  const stopped = new Promise((resolve) => {
    offSignal = installSignal(io, () => resolve({ reason: 'signal' }));
  });

  // Forward `remote` instead of the wire's remotePort by handing openTransport a
  // ctx whose remotePort IS the target; localPort pins the caller's LOCAL end.
  const forwardCtx = { ...ctx, remotePort: remote };
  const open = io.openTransport || openTransport;
  const openP = open(forwardCtx, { spawnFn: io.spawnFn, execFn: io.execFn, localPort: local });

  let t = null;
  try {
    const raced = await Promise.race([openP.then((tr) => ({ t: tr })), stopped]);
    if (raced.reason === 'signal') {
      // Signal beat the open. The open is still in flight — close its transport
      // whenever it lands (or swallow its failure); then a clean exit 0.
      openP.then((tr) => { try { tr.close(); } catch {} }).catch(() => {});
      return;
    }
    t = raced.t;

    const target = entryTarget(ctx) || (ctx.name || 'node');
    const bound = t.localPort || local;
    // io.onBound is the reuse seam for the `web` verb: same tunnel machinery, a
    // different "it's up" announcement (a browser URL + a best-effort pop). Absent
    // (the port-forward path) → the plain forwarding line, behavior unchanged.
    if (io.onBound) io.onBound({ bound, target, remote, remoteLabel, printer });
    else printer.line(`forwarding 127.0.0.1:${bound} -> ${target}:${remoteLabel} — Ctrl-C to stop`);

    // Foreground hold: whichever fires first wins. A signal = clean stop (exit 0);
    // the tunnel child exiting = the node/tunnel dropped (exit CONNECT with stderr).
    const childGone = t.waitExit().then(() => ({ reason: 'exit' }));
    const outcome = await Promise.race([stopped, childGone]);
    if (outcome.reason === 'exit') {
      const err = (t.stderr && t.stderr()) || '';
      throw new CliError(EXIT.CONNECT, `tunnel closed${err ? `:\n${err}` : ''}`);
    }
    // signal: fall through to a clean exit
  } finally {
    try { if (offSignal) offSignal(); } catch {}
    try { if (t) t.close(); } catch {}
  }
}

function safeLoad(io) {
  try { return contexts.load(io.contextsFile, { warn: () => {} }); }
  catch { return { current: null, contexts: {} }; }
}

module.exports = { portForward, parseForwardSpec, installSignal };
