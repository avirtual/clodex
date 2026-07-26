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
const { ssmArgv, kubectlArgv, gcloudArgv, azArgv, substitutePort } = require('./cli/src/transport');

// Typed cloud transports, one row per kind:
//   argv     — the builder that turns the block into a {port}-bearing argv
//   fields   — every field that identifies the DESTINATION. A change to any of
//              them dials a different box and must restart the tunnel.
//   required — the subset without which there is nothing to dial. A block
//              missing one gets NO tunnel, rather than a half-built argv the
//              vendor CLI would reject at connect time with a worse message.
//
// A table rather than a switch, so adding a kind is one row instead of four
// edits in three files — and so `sameCloud` cannot fall out of step with the
// builders. stores.js admits at most one cloud block per peer, so in practice
// exactly one of these keys is present on a record.
const CLOUD_KINDS = {
  ssm:     { argv: ssmArgv,     fields: ['target', 'region', 'profile'],     required: ['target'] },
  kubectl: { argv: kubectlArgv, fields: ['target', 'namespace', 'context'],  required: ['target'] },
  gcloud:  { argv: gcloudArgv,  fields: ['instance', 'zone', 'project'],     required: ['instance'] },
  // az has no destination-field syntax in the Peers dialog (see stores.js's
  // PEER_CLOUD_KINDS), so today it is reachable only by import or a hand-edited
  // settings file — the supervisor accepts it so step 4's import needs no
  // second pass here. All three fields are required: the bastion is the tunnel
  // endpoint, the target the VM behind it, and neither is optional to azArgv.
  az:      { argv: azArgv,      fields: ['bastion', 'resourceGroup', 'target'], required: ['bastion', 'resourceGroup', 'target'] },
};

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

// Destination equality for a cloud transport — kind first, then field by field
// off the table. Field-by-field because a changed region/namespace/zone dials a
// DIFFERENT box: an identity comparison of two freshly-built objects would
// restart on every settings write, and a first-field-only comparison would never
// restart on a selector change. Both are wrong in opposite directions.
function sameCloud(a, b) {
  if (!a || !b) return !a && !b;
  if (a.kind !== b.kind) return false;
  return CLOUD_KINDS[a.kind].fields.every((f) => (a.block[f] || null) === (b.block[f] || null));
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
  // Options carry a cloud transport under its OWN kind key (`ssm: {…}`,
  // `kubectl: {…}`, `gcloud: {…}`) — the same shape the peer record uses, so a
  // settings entry can be handed straight in with no translation step to get
  // wrong. Normalized internally to `this.cloud = { kind, block }`.
  constructor({ id, sshHost, remotePort, spawnFn, onState, ...opts }) {
    this.id = id;
    this.sshHost = sshHost || null;
    this.cloud = null;
    for (const kind of Object.keys(CLOUD_KINDS)) {
      if (opts[kind]) { this.cloud = { kind, block: { ...opts[kind] } }; break; }
    }
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
      // The dialled destination, under its kind key, for the UI — the DATA,
      // never an argv. The renderer reads this row (it never sees the peer
      // record), so the kind is how it can say WHICH transport a peer uses.
      ...(this.cloud ? { [this.cloud.kind]: { ...this.cloud.block } } : {}),
      remotePort: this.remotePort,
      state: this.state, localPort: this.localPort, error: this.lastError,
    };
  }

  url() { return this.state === 'up' && this.localPort ? `http://127.0.0.1:${this.localPort}` : null; }

  // ssh's argv TAIL (no leading 'ssh'), kept as-is for the original call shape.
  args(localPort) {
    return [...SSH_BASE_ARGS, '-L', `${localPort}:127.0.0.1:${this.remotePort}`, this.sshHost];
  }

  // The full argv INCLUDING the command word, per transport. SYNCHRONOUS by
  // construction: every arm is pure string assembly. `ssm.ecs` would break that
  // (two awaited `aws` reads to learn its target), which is exactly why the
  // store admits no `ecs` block — see PEER_CLOUD_KINDS in stores.js.
  argv(localPort) {
    if (this.cloud) {
      const build = CLOUD_KINDS[this.cloud.kind].argv;
      return substitutePort(build(this.cloud.block, this.remotePort), localPort);
    }
    return ['ssh', ...this.args(localPort)];
  }

  // Every vendor CLI forks helpers a plain child-kill would orphan (aws its
  // session-manager-plugin, kubectl and gcloud their own), so a cloud child
  // leads its own process group and is killed by group — the same reasoning,
  // and the same > 0 pid guard, as cli/src/transport.js's close(). ssh needs
  // none of that and keeps its original non-detached spawn exactly.
  _detached() { return !!this.cloud; }

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
      // Named in errors even if argv() itself throws.
      let cmdName = this.cloud ? this.cloud.kind : 'ssh';
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
  // or a typed cloud kind) get tunnels. A change to the destination — host, any
  // field of a cloud block, or the remote port — restarts that tunnel.
  sync(peers) {
    const wanted = new Map();
    for (const p of Array.isArray(peers) ? peers : []) {
      if (!p || !p.id) continue;
      const remotePort = Number.isInteger(p.remotePort) ? p.remotePort : 7900;
      if (p.sshHost) {
        wanted.set(String(p.id), { sshHost: String(p.sshHost), cloud: null, remotePort });
        continue;
      }
      for (const [kind, spec] of Object.entries(CLOUD_KINDS)) {
        const raw = p[kind];
        // Every required field must be present; without them there is nothing to
        // dial, so the peer gets no tunnel rather than a malformed argv that
        // fails later with a vendor CLI's own confusing message.
        if (!raw || !spec.required.every((f) => raw[f])) continue;
        // Copy only the fields we dial with, stringified — so a later mutation
        // of the settings object can't silently change a running tunnel's
        // identity, and an unexpected key can't reach the argv builder.
        const block = {};
        for (const f of spec.fields) if (raw[f]) block[f] = String(raw[f]);
        wanted.set(String(p.id), { sshHost: null, cloud: { kind, block }, remotePort });
        break;
      }
    }
    for (const [id, tun] of this._tunnels) {
      const w = wanted.get(id);
      if (!w || w.sshHost !== tun.sshHost || w.remotePort !== tun.remotePort
          || !sameCloud(w.cloud, tun.cloud)) {
        tun.stop();
        this._tunnels.delete(id);
      }
    }
    for (const [id, w] of wanted) {
      if (!this._tunnels.has(id)) {
        // Hand the block back under its kind key — the constructor's shape.
        const { cloud, ...rest } = w;
        const tun = new Tunnel({
          id, ...rest, ...(cloud ? { [cloud.kind]: cloud.block } : {}),
          spawnFn: this._spawnFn, onState: this._onState,
        });
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

// Does this peer record name a typed cloud transport this supervisor can dial?
// Exported so callers ask the module that OWNS the kind list rather than each
// keeping its own `p.ssm || p.kubectl || …` chain — three such chains would be
// three places to forget a kind, and forgetting one reads as a peer that
// silently never connects.
function hasCloudTransport(peer) {
  if (!peer) return false;
  return Object.entries(CLOUD_KINDS).some(([kind, spec]) => {
    const raw = peer[kind];
    return !!(raw && spec.required.every((f) => raw[f]));
  });
}

// CLOUD_KINDS and sameCloud are exported for the WEB tunnel supervisor
// (web-tunnel.js), which dials the same destinations for a different reason.
// Exported rather than copied: a second copy of the kind table is how the web
// view came to refuse transports the wire already dialled (t36).
module.exports = { TunnelManager, Tunnel, hasCloudTransport, CLOUD_KINDS, sameCloud };
