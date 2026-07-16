// session-meta.js — sidebar organizational metadata that isn't on the live
// session record: last-activity timestamp (from the transcript), and the cwd's
// git branch + pull-request state (like Claude Code's own PR awareness). Powers
// group-by / sort-by / filter in the sidebar toolbar.
//
// Two cost tiers, deliberately separated:
//   - Timestamps are a cheap fs.stat of the per-agent transcript symlink target
//     (works for claude AND codex — it's whatever the CLI actually writes), so
//     they're computed synchronously on every meta request.
//   - PR status shells out to `git` + `gh`, which is slow and network-bound, so
//     it's cached per-cwd with a TTL and only refreshed on demand.
//
// Pure except fs reads + the git/gh child processes. REGISTRY_DIR is injected so
// the module stays electron-free and testable (mirrors clodex-paths consumers).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pathFor } = require('./clodex-paths');

function createSessionMeta({ REGISTRY_DIR, prTtlMs = 60_000 }) {
  // cwd -> { at, promise|value } PR-status cache. A promise while in flight so
  // concurrent requests for the same repo coalesce onto one git/gh run.
  const prCache = new Map();

  function run(cmd, args, cwd, timeoutMs = 5000) {
    return new Promise((resolve) => {
      execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err ? null : String(stdout || '')));
    });
  }

  // Like run, but distinguishes the failure modes we care about for `gh`:
  //   { code: 'ENOENT' }  — the binary isn't installed / on PATH
  //   { code: <number> }  — ran but exited non-zero (e.g. "no PR for this branch")
  //   { stdout }          — success
  function runDetailed(cmd, args, cwd, timeoutMs = 6000) {
    return new Promise((resolve) => {
      execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (!err) return resolve({ ok: true, stdout: String(stdout || '') });
          resolve({ ok: false, code: err.code, stdout: String(stdout || '') });
        });
    });
  }

  // Last real write to this session's transcript. The run/<name>/transcript.jsonl
  // symlink points at the CLI's live transcript; its target mtime is the last
  // turn and survives GUI restarts. Returns epoch ms or null.
  function lastActivityTs(name) {
    try {
      const link = pathFor(REGISTRY_DIR, name, 'transcript');
      const real = fs.realpathSync(link);
      return fs.statSync(real).mtimeMs;
    } catch {
      return null;
    }
  }

  // git branch + PR state for a cwd. Cached with a TTL. Returns
  // { isRepo, branch, prState: 'open'|'merged'|'closed'|'none'|null, prNumber }.
  // `gh` absent / not authed / offline → prState:null (unknown), never throws.
  async function prStatus(cwd, { force = false } = {}) {
    if (!cwd) return { isRepo: false, branch: null, prState: null, prNumber: null };
    const now = Date.now();
    const hit = prCache.get(cwd);
    if (!force && hit && (now - hit.at) < prTtlMs) return hit.value;
    // Coalesce concurrent in-flight computes for the same cwd.
    if (!force && hit && hit.promise) return hit.promise;

    const promise = (async () => {
      const branchOut = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      if (branchOut == null) return { isRepo: false, branch: null, prState: null, prNumber: null };
      const branch = branchOut.trim() || null;
      let prState = null, prNumber = null;
      // gh pr view on the current branch → JSON {state, number}. Distinguish the
      // three outcomes so the UI can bucket correctly:
      //   success        → the PR's state (open|merged|closed)
      //   ran, exit ≠ 0  → no PR for this branch → 'none' (a real, groupable fact)
      //   ENOENT         → gh not installed → null (unknown; neutral group)
      const gh = await runDetailed('gh', ['pr', 'view', '--json', 'state,number'], cwd, 6000);
      if (gh.ok) {
        try {
          const j = JSON.parse(gh.stdout);
          prNumber = j.number || null;
          prState = j.state ? String(j.state).toLowerCase() : 'none';
        } catch { prState = 'none'; }
      } else if (gh.code === 'ENOENT') {
        prState = null; // gh unavailable — genuinely unknown
      } else {
        prState = 'none'; // gh ran and reported no PR for this branch
      }
      return { isRepo: true, branch, prState, prNumber };
    })();

    prCache.set(cwd, { at: now, promise });
    const value = await promise;
    prCache.set(cwd, { at: Date.now(), value });
    return value;
  }

  // Bulk metadata for a set of sessions [{ name, cwd }]. Timestamps always;
  // PR status only when includePr (it's the slow tier). Returns
  // { [name]: { lastActivityTs, branch, prState, prNumber } }.
  async function metaFor(sessions, { includePr = true } = {}) {
    const out = {};
    // Dedupe PR lookups by cwd — many sessions share a repo.
    const prByCwd = new Map();
    for (const s of sessions) {
      const m = { lastActivityTs: lastActivityTs(s.name), branch: null, prState: null, prNumber: null };
      out[s.name] = m;
      if (includePr && s.cwd && !prByCwd.has(s.cwd)) prByCwd.set(s.cwd, null);
    }
    if (includePr) {
      await Promise.all([...prByCwd.keys()].map(async (cwd) => {
        prByCwd.set(cwd, await prStatus(cwd));
      }));
      for (const s of sessions) {
        if (!s.cwd) continue;
        const pr = prByCwd.get(s.cwd);
        if (pr) Object.assign(out[s.name], { branch: pr.branch, prState: pr.prState, prNumber: pr.prNumber });
      }
    }
    return out;
  }

  return { lastActivityTs, prStatus, metaFor, _prCache: prCache };
}

module.exports = { createSessionMeta };
