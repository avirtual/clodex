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
// Since t49 the SUPERVISION ITSELF is shared with web-tunnel.js: spawn,
// respawn, backoff, the stable check, the status row and the kill all live in
// tunnel-supervisor.js, and this file says only what makes a WIRE tunnel
// different. The two copies were ~90 identical lines apiece and had drifted in
// three places (journal: tasks/tunnel-supervisor/). What is configured here,
// and the property of the CONSUMER that decides each:
//
//   • RETRY IS UNBOUNDED, because Clodex itself needs this forward
//     continuously. A dead tunnel is CALM (laptops sleep, wifi drops) — restart
//     with capped backoff, no error toasts. Giving up would need a human to
//     notice and re-arm it, and nobody is watching a wire tunnel. The last ssh
//     stderr line is kept so a genuine misconfig (key rejected, unknown host) is
//     diagnosable in the UI, not silently identical to "asleep".
//   • THE PORT IS RE-PICKED per respawn, because the consumer can be CORRECTED
//     later: PeerConnection is re-pointed through onState → resolvePeerUrls →
//     PeerManager.sync. Re-picking is strictly better than pinning when that
//     holds — it cannot collide with whatever took the old port meanwhile.
//   • NO READINESS PROBE, because the consumer verifies the forward ITSELF: the
//     peer client's 15s hello loop finds a dead port on its own and stays calmly
//     offline until a later onState repoints it. `state: 'up'` here means only
//     "the child is alive", which is all `ssh -N` can offer and all this
//     consumer needs. (web-tunnel's consumer is a browser tab, which gets one
//     shot and no loop — hence the probe there. Not "peers vs web": whether the
//     consumer re-derives the truth.)
//
// Auth is key-based only (BatchMode=yes): Clodex never proxies an
// interactive password/hostkey dialog. StrictHostKeyChecking=accept-new
// keeps first contact friction-free (TOFU, same trust move as answering
// "yes" once by hand) while still failing loudly on a CHANGED key.
//
// spawnFn is injectable for tests; production uses child_process.spawn.

'use strict';

// The shared supervisor (t49/L2) and the destination vocabulary it owns.
const {
  SupervisedTunnel, CLOUD_KINDS, sameCloud, destinationOf, hasCloudTransport,
} = require('./tunnel-supervisor');

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;
// A tunnel that survived this long was genuinely up — reset backoff.
const STABLE_MS = 30000;
// The wire port every Clodex serves on, used when a record names none. Unlike
// the web tunnel's remote port — which comes from the peer's hello and must
// never be guessed — this one is a constant of the protocol.
const DEFAULT_REMOTE_PORT = 7900;

// The wire tunnel: the shared supervisor with wire policy. Everything this class
// does NOT say is deliberate — retry, backoff, spawn, kill, status and argv
// construction are the supervisor's, identical to the web tunnel's, and the
// three lines below are the whole of the difference.
class Tunnel extends SupervisedTunnel {
  // Options carry a cloud transport under its OWN kind key (`ssm: {…}`,
  // `kubectl: {…}`, `gcloud: {…}`) — the same shape the peer record uses, so a
  // settings entry can be handed straight in with no translation step to get
  // wrong.
  constructor({ remotePort, ...opts }) {
    super({
      ...opts,
      remotePort: remotePort || DEFAULT_REMOTE_PORT,
      backoffMinMs: BACKOFF_MIN_MS,
      backoffMaxMs: BACKOFF_MAX_MS,
      stableMs: STABLE_MS,
      giveUpMs: null,        // unbounded: nobody is watching this one
      pinPort: false,        // the consumer is re-pointed through onState
      readiness: null,       // the consumer's own hello loop is the probe
    });
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
  //
  // The destination is computed by the supervisor's `destinationOf`, the same
  // rule the web manager uses: two rules for "what does this record dial" is how
  // the two sides came to disagree about which records are forwardable at all.
  sync(peers) {
    const wanted = new Map();
    for (const p of Array.isArray(peers) ? peers : []) {
      if (!p || !p.id) continue;
      const dest = destinationOf(p);
      if (!dest) continue;
      const remotePort = Number.isInteger(p.remotePort) ? p.remotePort : DEFAULT_REMOTE_PORT;
      wanted.set(String(p.id), { ...dest, remotePort });
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

// CLOUD_KINDS, sameCloud and hasCloudTransport moved to tunnel-supervisor.js
// (t49) and are re-exported unchanged: they were part of this module's surface
// before the move — peer-import.js, web-tunnel.js and peer-wiring.js all read
// them from here, and test/peer-tunnel.test.js pins hasCloudTransport from here.
// Re-exported rather than repointed so no caller and no existing test needs
// editing for a move that changed nothing about them.
module.exports = { TunnelManager, Tunnel, hasCloudTransport, CLOUD_KINDS, sameCloud };
