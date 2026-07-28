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
// FLAT `*.js` at the top level only, and that single rule is the whole filter:
// subdirectories are never descended, so test/, renderer/, node_modules/, cli/
// and the rest are excluded by construction rather than by an ignore list.
//
// An explicit ignore list was written here first and removed as DEAD CODE: a
// directory never passes `\.js$`, and a file named `test.js` never equals
// `test`, so no name could ever satisfy both conditions. It was unreachable in
// every case. Worth saying because the same grammar is duplicated in
// clodex-team.js, and dead code in a duplicated grammar is doubly expensive —
// it invites two copies of a rule that does nothing to drift apart.
//
// The renderer is deliberately out of scope: it reloads per window, so a
// changed renderer file does not produce the stale-host confusion this addresses.
const WATCHED_RE = /\.js$/;

// A digest of the main-process sources in `dir`. Pure apart from the stat calls;
// returns null only if the directory cannot be read at all, which is the
// "cannot tell" case every caller must treat as NOT-stale (see isStale).
function computeModuleDigest(dir, fsImpl = fs) {
  let names;
  try { names = fsImpl.readdirSync(dir); } catch { return null; }
  const parts = [];
  for (const name of names.sort()) {
    if (!WATCHED_RE.test(name)) continue;
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

// ── The stamp-less fallback (t94) ───────────────────────────────────────────
//
// WHY. Everything above needs a stamp, and the stamp is written by the host AT
// BOOT. So a host that started before this feature existed leaves none, and the
// check goes silent — on precisely the host it was built for. Observed live:
// pid 55910, up 14h45m, nine top-level modules changed underneath it including
// session-manager.js, and `clodex-team` said nothing. The stamp-less window is
// not a brief bootstrap either: it lasts until the next restart, and rare
// restarts are the entire premise of the feature.
//
// WHAT IS AND IS NOT PROVABLE HERE. The tempting claim is "a module whose mtime
// is newer than the process start time cannot be loaded by that process". It is
// FALSE in this codebase: require() is lazy, and modules are pulled inside
// function bodies all over the main process (main.js:579 ipc-handlers,
// session-manager.js:428/445-448/454/466/645 the whole wire/ stack,
// peer-wiring.js:64, remote-wiring.js:100, sandbox.js:486). A file edited after
// boot but before its first lazy require IS live in the host.
//
// So this fallback claims strictly less: the bytes on disk CHANGED after the
// process started. That is a fact about two timestamps with no theory of the
// module system attached, and it is still enough to stop the mistake this
// exists to prevent — a reader told "9 modules changed under a 14h-old host"
// does not conclude the source is broken.
//
// The wording below is load-bearing for that reason: it reports evidence and
// explicitly says staleness is UNCONFIRMED. Do not tighten it into a claim
// about what the host loaded.

// Watched modules whose bytes changed after `sinceMs`. null = cannot tell.
function changedSince(dir, sinceMs, fsImpl = fs) {
  let names;
  try { names = fsImpl.readdirSync(dir); } catch { return null; }
  const changed = [];
  for (const name of names.sort()) {
    if (!WATCHED_RE.test(name)) continue;
    try {
      const st = fsImpl.statSync(path.join(dir, name));
      if (st.isFile() && st.mtimeMs > sinceMs) changed.push(name);
    } catch { /* vanished mid-scan */ }
  }
  return changed;
}

// The line for a host with NO stamp, or null when there is nothing to say.
// PURE: the caller supplies the host's identity, because the two surfaces learn
// it in completely different ways — the host itself knows its own start time
// from process.uptime(), while a separate process has to ask the OS. Keeping
// that out of here means the wording and the comparison are decided in ONE
// place, and neither surface needs a live app or a real clock to be tested.
//
// THREE STATES, AND THE THIRD MUST NOT LOOK LIKE THE FIRST. That is the defect
// being fixed: "checked, and fresh" and "could not check at all" both rendered
// as silence, so silence read as fresh. Silence now means fresh and nothing
// else; when the check cannot run, it says so out loud.
function bootstrapNotice({ pid, startedAt, root }, { now = Date.now(), fsImpl = fs } = {}) {
  if (!root || !Number.isFinite(startedAt)) {
    return `cannot determine whether the running host${Number.isInteger(pid) ? ` (pid ${pid})` : ''}`
      + ' is current — no boot stamp, and its start time could not be read';
  }
  const changed = changedSince(root, startedAt, fsImpl);
  if (changed === null) {
    return `cannot determine whether the running host${Number.isInteger(pid) ? ` (pid ${pid})` : ''}`
      + ` is current — no boot stamp, and ${root} could not be read`;
  }
  if (!changed.length) return null;      // checked, and nothing changed underneath it
  const shown = changed.slice(0, 3).join(', ');
  return `${changed.length} module${changed.length === 1 ? '' : 's'} changed since the running host`
    + `${Number.isInteger(pid) ? ` (pid ${pid})` : ''} started ${fmtAge(now - startedAt)} ago`
    + ` — ${shown}${changed.length > 3 ? ', ...' : ''}.`
    + ' This host has no boot stamp (it predates the check), so staleness is UNCONFIRMED;'
    + ' restart the app if a fix you expect to be live is not';
}

// What a reader should see about the host, in whichever state it is: the
// stamped answer when there is a stamp, the evidence-only fallback when there
// is not, and null only when the host is genuinely fine.
function hostNotice(runRoot, dir, host, { now = Date.now(), fsImpl = fs } = {}) {
  const stamp = readHostStamp(runRoot, fsImpl);
  if (stamp) return staleNotice(stamp, computeModuleDigest(stamp.dir || dir, fsImpl), now);
  return bootstrapNotice(host || {}, { now, fsImpl });
}

module.exports = {
  HOST_STAMP_BASENAME,
  computeModuleDigest,
  isStale,
  writeHostStamp,
  readHostStamp,
  staleNotice,
  changedSince,
  bootstrapNotice,
  hostNotice,
};
