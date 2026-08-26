// No electron require in this module: the two electron seams are injected as
// getter fns so it runs unchanged under a headless host.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { isEnvTruthy, teeBlindBackend } = require('./claude-env');

function wirescopeBindHost(env = process.env) {
  return env.CLODEX_WIRESCOPE_HOST || '127.0.0.1';
}
function uvicornArgs(port, env = process.env) {
  return ['-m', 'uvicorn', 'logproxy:app', '--host', wirescopeBindHost(env), '--port', String(port)];
}

// A truthy CLODEX_WIRESCOPE does NOT override the tee-blind gate — Bedrock/Vertex
// traffic ignores ANTHROPIC_BASE_URL, so there is nothing to force on.
// The tee-blind check reads the NODE-level env only, never the per-session
// settings chain: a node with some Bedrock sessions still keeps wirescope.
function wirescopeEnvGate(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, 'CLODEX_WIRESCOPE')) {
    const v = String(env.CLODEX_WIRESCOPE == null ? '' : env.CLODEX_WIRESCOPE).trim().toLowerCase();
    if (v === 'off' || !isEnvTruthy(v)) return 'disabled by CLODEX_WIRESCOPE';
  }
  const blind = teeBlindBackend(env);
  if (blind) return `tee-blind backend (${blind}) — proxy would see no traffic`;
  return null;
}

function createWirescopeSupervisor({ log, ProxyClient, getUiSettings, getUserDataPath, isPackaged }) {
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

    baseUrl() { return this._base(getUiSettings().get().wirescopePort || 7800); }

    _dirs() {
      const root = path.join(getUserDataPath(), 'wirescope');
      return { logDir: path.join(root, 'logs'), warmthDb: path.join(root, 'warmth.sqlite') };
    }

    _looksValid(dir) {
      try { return !!dir && fs.existsSync(path.join(dir, 'logproxy.py')); } catch { return false; }
    }

    // Vendored snapshot. Dev runs straight from the repo's vendor/ dir; packaged
    // runs from Contents/Resources (extraResources — python can't execute from
    // inside the asar archive).
    _vendorDir() {
      const dir = isPackaged()
        ? path.join(process.resourcesPath, 'wirescope')
        : path.join(__dirname, 'vendor', 'wirescope');
      return this._looksValid(dir) ? dir : null;
    }

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

// Vendored only: a user checkout self-reports its version however it likes,
// so comparing it would produce false staleness.
    _sourceVersion(src) {
      if (!src || src.origin !== 'vendored' || !src.dir) return null;
      try { return fs.readFileSync(path.join(src.dir, 'RELEASE'), 'utf8').trim(); } catch { return null; }
    }

    _venvDir() { return path.join(getUserDataPath(), 'wirescope', 'venv'); }
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
          // Some distros (Amazon Linux 2023, minimal RHEL) ship a python3 whose
          // venvs are born WITHOUT pip (ensurepip split into a separate rpm), so
          // `venv/bin/python3 -m pip` dies with "No module named pip". Probe and
          // bootstrap via ensurepip before the install; if even ensurepip is
          // missing, fail with the actionable package hint instead of the bare
          // module error.
          try { await this._run(py, ['-m', 'pip', '--version'], { timeoutMs: 30000 }); }
          catch {
            try { await this._run(py, ['-m', 'ensurepip', '--upgrade'], { timeoutMs: 120000 }); }
            catch {
              throw new Error('venv has no pip and ensurepip is unavailable — install your distro\'s python3-pip package (e.g. dnf install python3-pip) and retry');
            }
          }
          await this._run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', reqPath],
            { timeoutMs: 600000 });
        }
        fs.writeFileSync(stamp, reqHash);
        return py;
      } finally {
        this.installing = false;
      }
    }

// process.env is read at CALL time (never hoisted): a headless node picks up
// its systemd drop-in / pod env live on restart.
    autoStartWanted() {
      if (wirescopeEnvGate(process.env)) return false;
      const s = getUiSettings().get();
      if (!s.proxyEnabled) return false;
      try {
        const u = new URL(s.proxyUrl);
        const port = parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10);
        return (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
          && port === (s.wirescopePort || 7800);
      } catch { return false; }
    }

    // The loopback port a PEER could forward to, or null when this box has no
    // wirescope to reach (t443). SYNCHRONOUS and unprobed on purpose: its only
    // caller is the peering hello, which answers on the request thread and must
    // not wait on a python process — status() is the probing one and is async
    // for exactly that reason.
    //
    // Gated on autoStartWanted() rather than on the port alone: `wirescopePort`
    // is a settings value that survives CLODEX_WIRESCOPE=off and a proxy pointed
    // somewhere else, so advertising it unconditionally would tell a peer to
    // forward to a port nothing listens on. That is the guess this ticket
    // exists to prevent, one layer earlier.
    localReach() {
      if (!this.autoStartWanted()) return null;
      const port = getUiSettings().get().wirescopePort || 7800;
      return Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : null;
    }

    async status() {
      const s = getUiSettings().get();
      const port = s.wirescopePort || 7800;
      const base = this._base(port);
      const src = this._source();
      const probe = await ProxyClient.probe(base).catch(() => null);
      const alive = !!(this.child && this.child.exitCode === null && !this.child.killed)
        || !!this._survivorPid();

      let state;
      if (probe) state = alive ? 'managed' : 'external';
      else if (this.installing) state = 'installing';
      else if (alive || this._startChain) state = 'starting';
      else state = 'stopped';

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
        envGate: wirescopeEnvGate(process.env),
      };
    }

    async start() {
      const gate = wirescopeEnvGate(process.env);
      if (gate) {
        this.lastError = `wirescope ${gate}`;
        return { ok: false, error: this.lastError };
      }
      const s = getUiSettings().get();
      const port = s.wirescopePort || 7800;
      const base = this._base(port);

      const probe = await ProxyClient.probe(base).catch(() => null);
      if (probe) {
        this.lastError = null;
        const ours = !!(this._survivorPid() || this._reclaimPidFile(port));
// The _upgradeTried latch is once per app launch — without it an unexpected
// version string restart-loops. Adopted external instances are never touched.
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

    _pidFile() { return path.join(getUserDataPath(), 'wirescope', 'wirescope.pid'); }
    _logFile() { return path.join(this._dirs().logDir, 'uvicorn.log'); }

    // The ONE place a pid of FILE provenance enters this class, so it is the one
    // place the `> 0` refusal has to live: stop() and restart() both signal
    // whatever this returns, and restart() escalates to SIGKILL. `> 0` and not
    // merely truthy — process.kill reads a non-positive pid as a BROADCAST, so a
    // pidfile carrying -1 (a truncated write, a hand-edit, a recycled file) has
    // stop() signalling every process the user owns. The liveness probe below is
    // no backstop for that: kill(-1, 0) does NOT throw, so a broadcast pid reads
    // as alive and restart()'s gone() poll never terminates the escalation.
    _survivorPid() {
      try {
        const rec = JSON.parse(fs.readFileSync(this._pidFile(), 'utf8'));
        const s = getUiSettings().get();
        if (!rec) return null;
        if (!(rec.pid > 0)) {
          // Logged only when the pidfile actually carried something: an absent
          // pid is the ordinary "no survivor" case, a non-positive one is a
          // corrupt record that would have been signalled.
          if (rec.pid !== undefined) {
            log.warn('wirescope', `ignoring pidfile: pid is ${rec.pid}, which would broadcast rather than target`);
          }
          return null;
        }
        if (rec.port !== (s.wirescopePort || 7800)) return null;
        process.kill(rec.pid, 0); // throws if gone
        return rec.pid;
      } catch { return null; }
    }

    // Re-adopt a managed proxy whose pidfile was lost (pre-fix orphans, a wiped
    // userData). Identity is OBSERVED from outside, never asked for: /_identity
    // carries no pid, and trusting a self-reported one would let any listener on
    // the port talk Clodex into a record that `stop()` then kills.
    //
    // The evidence is WARMTH_DB in the process env, and only that. cwd and argv
    // are NOT evidence: `uvicorn logproxy:app` resolves the module only when cwd
    // IS the source dir, so both are entailed by any working wirescope on that
    // port — including one the USER hand-started from their own wirescopeDir,
    // which adoption would then let stop()/restart() kill. WARMTH_DB discriminates
    // because proxylab/store.py defaults it INTO the source dir when unset, while
    // _spawn always overrides it to this app's userData; it is fixed at exec, so
    // nothing outside the process can forge it, and every pre-fix orphan carries
    // it (the var predates the pidfile — see _spawn's env).
    // Compared against _dirs() rather than a pattern: that is the same function
    // that produced the value, so a dev-vs-packaged userData correctly does NOT
    // adopt the other's survivor.
    // Callers must have probed the port first — this only establishes ownership.
    _reclaimPidFile(port) {
      if (this._survivorPid()) return null;            // a valid record already exists
      // start() runs on every launch and every settings:set, so an unfixable
      // environment must not log on a loop. `log` is a bare fn in some hosts —
      // never assume the tagged-method shape here.
      const warnOnce = (tool) => {
        if (this._missingTool === tool) return;
        this._missingTool = tool;
        const msg = `${tool} not found — cannot re-adopt an orphaned wirescope`;
        try { (log && typeof log.warn === 'function') ? log.warn('wirescope', msg) : (typeof log === 'function' && log(msg)); } catch {}
      };
      const wantDb = this._dirs().warmthDb;
      const host = wirescopeBindHost(process.env);
      let pids;
      try {
        // -w: lsof exits nonzero on any warning, which would discard a good read.
        // Address-scoped and ALL holders, not [0]: a foreign co-listener picked
        // arbitrarily would block recovery forever.
        pids = execFileSync('lsof', ['-w', '-nP', `-iTCP@${host}:${port}`, '-sTCP:LISTEN', '-t'],
          { encoding: 'utf8', timeout: 2000 })
          .split('\n').map((l) => parseInt(l.trim(), 10)).filter(Boolean);
      } catch (e) {
        // ENOENT here means lsof is absent (common in Linux containers) and the
        // feature can never work — silent failure would leave no way to diagnose
        // a proxy that never re-adopts.
        if (e && e.code === 'ENOENT') warnOnce('lsof');
        return null;
      }
      for (const pid of pids) {
        let env;
        try {
          env = execFileSync('ps', ['-Eww', '-o', 'command=', '-p', String(pid)],
            { encoding: 'utf8', timeout: 2000 });
        } catch (e) {
          if (e && e.code === 'ENOENT') warnOnce('ps');
          return null;
        }
        // Bounded by the NEXT VAR= token, not by whitespace: these are userData
        // paths and "Application Support" has a space in it. The alternation must
        // include \n — ps ends its line with one, `.` never crosses it, and a
        // bare `$` (no /m) does not match before it, so the LAST var on the line
        // silently failed to parse.
        const m = env.match(/WARMTH_DB=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|\n|$)/);
        if (!m || m[1] !== wantDb) continue;
        try {
          fs.mkdirSync(path.dirname(this._pidFile()), { recursive: true });
          fs.writeFileSync(this._pidFile(), JSON.stringify({ pid, port }));
        } catch { return null; }
        return pid;
      }
      return null;
    }

    // Drop the pidfile only when it still names `pid`. A restart's outgoing child
    // must never delete its successor's record — see the exit handler.
    _releasePidFile(pid) {
      try {
        const rec = JSON.parse(fs.readFileSync(this._pidFile(), 'utf8'));
        if (rec && rec.pid !== pid) return;      // a successor owns it now
      } catch { /* unreadable/absent — fall through and unlink */ }
      try { fs.unlinkSync(this._pidFile()); } catch {}
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

      const child = spawn(python, uvicornArgs(port),
        {
          cwd: dir,
          env: {
            ...process.env,
            PORT: String(port), LOG_DIR: logDir, WARMTH_DB: warmthDb,
            PYTHONDONTWRITEBYTECODE: '1',
// Canonical start_proxy.sh defaults — bare uvicorn leaves them OFF.
// `?? '…'` mirrors the script's ${VAR-default}: an explicitly exported 0
// sticks (`||` would silently re-enable the default).
            STRIP_COMPACT_CACHE: process.env.STRIP_COMPACT_CACHE ?? '1',
            WARMTH_BLOCK_COLD_PING: process.env.WARMTH_BLOCK_COLD_PING ?? '1',
            WARMTH_LOG_FILE: process.env.WARMTH_LOG_FILE ?? '1',
            WS_SPAWNER_HINT: process.env.WS_SPAWNER_HINT ?? '1',
            WS_OMIT_DEFAULT: process.env.WS_OMIT_DEFAULT ?? 'useremail',
            // EndConversation is CLI-pinned (immune to settings-deny /
            // --disallowedTools), so the proxy strip is the only removal
            // route. Default-on: the schema costs ~1.7k tokens per request
            // and the tool is useless in a wrapped session. Export
            // STRIP_TOOLS_GLOBAL= (empty) to turn it off; per-spawn
            // re-admit via [wirescope:keep-tools EndConversation].
            STRIP_TOOLS_GLOBAL: process.env.STRIP_TOOLS_GLOBAL ?? 'EndConversation',
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
        // ONLY if the record still names THIS child. `exit` lands asynchronously,
        // so on a restart it fires AFTER the successor has already written its own
        // pidfile — an unconditional unlink deletes the live proxy's record.
        // Clodex then cannot recognize its own survivor: _survivorPid() returns
        // null, so status() reports `external` (the UI reads "not running" and
        // hides Restart) and start()'s `ours` gate never runs the version check,
        // pinning the running proxy at whatever version it launched with while a
        // newer one sits vendored. Observed live: a v0.6.46 survivor ignored a
        // v0.6.47 vendor bump across GUI restarts.
        this._releasePidFile(child.pid);
        if (code && code !== 0) {
          const tail = this._logTail();
          this.lastError = `wirescope exited (code ${code})${tail ? ': ' + tail : ''}`;
        } else if (signal && signal !== 'SIGTERM') {
          this.lastError = `wirescope terminated (${signal})`;
        }
      });
      child.unref();
    }

    stop() {
      if (this.child && this.child.exitCode === null) {
        try { this.child.kill('SIGTERM'); } catch {}
      } else {
        const pid = this._survivorPid();
        if (pid) {
          try { process.kill(pid, 'SIGTERM'); } catch {}
          this._releasePidFile(pid);
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
      this._releasePidFile(pid);
      this.child = null;
      this.startedPort = null;
      return this.start();
    }
  }

  return { WirescopeSupervisor };
}

module.exports = { createWirescopeSupervisor, wirescopeBindHost, uvicornArgs, wirescopeEnvGate };
