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
const RESOLVE_WINDOW_MS = 5 * 60 * 1000;
const WATCH_RETRY_MS = 3000;
const PROBE_BACKOFF_MS = [0, 0, 0, 1000, 1000, 3000, 5000, 10000];

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

function tasksDirFromScratchpad(scratchpadDir) {
  if (typeof scratchpadDir !== 'string' || !scratchpadDir) return null;
  if (!path.isAbsolute(scratchpadDir)) return null;
  return path.join(path.dirname(scratchpadDir), 'tasks');
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
  const dir = tasksDirFromScratchpad(obj.scratchpad_dir)
    || tasksDirFor(obj.cwd, obj.session_id, opts);
  if (!dir) return null;

  const rec = {
    id,
    command,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
    agentId: typeof obj.agent_id === 'string' ? obj.agent_id : null,
    tasksDir: dir,
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

function psArgvEncode(command) {
  let out = '';
  for (const b of Buffer.from(String(command == null ? '' : command), 'utf8')) {
    if (b === 0x0a) out += '\\012';
    else if (b === 0x09) out += '\\011';
    else if (b === 0x7f) out += '^?';
    else if (b < 0x20) out += `^${String.fromCharCode(b + 64)}`;
    else out += String.fromCharCode(b);
  }
  return out;
}

function argvNeedle(command) {
  const cmd = String(command == null ? '' : command);
  if (!cmd) return null;
  return psArgvEncode(`eval '${cmd.split("'").join(`'"'"'`)}'`);
}

function defaultResolveOwners(needles, opts) {
  const run = (opts && opts.exec) || execFileSync;
  const wanted = Array.isArray(needles) ? needles.filter(Boolean) : [];
  if (!wanted.length) return [];

  let psOut = '';
  try {
    psOut = run('ps', ['-axww', '-o', 'pid=,args='], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return []; }

  const byPid = new Map();
  for (const line of psOut.split('\n')) {
    const m = /^\s*([0-9]{1,10})\s+(.*)$/.exec(line);
    if (!m || !m[2]) continue;
    if (!wanted.some((n) => m[2].includes(n))) continue;
    byPid.set(m[1], m[2]);
  }
  if (!byPid.size) return [];

  const pids = [...byPid.keys()];
  let lsOut = '';
  try {
    lsOut = run('lsof', ['-a', '-p', pids.join(','), '-d', '1', '-Fpn'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    lsOut = e && typeof e.stdout === 'string' ? e.stdout : '';
  }
  if (!lsOut) return [];

  const out = [];
  let pid = null;
  for (const line of lsOut.split('\n')) {
    if (line.startsWith('p')) { pid = line.slice(1); continue; }
    if (!line.startsWith('n') || !pid) continue;
    const file = line.slice(1);
    const args = byPid.get(pid);
    if (args && file.startsWith('/')) out.push({ pid, args, file });
  }
  return out;
}

function createBashLive(deps) {
  const {
    REGISTRY_DIR,
    fs = fsDefault,
    now = Date.now,
    watch = null,
    resolveOwners = defaultResolveOwners,
  } = deps || {};

  const openWatch = watch || ((dir, cb) => fs.watch(dir, { persistent: false }, cb));
  const realpath = (deps && deps.realpath) || ((d) => {
    try { return fs.realpathSync(d); } catch { return d; }
  });
  const statFile = (deps && deps.statFile) || ((p) => fs.statSync(p));
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
        watchFailedAt: new Map(),
        candidates: new Map(),
        rows: new Map(),
        events: [],
        lastRead: now(),
        lastProbeAt: 0,
        probeMisses: 0,
        probeWaiting: null,
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
        tasksDir: realpath(obj.tasksDir),
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
    const t = now();
    if (st.watches.has(dir)) {
      if (st.watches.get(dir) !== null) return;
      if (t - (st.watchFailedAt.get(dir) || 0) < WATCH_RETRY_MS) {
        seedCandidates(st, dir);
        return;
      }
      st.watches.delete(dir);
    }
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
      st.watchFailedAt.set(dir, t);
      seedCandidates(st, dir);
      syncSweep();
      return;
    }
    if (handle && typeof handle.on === 'function') handle.on('error', () => {});
    st.watches.set(dir, handle);
    st.watchFailedAt.delete(dir);
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
        st.candidates.set(key, { dir, base: n, path: key, seenAt: now(), owner: null });
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
            st.candidates.set(key, { dir, base: n, path: key, seenAt: now(), owner: null });
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

  function creationTimeOf(p) {
    let s = null;
    try { s = statFile(p); } catch { return null; }
    if (!s || typeof s !== 'object') return null;
    const birth = s.birthtimeMs;
    if (typeof birth === 'number' && Number.isFinite(birth) && birth > 0) return birth;
    const m = s.mtimeMs;
    if (typeof m === 'number' && Number.isFinite(m) && m > 0) return m;
    return null;
  }

  function pairByOrder(group, cands) {
    const obs = [...group].sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 1; i < obs.length; i += 1) {
      if (!(obs[i - 1].startedAt < obs[i].startedAt)) return null;
    }
    const timed = [];
    for (const c of cands) {
      const born = creationTimeOf(c.path);
      if (born === null) return null;
      timed.push({ c, born });
    }
    timed.sort((a, b) => a.born - b.born);
    for (let i = 1; i < timed.length; i += 1) {
      if (!(timed[i - 1].born < timed[i].born)) return null;
    }
    return obs.map((o, i) => [o, timed[i].c]);
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
    const t = now();
    const waiting = observers.filter(
      (o) => !claimed.has(o.id) && t - (o.startedAt || t) <= RESOLVE_WINDOW_MS,
    );
    if (!waiting.length) return;

    const waitingIds = new Set(waiting.map((o) => o.id));
    const seen = st.probeWaiting;
    const misses = !seen || [...waitingIds].some((id) => !seen.has(id))
      ? 0
      : (st.probeMisses || 0);
    st.probeMisses = misses;
    const wait = PROBE_BACKOFF_MS[Math.min(misses, PROBE_BACKOFF_MS.length - 1)];
    if (wait && t - (st.lastProbeAt || 0) < wait) return;
    st.lastProbeAt = t;
    st.probeWaiting = waitingIds;

    const needles = new Map();
    for (const o of waiting) {
      const n = argvNeedle(o.command);
      if (n) needles.set(o.id, n);
    }
    if (!needles.size) return;

    let procs = null;
    try { procs = resolveOwners([...needles.values()]); } catch { procs = null; }
    if (!Array.isArray(procs) || !procs.length) {
      st.probeMisses = misses + 1;
      return;
    }

    const byPath = new Map();
    for (const c of free) byPath.set(c.path, c);
    let resolvedAny = false;

    const groups = new Map();
    for (const o of waiting) {
      const needle = needles.get(o.id);
      if (!needle) continue;
      const g = groups.get(needle);
      if (g) g.push(o);
      else groups.set(needle, [o]);
    }

    for (const [needle, group] of groups) {
      const hits = procs.filter((p) => typeof p.args === 'string' && p.args.includes(needle));
      if (!hits.length) continue;
      const files = new Set(hits.map((h) => h.file).filter((f) => st.candidates.has(f)));
      if (files.size !== group.length) continue;
      const cands = [...files].map((f) => byPath.get(f));
      if (cands.some((c) => !c || c.owner)) continue;
      const pairs = group.length === 1
        ? [[group[0], cands[0]]]
        : pairByOrder(group, cands);
      if (!pairs) continue;
      for (const [o, c] of pairs) {
        c.owner = o.id;
        claimed.add(o.id);
      }
      resolvedAny = true;
    }
    st.probeMisses = resolvedAny ? 0 : misses + 1;
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
      syncSweep();
      return [];
    }

    const dirs = new Set(observers.map((o) => o.tasksDir));
    for (const dir of dirs) ensureWatch(st, dir);
    for (const dir of [...st.watches.keys()]) {
      if (dirs.has(dir)) continue;
      const h = st.watches.get(dir);
      if (h && typeof h.close === 'function') { try { h.close(); } catch {} }
      st.watches.delete(dir);
      st.watchFailedAt.delete(dir);
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
      if (!c && !row.finishedAt && !row.offset
          && t - (o.startedAt || t) > RESOLVE_WINDOW_MS) {
        st.rows.delete(o.id);
        dropObserver(name, o.file);
        continue;
      }
      out.push({
        id: row.id,
        command: row.command,
        agentId: row.agentId,
        output: row.text.replace(/\n+$/, ''),
        bytes: row.bytes,
        tailed: row.tailed,
        resolved: !!(c || row.offset > 0 || row.finishedAt),
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
    const wanted = seats.size > 0;
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

  function seatCount() {
    return seats.size;
  }

  function pendingEventCount() {
    let n = 0;
    for (const st of seats.values()) n += st.events.length;
    return n;
  }

  return { read, stop, stopAll, watchedDirCount, seatCount, pendingEventCount };
}

module.exports = {
  createBashLive,
  writeObserver,
  pruneObservers,
  tasksDirFor,
  tasksDirFromScratchpad,
  psArgvEncode,
  argvNeedle,
  defaultResolveOwners,
  LIVE_MAX_BYTES,
  IDLE_REAP_MS,
  IDLE_SWEEP_MS,
  EVENT_QUEUE_MAX,
  FINALIZED_GRACE_MS,
  RESOLVE_WINDOW_MS,
  WATCH_RETRY_MS,
  PROBE_BACKOFF_MS,
  OBSERVER_MAX_AGE_MS,
  OBSERVER_MAX_FILES,
  TASK_OUTPUT_RE,
  OBSERVER_FILE_RE,
  WATCH_SENTINEL,
};
