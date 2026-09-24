'use strict';

const childProcess = require('child_process');
const { StringDecoder } = require('string_decoder');

const KILL_GRACE_MS = 5000;

function groupKill(pid, sig) {
  if (!(pid > 0)) return false;
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function parseLstart(text) {
  const ms = Date.parse(String(text || '').trim().replace(/\s+/g, ' '));
  return Number.isFinite(ms) ? ms : null;
}

function kernelStartTime(pid, execFileSync = childProcess.execFileSync) {
  if (!(pid > 0)) return null;
  try {
    return parseLstart(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }));
  } catch {
    return null;
  }
}

function epipe() {
  const err = new Error('EPIPE: stream seat stdin is closed');
  err.code = 'EPIPE';
  return err;
}

function spawnStreamSeat({
  cmd, args, cwd, env,
  spawn = childProcess.spawn,
  onLine, onExit, onClose,
  log = null,
  now = Date.now,
  startTimeOf = kernelStartTime,
  killGroup = groupKill,
}) {
  const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const pid = child.pid;
  const startedAt = now();
  const startTime = pid > 0 ? startTimeOf(pid) : null;
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let scanFrom = 0;
  let skipped = 0;
  let exited = false;
  let closed = false;
  let closeFired = false;
  let exitInfo = { code: null, signal: null };
  let killTimer = null;
  let stderrTail = '';

  const warn = (msg) => { try { if (log && log.warn) log.warn('stream-seat', msg); } catch {} };

  const emit = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      skipped += 1;
      warn(`pid ${pid}: skipped unparsable stdout line (${line.length} chars, ${skipped} so far)`);
      return;
    }
    if (typeof onLine === 'function') {
      try { onLine(obj); } catch (e) { warn(`pid ${pid}: onLine threw: ${e && e.message}`); }
    }
  };

  const feed = (text) => {
    if (!text) return;
    buf += text;
    let i = buf.indexOf('\n', scanFrom);
    while (i !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      emit(line);
      i = buf.indexOf('\n');
    }
    scanFrom = buf.length;
  };

  const flush = () => {
    feed(decoder.end());
    if (buf) {
      const rest = buf;
      buf = '';
      scanFrom = 0;
      emit(rest);
    }
  };

  const maybeClose = () => {
    if (closeFired || !exited || !closed) return;
    closeFired = true;
    flush();
    if (typeof onClose === 'function') onClose(exitInfo.code, exitInfo.signal);
  };

  const markExit = (code, signal) => {
    if (exited) return;
    exited = true;
    exitInfo = { code: code == null ? null : code, signal: signal || null };
    if (typeof onExit === 'function') {
      try { onExit(exitInfo.code, exitInfo.signal); } catch (e) { warn(`pid ${pid}: onExit threw: ${e && e.message}`); }
    }
    maybeClose();
  };

  if (child.stdout) {
    child.stdout.on('data', (chunk) => feed(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
    child.stdout.on('end', flush);
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-4096);
    });
  }
  if (child.stdin) child.stdin.on('error', () => {});
  child.on('error', (e) => {
    warn(`pid ${pid}: ${e && e.message}`);
    if (!(pid > 0)) {
      markExit(null, null);
      closed = true;
      maybeClose();
    }
  });
  child.on('exit', (code, signal) => markExit(code, signal));
  child.on('close', (code, signal) => {
    closed = true;
    if (!exited) markExit(code, signal);
    else maybeClose();
  });

  const send = (obj) => {
    const stdin = child.stdin;
    if (exited || !stdin || stdin.destroyed || stdin.writableEnded) return Promise.reject(epipe());
    return new Promise((resolve, reject) => {
      try {
        stdin.write(`${JSON.stringify(obj)}\n`, (err) => (err ? reject(err) : resolve()));
      } catch (e) {
        reject(e && e.code ? e : epipe());
      }
    });
  };

  const close = () => {
    try { if (child.stdin && !child.stdin.writableEnded) child.stdin.end(); } catch {}
  };

  const kill = () => {
    killGroup(pid, 'SIGTERM');
    if (killTimer) return;
    killTimer = setTimeout(() => { killGroup(pid, 'SIGKILL'); }, KILL_GRACE_MS);
    if (killTimer && typeof killTimer.unref === 'function') killTimer.unref();
  };

  return {
    pid,
    startedAt,
    startTime,
    send,
    close,
    kill,
    get exited() { return exited; },
    get skipped() { return skipped; },
    get stderrTail() { return stderrTail; },
  };
}

module.exports = { spawnStreamSeat, groupKill, isAlive, kernelStartTime, parseLstart, KILL_GRACE_MS };
