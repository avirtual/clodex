'use strict';

const CLI_CONFIG_LOCK_STALE_MS = 10000;
const CONFIG_LOCK_WAITS_MS = [25, 50, 100, 200, 400, 400, 400, 400];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function claudeConfigLockPath(configFile) {
  return `${configFile}.lock`;
}

function tryMkdirLock(fs, lockPath, now, staleMs) {
  for (let pass = 0; pass < 2; pass++) {
    try {
      fs.mkdirSync(lockPath);
      return { held: true };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { held: false, error: e };
    }
    if (pass > 0) break;
    let st;
    try { st = fs.statSync(lockPath); } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      return { held: false, error: e };
    }
    if (!(st.mtimeMs < now() - staleMs)) break;
    try { fs.rmdirSync(lockPath); } catch (e) {
      if (!e || e.code !== 'ENOENT') return { held: false, error: e };
    }
  }
  return { held: false, busy: true };
}

function acquireClaudeConfigLock({ fs, file, sleepFn = sleepSync, now = Date.now, waitsMs = CONFIG_LOCK_WAITS_MS, staleMs = CLI_CONFIG_LOCK_STALE_MS }) {
  const lockPath = claudeConfigLockPath(file);
  for (let attempt = 0; ; attempt++) {
    const r = tryMkdirLock(fs, lockPath, now, staleMs);
    if (r.held) {
      let released = false;
      return {
        lockPath,
        release() {
          if (released) return;
          released = true;
          try { fs.rmdirSync(lockPath); } catch {}
        },
      };
    }
    if (!r.busy) return { lockPath, release: null, reason: (r.error && (r.error.code || r.error.message)) || 'unknown error' };
    if (attempt >= waitsMs.length) return { lockPath, release: null, reason: `held for over ${waitsMs.reduce((a, b) => a + b, 0)} ms` };
    sleepFn(waitsMs[attempt]);
  }
}

function withClaudeConfigLock({ fs, file, fn, log = null, sleepFn, now, waitsMs, staleMs }) {
  const lock = acquireClaudeConfigLock({ fs, file, sleepFn, now, waitsMs, staleMs });
  if (!lock.release && log) log.warn('session', `config lock ${lock.lockPath}: not taken (${lock.reason}); writing ${file} without it`);
  try {
    return fn({ locked: !!lock.release });
  } finally {
    if (lock.release) lock.release();
  }
}

module.exports = { CLI_CONFIG_LOCK_STALE_MS, CONFIG_LOCK_WAITS_MS, acquireClaudeConfigLock, claudeConfigLockPath, withClaudeConfigLock };
