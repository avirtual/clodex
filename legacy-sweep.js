// legacy-sweep.js — one-time migration of the OLD flat ~/.clodex artifact
// grammar (`{name}-hook.sh`, `{name}.jsonl`, `{name}.sock`, …) into the
// per-agent run/<name>/ layout (clodex-paths). Runs once at startup, gated by a
// run/.migrated marker.
//
// NAME-DRIVEN, never filename-parsed. The sweep only ever deletes exactly
// `{knownName}{knownSuffix}` for a name drawn from sessions.json ∪ live
// sessions. It never reverse-parses a filename to discover an owner, so the two
// shared files that structurally look per-agent — wire-shadow.jsonl (the global
// wire log, matches `.jsonl`) and codex-session-hook.sh (the one shared Codex
// hook, matches `-hook.sh`) — can never be misattributed to an agent and
// deleted. messages/, pending/, agents/, skills/, library/, skill-plugins/ and
// every other shared dir are likewise untouched (they aren't `{name}{suffix}`).
//
// Orphan pass (findOrphans): LOG ONLY, no deletion. Surfaces (a) run/<name>/
// dirs with no candidate owner (dead-agent residue) and (b) stray root-level
// flat files whose derived name isn't a candidate (a forgotten-session artifact
// the name-driven sweep can't reach). We watch these live before enabling any
// auto-GC — this pass never removes anything.

const path = require('path');
const { legacyPathsFor, legacySuffixes } = require('./clodex-paths');

const MARKER = '.migrated';

// Root-level files that structurally match a per-agent suffix but are SHARED —
// excluded from the orphan pass so they don't log as false orphans.
const SHARED_FILES = new Set(['wire-shadow.jsonl', 'codex-session-hook.sh']);

// Reverse-map a root filename to the name that WOULD own it, longest suffix
// first so `foo-hook-output.json` resolves to `foo`, not a bare `.json` match.
// Used ONLY by the log-only orphan pass — never by the sweep.
function deriveOwner(fname) {
  for (const suffix of legacySuffixes()) {
    if (fname.length > suffix.length && fname.endsWith(suffix)) {
      return fname.slice(0, -suffix.length);
    }
  }
  return null;
}

// Delete the flat artifacts for every candidate name and write the marker.
// Idempotent + marker-gated: a second call is a no-op. fs/log injectable for
// tests. Returns { swept, skipped }.
function runLegacySweep({ root, names = [], fs = require('fs'), log = null } = {}) {
  const runRoot = path.join(root, 'run');
  const markerPath = path.join(runRoot, MARKER);
  try { if (fs.existsSync(markerPath)) return { swept: 0, skipped: true }; } catch {}

  let swept = 0;
  for (const name of names) {
    for (const p of legacyPathsFor(root, name)) {
      try {
        if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); swept++; }
      } catch { /* best effort — a stuck file just stays, harmless residue */ }
    }
  }
  try {
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`);
  } catch {}
  if (log) log.info('migrate', `legacy flat-file sweep: removed ${swept} artifact(s) for ${names.length} known session(s)`);
  return { swept, skipped: false };
}

// PURE. Given the run/ subdir names, the root filenames, and the candidate set,
// return the orphans to LOG (never delete). No I/O — main.js does the readdirs
// and the logging.
function findOrphans({ runEntries = [], rootEntries = [], candidates = new Set() } = {}) {
  const orphanDirs = runEntries.filter((n) => n !== MARKER && !candidates.has(n));
  const orphanRootFiles = [];
  for (const fname of rootEntries) {
    if (SHARED_FILES.has(fname)) continue;
    const owner = deriveOwner(fname);
    if (owner && !candidates.has(owner)) orphanRootFiles.push(fname);
  }
  return { orphanDirs, orphanRootFiles };
}

module.exports = { runLegacySweep, findOrphans, deriveOwner, MARKER, SHARED_FILES };
