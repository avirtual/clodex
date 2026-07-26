// Tunnel supervisor — Clodex-managed port forwards for peered Clodexes, so
// "add a peer" is just a destination, not homework. One tunnel per peer that
// has a DIALABLE transport; the local port is picked fresh on every (re)start
// and the peer client is pointed at it via onState.
//
// Two transports, one supervisor (t32 step 1):
//   sshHost — the built-in `ssh -N -L` forward, unchanged since day one.
//   ssm     — AWS SSM port-forwarding, argv built by cli/src/transport.js's
//             `ssmArgv` + `substitutePort`. The argv builder is IMPORTED, not
//             re-implemented, so the GUI and the CLI cannot drift into two
//             different ideas of how to dial the same box. Only the DATA
//             (target/region/profile) lives in the peer record — an executable
//             argv is never persisted by this side.
//
// Supervision model mirrors the peer connections themselves: a dead tunnel
// is CALM (laptops sleep, wifi drops) — restart with capped backoff, no
// error toasts. The last ssh stderr line is kept so a genuine misconfig
// (key rejected, unknown host) is diagnosable in the UI, not silently
// identical to "asleep".
//
// Auth is key-based only (BatchMode=yes): Clodex never proxies an
// interactive password/hostkey dialog. StrictHostKeyChecking=accept-new
// keeps first contact friction-free (TOFU, same trust move as answering
// "yes" once by hand) while still failing loudly on a CHANGED key.
//
// spawnFn is injectable for tests; production uses child_process.spawn.

'use strict';

const net = require('net');
const { spawn } = require('child_process');
// The CLI's argv builders, reused verbatim. cli/ ships in the DMG (build.files,
// t32 step 0), so this require resolves in a packaged app as well as a checkout;
// the leaf direction is unchanged — cli/ never requires an app file.
const { ssmArgv, substitutePort } = require('./cli/src/transport');

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;
// A tunnel that survived this long was genuinely up — reset backoff.
const STABLE_MS = 30000;

const SSH_BASE_ARGS = [
  '-N',
  '-o', 'BatchMode=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=2',
  '-o', 'ConnectTimeout=10',
];

// Destination equality for an ssm block — field-by-field, because a changed
// region or profile dials a DIFFERENT box and must restart the tunnel, not be
// waved through by an identity comparison of two freshly-built objects.
function sameSsm(a, b) {
  if (!a || !b) return !a && !b;
  return a.target === b.target && (a.region || null) === (b.region || null)
    && (a.profile || null) === (b.profile || null);
}

function pickFreePort(cb) {
  const srv = net.createServer();
  srv.on('error', () => cb(null));
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    srv.close(() => cb(port));
  });
}

class Tunnel {
  constructor({ id, sshHost, ssm, remotePort, spawnFn, onState }) {
    this.id = id;
    this.sshHost = sshHost || null;
    this.ssm = ssm || null;
    this.remotePort = remotePort || 7900;
    this._spawn = spawnFn || spawn;
    this._onState = onState || (() => {});
    this.localPort = null;
    this.state = 'down';             // 'up' | 'down'
    this.lastError = null;
    this._child = null;
    this._timer = null;
    this._backoff = BACKOFF_MIN_MS;
    this._stopped = false;
  }

  start() {
    this._stopped = false;
    this._spawnTunnel();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    this._timer = null;
    this._killChild();
    this.localPort = null;
    this._setState('down');
  }

  status() {
    return {
      id: this.id, sshHost: this.sshHost,
      // The dialled destination, for the UI — the DATA, never an argv.
      ...(this.ssm ? { ssm: { ...this.ssm } } : {}),
      remotePort: this.remotePort,
      state: this.state, localPort: this.localPort, error: this.lastError,
    };
  }

  url() { return this.state === 'up' && this.localPort ? `http://127.0.0.1:${this.localPort}` : null; }

  // ssh's argv TAIL (no leading 'ssh'), kept as-is for the original call shape.
  args(localPort) {
    return [...SSH_BASE_ARGS, '-L', `${localPort}:127.0.0.1:${this.remotePort}`, this.sshHost];
  }

  // The full argv INCLUDING the command word, per transport. Synchronous by
  // construction: both arms are pure string assembly. `ssm.ecs` would break that
  // (it needs two awaited `aws` reads to learn its target), which is exactly why
  // this pass admits `ssm.target` only — see sanitizePeerSsm in stores.js.
  argv(localPort) {
    if (this.ssm) return substitutePort(ssmArgv(this.ssm, this.remotePort), localPort);
    return ['ssh', ...this.args(localPort)];
  }

  // aws forks a session-manager-plugin helper that a plain child-kill orphans,
  // so an ssm child leads its own process group and is killed by group (the same
  // reasoning, and the same > 0 pid guard, as cli/src/transport.js's close()).
  // ssh needs none of that and keeps its original non-detached spawn exactly.
  _detached() { return !!this.ssm; }

  _killChild() {
    const child = this._child;
    if (!child) return;
    this._child = null;
    try {
      if (this._detached() && child.pid > 0) {
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch { try { child.kill('SIGTERM'); } catch {} }
      } else {
        child.kill();
      }
    } catch {}
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    try { this._onState(this.id, this.status()); } catch {}
  }

  _spawnTunnel() {
    if (this._stopped || this._child) return;
    pickFreePort((port) => {
      if (this._stopped) return;
      if (!port) { this.lastError = 'no free local port'; return this._scheduleRestart(); }
      this.localPort = port;
      let child;
      let cmdName = this.ssm ? 'aws' : 'ssh';   // named in errors even if argv() throws
      try {
        const [cmd, ...rest] = this.argv(port);
        cmdName = cmd;
        child = this._spawn(cmd, rest, {
          stdio: ['ignore', 'ignore', 'pipe'],
          ...(this._detached() ? { detached: true } : {}),
        });
      } catch (e) {
        this.lastError = e.message;
        return this._scheduleRestart();
      }
      this._child = child;
      const bornAt = Date.now();
      let stderrTail = '';
      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-500);
        });
      }
      child.on('error', (e) => {           // spawn failure (binary missing)
        // A missing vendor CLI is the common ssm misconfig and reads as a bare
        // ENOENT otherwise — name the binary, same copy as cli/src/transport.js.
        this.lastError = (e && (e.code === 'ENOENT' || /ENOENT/.test(e.message || '')))
          ? `${cmdName}: command not found — is ${cmdName} installed and on PATH?`
          : e.message;
        this._child = null;
        this._scheduleRestart();
      });
      child.on('exit', (code) => {
        this._child = null;
        this.localPort = null;
        const line = stderrTail.trim().split('\n').pop() || '';
        this.lastError = line || (code === 0 ? null : `${cmdName} exited (${code})`);
        if (Date.now() - bornAt > STABLE_MS) this._backoff = BACKOFF_MIN_MS;
        this._scheduleRestart();
      });
      // ssh -N prints nothing on success and the aws session plugin's chatter
      // is ignorable; the process being alive IS the tunnel. Whether the far end
      // actually answers is the peer client's hello loop's job — this layer only
      // supervises the transport.
      this._setState('up');
    });
  }

  _scheduleRestart() {
    this._setState('down');
    if (this._stopped) return;
    const delay = this._backoff;
    this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX_MS);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this._spawnTunnel(); }, delay);
  }
}

class TunnelManager {
  constructor({ spawnFn, onState } = {}) {
    this._spawnFn = spawnFn || null;
    this._onState = onState || (() => {});
    this._tunnels = new Map();       // peerId -> Tunnel
  }

  // peers: full settings entries; only those with a DIALABLE transport (sshHost
  // or a typed cloud kind) get tunnels. A change to the destination — host, ssm
  // target/region/profile, or the remote port — restarts that tunnel.
  sync(peers) {
    const wanted = new Map();
    for (const p of Array.isArray(peers) ? peers : []) {
      if (!p || !p.id) continue;
      const remotePort = Number.isInteger(p.remotePort) ? p.remotePort : 7900;
      if (p.sshHost) {
        wanted.set(String(p.id), { sshHost: String(p.sshHost), ssm: null, remotePort });
      } else if (p.ssm && p.ssm.target) {
        // Copy the fields we dial with, so a later mutation of the settings
        // object can't silently change a running tunnel's identity.
        const { target, region, profile } = p.ssm;
        wanted.set(String(p.id), {
          sshHost: null,
          ssm: { target: String(target), ...(region ? { region: String(region) } : {}), ...(profile ? { profile: String(profile) } : {}) },
          remotePort,
        });
      }
    }
    for (const [id, tun] of this._tunnels) {
      const w = wanted.get(id);
      if (!w || w.sshHost !== tun.sshHost || w.remotePort !== tun.remotePort
          || !sameSsm(w.ssm, tun.ssm)) {
        tun.stop();
        this._tunnels.delete(id);
      }
    }
    for (const [id, w] of wanted) {
      if (!this._tunnels.has(id)) {
        const tun = new Tunnel({ id, ...w, spawnFn: this._spawnFn, onState: this._onState });
        this._tunnels.set(id, tun);
        tun.start();
      }
    }
  }

  urlFor(id) {
    const tun = this._tunnels.get(String(id));
    return tun ? tun.url() : null;
  }

  statuses() { return [...this._tunnels.values()].map((t) => t.status()); }

  stopAll() {
    for (const tun of this._tunnels.values()) tun.stop();
    this._tunnels.clear();
  }
}

module.exports = { TunnelManager, Tunnel };
