// tunnel-supervisor.js — ONE supervised local port forward (t49/L2).
//
// Keeps a child process alive that binds 127.0.0.1:<localPort> and carries it to
// some remote port: `ssh -N -L`, or a vendor CLI's own forward (aws ssm /
// kubectl / gcloud / az). Respawn with capped backoff, a stable-run check that
// retires the backoff, and a status row emitted on every state change.
//
// peer-tunnel.js's `Tunnel` and web-tunnel.js's `WebTunnel` were ~90 identical
// lines of this apiece. What actually differed between them is THREE things —
// the audit predicted four, and the fourth (the error sink) turned out to be the
// same mechanism on both sides with the difference living entirely in the
// consumer above (see D7 in tasks/tunnel-supervisor/journal.md).
//
// The parameters, and — the point of the exercise — the property of the CONSUMER
// that decides each. None of them is "which caller am I": a supervisor that asks
// that has not been unified, and a fourth consumer arriving next year must be
// classifiable by these questions alone.
//
//   1. RETRY — `backoffMinMs` / `backoffMaxMs` / `stableMs` / `giveUpMs`.
//      Decided by: does someone's ATTENTION depend on this forward?
//      A forward Clodex itself needs continuously retries forever (giveUpMs
//      null): unreachable is normal, laptops sleep, and giving up would need a
//      human to notice and re-arm it. A forward that exists because a human
//      asked to look at something is bounded — their attention is, so retrying
//      at a dead box forever leaves a forgotten forward open to a remote
//      machine. The two ceilings differ for the same reason (60s vs 30s: a 60s
//      ceiling inside a 120s give-up window buys about three attempts).
//
//   2. PORT STABILITY — `pinPort`.
//      Decided by: ONCE THIS SUPERVISOR HAS HANDED OVER A URL, CAN THAT URL BE
//      CORRECTED LATER? A consumer this process re-points itself (an object with
//      a `sync()`) is happy with a fresh port per respawn, and re-picking is
//      strictly better: it cannot collide with whatever took the old one. A
//      consumer holding a dead string it will never be told about — a browser
//      tab in an application Clodex does not own — needs the port to survive the
//      respawn, or the first wifi blip strands it. Pinned means chosen once and
//      re-bound every attempt; ExitOnForwardFailure turns a port that got taken
//      meanwhile into an honest failure rather than a silent bind elsewhere.
//
//   3. READINESS — `readiness: { probe, timeoutMs, pollMs } | null`.
//      Decided by: does the consumer VERIFY THE FORWARD ITSELF?
//      `state: 'up'` means only "the child is alive", on both sides, and that is
//      deliberately a supervision fact rather than a liveness claim — `ssh -N`
//      prints nothing on success, so it is all the process can offer, and it is
//      the right input for the backoff, the give-up clock and the UI's phase,
//      which all ask "is this being maintained". It costs nothing to emit and
//      therefore proves nothing, exactly as the standing rule says.
//      A consumer that re-derives the truth on its own schedule (a hello loop
//      that will find a dead port within 15s and stay calmly offline) needs
//      nothing stronger, and paying for a probe would only delay the moment it
//      starts checking. A consumer that gets ONE shot — a browser tab, opened
//      once — needs the stronger fact, because `kubectl port-forward` lives for
//      a few hundred ms before it accepts and a tab opened into that gap shows
//      an error page (reported from live use).
//      So `readiness` gates exactly one extra emit, `firstUp`, and only when
//      configured. It is a one-shot announcement, never stored on the status
//      row: a consumer polling status() later must not be able to read it as
//      still true and act a second time.
//      The PROBE ITSELF IS INJECTED. This module never learns how to tell that a
//      forward is serving — it asks the function it was handed. That is what
//      keeps "which vendor CLI logs what on success" from ever landing here.
//
// WHAT IS NOT HERE, and stays out (t41's refusal, restated): supervision OF
// supervision. Reconciling a settings list into a set of tunnels, deciding when
// a destination changed enough to restart, popping a browser, re-pointing a peer
// connection — all of that lives in the managers in peer-tunnel.js and
// web-tunnel.js and in peer-wiring.js above them. This class supervises exactly
// one child and reports; it holds no map, and it cannot grow one without being
// handed something it currently has no reference to.
//
// Electron-free by construction (net + the cli/ leaves only), like everything
// else at this layer.

'use strict';

const net = require('net');
// The CLI's argv builders, reused verbatim — the GUI and the CLI cannot drift
// into two ideas of how to dial the same box. cli/ ships in the DMG
// (build.files) so this resolves in a packaged app; the leaf direction is
// unchanged, cli/ never requires an app file.
const { ssmArgv, kubectlArgv, gcloudArgv, azArgv, substitutePort } = require('./cli/src/transport');
// The shared dial (t42/L1): spawn, stderr accumulation, ENOENT classification,
// the process-group kill. Supervision — backoff, the stable check, what `up`
// means — is HERE; the dial knows nothing about any of it.
const { spawnDial, killDial, sshTunnelArgv, STDERR_TAIL_BYTES } = require('./cli/src/dial');

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
  // settings file. All three fields are required: the bastion is the tunnel
  // endpoint, the target the VM behind it, and neither is optional to azArgv.
  az:      { argv: azArgv,      fields: ['bastion', 'resourceGroup', 'target'], required: ['bastion', 'resourceGroup', 'target'] },
};

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

// The forwardable destination of one record — an ssh host, or a cloud block with
// every required field — in the shape the constructor takes, or null for a
// record with nothing to forward over (a url-only peer). ssh wins when both are
// present.
//
// ONE rule, asked by both managers: the destination a sync KEEPS and the
// destination an open BUILDS must be computed the same way. Two rules is how a
// cloud web tunnel would open and then be pruned by the very next settings
// write — which is exactly what t36 fixed on one side while the other kept its
// own copy of the loop.
function destinationOf(rec) {
  if (!rec) return null;
  if (rec.sshHost) return { sshHost: String(rec.sshHost), cloud: null };
  for (const [kind, spec] of Object.entries(CLOUD_KINDS)) {
    const raw = rec[kind];
    // Every required field or no tunnel — a half-built argv fails later with the
    // vendor CLI's own worse message.
    if (!raw || !spec.required.every((f) => raw[f])) continue;
    // Copy only the fields we dial with, stringified: a later mutation of the
    // settings object can't change a running tunnel's identity, and an
    // unexpected key can't reach the argv builder.
    const block = {};
    for (const f of spec.fields) if (raw[f]) block[f] = String(raw[f]);
    return { sshHost: null, cloud: { kind, block } };
  }
  return null;
}

// Does this record name a typed cloud transport this supervisor can dial?
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

// Module-local by design. It was briefly exported in the t49 merge with no
// consumer and was not on the pre-merge surface — and `cli/src/transport.js`
// already exports a DIFFERENT `pickFreePort` (promise-returning, no callback),
// so a second one of the same name is a miswire waiting for the wrong import.
// Nothing needs it out here, tests included: `_spawnTunnel` closes over this
// const, so reassigning an export could never have changed what it calls. The
// seam that does work is `net.createServer`, resolved on the module object at
// call time below.
function pickFreePort(cb) {
  const srv = net.createServer();
  srv.on('error', () => cb(null));
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    srv.close(() => cb(port));
  });
}

class SupervisedTunnel {
  // A cloud transport arrives under its OWN kind key (`kubectl: {…}`) — the same
  // shape the peer record uses, so a settings entry can be handed straight in
  // with no translation step to get wrong. Normalized to
  // `this.cloud = { kind, block }`. Everything else is the policy above.
  constructor({
    id, sshHost, remotePort, spawnFn, onState,
    backoffMinMs, backoffMaxMs, stableMs, giveUpMs = null,
    pinPort = false, readiness = null,
    ...opts
  }) {
    this.id = id;
    this.sshHost = sshHost || null;
    this.cloud = null;
    for (const kind of Object.keys(CLOUD_KINDS)) {
      if (opts[kind]) { this.cloud = { kind, block: { ...opts[kind] } }; break; }
    }
    this.remotePort = remotePort;
    // null when not injected — spawnDial falls back to child_process.spawn, so
    // this module never requires child_process at all.
    this._spawn = spawnFn || null;
    this._onState = onState || (() => {});
    this._backoffMinMs = backoffMinMs;
    this._backoffMaxMs = backoffMaxMs;
    this._stableMs = stableMs;
    this._giveUpMs = giveUpMs;
    this._pinPort = !!pinPort;
    this._readiness = readiness;
    // Pinned tunnels assign this once, in _spawnTunnel's first pass, and never
    // reassign it; unpinned ones re-pick per spawn and release it on death.
    this.localPort = null;
    this.state = 'down';             // 'up' | 'down' | 'gave-up'
    this.lastError = null;
    this._child = null;
    this._timer = null;
    this._backoff = backoffMinMs;
    this._stopped = false;
    this._announced = false;         // readiness: the one-shot has gone out
    this._deadline = 0;              // give-up wall-clock; 0 = never
    // One record per LIVE readiness loop — `{ wake, timer, done }` — and never a
    // per-instance slot, for the same reason `bornAt` below is a closure const
    // (t51). `_spawnOn` starts one loop per CHILD, so two can be alive at once
    // whenever a probe outlives its child, and every shared slot they would
    // share is a slot the newer loop silently takes from the older: the wake
    // resolver (older loop parked forever, the exact bug the wake was added to
    // close), the sleep timer (older loop's timer survives stop()), and the
    // outstanding-promise slot (settled() answering for the wrong loop).
    //
    // Held as ONE set of records rather than three collections because all three
    // are keyed by the same thing — one live loop — and three collections is
    // three chances to drift. The set is the only reason stop() can reach a loop
    // it has no other name for; a closure alone cannot serve state that
    // something OUTSIDE the loop must read.
    this._probes = new Set();
  }

  start() {
    if (!this._stopped && this._child) return;   // already running
    this._stopped = false;
    // `!= null`, not truthiness: `giveUpMs: 0` means give up on the first
    // failure, and the pre-merge web side said so with `Number.isInteger`. Under
    // a truthy test 0 silently becomes "retry forever" — the opposite policy,
    // for the arm whose whole purpose is a bound. No call site passes 0 today.
    if (this._giveUpMs != null) this._deadline = Date.now() + this._giveUpMs;
    this._spawnTunnel();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    this._timer = null;
    // Wake EVERY probe that is asleep between attempts, not just the newest.
    // Without this the await never settles and the async frame is retained for
    // the life of the process — the timer it was waiting on has just been
    // cleared, so nothing else will ever resolve it. Each loop re-checks
    // ownership on wake and returns without announcing.
    for (const p of this._probes) {
      clearTimeout(p.timer);
      p.timer = null;
      const wake = p.wake;
      p.wake = null;
      if (wake) wake();
    }
    this._killChild();
    this._releasePort();
    this._setState('down');
  }

  // Resolves when no readiness announcement is outstanding — ALL of them, which
  // is what the sentence has always claimed and what a single slot could not
  // express: with one slot, whichever loop finished LAST wrote null and answered
  // for loops still running (measured: settled() resolved while a live loop went
  // on to make five more probe calls). A stopped or never-probing tunnel settles
  // immediately.
  //
  // Snapshots at call time, exactly as the single slot did: a loop that STARTS
  // after this call is not awaited. The question is "is anything outstanding
  // now", not "will anything ever start again".
  //
  // Exists so a caller — a test, or anything that must know the supervisor has
  // genuinely finished — can wait for it instead of guessing a duration, and so
  // the parked-sleep bug the wake above closes cannot come back silently:
  // without that wake, this never settles.
  settled() { return Promise.all([...this._probes].map((p) => p.done)); }

  status() {
    return {
      id: this.id, sshHost: this.sshHost,
      // The dialled destination, under its kind key, for the UI — the DATA,
      // never an argv. The renderer reads this row (it never sees the peer
      // record), so the kind is how it can say WHICH transport a peer uses.
      ...(this.cloud ? { [this.cloud.kind]: { ...this.cloud.block } } : {}),
      remotePort: this.remotePort,
      state: this.state, localPort: this.localPort, error: this.lastError,
      url: this.url(),
    };
  }

  // The ONLY place a URL comes from — non-null exclusively while the forward is
  // actually up, so a port that is pinned but not currently forwarded can never
  // be read as one. Assembling it from localPort is where a consumer would get
  // that wrong; one producer, one rule.
  url() { return this.state === 'up' && this.localPort ? `http://127.0.0.1:${this.localPort}` : null; }

  // ssh's argv TAIL (no leading 'ssh'), kept as-is for the original call shape.
  // The bytes come from the shared dial's sshTunnelArgv.
  args(localPort) {
    return sshTunnelArgv(this.sshHost, this.remotePort, localPort).slice(1);
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
    // `fallbackKill` stays on (the default): a non-detached ssh child, or a
    // detached one with no usable pid, is still killed directly. openTransport
    // has no such arm — see dial.js's killDial and drift D3.
    killDial(child, { group: this._detached() });
  }

  // An UNPINNED port is only meaningful while its child lives: reporting one
  // after the child died names a port nothing is bound to. A pinned one is the
  // tunnel's identity for its whole life and survives every death by design.
  _releasePort() { if (!this._pinPort) this.localPort = null; }

  // State transitions only — it returns early when the state is unchanged, which
  // is why the firstUp emit cannot ride it (by the time a probe succeeds the
  // state is already 'up') and builds its own payload instead.
  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    try { this._onState(this.id, this.status()); } catch {}
  }

  _spawnTunnel() {
    if (this._stopped || this._child) return;
    if (this._pinPort && this.localPort) return this._spawnOn(this.localPort);
    pickFreePort((port) => {
      // Re-check BOTH conditions, not just _stopped: picking a free port is a
      // real async round trip during which `_child` is null, so a second entry
      // landing in that window would spawn a second child and orphan the first
      // (this._child overwritten, so _killChild can never reach it). Latent
      // today — start() runs once and the backoff timer only exists when there
      // is no child — but the window is real and free to close.
      if (this._stopped || this._child) return;
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
      // The THIRD death path, and it releases like the other two. D5's rule is
      // "both paths or neither"; a synchronous spawn failure is a path that
      // arrived later and was left out, so `status().localPort` named a port
      // nothing ever bound. Cosmetic today — `url()` gates on `state === 'up'`
      // — and free, which is exactly the class this module closes on sight.
      this._releasePort();
      return this._scheduleRestart();
    }
    const child = dial.child;
    this._child = child;
    // Per-CHILD, in the closure — never a field. A field is overwritten by the
    // next spawn before an older child's exit fires, and that exit then measures
    // the wrong lifetime: on a bounded tunnel it can retire the give-up clock
    // for a box that never worked, which is the one failure the clock exists to
    // catch. Same reason `mine()` below compares identity rather than trusting
    // that we are still the current child.
    const bornAt = Date.now();
    const mine = () => this._child === child;
    child.on('error', (e) => {           // spawn failure (binary missing)
      if (!mine()) return;
      // The dial classifies; this layer decides what the consumer sees. A
      // missing vendor CLI is the common cloud misconfig and reads as a bare
      // ENOENT otherwise, so the diagnosis replaces the raw message here — the
      // CLI appends it to stderr instead (t40's "same information, rendered
      // twice"). What the dial ALSO offers and this layer still does not show:
      // the full stderr rather than its last line.
      const f = dial.failure(e);
      this.lastError = f.diagnosis || f.message;
      this._child = null;
      this._releasePort();
      this._scheduleRestart();
    });
    child.on('exit', (code) => {
      if (!mine()) return;
      this._child = null;
      this._releasePort();
      const line = dial.stderr().trim().split('\n').pop() || '';
      this.lastError = line || (code === 0 ? null : `${cmdName} exited (${code})`);
      // A spawn that lasted counts as a box that genuinely works: reset the
      // backoff, and retire the give-up clock so later blips are treated as
      // outages rather than as evidence the box was never there. Retiring it on
      // the first 'up' instead would retire it on essentially every tunnel —
      // 'up' is only "the child is alive" — and the cap would never fire.
      if (Date.now() - bornAt > this._stableMs) {
        this._backoff = this._backoffMinMs;
        this._deadline = 0;
      }
      this._scheduleRestart();
    });
    this._setState('up');
    if (this._readiness && !this._announced) {
      // One record per loop, created here and handed IN — the loop never reaches
      // for a slot on the supervisor, so a later child cannot take one from it.
      // Removed by its own `.finally`, so the set holds exactly the live loops
      // and `settled()`'s snapshot is the true outstanding set. Identity does
      // the work an ownership re-check would otherwise have to do, and cannot be
      // got wrong the way a guarded shared slot can.
      const rec = { wake: null, timer: null, done: null };
      this._probes.add(rec);
      rec.done = this._probeThenAnnounce(child, port, rec)
        .finally(() => { this._probes.delete(rec); });
    }
  }

  // Wait until the injected probe says the local port is serving, then emit the
  // once-per-tunnel `firstUp`. Notes on the shape:
  //
  //   • `_announced` is set HERE, and only when the emit actually goes out — so
  //     a child that dies mid-probe leaves the announcement still owed, and the
  //     respawn probes again. Setting it at spawn time would spend the
  //     consumer's single shot on a tunnel that never served.
  //   • Its own _onState call rather than a _setState: _setState fires ON CHANGE
  //     and the state is already 'up' by now, so riding it would drop the emit.
  //   • Every await is followed by a re-check that this loop still owns the
  //     tunnel. A probe that outlived its child would announce a port nothing is
  //     listening on.
  //   • On TIMEOUT it announces ANYWAY, with `ready: false`. The consumer asked
  //     for this; after the full bound, giving them the unverified answer beats
  //     silently swallowing the request. `ready` distinguishes the two in the
  //     log — a fallback that reads identically to the happy path is not a
  //     fallback anyone can debug.
  //   • `rec` is this loop's OWN record (its sleep resolver and timer). It is a
  //     parameter rather than a lookup because that is what makes the state
  //     per-child by construction: there is no shared slot to reach for.
  async _probeThenAnnounce(child, port, rec) {
    const { probe, timeoutMs, pollMs } = this._readiness;
    const deadline = Date.now() + timeoutMs;
    const mine = () => !this._stopped && this._child === child && this._announced === false;
    for (;;) {
      if (!mine()) return;
      let ok = false;
      try { ok = await probe(port); } catch { ok = false; }
      if (!mine()) return;
      if (ok) break;
      if (Date.now() >= deadline) {
        this._announced = true;
        try { this._onState(this.id, { ...this.status(), firstUp: true, ready: false }); } catch {}
        return;
      }
      await new Promise((resolve) => {
        rec.wake = resolve;
        rec.timer = setTimeout(resolve, pollMs);
      });
      clearTimeout(rec.timer);
      rec.timer = null;
      rec.wake = null;
    }
    if (!mine()) return;
    this._announced = true;
    try { this._onState(this.id, { ...this.status(), firstUp: true, ready: true }); } catch {}
  }

  _scheduleRestart() {
    this._setState('down');
    if (this._stopped) return;
    if (this._deadline && Date.now() >= this._deadline) {
      // Never came up in the window — stop, and SAY so. lastError survives into
      // the terminal state so a consumer can show why rather than just "down".
      // Unreachable when giveUpMs is null: _deadline stays 0 and this tunnel
      // retries for as long as it is wanted.
      this._stopped = true;
      clearTimeout(this._timer);
      this._timer = null;
      this._setState('gave-up');
      return;
    }
    const delay = this._backoff;
    this._backoff = Math.min(this._backoff * 2, this._backoffMaxMs);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this._spawnTunnel(); }, delay);
  }
}

module.exports = {
  SupervisedTunnel, CLOUD_KINDS, sameCloud, destinationOf, hasCloudTransport,
};
