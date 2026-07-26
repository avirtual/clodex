// web-tunnel.js — on-demand port forwards to a PEER'S WEB FRONTEND, so
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
//   4. THE POP WAITS FOR THE PORT, not for the process (t37). Everything else
//      here treats "the child is alive" as up, which is all `ssh -N` can offer
//      and is right for supervision. But a browser is a harder consumer than a
//      socket client: `kubectl port-forward` lives for a few hundred ms before
//      it accepts, and a tab opened into that gap shows an error page and
//      self-refreshes — reported from live use. So the ONE emit a browser rides,
//      `firstUp`, waits until 127.0.0.1:<localPort> actually accepts a TCP
//      connection. Only that emit: `state: 'up'`, the give-up clock, the stable
//      check and sync() all keep their existing timing, because re-timing them
//      would change supervision to fix a cosmetic bug. A TCP probe rather than
//      the CLI's own "Forwarding from …" line, because a per-kind
//      success-pattern table is vendor knowledge this layer does not want and
//      would need its own fallback for when the pattern never matches.
//
// TRANSPORTS: ssh AND the typed cloud kinds (t36). This module was ssh-only at
// t30 on the ruling that "no Clodex peer record can express SSM/kubectl/gcloud/az
// (sanitizePeers accepts url + sshHost and drops everything else), so the
// capability would have nothing to reach". t32 falsified that premise —
// PEER_CLOUD_KINDS in stores.js now admits all four — and the ruling outlived it
// by one release, which is how a kubectl peer shipped with working sessions and a
// refused web view. The kind table and the argv builders are IMPORTED from the
// wire supervisor (which imports them in turn from cli/src/transport.js), so
// "which transports can Clodex dial" has exactly one answer and a fifth kind
// cannot arrive here late again.
//
// What remains genuinely impossible is a URL-ONLY peer: it names a destination
// Clodex reaches over somebody else's network path, with no forward to drive.
// That refusal stays, and says so.
//
// spawnFn and probeFn are injectable for tests; production uses
// child_process.spawn and cli/src/transport's portAccepts.

'use strict';

const net = require('net');
// The shared dial (t42/L1) — spawn, stderr tail, ENOENT classification, the
// process-group kill. Imported for the same reason the kind table below is: this
// module's copy and the wire supervisor's were byte-identical, and two copies of
// a kill path drift without anyone noticing. The three INVERSIONS above are all
// supervision, so none of them moves; the dial has no opinion about them.
const { spawnDial, killDial, sshTunnelArgv, STDERR_TAIL_BYTES } = require('./cli/src/dial');
// The wire supervisor owns the kind table (kinds, destination fields, required
// fields, argv builder per kind) and `sameCloud`. Imported rather than restated:
// two copies of "which cloud kinds exist" is precisely the drift that produced
// this ticket, one layer down.
const { CLOUD_KINDS, sameCloud } = require('./peer-tunnel');
// portAccepts: a one-shot TCP connect to 127.0.0.1:<port>. Imported rather than
// rewritten — the CLI has asked this exact question since day one, and
// WAIT_PORT_MS is the bound it already settled on for it.
const { substitutePort, portAccepts, WAIT_PORT_MS } = require('./cli/src/transport');

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
// How long to keep asking "does the local port accept yet?" before popping the
// browser anyway (inversion 4). Same bound the CLI uses for the same question.
const PROBE_MS = WAIT_PORT_MS;
// Gap between probe attempts. The first attempt is immediate — an ssh forward
// accepts straight away, so it must not pay a poll interval it doesn't need.
const PROBE_POLL_MS = 100;

function pickFreePort(cb) {
  const srv = net.createServer();
  srv.on('error', () => cb(null));
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    srv.close(() => cb(port));
  });
}

class WebTunnel {
  // A cloud transport arrives under its OWN kind key (`kubectl: {…}`) — the same
  // shape the peer record and the wire supervisor use, so a settings entry needs
  // no translation step to get wrong. Normalized to `this.cloud = { kind, block }`.
  constructor({ id, sshHost, remotePort, spawnFn, onState, giveUpMs, probeFn, probeMs, ...opts }) {
    this.id = id;
    this.sshHost = sshHost || null;
    this.cloud = null;
    for (const kind of Object.keys(CLOUD_KINDS)) {
      if (opts[kind]) { this.cloud = { kind, block: { ...opts[kind] } }; break; }
    }
    this.remotePort = remotePort;
    // null when not injected — spawnDial falls back to child_process.spawn.
    this._spawn = spawnFn || null;
    this._probe = probeFn || portAccepts;
    this._probeMs = Number.isInteger(probeMs) ? probeMs : PROBE_MS;
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
    this._probeTimer = null;         // pending probe retry (inversion 4)
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
    clearTimeout(this._probeTimer);
    this._probeTimer = null;
    this._killChild();
    this._setState('down');
  }

  // `url` is part of the status rather than something a consumer assembles from
  // localPort: assembling it is where a consumer would get it wrong (a port that
  // is pinned but not currently forwarded is not a URL). One producer, one rule.
  status() {
    return {
      id: this.id, sshHost: this.sshHost,
      // The dialled destination under its kind key — the DATA, never an argv,
      // the same row shape the wire tunnel's status carries. The renderer never
      // sees the peer record, so this is how it can name WHICH transport.
      ...(this.cloud ? { [this.cloud.kind]: { ...this.cloud.block } } : {}),
      remotePort: this.remotePort,
      state: this.state, localPort: this.localPort, error: this.lastError,
      url: this.url(),
    };
  }

  // The ONLY place a web URL comes from. Non-null exclusively while the forward
  // is actually up, so there is no dead placeholder for the UI to render by
  // mistake — the peer tunnel's http://127.0.0.1:1 sentinel has no analogue here.
  url() { return this.state === 'up' && this.localPort ? `http://127.0.0.1:${this.localPort}` : null; }

  // ssh's argv TAIL (no leading 'ssh'), kept as-is for the original call shape.
  // Bytes from the shared dial's sshTunnelArgv — the wire supervisor's copy and
  // this one were byte-identical, so they are now one definition.
  args(localPort) {
    return sshTunnelArgv(this.sshHost, this.remotePort, localPort).slice(1);
  }

  // The full argv INCLUDING the command word, per transport — the wire
  // supervisor's `argv()` with one difference that matters: `localPort` here is
  // the PINNED port, so every respawn substitutes the same value. Synchronous by
  // construction, every arm pure string assembly (`ssm.ecs` would break that,
  // which is why the store admits no `ecs` block).
  argv(localPort) {
    if (this.cloud) {
      const build = CLOUD_KINDS[this.cloud.kind].argv;
      return substitutePort(build(this.cloud.block, this.remotePort), localPort);
    }
    return ['ssh', ...this.args(localPort)];
  }

  // aws/kubectl/gcloud/az each fork helpers a plain child-kill orphans, and an
  // orphaned forward to a REMOTE box is the worst outcome this module has (it
  // outlives the operator's reason for it — the same hole the give-up cap
  // exists to close, arrived at from the other side). So a cloud child leads its
  // own process group and is killed by group. ssh needs none of that and keeps
  // its original non-detached spawn byte-identical.
  _detached() { return !!this.cloud; }

  _killChild() {
    const child = this._child;
    if (!child) return;
    this._child = null;
    killDial(child, { group: this._detached() });
  }

  // State transitions only — it returns early when the state is unchanged, which
  // is why the firstUp emit cannot ride it (by the time the probe succeeds the
  // state is already 'up') and builds its own payload instead. The invariant
  // that survives from t30b: firstUp is a property of ONE emit and never of the
  // stored status, so a consumer polling status() later cannot read it as still
  // true and pop a second browser window.
  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    try { this._onState(this.id, this.status()); } catch {}
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
    let dial;
    // Named in errors even if argv() itself throws.
    let cmdName = this.cloud ? this.cloud.kind : 'ssh';
    try {
      const argv = this.argv(port);
      cmdName = argv[0];
      dial = spawnDial(argv, {
        spawnFn: this._spawn,
        detached: this._detached(),
        stderrLimit: STDERR_TAIL_BYTES,
      });
    } catch (e) {
      this.lastError = e.message;
      return this._scheduleRestart();
    }
    const child = dial.child;
    this._child = child;
    child.on('error', (e) => {
      // The dial classifies a spawn failure; this layer renders it. A missing
      // vendor CLI is the common cloud misconfig and reads as a bare ENOENT
      // otherwise. (ssh is always installed, which is why the ssh-only version of
      // this module had no such arm.)
      const f = dial.failure(e);
      this.lastError = f.diagnosis || f.message;
      this._child = null;
      this._scheduleRestart();
    });
    this._bornAt = Date.now();
    child.on('exit', (code) => {
      this._child = null;
      const line = dial.stderr().trim().split('\n').pop() || '';
      this.lastError = line || (code === 0 ? null : `${cmdName} exited (${code})`);
      // A spawn that lasted counts as a box that genuinely works: reset the
      // backoff AND retire the give-up clock, so later blips are treated as
      // outages rather than as evidence the box was never there.
      if (Date.now() - this._bornAt > this._stableMs) {
        this._backoff = BACKOFF_MIN_MS;
        this._deadline = 0;
      }
      this._scheduleRestart();
    });
    // UP = "the child is alive" — for SUPERVISION. That is all `ssh -N` can
    // offer (it prints nothing on success) and it is the right signal for the
    // give-up clock, the stable check, sync() and the UI phase, all of which ask
    // "is this tunnel being maintained", not "is it serving yet". Left exactly
    // as it was: re-timing supervision to fix a cosmetic bug would trade a
    // half-second of ugliness for a class of timing changes nobody asked for.
    //
    // The BROWSER is the one consumer that needs the stronger fact, and it rides
    // exactly one emit — see _probeThenPop.
    this._setState('up');
    if (!this._opened) this._probeThenPop(child, port);
  }

  // Wait until 127.0.0.1:<port> accepts, then emit the once-per-tunnel firstUp
  // the browser pop rides (inversions 2 + 4). Notes on the shape:
  //
  //   • `_opened` is set HERE, not at spawn time, and only when the emit
  //     actually goes out — so a child that dies mid-probe leaves the pop still
  //     owed, and the respawn (with the same PINNED port) probes again. Setting
  //     it at spawn time would spend the operator's single pop on a tunnel that
  //     never served.
  //   • The emit is its own _onState call rather than a _setState: _setState
  //     only fires ON CHANGE, and by now the state is already 'up', so riding it
  //     would drop the emit entirely. The payload is the same
  //     `{...status(), firstUp: true}` shape peer-wiring already reads.
  //   • Every await is followed by a re-check that this loop still owns the
  //     tunnel (`_stopped`, and `_child === child`). A probe that outlived its
  //     child would pop a browser at a port nothing is listening on.
  //   • On TIMEOUT it pops ANYWAY, with `ready: false`. The operator asked for a
  //     browser; after the full bound, giving them the tab they clicked (worst
  //     case: today's behaviour, a page they reload) beats silently swallowing
  //     the request. `ready` distinguishes the two in the log — a fallback that
  //     reads identically to the happy path is not a fallback anyone can debug.
  async _probeThenPop(child, port) {
    const deadline = Date.now() + this._probeMs;
    const mine = () => !this._stopped && this._child === child && this._opened === false;
    for (;;) {
      if (!mine()) return;
      let ok = false;
      try { ok = await this._probe(port); } catch { ok = false; }
      if (!mine()) return;
      if (ok) break;
      if (Date.now() >= deadline) {
        // Bound lapsed with the child still alive. Pop unconfirmed, and say so.
        this._opened = true;
        try { this._onState(this.id, { ...this.status(), firstUp: true, ready: false }); } catch {}
        return;
      }
      await new Promise((resolve) => { this._probeTimer = setTimeout(resolve, PROBE_POLL_MS); });
    }
    if (!mine()) return;
    this._opened = true;
    try { this._onState(this.id, { ...this.status(), firstUp: true, ready: true }); } catch {}
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

// The forwardable destination of one record — an ssh host, or a cloud block with
// every required field — in the shape the constructor takes, or null for a record
// with nothing to forward over (a url-only peer). ssh wins when both are present,
// matching TunnelManager.sync.
//
// Shared by open() and sync() so the destination a sync KEEPS and the destination
// an open BUILDS are computed by one rule. Two rules is how a cloud web tunnel
// would open and then be pruned by the very next settings write.
function destinationOf(rec) {
  if (!rec) return null;
  if (rec.sshHost) return { sshHost: String(rec.sshHost), cloud: null };
  for (const [kind, spec] of Object.entries(CLOUD_KINDS)) {
    const raw = rec[kind];
    // Every required field or no tunnel — a half-built argv fails later with the
    // vendor CLI's own worse message.
    if (!raw || !spec.required.every((f) => raw[f])) continue;
    // Copy only the fields we dial with, stringified: a later mutation of the
    // settings object can't change a running tunnel's identity, and an unexpected
    // key can't reach the argv builder.
    const block = {};
    for (const f of spec.fields) if (raw[f]) block[f] = String(raw[f]);
    return { sshHost: null, cloud: { kind, block } };
  }
  return null;
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
  // gets a refusal rather than a guessed port.
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
    // to the old one. Cloud destinations compare field by field via the wire
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

module.exports = { WebTunnelManager, WebTunnel, destinationOf, GIVE_UP_MS };
