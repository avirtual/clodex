// wirescope-supervisor.js — the WirescopeSupervisor (phase-1 of the wirescope
// integration): detect-first adoption of a wirescope already answering on the
// configured port, else spawn the vendored `uvicorn logproxy:app` in a Clodex-
// managed venv under userData. Manages venv create/reinstall, survivor pickup
// across app restarts (pidfile), and clean SIGTERM shutdown of only our child.
//
// FACTORY (M3 DI): reads three main.js globals — the logger and ProxyClient
// (injected by value) and uiSettings (injected as a getUiSettings() getter,
// since it is only assigned in app.whenReady(), after this module is required).
// electron/app + crypto/fs/path/child_process are ordinary requires. Bodies are
// byte-identical modulo the +2 factory indent and the 7 flagged seam lines.
//
// Spawns real processes + touches userData, so integration-only; no unit tests.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app } = require('electron');

function createWirescopeSupervisor({ log, ProxyClient, getUiSettings }) {
  // ---------------------------------------------------------------------------
  // WirescopeSupervisor (phase-1): run the vendored wirescope, zero setup
  // ---------------------------------------------------------------------------
  // Detect-first: if a wirescope is already answering on the configured port we
  // ADOPT it (never spawn a second — that's how the user's shared :7800 stays the
  // single ledger). Otherwise spawn `uvicorn logproxy:app` with the PORT +
  // LOG_DIR + WARMTH_DB triple so a managed instance is fully owner-scoped and
  // coexists with anything else. SIGTERM is a clean shutdown (uvicorn graceful +
  // atexit writer drain). We only ever stop OUR child.
  //
  // Phase-1: the source defaults to the vendored snapshot shipped with Clodex
  // (scripts/vendor-wirescope.sh → vendor/wirescope, pinned by VENDOR.json); an
  // explicit wirescopeDir setting still wins for users tracking their own tree.
  // Dependencies live in a Clodex-managed venv under userData, created on first
  // start and re-installed when the source's requirements.txt changes. Requires
  // a system python3 (macOS: xcode-select --install); everything degrades
  // gracefully without one — sessions fall back to wire → Anthropic direct.
  // See https://github.com/avirtual/wirescope and .claude/memory.md.
  class WirescopeSupervisor {
    constructor() {
      this.child = null;       // ChildProcess of a managed instance, else null
      this.startedPort = null; // port we spawned on
      this.lastError = null;   // surfaced to the prefs UI
      this._stderr = '';       // tail of child stderr for diagnostics
      this.installing = false; // venv create / pip install in flight
      this._startChain = null; // in-flight async start (venv → spawn) guard
    }

    _base(port) { return `http://127.0.0.1:${port}`; }

    // Base URL of the configured managed instance (for machine-wide endpoints
    // like /_prune that aren't tied to a routed session). Doesn't probe — the
    // caller's request surfaces a down proxy as an error.
    baseUrl() { return this._base(getUiSettings().get().wirescopePort || 7800); }

    _dirs() {
      const root = path.join(app.getPath('userData'), 'wirescope');
      return { logDir: path.join(root, 'logs'), warmthDb: path.join(root, 'warmth.sqlite') };
    }

    // dir looks like a wirescope checkout if it has the logproxy entrypoint.
    _looksValid(dir) {
      try { return !!dir && fs.existsSync(path.join(dir, 'logproxy.py')); } catch { return false; }
    }

    // Vendored snapshot. Dev runs straight from the repo's vendor/ dir; packaged
    // runs from Contents/Resources (extraResources — python can't execute from
    // inside the asar archive).
    _vendorDir() {
      const dir = app.isPackaged
        ? path.join(process.resourcesPath, 'wirescope')
        : path.join(__dirname, 'vendor', 'wirescope');
      return this._looksValid(dir) ? dir : null;
    }

    // Source resolution: an explicit user checkout wins; otherwise the vendored
    // snapshot. A set-but-invalid user dir is an error, not a silent fallback —
    // the user pointed somewhere on purpose.
    _source() {
      const s = getUiSettings().get();
      const dir = s.wirescopeDir || '';
      if (dir) {
        return this._looksValid(dir)
          ? { dir, origin: 'user' }
          : { dir: null, origin: 'user', error: `Not a wirescope checkout (no logproxy.py in ${dir})` };
      }
      const vend = this._vendorDir();
      return vend
        ? { dir: vend, origin: 'vendored' }
        : { dir: null, origin: null, error: 'No wirescope source (no vendored copy in this build; set a source directory)' };
    }

    // Version the resolved source would run if (re)spawned — for staleness
    // detection against a running instance. Only meaningful for the vendored
    // snapshot: RELEASE is written by scripts/vendor-wirescope.sh and echoed
    // verbatim by /_identity, so string equality is exact. A user checkout
    // self-reports however it likes — no comparison, no false staleness.
    _sourceVersion(src) {
      if (!src || src.origin !== 'vendored' || !src.dir) return null;
      try { return fs.readFileSync(path.join(src.dir, 'RELEASE'), 'utf8').trim(); } catch { return null; }
    }

    _venvDir() { return path.join(app.getPath('userData'), 'wirescope', 'venv'); }
    _venvPython() { return path.join(this._venvDir(), 'bin', 'python3'); }

    // GUI apps inherit launchd's minimal PATH. Startup merges the login shell's
    // PATH, but the hard fallbacks keep this working when that merge hasn't run
    // (dev) or the shell profile is broken.
    _findPython3() {
      const cands = (process.env.PATH || '').split(':').filter(Boolean)
        .map((d) => path.join(d, 'python3'))
        .concat(['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']);
      for (const p of cands) {
        try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
      }
      return null;
    }

    _run(cmd, args, opts = {}) {
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
        } catch (e) { reject(e); return; }
        let tail = '';
        if (child.stderr) child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, opts.timeoutMs || 300000);
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`${path.basename(cmd)} ${args[1] || args[0]} exited ${code}${
            tail ? ': ' + tail.trim().split('\n').slice(-3).join(' ').slice(-300) : ''}`));
        });
      });
    }

    // Managed venv under userData, stamped with the source's requirements hash
    // so a vendored upgrade (or a user checkout's dep bump) re-installs once and
    // an unchanged one is a two-stat no-op.
    async _ensureVenv(srcDir) {
      const reqPath = path.join(srcDir, 'requirements.txt');
      let reqHash = '';
      try { reqHash = crypto.createHash('sha256').update(fs.readFileSync(reqPath)).digest('hex'); } catch {}
      const venv = this._venvDir();
      const py = this._venvPython();
      const stamp = path.join(venv, '.clodex-venv-stamp');
      try {
        if (fs.existsSync(py) && fs.readFileSync(stamp, 'utf8').trim() === reqHash) return py;
      } catch {}
      const sysPy = this._findPython3();
      if (!sysPy) throw new Error('python3 not found — install Python 3.9+ (macOS: xcode-select --install)');
      this.installing = true;
      try {
        fs.mkdirSync(path.dirname(venv), { recursive: true });
        if (!fs.existsSync(py)) await this._run(sysPy, ['-m', 'venv', venv], { timeoutMs: 120000 });
        if (reqHash) {
          await this._run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', reqPath],
            { timeoutMs: 600000 });
        }
        fs.writeFileSync(stamp, reqHash);
        return py;
      } finally {
        this.installing = false;
      }
    }

    // Autostart is wanted only when sessions would actually route through the
    // managed instance: proxy enabled AND proxyUrl pointing at the managed local
    // port. A remote/custom proxyUrl means the user runs their own thing.
    autoStartWanted() {
      const s = getUiSettings().get();
      if (!s.proxyEnabled) return false;
      try {
        const u = new URL(s.proxyUrl);
        const port = parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10);
        return (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
          && port === (s.wirescopePort || 7800);
      } catch { return false; }
    }

    async status() {
      const s = getUiSettings().get();
      const port = s.wirescopePort || 7800;
      const base = this._base(port);
      const src = this._source();
      const probe = await ProxyClient.probe(base).catch(() => null);
      // "Ours" = the child of this launch, or a surviving instance from a
      // previous launch (pidfile) — both count as managed, not external.
      const alive = !!(this.child && this.child.exitCode === null && !this.child.killed)
        || !!this._survivorPid();

      let state;
      if (probe) state = alive ? 'managed' : 'external';
      else if (this.installing) state = 'installing';
      else if (alive || this._startChain) state = 'starting';
      else state = 'stopped';

      // Managed instance serving a different version than the vendored source
      // would spawn — the launch-time auto-restart normally clears this; it
      // survives only if that path was latched or raced, and the prefs
      // Restart button is the manual clear.
      const wantVersion = this._sourceVersion(src);
      const stale = !!(alive && probe && probe.version && wantVersion && probe.version !== wantVersion);

      return {
        state, port, base,
        dir: s.wirescopeDir || '',
        dirValid: src.origin === 'user' ? !!src.dir : this._looksValid(s.wirescopeDir),
        origin: src.dir ? src.origin : null, // 'user' | 'vendored' | null
        product: probe ? probe.product : null,
        version: probe ? probe.version : null,
        stale,
        managed: alive,
        error: this.lastError,
      };
    }

    // Fully async start chain: (venv ensure →) spawn. Returns immediately —
    // first run installs the venv (python3 -m venv + pip install), which can
    // take tens of seconds; the prefs dialog polls progress via status().
    // Returns { ok, state, error? }. Adopts an existing wirescope rather than
    // spawning a duplicate. Spawn errors surface asynchronously via status().
    async start() {
      const s = getUiSettings().get();
      const port = s.wirescopePort || 7800;
      const base = this._base(port);

      // Detect-first: already serving here? Reattach if it's our survivor from
      // a previous launch, adopt if it's someone else's — never spawn a second.
      const probe = await ProxyClient.probe(base).catch(() => null);
      if (probe) {
        this.lastError = null;
        const ours = !!this._survivorPid();
        // Vendor-bump pickup: a managed survivor deliberately outlives the GUI,
        // so after a re-vendor it keeps serving the OLD code forever unless
        // someone kills it. If the survivor's reported version differs from the
        // vendored RELEASE, restart it in place — once per app launch (the
        // latch), so an unexpected version string can never restart-loop.
        // Adopted external instances are someone else's process: never touched,
        // whatever their version.
        if (ours && !this._upgradeTried) {
          const want = this._sourceVersion(this._source());
          if (want && probe.version && probe.version !== want) {
            this._upgradeTried = true;
            return this.restart();
          }
        }
        return { ok: true, state: ours ? 'managed' : 'external', adopted: !ours };
      }
      if (this.child && this.child.exitCode === null) {
        return { ok: true, state: 'starting' };
      }
      if (this._startChain) {
        return { ok: true, state: this.installing ? 'installing' : 'starting' };
      }
      const src = this._source();
      if (!src.dir) {
        this.lastError = src.error;
        return { ok: false, error: this.lastError };
      }

      this.lastError = null;
      const chain = (async () => {
        const py = await this._ensureVenv(src.dir);
        this._spawn(py, src.dir, port);
      })();
      this._startChain = chain;
      chain
        .catch((e) => { this.lastError = e.message; })
        .finally(() => { if (this._startChain === chain) this._startChain = null; });
      return { ok: true, state: 'installing' };
    }

    _pidFile() { return path.join(app.getPath('userData'), 'wirescope', 'wirescope.pid'); }
    _logFile() { return path.join(this._dirs().logDir, 'uvicorn.log'); }

    // The pid of a still-running managed instance from a PREVIOUS app launch.
    // Guarded by port match: a pidfile for a different port is stale config,
    // not our instance (pid-reuse misfire is accepted as a local-tool risk —
    // the exposure is one SIGTERM to a same-uid process recorded in our own
    // pidfile).
    _survivorPid() {
      try {
        const rec = JSON.parse(fs.readFileSync(this._pidFile(), 'utf8'));
        const s = getUiSettings().get();
        if (!rec || !rec.pid || rec.port !== (s.wirescopePort || 7800)) return null;
        process.kill(rec.pid, 0); // throws if gone
        return rec.pid;
      } catch { return null; }
    }

    _logTail() {
      try {
        const buf = fs.readFileSync(this._logFile(), 'utf8');
        return buf.trim().split('\n').slice(-3).join(' ').slice(-300);
      } catch { return ''; }
    }

    // Spawn uvicorn from the resolved source with the venv's python.
    // DETACHED + stderr-to-logfile + pidfile: the managed instance deliberately
    // OUTLIVES the GUI, so the warmth ledger and prefix caches keep continuity
    // across app restarts; the next launch re-recognizes it via the pidfile and
    // the Traffic optimization toggle can still stop it. Nothing may tie its
    // stdio to the Electron process — parent exit would break the pipe under it.
    // PYTHONDONTWRITEBYTECODE: a packaged vendored copy lives inside the signed
    // .app bundle — __pycache__ writes there would invalidate the code signature.
    _spawn(python, dir, port) {
      const { logDir, warmthDb } = this._dirs();
      try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
      let logFd = 'ignore';
      try { logFd = fs.openSync(this._logFile(), 'a'); } catch {}

      const child = spawn(python,
        ['-m', 'uvicorn', 'logproxy:app', '--host', '127.0.0.1', '--port', String(port)],
        {
          cwd: dir,
          env: {
            ...process.env,
            PORT: String(port), LOG_DIR: logDir, WARMTH_DB: warmthDb,
            PYTHONDONTWRITEBYTECODE: '1',
            // Canonical start_proxy.sh defaults (verified against the script,
            // 2026-07-03) — bare uvicorn leaves them OFF, which silently drops
            // deployment behavior the fleet has always run with. Most load-
            // bearing: WARMTH_BLOCK_COLD_PING (a ping/hold against an expired
            // prefix must DECLINE, not re-write the full prefix at premium)
            // and WS_OMIT_DEFAULT (subagent spawns don't inherit the userEmail
            // block; main lines carry it unless the agent omits explicitly).
            // Explicit user env overrides win (`?? '…'` mirrors the script's
            // ${VAR-default}: an exported 0 sticks).
            STRIP_COMPACT_CACHE: process.env.STRIP_COMPACT_CACHE ?? '1',
            WARMTH_BLOCK_COLD_PING: process.env.WARMTH_BLOCK_COLD_PING ?? '1',
            WARMTH_LOG_FILE: process.env.WARMTH_LOG_FILE ?? '1',
            WS_SPAWNER_HINT: process.env.WS_SPAWNER_HINT ?? '1',
            WS_OMIT_DEFAULT: process.env.WS_OMIT_DEFAULT ?? 'useremail',
          },
          detached: true,
          stdio: ['ignore', logFd, logFd],
        });
      if (logFd !== 'ignore') { try { fs.closeSync(logFd); } catch {} }

      this.child = child;
      this.startedPort = port;
      try {
        fs.writeFileSync(this._pidFile(), JSON.stringify({ pid: child.pid, port }));
      } catch {}
      child.on('error', (e) => {
        this.lastError = `wirescope failed to start: ${e.message}`;
        if (this.child === child) { this.child = null; this.startedPort = null; }
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) { this.child = null; this.startedPort = null; }
        try { fs.unlinkSync(this._pidFile()); } catch {}
        if (code && code !== 0) {
          const tail = this._logTail();
          this.lastError = `wirescope exited (code ${code})${tail ? ': ' + tail : ''}`;
        } else if (signal && signal !== 'SIGTERM') {
          this.lastError = `wirescope terminated (${signal})`;
        }
      });
      child.unref();
    }

    // Stop a Clodex-managed instance — the live child of this launch, or a
    // survivor from a previous one (via pidfile). Never an adopted/external
    // instance: those have no pidfile of ours.
    stop() {
      if (this.child && this.child.exitCode === null) {
        try { this.child.kill('SIGTERM'); } catch {}
      } else {
        const pid = this._survivorPid();
        if (pid) {
          try { process.kill(pid, 'SIGTERM'); } catch {}
          try { fs.unlinkSync(this._pidFile()); } catch {}
        }
      }
      this.child = null;
      this.startedPort = null;
      return { ok: true };
    }

    // Restart the MANAGED instance in place — vendor-bump pickup or a manual
    // nudge from prefs. Only ours (live child or pidfile survivor); an adopted
    // external instance is someone else's process and gets an error, not a kill.
    // Death is confirmed by pid polling, not the child handle (the instance is
    // detached and usually from a previous launch); a hung graceful shutdown
    // gets SIGKILL after ~10s. Waiting for the pid to actually vanish before
    // start() matters: uvicorn's graceful drain keeps answering probes while
    // dying, and a premature start() would "adopt" the corpse.
    async restart() {
      const pid = (this.child && this.child.exitCode === null && !this.child.killed)
        ? this.child.pid : this._survivorPid();
      if (!pid) {
        const s = getUiSettings().get();
        const probe = await ProxyClient.probe(this._base(s.wirescopePort || 7800)).catch(() => null);
        if (probe) return { ok: false, error: 'Proxy on this port is not managed by Clodex — restart it where it was started.' };
        return this.start(); // nothing running: restart degenerates to start
      }
      try { process.kill(pid, 'SIGTERM'); } catch {}
      const gone = () => { try { process.kill(pid, 0); return false; } catch { return true; } };
      for (let i = 0; i < 40 && !gone(); i++) await new Promise((r) => setTimeout(r, 250));
      if (!gone()) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
      try { fs.unlinkSync(this._pidFile()); } catch {}
      this.child = null;
      this.startedPort = null;
      return this.start();
    }
  }

  return { WirescopeSupervisor };
}

module.exports = { createWirescopeSupervisor };
