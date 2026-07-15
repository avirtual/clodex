// session-discovery.js — find Claude/Codex sessions that were NOT created by
// Clodex, so the operator can adopt them into the sidebar. Three lenses, all
// read-only:
//
//   1. On-disk scan  — walk EVERY ~/.claude/projects/<slug>/*.jsonl (global,
//      unlike ipc-handlers' session:history which is scoped to one session's
//      cwd), read each transcript's own embedded `cwd`, and surface recent ones.
//   2. Live processes — `pgrep`/`ps` for running `claude`/`codex` CLIs outside
//      Clodex, resolving each PID's cwd via `lsof`. Clodex can't attach a foreign
//      PTY, so "adopt" = spawn a Clodex-managed session that `--resume`s the same
//      transcript; this lens just tells the operator which ones are live NOW.
//   3. Auto-import   — the startup entry point: the on-disk scan, filtered to
//      what Clodex doesn't already track, returned for the caller to surface.
//
// All spawn/adoption stays in session-manager (this module never mutates). Pure
// except for fs reads + the two child_process probes. No new dependency.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const CLAUDE_PROJECTS = () => path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_MAX_AGE_MS = 14 * 24 * 3600 * 1000; // two weeks

// Pull the embedded cwd out of a Claude transcript. Claude writes `"cwd":"…"` on
// most record types (user/attachment/…); grab the first hit without a full JSON
// parse of every line (files run to MBs). Returns null when absent.
function transcriptCwd(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    // Read a head chunk — the cwd appears within the first few records.
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, n);
    const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return null;
    try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// One pass over the whole Claude transcript store. Returns a flat list of
// { sessionId, cwd, slug, file, mtime } for every *.jsonl newer than maxAgeMs.
// `readMeta` (engine.readSessionMeta) is optional; when given, title/turns/last
// are folded in. Sorted newest-first. Never throws — a missing store yields [].
function scanClaudeDisk({ maxAgeMs = DEFAULT_MAX_AGE_MS, readMeta = null } = {}) {
  const root = CLAUDE_PROJECTS();
  const cutoff = Date.now() - maxAgeMs;
  const out = [];
  let slugs;
  try { slugs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const slugEnt of slugs) {
    if (!slugEnt.isDirectory()) continue;
    const slugDir = path.join(root, slugEnt.name);
    let files;
    try { files = fs.readdirSync(slugDir); } catch { continue; }
    for (const fn of files) {
      if (!fn.endsWith('.jsonl')) continue;
      const file = path.join(slugDir, fn);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      const sessionId = fn.slice(0, -6);
      const rec = {
        sessionId,
        type: 'claude',
        cwd: transcriptCwd(file),
        slug: slugEnt.name,
        file,
        mtime: st.mtimeMs,
        title: null, turns: null, lastActive: null,
      };
      if (readMeta) {
        const meta = readMeta(file);
        if (meta) { rec.title = meta.title; rec.turns = meta.turns; rec.lastActive = meta.last; }
      }
      out.push(rec);
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// Adopt-candidates: the disk scan minus anything Clodex already tracks. `tracked`
// is the Set of sessionIds Clodex owns (live + persisted, incl. each entry's
// sessionIds history). Used by both the on-demand picker and startup auto-import.
function discoverAdoptable({ tracked = new Set(), maxAgeMs = DEFAULT_MAX_AGE_MS, readMeta = null } = {}) {
  return scanClaudeDisk({ maxAgeMs, readMeta }).filter((r) => !tracked.has(r.sessionId));
}

// --- Live process detection ------------------------------------------------
// Best-effort, POSIX only. `pgrep -x` matches the exact process name (the CLI
// binaries are literally `claude` / `codex`), then `lsof` resolves each PID's
// cwd. Windows has neither; it returns [] there. Never throws.

function run(cmd, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

async function pidsFor(name) {
  const out = await run('pgrep', ['-x', name]);
  if (out == null) return [];
  return out.split('\n').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

// cwd of a pid via `lsof -a -d cwd -p <pid> -Fn` (the `n…` line is the path).
async function cwdOfPid(pid) {
  const out = await run('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn']);
  if (out == null) return null;
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) return line.slice(1);
  }
  return null;
}

// Running claude/codex CLIs on this box. `ownPids` (Clodex's own PTY child pids)
// are excluded so we only report FOREIGN processes. Returns
// [{ pid, type, cwd }], newest-first is meaningless here so it's pid-ordered.
async function discoverLiveProcesses({ ownPids = new Set() } = {}) {
  if (process.platform === 'win32') return [];
  const results = [];
  for (const type of ['claude', 'codex']) {
    const pids = await pidsFor(type);
    for (const pid of pids) {
      if (ownPids.has(pid)) continue;
      const cwd = await cwdOfPid(pid);
      results.push({ pid, type, cwd });
    }
  }
  return results;
}

module.exports = {
  scanClaudeDisk,
  discoverAdoptable,
  discoverLiveProcesses,
  transcriptCwd,
  DEFAULT_MAX_AGE_MS,
};
