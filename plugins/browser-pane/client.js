'use strict';

const childProcess = require('node:child_process');

const DEFAULTS = {
  readyMs: 20000,
  heartbeatMs: 30000,
  pongMs: 10000,
  idleStopMs: 15 * 60 * 1000,
  crashWindowMs: 5 * 60 * 1000,
  crashLimit: 3,
  refuseMs: 10 * 60 * 1000,
  termMs: 3000,
  killMs: 2000,
  logWindowMs: 60000,
  logBurst: 20,
};

const OP_DEADLINE_MS = {
  ping: 10000, open: 110000, read: 20000, inspect: 20000, shutdown: 5000,
  click: 100000, type: 100000, key: 100000, select: 100000, handback: 15000, show: 5000,
};
const STDERR_KEEP = 20;
const HEADLESS = 'browser unavailable — this Clodex host has no Electron (headless); the browser pane needs the desktop app.';
const CRASHED = 'browser unavailable — the child crashed 3 times; see the Clodex log';

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
  clearTimeout: (t) => clearTimeout(t),
};

function codedError(message, code, detail) {
  const e = new Error(message);
  if (code) e.code = code;
  if (detail) e.detail = detail;
  return e;
}

function createClient(opts) {
  const o = { ...DEFAULTS, ...(opts.timeouts || {}) };
  const clock = opts.clock || realClock;
  const spawn = opts.spawn || childProcess.spawn;
  const log = opts.log || { info() {}, error() {} };
  const onEvent = opts.onEvent || (() => {});
  const onExit = opts.onExit || (() => {});

  let proc = null;
  let startP = null;
  let state = 'off';
  let nextId = 1;
  const pending = new Map();
  let exits = [];
  let refusedUntil = 0;
  let expectExit = false;
  let disposed = false;
  let lastActivity = clock.now();
  let idleTimer = null;
  let beatTimer = null;
  let stderrTail = [];
  let exitWaiters = [];
  let logCount = 0;
  let logWindowAt = 0;

  const limited = (msg) => {
    const now = clock.now();
    if (now - logWindowAt > o.logWindowMs) { logWindowAt = now; logCount = 0; }
    logCount += 1;
    if (logCount <= o.logBurst) log.info(msg);
  };

  const clear = (t) => { if (t) clock.clearTimeout(t); return null; };

  function send(frame) {
    if (!proc || !proc.stdin || proc.stdin.destroyed) return false;
    try { proc.stdin.write(JSON.stringify({ cxb: 1, ...frame }) + '\n'); return true; } catch { return false; }
  }

  function onFrame(frame) {
    if (frame.id != null) {
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      clear(p.timer);
      if (frame.ok) p.resolve(frame.result || {});
      else p.reject(codedError(String(frame.error || 'browser child error'), frame.code || 'INTERNAL', frame.detail));
      return;
    }
    if (frame.event === 'ready') {
      if (startP && startP.ready) startP.ready(frame);
      return;
    }
    if (frame.event) onEvent(frame);
  }

  function attachLines(stream, fn) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        fn(line);
      }
    });
  }

  function onStdout(line) {
    if (!line.trim()) return;
    let frame = null;
    try { frame = JSON.parse(line); } catch {}
    if (!frame || typeof frame !== 'object' || frame.cxb !== 1) {
      limited(`child stdout (ignored): ${line.slice(0, 200)}`);
      return;
    }
    onFrame(frame);
  }

  function onStderr(line) {
    if (!line.trim()) return;
    stderrTail.push(line);
    if (stderrTail.length > STDERR_KEEP) stderrTail = stderrTail.slice(-STDERR_KEEP);
    limited(`child: ${line.slice(0, 300)}`);
  }

  function tailLine() {
    return stderrTail.join(' ').replace(/\s+/g, ' ').trim().slice(-300) || 'no output';
  }

  function exitLabel(code, signal) {
    return signal ? signal : `code ${code}`;
  }

  function handleExit(p, code, signal) {
    if (p !== proc) return;
    proc = null;
    state = 'off';
    beatTimer = clear(beatTimer);
    idleTimer = clear(idleTimer);
    const expected = expectExit || disposed;
    const quit = !expected && code === 0 && !signal;
    expectExit = false;
    for (const [id, req] of pending) {
      pending.delete(id);
      clear(req.timer);
      req.reject(codedError(`browser child exited (${exitLabel(code, signal)}) during ${req.op}; its effect is unknown — read again`, 'CLOSED'));
    }
    if (startP && startP.fail) startP.fail(codedError(`browser child did not start: ${tailLine()}`, 'INTERNAL'));
    startP = null;
    if (!expected && !quit) {
      const now = clock.now();
      exits = exits.filter((t) => now - t < o.crashWindowMs);
      exits.push(now);
      log.error(`browser child exited unexpectedly (${exitLabel(code, signal)}); tail: ${tailLine()}`);
      if (exits.length >= o.crashLimit) {
        refusedUntil = now + o.refuseMs;
        exits = [];
        state = 'unavailable';
      }
    }
    onExit({ code, signal, expected, quit });
    const waiters = exitWaiters;
    exitWaiters = [];
    for (const w of waiters) w();
  }

  function kill(sig) {
    if (!proc) return;
    try { proc.kill(sig); } catch {}
  }

  function scheduleBeat() {
    beatTimer = clear(beatTimer);
    beatTimer = clock.setTimeout(() => {
      beatTimer = null;
      if (!proc || state !== 'running') return;
      request('ping', {}, { timeoutMs: o.pongMs, quiet: true })
        .then(() => scheduleBeat())
        .catch((e) => {
          if (e && e.code === 'TIMEOUT' && proc) {
            log.error('browser child missed a heartbeat; killing it');
            kill('SIGKILL');
          }
        });
    }, o.heartbeatMs);
  }

  function scheduleIdle() {
    idleTimer = clear(idleTimer);
    idleTimer = clock.setTimeout(() => {
      idleTimer = null;
      if (!proc || state !== 'running') return;
      const busy = [...pending.values()].some((r) => !r.quiet);
      if (busy || clock.now() - lastActivity < o.idleStopMs) { scheduleIdle(); return; }
      stop();
    }, Math.max(0, lastActivity + o.idleStopMs - clock.now()));
  }

  function start() {
    if (proc && state === 'stopping') return new Promise((r) => exitWaiters.push(r))
      .then(() => (disposed ? Promise.reject(codedError('browser pane is disabled', 'CLOSED')) : start()));
    if (proc && state === 'running') return Promise.resolve();
    if (startP) return startP.promise;
    const spec = opts.spawnSpec();
    if (!spec || spec.error) {
      const msg = spec && spec.error === 'no Electron on this host' ? HEADLESS
        : `browser unavailable — ${(spec && spec.error) || 'no launch spec'}`;
      return Promise.reject(codedError(msg, 'INTERNAL'));
    }
    stderrTail = [];
    const entry = {};
    entry.promise = new Promise((resolve, reject) => {
      entry.ready = (frame) => {
        entry.ready = null;
        entry.fail = null;
        entry.timer = clear(entry.timer);
        state = 'running';
        startP = null;
        log.info(`browser child ready (pid ${frame.pid}, electron ${frame.electron})`);
        scheduleBeat();
        scheduleIdle();
        resolve(frame);
      };
      entry.fail = (err) => {
        entry.ready = null;
        entry.fail = null;
        entry.timer = clear(entry.timer);
        reject(err);
      };
    });
    startP = entry;
    state = 'starting';
    let p;
    try {
      p = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], env: spec.env });
    } catch (e) {
      startP = null;
      state = 'off';
      return Promise.reject(codedError(`browser child did not start: ${e.message}`, 'INTERNAL'));
    }
    proc = p;
    attachLines(p.stdout, onStdout);
    attachLines(p.stderr, onStderr);
    p.stdin.on('error', () => {});
    p.on('error', (e) => {
      stderrTail.push(e.message);
      if (p.exitCode == null && p.pid == null) handleExit(p, null, null);
    });
    p.on('exit', (code, signal) => handleExit(p, code, signal));
    entry.timer = clock.setTimeout(() => {
      entry.timer = null;
      if (entry.fail) {
        entry.fail(codedError(`browser child did not start: ${tailLine()}`, 'INTERNAL'));
        kill('SIGKILL');
      }
    }, o.readyMs);
    return entry.promise;
  }

  function request(op, args = {}, meta = {}) {
    if (disposed) return Promise.reject(codedError('browser pane is disabled', 'CLOSED'));
    if (!meta.quiet) {
      lastActivity = clock.now();
      if (refusedUntil && clock.now() < refusedUntil) return Promise.reject(codedError(CRASHED, 'INTERNAL'));
      if (refusedUntil && clock.now() >= refusedUntil) { refusedUntil = 0; if (state === 'unavailable') state = 'off'; }
    }
    return start().then(() => new Promise((resolve, reject) => {
      const id = nextId++;
      const ms = meta.timeoutMs || OP_DEADLINE_MS[op] || 20000;
      const req = { op, resolve, reject, quiet: !!meta.quiet, timer: null };
      req.timer = clock.setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(codedError(`browser child did not answer ${op} within ${Math.round(ms / 1000)}s`, 'TIMEOUT'));
      }, ms);
      pending.set(id, req);
      const frame = { id, op, args };
      if (meta.service) frame.service = meta.service;
      if (meta.seat) frame.seat = meta.seat;
      if (!send(frame)) {
        pending.delete(id);
        clear(req.timer);
        reject(codedError('browser child is not running', 'CLOSED'));
        return;
      }
      if (!req.quiet) scheduleIdle();
    }));
  }

  function escalate(p) {
    const gone = () => p.exitCode != null || p.signalCode != null;
    clock.setTimeout(() => {
      if (gone()) return;
      try { p.kill('SIGTERM'); } catch {}
      clock.setTimeout(() => {
        if (gone()) return;
        try { p.kill('SIGKILL'); } catch {}
      }, o.killMs);
    }, o.termMs);
  }

  function stop() {
    if (!proc) return;
    state = 'stopping';
    expectExit = true;
    send({ id: nextId++, op: 'shutdown', args: {} });
    escalate(proc);
  }

  function dispose() {
    disposed = true;
    idleTimer = clear(idleTimer);
    beatTimer = clear(beatTimer);
    if (!proc) return;
    expectExit = true;
    send({ id: nextId++, op: 'shutdown', args: {} });
    escalate(proc);
  }

  return {
    request,
    stop,
    dispose,
    state: () => state,
    pid: () => (proc ? proc.pid : null),
  };
}

module.exports = { createClient, HEADLESS, CRASHED, OP_DEADLINE_MS };
