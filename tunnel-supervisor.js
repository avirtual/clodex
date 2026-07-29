// `state: 'up'` means only that the child is alive: `ssh -N` prints nothing on
// success, so it is all the process can offer. A consumer that gets ONE shot at
// the URL passes `readiness` instead — `kubectl port-forward` lives a few hundred
// ms before it accepts, and a browser tab opened into that gap shows an error
// page. The probe is injected; this module never learns how to tell that a
// forward is serving. `firstUp` is a one-shot emit, never stored on the status
// row, so a later status() reader cannot act on it a second time.

'use strict';

const net = require('net');
const { ssmArgv, kubectlArgv, gcloudArgv, azArgv, substitutePort } = require('./cli/src/transport');
const { spawnDial, killDial, sshTunnelArgv, STDERR_TAIL_BYTES } = require('./cli/src/dial');

const CLOUD_KINDS = {
  ssm:     { argv: ssmArgv,     fields: ['target', 'region', 'profile'],     required: ['target'] },
  kubectl: { argv: kubectlArgv, fields: ['target', 'namespace', 'context'],  required: ['target'] },
  gcloud:  { argv: gcloudArgv,  fields: ['instance', 'zone', 'project'],     required: ['instance'] },
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

function destinationOf(rec) {
  if (!rec) return null;
  if (rec.sshHost) return { sshHost: String(rec.sshHost), cloud: null };
  for (const [kind, spec] of Object.entries(CLOUD_KINDS)) {
    const raw = rec[kind];
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

function hasCloudTransport(peer) {
  if (!peer) return false;
  return Object.entries(CLOUD_KINDS).some(([kind, spec]) => {
    const raw = peer[kind];
    return !!(raw && spec.required.every((f) => raw[f]));
  });
}

// Deliberately not exported: cli/src/transport.js exports a DIFFERENT
// `pickFreePort` (promise-returning, no callback), and `_spawnTunnel` closes over
// this const anyway — the seam that works is `net.createServer`.
function pickFreePort(cb) {
  const srv = net.createServer();
  srv.on('error', () => cb(null));
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    srv.close(() => cb(port));
  });
}

class SupervisedTunnel {
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
    this._spawn = spawnFn || null;
    this._onState = onState || (() => {});
    this._backoffMinMs = backoffMinMs;
    this._backoffMaxMs = backoffMaxMs;
    this._stableMs = stableMs;
    this._giveUpMs = giveUpMs;
    this._pinPort = !!pinPort;
    this._readiness = readiness;
    this.localPort = null;
    this.state = 'down';             // 'up' | 'down' | 'gave-up'
    this.lastError = null;
    this._child = null;
    this._timer = null;
    this._backoff = backoffMinMs;
    this._stopped = false;
    this._announced = false;         // readiness: the one-shot has gone out
    this._deadline = 0;              // give-up wall-clock; 0 = never
    // One record per LIVE readiness loop. `_spawnOn` starts one per CHILD and a
    // probe can outlive its child, so two loops can be alive at once: any
    // per-instance wake/timer slot would let the newer loop take the older's,
    // parking the older await forever and leaving its timer live past stop().
    // The set is also the only way stop() can reach a loop it has no name for.
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

  settled() { return Promise.all([...this._probes].map((p) => p.done)); }

  status() {
    return {
      id: this.id, sshHost: this.sshHost,
      ...(this.cloud ? { [this.cloud.kind]: { ...this.cloud.block } } : {}),
      remotePort: this.remotePort,
      state: this.state, localPort: this.localPort, error: this.lastError,
      url: this.url(),
    };
  }

  url() { return this.state === 'up' && this.localPort ? `http://127.0.0.1:${this.localPort}` : null; }

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
    killDial(child, { group: this._detached() });
  }

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
      const rec = { wake: null, timer: null, done: null };
      this._probes.add(rec);
      rec.done = this._probeThenAnnounce(child, port, rec)
        .finally(() => { this._probes.delete(rec); });
    }
  }

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
