// web-tunnel.js — on-demand port forwards to a PEER'S WEB FRONTEND, so
// "look at that box's GUI" is a click instead of a hand-run ssh command. A
// sibling of peer-tunnel.js: since t49 both are the SAME supervisor
// (tunnel-supervisor.js) under different policy, and this file says only what
// makes a web-view forward different. Three inversions, and each is a parameter
// rather than a fork — every one of them decided by a property of the CONSUMER,
// never by which caller we are:
//
//   1. THE LOCAL PORT IS PINNED, because our consumer CANNOT BE RE-POINTED. The
//      wire tunnel re-picks a free port on every respawn — right there, because
//      its consumer is the peer client, which is re-pointed through onState.
//      Ours is a browser tab in an application Clodex does not own; it holds a
//      dead string and will never be told otherwise, so a re-picked port would
//      strand it after the first wifi blip. The port is chosen ONCE, at start,
//      and every respawn re-binds the SAME one; ExitOnForwardFailure=yes (in the
//      shared ssh args) turns a port that got taken meanwhile into an honest
//      failure + backoff rather than a silent bind somewhere else.
//   2. THE BROWSER OPENS EXACTLY ONCE, on the first successful up. Respawns do
//      not re-open it: the pin means the tab the operator already has works again
//      the moment the forward is back, and popping a window on every wifi blip
//      would be its own bug. The pop itself is NOT here — this module has no
//      business knowing what a browser is, and under the web frontend the
//      operator's browser is on the far side of a wire. It rides the state event
//      to whoever asked; `firstUp` in the payload marks that transition once.
//   3. IT GIVES UP. The wire tunnel retries forever because Clodex needs that
//      connection continuously and nobody is watching it; a human's attention is
//      bounded, so retrying at a dead box forever leaves a forgotten forward open
//      to a remote machine. After GIVE_UP_MS without ever coming up the
//      supervisor stops and reports 'gave-up', which is the only close that needs
//      nobody to do anything.
//   4. THE POP WAITS FOR THE PORT, not for the process (t37) — because our
//      consumer gets ONE SHOT and no loop of its own. `state: 'up'` means "the
//      child is alive", which is all `ssh -N` can offer and is right for
//      supervision; the peer client can live with it because its 15s hello loop
//      re-derives the truth. A browser cannot: `kubectl port-forward` lives for
//      a few hundred ms before it accepts, and a tab opened into that gap shows
//      an error page and self-refreshes — reported from live use. So the ONE
//      emit a browser rides, `firstUp`, waits until 127.0.0.1:<localPort>
//      actually accepts a TCP connection. Only that emit: `state: 'up'`, the
//      give-up clock, the stable check and sync() all keep their existing
//      timing, because re-timing them would change supervision to fix a cosmetic
//      bug. A TCP probe rather than the CLI's own "Forwarding from …" line,
//      because a per-kind success-pattern table is vendor knowledge this layer
//      does not want and would need its own fallback for when the pattern never
//      matches. The probe is INJECTED into the supervisor, which is what keeps
//      that knowledge out of the shared layer too.
//
// TRANSPORTS: ssh AND the typed cloud kinds (t36). This module was ssh-only at
// t30 on the ruling that "no Clodex peer record can express SSM/kubectl/gcloud/az
// (sanitizePeers accepts url + sshHost and drops everything else), so the
// capability would have nothing to reach". t32 falsified that premise —
// PEER_CLOUD_KINDS in stores.js now admits all four — and the ruling outlived it
// by one release, which is how a kubectl peer shipped with working sessions and a
// refused web view. The kind table, the argv builders and `destinationOf` now
// live in the shared supervisor, so "which transports can Clodex dial" has
// exactly one answer and a fifth kind cannot arrive here late again.
//
// What remains genuinely impossible is a URL-ONLY peer: it names a destination
// Clodex reaches over somebody else's network path, with no forward to drive.
// That refusal stays, and says so.
//
// spawnFn and probeFn are injectable for tests; production uses
// child_process.spawn and cli/src/transport's portAccepts.

'use strict';

// The shared supervisor (t49/L2) — spawn, respawn, backoff, the stable check,
// the give-up cap, the readiness probe, the status row and the process-group
// kill. This module's copy and the wire supervisor's were ~90 identical lines
// that had drifted in three places; the four inversions above are all POLICY, so
// each is now a constructor argument.
const { SupervisedTunnel, sameCloud, destinationOf } = require('./tunnel-supervisor');
// portAccepts: a one-shot TCP connect to 127.0.0.1:<port>. Imported rather than
// rewritten — the CLI has asked this exact question since day one, and
// WAIT_PORT_MS is the bound it already settled on for it.
const { portAccepts, WAIT_PORT_MS } = require('./cli/src/transport');

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
// Never came up within this long → stop trying (inversion 3). Measured from
// start(), not from the last attempt, so a box that flaps without ever serving
// still terminates. The ceiling above is half the wire tunnel's for this reason:
// a 60s ceiling inside a 120s window would buy about three attempts.
const GIVE_UP_MS = 120000;
// A spawn that survived this long counts as having genuinely WORKED, and retires
// the give-up clock. The distinction matters because 'up' means only "the child
// is alive" — ssh -N prints nothing on success, so a forward to an unreachable
// box still reports up for the moment before it dies. Retiring the clock on the
// first 'up' would therefore retire it on essentially every tunnel and the cap
// would never fire. Same threshold and same reasoning as peer-tunnel.js's
// STABLE_MS, used for a different decision.
const STABLE_MS = 30000;
// How long to keep asking "does the local port accept yet?" before popping the
// browser anyway (inversion 4). Same bound the CLI uses for the same question.
const PROBE_MS = WAIT_PORT_MS;
// Gap between probe attempts. The first attempt is immediate — an ssh forward
// accepts straight away, so it must not pay a poll interval it doesn't need.
const PROBE_POLL_MS = 100;

// The web-view tunnel: the shared supervisor with the four inversions as
// arguments. Everything this class does NOT say is the supervisor's and is
// byte-identical to the wire tunnel's.
class WebTunnel extends SupervisedTunnel {
  // A cloud transport arrives under its OWN kind key (`kubectl: {…}`) — the same
  // shape the peer record and the wire supervisor use, so a settings entry needs
  // no translation step to get wrong.
  constructor({ giveUpMs, probeFn, probeMs, ...opts }) {
    super({
      ...opts,
      backoffMinMs: BACKOFF_MIN_MS,
      backoffMaxMs: BACKOFF_MAX_MS,
      // Scaled with the cap so a test that shortens the window doesn't need a
      // 30-second-stable spawn to exercise the "it worked" branch.
      stableMs: Number.isInteger(giveUpMs) ? Math.max(1, Math.floor(giveUpMs / 2)) : STABLE_MS,
      giveUpMs: Number.isInteger(giveUpMs) ? giveUpMs : GIVE_UP_MS,
      pinPort: true,
      readiness: {
        probe: probeFn || portAccepts,
        timeoutMs: Number.isInteger(probeMs) ? probeMs : PROBE_MS,
        pollMs: PROBE_POLL_MS,
      },
    });
  }
}

// One tunnel per peer the operator has explicitly opened — never per peer that
// merely exists. open()/close() are the toggle; sync() prunes tunnels whose peer
// went away or was disabled; stopAll() is app shutdown.
class WebTunnelManager {
  constructor({ spawnFn, onState, giveUpMs, probeFn, probeMs } = {}) {
    this._spawnFn = spawnFn || null;
    this._probeFn = probeFn || null;
    this._probeMs = probeMs;
    this._onState = onState || (() => {});
    this._giveUpMs = giveUpMs;
    this._tunnels = new Map();       // peerId -> WebTunnel
  }

  // Open (or re-open) the web tunnel for one peer. The transport rides in under
  // its own key — `sshHost`, or a cloud block like `kubectl: {…}` — the same
  // shape the peer record uses. remotePort comes from the peer's hello
  // (webHost.port): a caller with no live webHost has nothing to forward to and
  // gets a refusal rather than a guessed port. (The wire tunnel defaults its
  // remote port instead, because 7900 is a constant of the protocol; a web
  // frontend's port is not, so guessing one is the lie t30a exists to prevent.)
  open({ id, remotePort, ...rec }) {
    const key = String(id);
    const dest = destinationOf(rec);
    // A url-only peer is the one genuinely unforwardable case left: Clodex
    // reaches it over a path it does not own, so there is no local end to bind.
    // Said out loud rather than hidden — see the module header.
    if (!dest) return { ok: false, error: 'no forwardable transport: this peer is reached by URL, so there is nothing to tunnel over' };
    if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
      return { ok: false, error: 'peer reports no web frontend' };
    }
    const existing = this._tunnels.get(key);
    // A live tunnel to the same place is already the answer. A tunnel to a
    // DIFFERENT place (the box moved its web port, or the peer was re-pointed at
    // another host/cluster/instance) is stale: replace it rather than forwarding
    // to the old one. Cloud destinations compare field by field via the shared
    // supervisor's sameCloud — a changed namespace or region is a different box.
    if (existing) {
      if (existing.sshHost === dest.sshHost && sameCloud(dest.cloud, existing.cloud)
          && existing.remotePort === remotePort && existing.state !== 'gave-up') {
        return { ok: true, status: existing.status(), url: existing.url() };
      }
      existing.stop();
      this._tunnels.delete(key);
    }
    const tun = new WebTunnel({
      id: key, sshHost: dest.sshHost, remotePort,
      ...(dest.cloud ? { [dest.cloud.kind]: dest.cloud.block } : {}),
      spawnFn: this._spawnFn, onState: this._onState, giveUpMs: this._giveUpMs,
      probeFn: this._probeFn, probeMs: this._probeMs,
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
  // list — removed, disabled, or re-pointed at a different destination — is
  // closed. Nothing is ever OPENED here: on-demand only.
  //
  // Destination comparison goes through destinationOf/sameCloud rather than
  // sshHost: a cloud peer has no sshHost, so an sshHost-only test would find
  // `undefined !== null` for every one of them and prune its web tunnel on the
  // next settings write — an affordance that closes itself a moment after it
  // opens, with nothing in the log to say why.
  sync(peers) {
    const live = new Map();
    for (const p of Array.isArray(peers) ? peers : []) {
      if (!p || !p.id) continue;
      const dest = destinationOf(p);
      if (dest) live.set(String(p.id), dest);
    }
    for (const [id, tun] of [...this._tunnels]) {
      const dest = live.get(id);
      if (!dest || dest.sshHost !== tun.sshHost || !sameCloud(dest.cloud, tun.cloud)) this.close(id);
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

// destinationOf moved to tunnel-supervisor.js (t49) — both managers ask the same
// question of the same rule now — and is re-exported unchanged because it was
// part of this module's surface: peer-wiring.js reads it from here.
module.exports = { WebTunnelManager, WebTunnel, destinationOf, GIVE_UP_MS };
