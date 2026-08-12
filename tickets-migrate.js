// tickets-migrate.js — one-time migration of each TEAM's ticket board
// (~/.clodex/teams/<team>/tickets.json) into the PROJECT board the team is
// rooted at (clodex-paths.projectDirFor → projects/<leaf>-<hash8>/tickets.json).
// Modelled on legacy-sweep.js: pure leaf, one exported function, called from
// engine.js inside a catch-and-log so a failure degrades to a log line.
//
// COPY, then mark. The source file is never moved or deleted — nothing reads it
// after this, and it stays as a cold backup for a migration nobody can re-run.
//
// The marker is PER-TEAM, not global: a global one would permanently block a
// team that first appears on disk after the migration has run once.
//
// IDS ARE NEVER RENUMBERED on the destination. A ticket id is a public
// reference — it names artifact dirs, branch names and commit messages — so a
// silently re-issued id still resolves, just to the wrong work. Records already
// on the project board keep theirs; an ARRIVING record is re-issued above the
// current max only when its id is already taken, and then carries its previous
// id in `formerId`. Every arriving record carries `originTeam`, which is what
// makes the merge idempotent WITHOUT the marker: provenance is the only thing
// that distinguishes "this team's t7, already copied" from "the project's own
// t7, which is a different ticket".

const path = require('path');
const { createTicketsStore, nextTicketId } = require('./tickets-store');

const MARKER = '.tickets-migrated';
const TICKETS_FILE = 'tickets.json';
const TEAM_FILE = 'team.json';

// Provenance identity of a record ALREADY on the destination: which team it came
// from and what it was called there. A re-issued record answers with `formerId`,
// a record that kept its id with `id`, and a native (never-migrated) record with
// a null team — which can never equal an arriving record's key, so a native t7
// does not suppress a team's t7. It collides with it, which is the re-issue path.
//
// The `/` separator is unambiguous by construction, and it has to be: two teams
// whose names and ids run together into one string would suppress each other's
// records as already-migrated, losing tickets silently. A team name is a
// directory under teams/ and matches team-manifest's NAME_RE
// (`[a-zA-Z0-9._-]{1,64}`); an id matches tickets-store's `^t\d+$`. Neither
// alphabet contains `/`, so the split point is unique. Do not drop it for bare
// concatenation, and do not reach for a control byte — a raw NUL here makes the
// whole file binary to git and grep, which is how this shipped once already.
function originKey(rec) {
  if (!rec || rec.originTeam == null) return null;
  return `${rec.originTeam}/${rec.formerId != null ? rec.formerId : rec.id}`;
}

// The destination board, or a THROW. Only a genuinely absent file reads as an
// empty board; anything else — an unreadable file, malformed JSON, a JSON value
// that is not an array — is raised so the caller records a per-team error and
// writes no marker. The alternative (treating unreadable as empty) silently
// overwrites the operator's own records with source-only content, which is the
// one outcome this module must never produce.
function readDestination(fs, file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw new Error(`destination board ${file} exists but could not be read (${(e && e.code) || (e && e.message)})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`destination board ${file} is not valid JSON — refusing to overwrite it`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`destination board ${file} does not contain a ticket array — refusing to overwrite it`);
  }
  return parsed;
}

// PURE. Given the destination board and one team's source board, return the
// merged array. Destination records are returned untouched, in order, first.
function mergeBoards(dest, source, teamName) {
  const out = (dest || []).slice();
  const seen = new Set();
  for (const d of out) {
    const k = originKey(d);
    if (k) seen.add(k);
  }
  const takenIds = new Set(out.map((d) => d && d.id).filter((id) => id != null));
  for (const src of source || []) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    const key = `${teamName}/${src.id}`;   // same alphabet argument as originKey
    if (seen.has(key)) continue;   // already migrated on an earlier run
    seen.add(key);
    const rec = { ...src, originTeam: teamName };
    if (takenIds.has(src.id)) {
      // Re-issued ABOVE the whole merged board's max, recomputed each time so two
      // arriving collisions cannot be handed the same new id.
      rec.formerId = src.id;
      rec.id = nextTicketId(out);
    }
    takenIds.add(rec.id);
    out.push(rec);
  }
  return out;
}

// Migrate every team under <root>/teams/. Idempotent twice over: the per-team
// marker short-circuits a second run, and mergeBoards duplicates nothing even
// when the marker was deleted by hand. Returns a per-team summary for the log.
function runTicketsMigration({ root, fs = require('fs'), log = null } = {}) {
  const teamsDir = path.join(root, 'teams');
  const store = createTicketsStore({ fs, clodexHome: root });
  const result = { migrated: 0, teams: [] };

  let names;
  try { names = fs.readdirSync(teamsDir); } catch { return result; }

  for (const name of names.slice().sort()) {
    if (name.startsWith('.')) continue;
    const teamDir = path.join(teamsDir, name);
    const srcPath = path.join(teamDir, TICKETS_FILE);
    try {
      if (!fs.existsSync(srcPath)) continue;
      if (fs.existsSync(path.join(teamDir, MARKER))) {
        result.teams.push({ team: name, skipped: 'already migrated' });
        continue;
      }
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(path.join(teamDir, TEAM_FILE), 'utf-8')); } catch { manifest = null; }
      const projectRoot = manifest && typeof manifest.root === 'string' ? manifest.root : '';
      // No root, no project to migrate INTO. Guessing one would scatter records
      // onto a board nobody looks at, which is worse than leaving them here.
      if (!projectRoot) {
        result.teams.push({ team: name, skipped: 'no root in team.json' });
        if (log) log.info('migrate', `tickets: team ${name} has no root in ${TEAM_FILE} — left in place`);
        continue;
      }
      let source = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
        if (Array.isArray(parsed)) source = parsed;
      } catch { source = []; }

      // Read the DESTINATION directly rather than through store.load, which is
      // best-effort and answers [] for corrupt JSON and for a transient read error
      // (EACCES, EMFILE at startup) alike. Merging onto that [] and saving would
      // atomically replace a board that merely failed to READ with source-only
      // content, destroying the operator's own records — in the one module whose
      // whole design is copy-never-move. Present-but-unreadable is a per-team
      // error: no marker, so the next launch retries.
      const before = readDestination(fs, store.ticketsPath(projectRoot));
      const merged = mergeBoards(before, source, name);
      const added = merged.length - before.length;
      // Saved even when nothing was added, so the marker can never be written
      // over a board the save would have failed to create.
      store.save(projectRoot, merged);
      fs.writeFileSync(path.join(teamDir, MARKER), `${new Date().toISOString()}\n`);
      result.migrated += added;
      result.teams.push({ team: name, added, projectRoot });
      if (log) log.info('migrate', `tickets: team ${name} → ${projectRoot} (${added} record(s) copied of ${source.length})`);
    } catch (e) {
      // Per-team, so one unreadable team cannot cost the others their migration.
      result.teams.push({ team: name, error: (e && e.message) || 'unknown error' });
      if (log) log.info('migrate', `tickets: team ${name} skipped (${e && e.message})`);
    }
  }
  return result;
}

module.exports = { runTicketsMigration, mergeBoards, originKey, readDestination, MARKER };
