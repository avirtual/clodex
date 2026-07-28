// host-stamp.js — is the RUNNING main process older than the code on disk?
//
// WHY THIS EXISTS (t93). The Electron main process loads session-manager.js and
// friends once, at boot, and serves them indefinitely. Merging a fix implies no
// restart, so every intent-handling fix is inert for the running host until the
// operator restarts the app. Nothing anywhere said so. The observed cost: a host
// booted 02:33 took a pre-fix code path at 16:01, 8h40m after the fix merged,
// and the lead reasonably filed a ticket against source that was already
// correct. The failure mode is not "the fix didn't work" — it is "the fix worked
// and the evidence says otherwise", which is strong enough to make a careful
// engineer disbelieve correct code.
//
// `npm run dev` already handles this: dev-reload.js relaunches the app when a
// main-process module changes. But it is gated on CLODEX_DEV, which `npm start`
// (package.json:9) does not set, and it never runs packaged. So the common case
// — a long-lived `npm start` host, or a DMG — has no signal at all. This module
// is that signal, and ONLY a signal: it never restarts or reloads anything.
// Restarting is the operator's call; mid-session teardown of live agents costs
// far more than the problem.
//
// WHAT IS COMPARED. A digest over the main-process module files: `name:mtimeMs:size`
// per file, sorted, joined. Deliberately NOT the git HEAD commit:
//   - it asks the honest question directly (what is on disk vs what was loaded)
//     instead of a proxy that happens to correlate,
//   - it needs no git binary, no repo, and no child process — clodex-team.js is a
//     strict leaf that may require node builtins only,
//   - it degrades CORRECTLY when packaged: an asar's files never change, so the
//     answer is "never stale", which is true. A git-HEAD stamp would be
//     unavailable there and would have to fail open into silence.
// Content hashing every file would answer the same question for this purpose at
// materially more IO on a path that may be queried often.
//
// mtime+size does mean a touch with no edit reads as stale. That is the right
// direction to be wrong in: a spurious "restart to be sure" costs one restart,
// a missed staleness costs a wrongly-premised ticket.

const fs = require('fs');
const path = require('path');

// The stamp lives at the SHARED ~/.clodex/run root, beside messages/, pending/,
// agents/ and skills/ — it describes the host, not an agent, so it is
// deliberately NOT part of clodex-paths.js's per-agent `run/{name}/` grammar.
// The leading dot keeps the `run/*/agent.json` discovery scans (agent-transport,
// and clodex-team.js's doRoster) from mistaking it for a registration; both skip
// dotfiles already.
const HOST_STAMP_BASENAME = '.host.json';

// Files whose bytes are frozen into the running process at require() time.
// Flat main-process modules only: the renderer reloads per window, and a
// changed renderer file does not produce the class of confusion this addresses.
const WATCHED_RE = /\.js$/;
const IGNORE_RE = /^(node_modules|\.git|build|dist|vendor|docker|test|docs|scripts|renderer|web-dist|cli|tasks)$/;

// A digest of the main-process sources in `dir`. Pure apart from the stat calls;
// returns null only if the directory cannot be read at all, which is the
// "cannot tell" case every caller must treat as NOT-stale (see isStale).
function computeModuleDigest(dir, fsImpl = fs) {
  let names;
  try { names = fsImpl.readdirSync(dir); } catch { return null; }
  const parts = [];
  for (const name of names.sort()) {
    if (IGNORE_RE.test(name) || !WATCHED_RE.test(name)) continue;
    try {
      const st = fsImpl.statSync(path.join(dir, name));
      if (st.isFile()) parts.push(`${name}:${Math.round(st.mtimeMs)}:${st.size}`);
    } catch { /* vanished mid-scan — omit it, same as every other reader */ }
  }
  return parts.length ? parts.join('|') : null;
}

// THE comparison, kept pure and separately callable so a test can drive it with
// a matched and a mismatched pair directly. A check that reads the same in both
// states would prove nothing, so this must be the one place the question is
// answered — every surface below routes through it.
//
// FAILS CLOSED TO "FRESH": an unknown digest on either side means we cannot
// tell, and claiming staleness we cannot substantiate would train the reader to
// ignore the notice — the t82 lesson about a NOTE on every dispatch.
function isStale(bootDigest, currentDigest) {
  if (!bootDigest || !currentDigest) return false;
  return bootDigest !== currentDigest;
}

// Record the running host's identity at boot. Best-effort: a host that cannot
// write its stamp simply has no signal, which is where we already were.
function writeHostStamp(runRoot, dir, { pid = process.pid, now = Date.now(), fsImpl = fs } = {}) {
  const digest = computeModuleDigest(dir, fsImpl);
  if (!digest) return null;
  const stamp = { pid, bootedAt: now, dir, digest };
  const file = path.join(runRoot, HOST_STAMP_BASENAME);
  const tmp = `${file}.tmp.${pid}`;
  try {
    fsImpl.mkdirSync(runRoot, { recursive: true });
    fsImpl.writeFileSync(tmp, JSON.stringify(stamp));
    fsImpl.renameSync(tmp, file);
  } catch { return null; }
  return stamp;
}

function readHostStamp(runRoot, fsImpl = fs) {
  try {
    const obj = JSON.parse(fsImpl.readFileSync(path.join(runRoot, HOST_STAMP_BASENAME), 'utf8'));
    return obj && typeof obj.digest === 'string' ? obj : null;
  } catch { return null; }
}

function fmtAge(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? (m % 60 ? `${h}h${m % 60}m` : `${h}h`) : `${Math.floor(h / 24)}d`;
}

// The one line a reader sees, or null when there is nothing to say.
//
// QUIET WHEN FRESH, and that is the whole design. t79 says silence is a failure
// mode; t82 says "the happy path must stay quiet — a NOTE on every dispatch
// would train the lead to ignore the ones that matter". Both hold at once here
// only because staleness is rare and binary: say nothing at all until the thing
// the reader is about to assume is actually false. Same shape as
// _ticketDeliverySuffix.
function staleNotice(stamp, currentDigest, now = Date.now()) {
  if (!stamp || !isStale(stamp.digest, currentDigest)) return null;
  const age = typeof stamp.bootedAt === 'number' ? fmtAge(now - stamp.bootedAt) : null;
  return `running host (pid ${stamp.pid}) booted${age ? ` ${age} ago` : ''} from OLDER code than is on disk`
    + ' — merged fixes are NOT live until the app is restarted';
}

module.exports = {
  HOST_STAMP_BASENAME,
  computeModuleDigest,
  isStale,
  writeHostStamp,
  readHostStamp,
  staleNotice,
};
