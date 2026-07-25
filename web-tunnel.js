// web-tunnel.js — on-demand `ssh -N -L` forwards to a PEER'S WEB FRONTEND, so
// "look at that box's GUI" is a click instead of a hand-run ssh command. A
// sibling of peer-tunnel.js, deliberately NOT the same object: the peer tunnel
// carries Clodex's own wire and exists for as long as the peer does, while this
// one exists because a human asked to look at a GUI. Three inversions follow
// from that, and each is the reason this module is separate:
//
//   1. THE LOCAL PORT IS PINNED. Tunnel._spawnTunnel picks a fresh free port on
//      every respawn (peer-tunnel.js:99) — fine there, because the only consumer
//      is the peer client, which is re-pointed through onState. Our consumer is a
//      browser tab in an application Clodex does not own and cannot re-point. A
//      re-picked port would leave that tab pointing at nothing after the first
//      wifi blip. So the port is chosen ONCE, at start, and every respawn re-binds
//      the SAME port; ExitOnForwardFailure=yes (in SSH_BASE_ARGS) turns a port
//      that got taken meanwhile into an honest failure + backoff rather than a
//      silent bind somewhere else.
//   2. THE BROWSER OPENS EXACTLY ONCE, on the first successful up. Respawns do
//      not re-open it: the pin means the tab the operator already has works again
//      the moment the forward is back, and popping a window on every wifi blip
//      would be its own bug. The pop itself is NOT here — this module has no
//      business knowing what a browser is, and under the web frontend the
//      operator's browser is on the far side of a wire. It rides the state event
//      to whoever asked; `firstUp` in the status marks that transition once.
//   3. IT GIVES UP. The peer tunnel retries forever because Clodex needs that
//      connection continuously; a human's attention is bounded, so retrying at a
//      dead box forever leaves a forgotten forward open to a remote machine. After
//      GIVE_UP_MS without ever coming up it stops and reports 'gave-up', which is
//      the only close that needs nobody to do anything.
//
// ssh-only, by ruling: `cli/src/transport.js` could drive SSM/kubectl/gcloud/az,
// but no Clodex peer record can express those transports (sanitizePeers accepts
// url + sshHost and drops everything else), so the capability would have nothing
// to reach. See tasks/peer-web-view/journal.md.
//
// spawnFn is injectable for tests; production uses child_process.spawn.

'use strict';

const net = require('net');
const { spawn } = require('child_process');

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
// Never came up within this long → stop trying (inversion 3). Measured from
// start(), not from the last attempt, so a box that flaps without ever serving
// still terminates.
const GIVE_UP_MS = 120000;
// A spawn that survived this long counts as having genuinely WORKED, and retires
// the give-up clock. The distinction matters because 'up' here means only "the
// ssh process is alive" — ssh -N prints nothing on success, so a forward to an
// unreachable box still reports up for the moment before it dies. Retiring the
// clock on the first 'up' would therefore retire it on essentially every tunnel
// and the cap would never fire. Same threshold and same reasoning as
// peer-tunnel.js's STABLE_MS, used for a different decision.
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

class WebTunnel {
  constructor({ id, sshHost, remotePort, spawnFn, onState, giveUpMs }) {
    this.id = id;
    this.sshHost = sshHost;
    this.remotePort = remotePort;
    this._spawn = spawnFn || spawn;
    this._onState = onState || (() => {});
    this._giveUpMs = Number.isInteger(giveUpMs) ? giveUpMs : GIVE_UP_MS;
    // Scaled with the cap so a test that shortens the window doesn't need a
    // 30-second-stable spawn to exercise the "it worked" branch.
    this._stableMs = Number.isInteger(giveUpMs) ? Math.max(1, Math.floor(giveUpMs / 2)) : STABLE_MS;
    // Pinned for the life of this tunnel — assigned once in _spawnTunnel's first
    // pass and never reassigned, unlike peer-tunnel's per-spawn pick.
    this.localPort = null;
    this.state = 'down';             // 'up' | 'down' | 'gave-up'
    this.lastError = null;
    this._child = null;
    this._timer = null;
    this._backoff = BACKOFF_MIN_MS;
    this._stopped = false;
    this._opened = false;            // browser popped? (inversion 2)
    this._deadline = 0;              // give-up wall-clock (inversion 3)
    this._bornAt = 0;                // current spawn's start, for the stable check
  }

  start() {
    if (!this._stopped && this._child) return;   // already running
    this._stopped = false;
    this._deadline = Date.now() + this._giveUpMs;
    this._spawnTunnel();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    this._timer = null;
    if (this._child) { try { this._child.kill(); } catch {} this._child = null; }
    this._setState('down');
  }

  // `url` is part of the status rather than something a consumer assembles from
  // localPort: assembling it is where a consumer would get it wrong (a port that
  // is pinned but not currently forwarded is not a URL). One producer, one rule.
  status() {
    return {
      id: this.id, sshHost: this.sshHost, remotePort: this.remotePort,
      state: this.state, localPort: this.localPort, error: this.lastError,
      url: this.url(),
    };
  }

  // The ONLY place a web URL comes from. Non-null exclusively while the forward
  // is actually up, so there is no dead placeholder for the UI to render by
  // mistake — the peer tunnel's http://127.0.0.1:1 sentinel has no analogue here.
  url() { return this.state === 'up' && this.localPort ? `http://127.0.0.1:${this.localPort}` : null; }

  args(localPort) {
    return [...SSH_BASE_ARGS, '-L', `${localPort}:127.0.0.1:${this.remotePort}`, this.sshHost];
  }

  // `extra` rides the EMIT only, never the stored status — firstUp is a property
  // of one transition, and a consumer polling status() later must not read it as
  // still true and pop a second browser window.
  _setState(state, extra) {
    if (this.state === state) return;
    this.state = state;
    try { this._onState(this.id, extra ? { ...this.status(), ...extra } : this.status()); } catch {}
  }

  _spawnTunnel() {
    if (this._stopped || this._child) return;
    // Pin on the first pass only; every later attempt reuses it.
    if (this.localPort) return this._spawnOn(this.localPort);
    pickFreePort((port) => {
      if (this._stopped) return;
      if (!port) { this.lastError = 'no free local port'; return this._scheduleRestart(); }
      this.localPort = port;
      this._spawnOn(port);
    });
  }

  _spawnOn(port) {
    if (this._stopped || this._child) return;
    let child;
    try {
      child = this._spawn('ssh', this.args(port), { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      this.lastError = e.message;
      return this._scheduleRestart();
    }
    this._child = child;
    let stderrTail = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-500); });
    }
    child.on('error', (e) => {
      this.lastError = e.message;
      this._child = null;
      this._scheduleRestart();
    });
    this._bornAt = Date.now();
    child.on('exit', (code) => {
      this._child = null;
      const line = stderrTail.trim().split('\n').pop() || '';
      this.lastError = line || (code === 0 ? null : `ssh exited (${code})`);
      // A spawn that lasted counts as a box that genuinely works: reset the
      // backoff AND retire the give-up clock, so later blips are treated as
      // outages rather than as evidence the box was never there.
      if (Date.now() - this._bornAt > this._stableMs) {
        this._backoff = BACKOFF_MIN_MS;
        this._deadline = 0;
      }
      this._scheduleRestart();
    });
    // ssh -N prints nothing on success; the live process IS the forward. Whether
    // the far end serves anything is the browser's problem, not this layer's.
    //
    // firstUp marks the once-per-tunnel transition (inversion 2) — the one emit
    // the browser pop rides. It deliberately does NOT retire the give-up clock:
    // 'up' here means only that the ssh process is alive, and a forward to an
    // unreachable box is briefly 'up' too, so retiring on first up would retire
    // on nearly every tunnel and the cap would never fire. The clock is retired
    // by SURVIVING (the stable check above) instead.
    const firstUp = !this._opened;
    if (firstUp) this._opened = true;
    this._setState('up', firstUp ? { firstUp: true } : null);
  }

  _scheduleRestart() {
    this._setState('down');
    if (this._stopped) return;
    if (this._deadline && Date.now() >= this._deadline) {
      // Never came up in the window — stop, and SAY so. lastError survives into
      // the terminal state so the UI can show why rather than just "down".
      this._stopped = true;
      clearTimeout(this._timer);
      this._timer = null;
      this._setState('gave-up');
      return;
    }
    const delay = this._backoff;
    this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX_MS);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this._spawnTunnel(); }, delay);
  }
}

// One tunnel per peer the operator has explicitly opened — never per peer that
// merely exists. open()/close() are the toggle; sync() prunes tunnels whose peer
// went away or was disabled; stopAll() is app shutdown.
class WebTunnelManager {
  constructor({ spawnFn, onState, giveUpMs } = {}) {
    this._spawnFn = spawnFn || null;
    this._onState = onState || (() => {});
    this._giveUpMs = giveUpMs;
    this._tunnels = new Map();       // peerId -> WebTunnel
  }

  // Open (or re-open) the web tunnel for one peer. remotePort comes from the
  // peer's hello (webHost.port) — a caller with no live webHost has nothing to
  // forward to and gets a refusal rather than a guessed port.
  open({ id, sshHost, remotePort }) {
    const key = String(id);
    if (!sshHost) return { ok: false, error: 'ssh-only: this peer has no ssh host' };
    if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
      return { ok: false, error: 'peer reports no web frontend' };
    }
    const existing = this._tunnels.get(key);
    // A live tunnel to the same place is already the answer. A tunnel to a
    // DIFFERENT place (the box moved its web port, or the peer was re-pointed at
    // another host) is stale: replace it rather than forwarding to the old one.
    if (existing) {
      if (existing.sshHost === sshHost && existing.remotePort === remotePort && existing.state !== 'gave-up') {
        return { ok: true, status: existing.status(), url: existing.url() };
      }
      existing.stop();
      this._tunnels.delete(key);
    }
    const tun = new WebTunnel({
      id: key, sshHost, remotePort,
      spawnFn: this._spawnFn, onState: this._onState, giveUpMs: this._giveUpMs,
    });
    this._tunnels.set(key, tun);
    tun.start();
    return { ok: true, status: tun.status(), url: tun.url() };
  }

  close(id) {
    const key = String(id);
    const tun = this._tunnels.get(key);
    if (!tun) return { ok: true };
    tun.stop();
    this._tunnels.delete(key);
    // A closed tunnel emits its final 'down' through onState; the delete means a
    // later statuses() no longer lists it, which is how the UI learns it is gone.
    try { this._onState(key, { ...tun.status(), state: 'closed' }); } catch {}
    return { ok: true };
  }

  // peers: the same already-filtered list peer-wiring feeds TunnelManager.sync
  // (disabled peers excluded upstream). A tunnel whose peer is no longer in the
  // list — removed, disabled, or its ssh host changed — is closed. Nothing is
  // ever OPENED here: on-demand only.
  sync(peers) {
    const live = new Map();
    for (const p of Array.isArray(peers) ? peers : []) {
      if (p && p.id && p.sshHost) live.set(String(p.id), String(p.sshHost));
    }
    for (const [id, tun] of [...this._tunnels]) {
      if (live.get(id) !== tun.sshHost) this.close(id);
    }
  }

  urlFor(id) {
    const tun = this._tunnels.get(String(id));
    return tun ? tun.url() : null;
  }

  statusFor(id) {
    const tun = this._tunnels.get(String(id));
    return tun ? tun.status() : null;
  }

  statuses() { return [...this._tunnels.values()].map((t) => t.status()); }

  stopAll() {
    for (const tun of this._tunnels.values()) tun.stop();
    this._tunnels.clear();
  }
}

module.exports = { WebTunnelManager, WebTunnel, GIVE_UP_MS };
