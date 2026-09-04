'use strict';

const fsDefault = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { pathFor } = require('./clodex-paths');

const LIVE_MAX_BYTES = 30000;
const OBSERVER_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const OBSERVER_MAX_FILES = 64;
const IDLE_REAP_MS = 10000;
const IDLE_SWEEP_MS = 5000;
const EVENT_QUEUE_MAX = 512;
const WATCH_SENTINEL = '.watching';
const ARM_REFRESH_MS = 2000;
const FINALIZED_GRACE_MS = 5000;

const TASK_OUTPUT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.output$/;
const OBSERVER_FILE_RE = /^[A-Za-z0-9_-]{1,128}\.json$/;

function safeId(id) {
  const s = String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '');
  return s.slice(0, 128);
}

function tasksDirFor(cwd, sessionId, opts) {
  const o = opts || {};
  const uid = typeof o.uid === 'number' ? o.uid : (typeof process.getuid === 'function' ? process.getuid() : 0);
  const tmp = typeof o.tmpdir === 'string' && o.tmpdir ? o.tmpdir : os.tmpdir();
  if (typeof cwd !== 'string' || !cwd) return null;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) return null;
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return path.join(tmp, `claude-${uid}`, slug, sessionId, 'tasks');
}

function writeObserver(inputJson, liveDir, opts) {
  const fs = (opts && opts.fs) || fsDefault;
  const now = (opts && opts.now) || Date.now;
  let obj = null;
  try { obj = JSON.parse(inputJson); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.tool_name !== 'Bash') return null;
  const input = obj.tool_input && typeof obj.tool_input === 'object' ? obj.tool_input : {};
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command) return null;
  const id = safeId(obj.tool_use_id);
  if (!id) return null;
  const dir = tasksDirFor(obj.cwd, obj.session_id, opts);
  if (!dir) return null;

  let snapshot = [];
  try { snapshot = fs.readdirSync(dir).filter((n) => TASK_OUTPUT_RE.test(n)); } catch { snapshot = []; }

  const rec = {
    id,
    command,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
    agentId: typeof obj.agent_id === 'string' ? obj.agent_id : null,
    tasksDir: dir,
    snapshot,
    startedAt: now(),
  };

  try {
    fs.mkdirSync(liveDir, { recursive: true });
    const tmp = path.join(liveDir, `.tmp.${process.pid}.${id}`);
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, path.join(liveDir, `${id}.json`));
  } catch { return null; }

  pruneObservers(liveDir, { fs, now });
  return rec;
}

function pruneObservers(liveDir, opts) {
  const fs = (opts && opts.fs) || fsDefault;
  const now = ((opts && opts.now) || Date.now)();
  let names = [];
  try { names = fs.readdirSync(liveDir); } catch { return; }
  const kept = [];
  for (const n of names) {
    const full = path.join(liveDir, n);
    if (!OBSERVER_FILE_RE.test(n)) {
      if (n.startsWith('.tmp.')) {
        try {
          if (now - fs.statSync(full).mtimeMs > OBSERVER_MAX_AGE_MS) fs.unlinkSync(full);
        } catch {}
      }
      continue;
    }
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    if (now - mtime > OBSERVER_MAX_AGE_MS) {
      try { fs.unlinkSync(full); } catch {}
      continue;
    }
    kept.push({ full, mtime });
  }
  if (kept.length <= OBSERVER_MAX_FILES) return;
  kept.sort((a, b) => a.mtime - b.mtime);
  for (const e of kept.slice(0, kept.length - OBSERVER_MAX_FILES)) {
    try { fs.unlinkSync(e.full); } catch {}
  }
}

function defaultProbeOwner(file) {
  try {
    const out = execFileSync('lsof', ['-t', file], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = out.split('\n').map((s) => s.trim()).filter(Boolean)[0];
    if (!pid || !/^[0-9]{1,10}$/.test(pid)) return null;
    const args = execFileSync('ps', ['-p', pid, '-o', 'args='], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = args.trim();
    return line || null;
  } catch {
    return null;
  }
}

function commandFingerprint(command) {
  return String(command == null ? '' : command).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function createBashLive(deps) {
  const {
    REGISTRY_DIR,
    fs = fsDefault,
    now = Date.now,
    watch = null,
    probeOwner = defaultProbeOwner,
    tasksDirOpts = null,
  } = deps || {};

  const openWatch = watch || ((dir, cb) => fs.watch(dir, { persistent: false }, cb));
  const setInterval_ = (deps && deps.setInterval) || setInterval;
  const clearInterval_ = (deps && deps.clearInterval) || clearInterval;
  const seats = new Map();
  let sweepTimer = null;

  function seatFor(name) {
    let st = seats.get(name);
    if (!st) {
      st = {
        name,
        watches: new Map(),
        candidates: new Map(),
        rows: new Map(),
        events: [],
        lastRead: now(),
        armedAt: 0,
      };
      seats.set(name, st);
    }
    return st;
  }

  function liveDirFor(name) {
    return pathFor(REGISTRY_DIR, name, 'bashLive');
  }

  function arm(name, st) {
    const t = now();
    if (st.armedAt && t - st.armedAt < ARM_REFRESH_MS) return;
    st.armedAt = t;
    try {
      fs.mkdirSync(liveDirFor(name), { recursive: true });
      fs.writeFileSync(path.join(liveDirFor(name), WATCH_SENTINEL), '');
    } catch {}
  }

  function disarm(name) {
    try { fs.unlinkSync(path.join(liveDirFor(name), WATCH_SENTINEL)); } catch {}
  }

  function loadObservers(name) {
    const dir = liveDirFor(name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!OBSERVER_FILE_RE.test(n)) continue;
      let obj = null;
      try { obj = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
      if (!obj || typeof obj !== 'object') continue;
      if (typeof obj.id !== 'string' || typeof obj.tasksDir !== 'string') continue;
      if (typeof obj.command !== 'string' || !obj.command) continue;
      out.push({
        id: obj.id,
        file: n,
        command: obj.command,
        agentId: typeof obj.agentId === 'string' ? obj.agentId : null,
        tasksDir: obj.tasksDir,
        snapshot: Array.isArray(obj.snapshot) ? obj.snapshot : [],
        startedAt: typeof obj.startedAt === 'number' ? obj.startedAt : 0,
      });
    }
    out.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
    return out;
  }

  function dropObserver(name, file) {
    try { fs.unlinkSync(path.join(liveDirFor(name), file)); } catch {}
  }

  function ensureWatch(st, dir) {
    if (st.watches.has(dir)) return;
    let handle = null;
    try {
      handle = openWatch(dir, (_ev, filename) => {
        if (st.events.length >= EVENT_QUEUE_MAX) {
          st.events = [null];
          return;
        }
        st.events.push(filename == null ? null : String(filename));
      });
    } catch {
      st.watches.set(dir, null);
      seedCandidates(st, dir);
      return;
    }
    if (handle && typeof handle.on === 'function') handle.on('error', () => {});
    st.watches.set(dir, handle);
    seedCandidates(st, dir);
    syncSweep();
  }

  function isTaskFile(dir, base) {
    try {
      const lst = fs.lstatSync(path.join(dir, base));
      return lst.isFile();
    } catch {
      return false;
    }
  }

  function seedCandidates(st, dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (!TASK_OUTPUT_RE.test(n)) continue;
      if (!isTaskFile(dir, n)) continue;
      const key = path.join(dir, n);
      if (!st.candidates.has(key)) {
        st.candidates.set(key, { dir, base: n, path: key, seenAt: now(), owner: null, probed: false });
      }
    }
  }

  function drainEvents(st) {
    if (!st.events.length) return;
    const names = st.events;
    st.events = [];
    const rescan = new Set();
    for (const n of names) {
      if (n === null) {
        for (const dir of st.watches.keys()) rescan.add(dir);
        continue;
      }
      if (!TASK_OUTPUT_RE.test(n)) continue;
      for (const dir of st.watches.keys()) {
        const key = path.join(dir, n);
        if (isTaskFile(dir, n)) {
          if (!st.candidates.has(key)) {
            st.candidates.set(key, { dir, base: n, path: key, seenAt: now(), owner: null, probed: false });
          }
        } else {
          retire(st, key);
        }
      }
    }
    for (const dir of rescan) {
      seedCandidates(st, dir);
      for (const c of [...st.candidates.values()]) {
        if (c.dir === dir && !isTaskFile(dir, c.base)) retire(st, c.path);
      }
    }
  }

  function retire(st, key) {
    const c = st.candidates.get(key);
    if (!c) return;
    if (c.owner) {
      const row = st.rows.get(c.owner);
      if (row && !row.finishedAt) {
        tail(st, row, c);
        row.finishedAt = now();
      }
    }
    st.candidates.delete(key);
  }

  function tail(st, row, c) {
    let st2 = null;
    try { st2 = fs.statSync(c.path); } catch { return; }
    const size = st2.size;
    if (size < row.offset) row.offset = 0;
    if (size === row.offset) return;
    if (size - row.offset > LIVE_MAX_BYTES) {
      row.offset = size - LIVE_MAX_BYTES;
      row.tailed = true;
    }
    const len = size - row.offset;
    let fd = null;
    try {
      const buf = Buffer.alloc(len);
      fd = fs.openSync(c.path, 'r');
      const got = fs.readSync(fd, buf, 0, len, row.offset);
      fs.closeSync(fd);
      fd = null;
      if (got > 0) {
        row.offset += got;
        row.text += buf.subarray(0, got).toString('utf8');
        row.bytes = row.offset;
        if (row.text.length > LIVE_MAX_BYTES) {
          row.text = row.text.slice(row.text.length - LIVE_MAX_BYTES);
          row.tailed = true;
        }
      }
    } catch {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
  }

  function assign(st, observers) {
    const byId = new Map(observers.map((o) => [o.id, o]));
    const claimed = new Set();
    for (const c of st.candidates.values()) {
      if (c.owner && byId.has(c.owner)) claimed.add(c.owner);
      else if (c.owner) c.owner = null;
    }

    const free = [...st.candidates.values()].filter((c) => !c.owner);
    if (!free.length) return;
    const waiting = observers.filter((o) => !claimed.has(o.id));
    if (!waiting.length) return;

    const eligible = new Map();
    for (const c of free) {
      eligible.set(c.path, waiting.filter(
        (o) => o.tasksDir === c.dir && !o.snapshot.includes(c.base),
      ));
    }
    const unclaimed = (c) => eligible.get(c.path).filter((o) => !claimed.has(o.id));

    let progress = true;
    while (progress) {
      progress = false;
      for (const c of free) {
        if (c.owner) continue;
        const list = unclaimed(c);
        if (list.length !== 1) continue;
        c.owner = list[0].id;
        claimed.add(list[0].id);
        progress = true;
      }
    }

    for (const c of free) {
      if (c.owner || c.probed) continue;
      const list = unclaimed(c);
      if (list.length < 2) continue;
      c.probed = true;
      const args = probeOwner(c.path);
      if (!args) continue;
      const argsFp = commandFingerprint(args);
      const hits = list.filter((o) => argsFp.includes(commandFingerprint(o.command)));
      if (hits.length !== 1) continue;
      c.owner = hits[0].id;
      claimed.add(hits[0].id);
    }
  }

  function read(name) {
    reap(name);
    if (typeof name !== 'string' || !name) return [];
    const st = seatFor(name);
    st.lastRead = now();
    arm(name, st);

    const observers = loadObservers(name);
    if (!observers.length && !st.rows.size) {
      if (st.watches.size) closeWatches(st);
      st.candidates.clear();
      return [];
    }

    const dirs = new Set(observers.map((o) => o.tasksDir));
    for (const dir of dirs) ensureWatch(st, dir);
    for (const dir of [...st.watches.keys()]) {
      if (dirs.has(dir)) continue;
      const h = st.watches.get(dir);
      if (h && typeof h.close === 'function') { try { h.close(); } catch {} }
      st.watches.delete(dir);
      for (const c of [...st.candidates.values()]) {
        if (c.dir === dir) st.candidates.delete(c.path);
      }
    }

    drainEvents(st);

    const unmatched = observers.filter((o) => {
      const row = st.rows.get(o.id);
      if (row && (row.offset > 0 || row.finishedAt)) return false;
      return ![...st.candidates.values()].some((c) => c.owner === o.id);
    });
    if (unmatched.length) {
      for (const dir of new Set(unmatched.map((o) => o.tasksDir))) seedCandidates(st, dir);
    }

    assign(st, observers);

    const live = new Set(observers.map((o) => o.id));
    for (const [id, row] of [...st.rows]) {
      if (!live.has(id)) st.rows.delete(id);
    }

    const t = now();
    const out = [];
    for (const o of observers) {
      let row = st.rows.get(o.id);
      if (!row) {
        row = {
          id: o.id, command: o.command, agentId: o.agentId,
          offset: 0, bytes: 0, text: '', tailed: false,
          startedAt: o.startedAt, finishedAt: null, file: o.file,
        };
        st.rows.set(o.id, row);
      }
      const c = [...st.candidates.values()].find((x) => x.owner === o.id) || null;
      if (c && !row.finishedAt) tail(st, row, c);

      if (!c && !row.finishedAt && row.offset > 0) row.finishedAt = t;

      if (row.finishedAt && t - row.finishedAt > FINALIZED_GRACE_MS) {
        st.rows.delete(o.id);
        dropObserver(name, o.file);
        continue;
      }
      if (!c && !row.finishedAt && !row.offset) {
        if (t - (o.startedAt || t) > OBSERVER_MAX_AGE_MS) {
          st.rows.delete(o.id);
          dropObserver(name, o.file);
        }
        continue;
      }
      out.push({
        id: row.id,
        command: row.command,
        agentId: row.agentId,
        output: row.text.replace(/\n+$/, ''),
        bytes: row.bytes,
        tailed: row.tailed,
        startedAt: row.startedAt,
        elapsedMs: row.startedAt ? Math.max(0, t - row.startedAt) : null,
        finished: !!row.finishedAt,
      });
    }
    return out;
  }

  function closeWatches(st) {
    for (const h of st.watches.values()) {
      if (h && typeof h.close === 'function') { try { h.close(); } catch {} }
    }
    st.watches.clear();
  }

  function stop(name) {
    const st = seats.get(name);
    if (!st) return;
    closeWatches(st);
    seats.delete(name);
    disarm(name);
  }

  function reap(keep) {
    const t = now();
    for (const [name, st] of [...seats]) {
      if (name === keep) continue;
      if (t - st.lastRead > IDLE_REAP_MS) stop(name);
    }
    syncSweep();
  }

  function syncSweep() {
    const wanted = watchedDirCount() > 0;
    if (wanted && !sweepTimer) {
      sweepTimer = setInterval_(() => reap(null), IDLE_SWEEP_MS);
      if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    } else if (!wanted && sweepTimer) {
      clearInterval_(sweepTimer);
      sweepTimer = null;
    }
  }

  function stopAll() {
    for (const name of [...seats.keys()]) stop(name);
    if (sweepTimer) { clearInterval_(sweepTimer); sweepTimer = null; }
  }

  function watchedDirCount() {
    let n = 0;
    for (const st of seats.values()) n += st.watches.size;
    return n;
  }

  function pendingEventCount() {
    let n = 0;
    for (const st of seats.values()) n += st.events.length;
    return n;
  }

  return { read, stop, stopAll, watchedDirCount, pendingEventCount };
}

module.exports = {
  createBashLive,
  writeObserver,
  pruneObservers,
  tasksDirFor,
  commandFingerprint,
  defaultProbeOwner,
  LIVE_MAX_BYTES,
  IDLE_REAP_MS,
  IDLE_SWEEP_MS,
  EVENT_QUEUE_MAX,
  FINALIZED_GRACE_MS,
  OBSERVER_MAX_AGE_MS,
  OBSERVER_MAX_FILES,
  TASK_OUTPUT_RE,
  OBSERVER_FILE_RE,
  WATCH_SENTINEL,
};
