// Tunnel supervisor — Clodex-managed `ssh -N -L` forwards for peered
// Clodexes, so "add a peer" is just an ssh host, not homework. One tunnel
// per peer that has an sshHost configured; the local port is picked fresh
// on every (re)start and the peer client is pointed at it via onState.
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

function pickFreePort(cb) {
  const srv = net.createServer();
  srv.on('error', () => cb(null));
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    srv.close(() => cb(port));
  });
}

class Tunnel {
  constructor({ id, sshHost, remotePort, spawnFn, onState }) {
    this.id = id;
    this.sshHost = sshHost;
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
    if (this._child) { try { this._child.kill(); } catch {} this._child = null; }
    this.localPort = null;
    this._setState('down');
  }

  status() {
    return {
      id: this.id, sshHost: this.sshHost, remotePort: this.remotePort,
      state: this.state, localPort: this.localPort, error: this.lastError,
    };
  }

  url() { return this.state === 'up' && this.localPort ? `http://127.0.0.1:${this.localPort}` : null; }

  args(localPort) {
    return [...SSH_BASE_ARGS, '-L', `${localPort}:127.0.0.1:${this.remotePort}`, this.sshHost];
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
      try {
        child = this._spawn('ssh', this.args(port), { stdio: ['ignore', 'ignore', 'pipe'] });
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
      child.on('error', (e) => {           // spawn failure (no ssh binary)
        this.lastError = e.message;
        this._child = null;
        this._scheduleRestart();
      });
      child.on('exit', (code) => {
        this._child = null;
        this.localPort = null;
        const line = stderrTail.trim().split('\n').pop() || '';
        this.lastError = line || (code === 0 ? null : `ssh exited (${code})`);
        if (Date.now() - bornAt > STABLE_MS) this._backoff = BACKOFF_MIN_MS;
        this._scheduleRestart();
      });
      // ssh -N prints nothing on success; the process being alive IS the
      // tunnel. Whether the far end actually answers is the peer client's
      // hello loop's job — this layer only supervises the transport.
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

  // peers: full settings entries; only those with sshHost get tunnels.
  // Host/port change = restart that tunnel.
  sync(peers) {
    const wanted = new Map();
    for (const p of Array.isArray(peers) ? peers : []) {
      if (!p || !p.id || !p.sshHost) continue;
      wanted.set(String(p.id), { sshHost: String(p.sshHost), remotePort: Number.isInteger(p.remotePort) ? p.remotePort : 7900 });
    }
    for (const [id, tun] of this._tunnels) {
      const w = wanted.get(id);
      if (!w || w.sshHost !== tun.sshHost || w.remotePort !== tun.remotePort) {
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
