'use strict';

/**
 * tickets-viewer — engine half. Read-only, and structurally so: it opens
 * tickets.json for reading and there is no seam it could write through even by
 * mistake — tickets are not a `host.library` kind, so `remove` refuses them.
 * Opening, assigning, closing and cancelling stay with `[agent:task …]`, which
 * also delivers the spec, nudges a stalled seat and hands out the next ticket.
 * A button here that only edited the JSON would skip all of that.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Written ONLY by _internals.setClodexHomeForTest at the bottom of this file;
// nothing on the plugin's own code path assigns it, so in the app it is always
// null and clodexHome() is the expression below it.
let clodexHomeOverride = null;

// A bare homedir join, byte-identical to engine.js:133's REGISTRY_DIR. Reading
// CLODEX_HOME here would make the board report on a different tree than the app
// hosting it: core's root does not honour the variable.
//
// The HOME, not the teams dir: teams/ is where a team is discovered, projects/
// is where its board lives, and both hang off this one root.
function clodexHome() {
  return clodexHomeOverride || path.join(os.homedir(), '.clodex');
}

function teamsRoot() {
  return path.join(clodexHome(), 'teams');
}

/**
 * Core's clodex-paths.projectDirFor, copied rather than required for the same
 * reason `confine` below is: §12's lint refuses a require that leaves this
 * directory, and §4's rule for a utility a plugin needs is to copy it in. Keep
 * it byte-equivalent to core's — the leaf is cosmetic but the sha256-over-the-
 * RESOLVED-path (never the realpath) is what makes this read the same directory
 * the writer wrote, and a "cleaner" realpath here would silently point the
 * board at a directory that does not exist.
 */
function projectDirFor(root, projectPath) {
  const real = path.resolve(projectPath);
  const hash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 8);
  return path.join(root, 'projects', `${path.basename(real)}-${hash}`);
}

const TICKETS_FILE = 'tickets.json';
// A directory under teams/ is a team when it carries this. Without the check the
// board would list any stray directory as an empty team.
const TEAM_FILE = 'team.json';

/**
 * Core's path-confine.js, copied rather than required: §12 of
 * plugins/plugin-api.md refuses a relative require that leaves this directory,
 * and §4's rule for a utility a plugin needs is to copy it in. Keep the
 * semantics identical — resolve, then demand the result be a DIRECT child.
 *
 * Positive containment, not a name pattern: `.` and `..` are spelled entirely
 * in legal name characters, so no charset filter can reject them. The team name
 * arrives over IPC from the renderer and this is the only sanctioned way to
 * turn it into a path.
 */
function confine(root, name) {
  if (typeof root !== 'string' || !root) return null;
  if (typeof name !== 'string' || !name) return null;
  const dir = path.resolve(root, name);
  if (path.dirname(dir) !== path.resolve(root)) return null;
  return dir;
}

// Core's TICKET_STALL_MS and its per-team override, mirrored from
// session-manager's _sweepTickets. Re-derived rather than guessed: a board that
// called a ticket stalled on a different threshold than the one that nudges the
// seat would contradict the nudge the lead already saw.
const DEFAULT_STALL_MS = 30 * 60 * 1000;

// team-manifest.js's WATCHDOG_MIN_MS / WATCHDOG_MAX_MS. Core clamps at READ, in
// loadManifest, precisely because team.json is agent-writable; every consumer
// reaches watchdogMs through that choke point and this plugin does not, so it
// must clamp for itself. The unbounded direction is the dangerous one:
// JSON.parse('{"watchdogMs":1e400}') yields Infinity, which is a number and is
// greater than zero, and an unclamped board would then never call anything
// stalled while core kept nudging on 30 minutes.
const WATCHDOG_MIN_MS = 5 * 60 * 1000;
const WATCHDOG_MAX_MS = 7 * 24 * 60 * 60 * 1000;

// Core's RECENT_DONE_MS / RECENT_DONE_CAP from _taskList. Mirrored for the same
// reason: "recently closed" already has a definition in this app.
const RECENT_DONE_MS = 24 * 60 * 60 * 1000;
const RECENT_DONE_CAP = 10;

let host = null;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * `{ ok: true, tickets, malformed }` or `{ ok: false, error }`.
 *
 * Deliberately NOT tickets-store.js's `load()`, which is best-effort by design
 * and answers `[]` for a missing file, an unreadable one, invalid JSON and a
 * non-array alike. That is right for a writer that must not crash a session on
 * a corrupt registry, and wrong for a viewer: it would render a team whose
 * tickets.json is broken exactly like a team that has never opened one.
 *
 * A missing file is the one read failure that genuinely IS empty — the file is
 * created by the first `[agent:task add]`.
 *
 * Takes the PROJECT ROOT, not a team dir: the board moved to the project and a
 * team is now only where that root is read FROM.
 */
function readTickets(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot) {
    // Not locatable is a read FAILURE, not an empty board — the manifest warning
    // beside it explains why, and rendering "no tickets" here would report a
    // board nobody can find as a team that has never opened one.
    return { ok: false, error: `cannot locate ${TICKETS_FILE}: team.json names no project root` };
  }
  let raw;
  try {
    raw = fs.readFileSync(path.join(projectDirFor(clodexHome(), projectRoot), TICKETS_FILE), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, tickets: [], malformed: 0 };
    return { ok: false, error: `could not read ${TICKETS_FILE} (${(e && e.code) || (e && e.message) || 'unknown error'})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { ok: false, error: `${TICKETS_FILE} is not valid JSON` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: `${TICKETS_FILE} does not contain a ticket array` };
  }
  const tickets = parsed.filter((t) => t && typeof t === 'object' && !Array.isArray(t));
  // Counted, not silently dropped: a registry half-eaten by a bad hand-edit
  // would otherwise render as a shorter but perfectly healthy board.
  return { ok: true, tickets, malformed: parsed.length - tickets.length };
}

/**
 * The team's manifest, and with it the answer to "is this directory a team at
 * all". Exactly one of `missing` / `error` / `manifest` is set.
 *
 * Reading the file IS the existence probe, in place of an existsSync: that call
 * answers false for EACCES, EPERM and ELOOP alike, which would make a team
 * nobody can read indistinguishable from a team that was never created. The
 * three outcomes want three different pictures — not a team, a broken team, a
 * team — so the probe has to be able to tell them apart.
 *
 * A manifest that parses but is unusable is NOT a failure: it comes back with a
 * `warning` and the tickets beside it are still shown, because the tickets are
 * the thing on screen.
 */
function readManifest(teamDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(teamDir, TEAM_FILE), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { missing: true };
    return { error: `could not read ${TEAM_FILE} (${(e && e.code) || (e && e.message) || 'unknown error'})` };
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch (_) {
    return { manifest: null, warning: `${TEAM_FILE} is not valid JSON — core would refuse this team` };
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { manifest: null, warning: `${TEAM_FILE} does not contain an object — core would refuse this team` };
  }
  return { manifest: m, warning: manifestWarning(m) };
}

/**
 * Whether core's loadManifest would REJECT this manifest, as a sentence or null.
 *
 * A SUBSET of core's checks, deliberately: the full validator is 50 lines of
 * per-role normalization that would be a third copy to drift, and this is a
 * board, not a gate. The subset is one-directional and stays honest under
 * drift — what it names, core also rejects; what core rejects and it misses
 * renders as it does today, with no warning. It never calls a manifest good.
 * Not checked here: per-role shapes.
 */
function manifestWarning(m) {
  if (typeof m.root !== 'string' || !path.isAbsolute(m.root)) return `${TEAM_FILE} "root" is not an absolute path — core would refuse this team`;
  if (typeof m.lead !== 'string' || !m.lead) return `${TEAM_FILE} "lead" is not a seat name — core would refuse this team`;
  const roles = m.roles;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return `${TEAM_FILE} "roles" is not an object — core would refuse this team`;
  if (!('lead' in roles)) return `${TEAM_FILE} has no "lead" role — core would refuse this team`;
  return null;
}

/**
 * The team's own stall threshold when it sets one, core's default otherwise —
 * the same precedence _sweepTickets applies, and the same clamp loadManifest
 * applies at read. Both halves are load-bearing: the precedence keeps this
 * board's verdict equal to the watchdog's, and the clamp keeps a hand-edited
 * `watchdogMs` from silently emptying the stalled column.
 *
 * A manifest that would not parse falls back to the default rather than failing
 * the board — that is what core would use anyway.
 */
function stallMsFor(manifest) {
  const raw = manifest && manifest.watchdogMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_STALL_MS;
  return Math.min(WATCHDOG_MAX_MS, Math.max(WATCHDOG_MIN_MS, raw));
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

function str(v) {
  return v == null ? '' : String(v);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * One board row. Timestamps cross as raw numbers alongside the engine's `now`
 * so every age on screen is measured against a single clock reading — the same
 * one the `stalled` flag was computed from.
 *
 * `taskDir` is optional in the record (extractTaskDir only finds one when the
 * spec's first line carries a `tasks/…` path), and the renderer must show its
 * absence rather than an empty cell: it is how a fresh seat picks up a dead
 * worker's task, so "there isn't one" is the actionable half of the answer.
 */
function shape(t, now, stallMs) {
  const openedAt = num(t.openedAt);
  // `??`, not `||`: core writes `lastActivityAt || openedAt`, so the two
  // disagree only at an epoch-zero timestamp, where core falls back and this
  // does not. Left as `??` on purpose — a timestamp of 0 is not "no timestamp",
  // and num() has already turned every genuinely absent value into null.
  const lastActivityAt = num(t.lastActivityAt) ?? openedAt;
  const quietMs = lastActivityAt === null ? null : Math.max(0, now - lastActivityAt);
  // `assignee` stays the RAW field, because `stalled` and `backlog` below key off
  // "is anyone on the hook", which is what it answers. `shownFor` is the display
  // name and prefers the ROLE the ticket was filed under: core re-pins `assignee`
  // to a concrete seat at delivery, so rendering it raw makes this viewer name a
  // seat where both boards name the role.
  const assignee = str(t.assignee);
  const role = str(t.role);
  return {
    id: str(t.id) || '(no id)',
    title: str(t.title) || '(untitled)',
    role,
    shownFor: role || assignee,
    // Uncapped on purpose. A length limit here drops the tail of a spec with
    // nothing on screen to say so; the renderer caps the HEIGHT in CSS, where
    // the rest of the body is a scroll away rather than gone.
    spec: str(t.spec),
    state: str(t.state) || '(no state)',
    assignee,
    taskDir: str(t.taskDir),
    opener: str(t.opener),
    closedBy: str(t.closedBy),
    openedAt,
    closedAt: num(t.closedAt),
    lastActivityAt,
    ageMs: openedAt === null ? null : Math.max(0, now - openedAt),
    quietMs,
    // The lead has already been told about this one; shown so a board full of
    // stalls does not read as a board full of un-chased ones.
    nudged: num(t.nudgedAt) !== null,
    // An UNASSIGNED open ticket is never stalled: _sweepTickets skips it
    // outright (`t.assignee == null` — "backlog/closed exempt"), because there
    // is no seat to nudge. Flagging it here would invent a stall core cannot
    // produce and cannot clear, and the two states need opposite actions —
    // assign it, versus chase whoever holds it.
    // `!parked` for the same reason: core exempts a parked ticket from the
    // sweep, so flagging one here invents a stall core can neither produce nor
    // clear.
    stalled: assignee !== '' && !t.parked && quietMs !== null && quietMs >= stallMs,
    // The same condition said in the affirmative, and kept OUT of the stalled
    // count and the section head on purpose: how long a backlog ticket has sat
    // is worth seeing, and it is not a stall.
    backlog: assignee === '',
    // Distinct from `backlog`: both are undispatched, but a parked ticket
    // already names its seat, so the lead's action is to release it rather than
    // to decide who gets it.
    parked: t.parked === true,
  };
}

function board(teamName) {
  const dir = confine(teamsRoot(), teamName);
  if (dir === null) return { ok: false, error: 'a valid team name is required' };
  // Containment is not existence. `confine` accepts any legal single path
  // component — `...` among them — so without this a team that does not exist
  // reads as a team with nothing open, which is the same false green as a
  // corrupt registry rendering empty. team.json is what makes a directory a
  // team, exactly as in teams().
  const man = readManifest(dir);
  if (man.missing) return { ok: false, error: `no team "${teamName}" under ${teamsRoot()}` };
  if (man.error) return { ok: false, error: man.error };

  // The board is the PROJECT's, so the manifest's `root` is what locates it —
  // which makes an unusable team.json a READ failure now, where it used to be a
  // warning beside a perfectly readable board. That is not a regression to route
  // around: with no root there is no project, and the tickets are not somewhere
  // else to be found. It fails loudly for the same reason an unparseable board
  // does. The warning rides along so the row can say WHY.
  const read = readTickets(man.manifest && man.manifest.root);
  if (!read.ok) return man.warning ? { ...read, warning: man.warning } : read;

  const now = Date.now();
  const stallMs = stallMsFor(man.manifest);
  const all = read.tickets;

  const open = all
    .filter((t) => t.state === 'open')
    .map((t) => shape(t, now, stallMs))
    // Newest first. Deliberately NOT quietest-first: that ordering surfaced
    // stalls by POSITION, which the row's stall flag, its `tv-stalled` class and
    // the header's "N quiet longer than …" count already do wherever the row
    // sits — so it bought nothing and buried the ticket just filed under a
    // growing board. A ticket with no usable openedAt still sorts to the top
    // rather than the bottom — an unreadable age is itself worth looking at.
    .sort((a, b) => {
      if (a.openedAt === b.openedAt) return 0;
      if (a.openedAt === null) return -1;
      if (b.openedAt === null) return 1;
      return b.openedAt - a.openedAt;
    });

  const doneAll = all.filter((t) => t.state === 'done');
  const cancelledAll = all.filter((t) => t.state === 'cancelled');

  // done only, matching _taskList: a cancelled ticket is not something the team
  // shipped, and mixing the two produces a number that answers neither "what
  // got done" nor "what got dropped".
  const recentAll = doneAll
    .filter((t) => num(t.closedAt) !== null && now - t.closedAt < RECENT_DONE_MS)
    .sort((a, b) => b.closedAt - a.closedAt);
  const recent = recentAll.slice(0, RECENT_DONE_CAP).map((t) => shape(t, now, stallMs));

  return {
    ok: true,
    team: teamName,
    now,
    stallMs,
    // A manifest core would reject, when the tickets themselves read fine. Not
    // a false green about the tickets — they are real — but a board that showed
    // nothing would let a team the app cannot resolve look entirely healthy.
    warning: man.warning || '',
    open,
    recent,
    counts: {
      open: open.length,
      backlog: open.filter((t) => t.backlog).length,
      parked: open.filter((t) => t.parked).length,
      done: doneAll.length,
      cancelled: cancelledAll.length,
      recentOver: Math.max(0, recentAll.length - recent.length),
      recentWindowMs: RECENT_DONE_MS,
      // Records carrying a state this app never writes. Surfaced instead of
      // filtered away, because they are invisible in every other listing too.
      unknownState: all.length - open.length - doneAll.length - cancelledAll.length,
      malformed: read.malformed,
    },
  };
}

/**
 * `{ ok: true, teams }` or `{ ok: false, error }`. A missing teams/ directory is
 * "no teams yet" — nothing has ever created one — and every other readdir
 * failure is a failure, reported as one.
 *
 * Per-team read failures do NOT fail the list: one corrupt registry must not
 * hide the teams that are fine, so the row carries its own `error` and the
 * renderer paints that row differently.
 */
function teams() {
  const root = teamsRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, teams: [] };
    return { ok: false, error: `could not read ${root} (${(e && e.code) || (e && e.message) || 'unknown error'})` };
  }

  const out = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    // team.json is what makes a directory a team (team-manifest's TEAM_FILE).
    // Without this a stray directory would list as a team with no tickets. A
    // team.json that exists but cannot be READ is not a stray directory — it
    // lists, carrying its error.
    const man = readManifest(dir);
    if (man.missing) continue;
    if (man.error) {
      out.push({ team: d.name, error: man.error });
      continue;
    }

    const read = readTickets(man.manifest && man.manifest.root);
    if (!read.ok) {
      out.push({ team: d.name, error: read.error });
      continue;
    }
    const now = Date.now();
    const stallMs = stallMsFor(man.manifest);
    const open = read.tickets.filter((t) => t.state === 'open').map((t) => shape(t, now, stallMs));
    out.push({
      team: d.name,
      open: open.length,
      stalled: open.filter((t) => t.stalled).length,
      // Separate from `stalled` for the same reason it is separate on a row:
      // an unassigned ticket needs assigning, not chasing.
      backlog: open.filter((t) => t.backlog).length,
      parked: open.filter((t) => t.parked).length,
      warning: man.warning || '',
    });
  }
  out.sort((a, b) => (a.team < b.team ? -1 : a.team > b.team ? 1 : 0));
  return { ok: true, teams: out };
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

module.exports.activate = (h) => {
  host = h;

  host.ipc.handle('teams', () => teams());
  host.ipc.handle('board', (team) => board(team));

  host.log.info('activated');
};

module.exports.deactivate = () => {
  host = null;
};

// Exported for the test suite. Not part of the plugin contract — the host only
// ever calls activate/deactivate and the two ipc methods above.
module.exports._internals = {
  confine, readTickets, readManifest, stallMsFor, shape, board, teams, teamsRoot,
  clodexHome, projectDirFor,
  DEFAULT_STALL_MS, WATCHDOG_MIN_MS, WATCHDOG_MAX_MS, RECENT_DONE_MS, RECENT_DONE_CAP,
  // The tree is no longer env-derived, so a test needs a seam that is not an
  // environment variable. It overrides the HOME rather than the teams dir, because
  // teams/ and projects/ must move together — a test that repointed only teams/
  // would read fixture manifests against the operator's real boards.
  // Deliberately NOT on the host surface: hostApi is frozen at "1", and a plugin
  // able to ask core where things live is a contract change. Pass null to restore.
  setClodexHomeForTest(dir) { clodexHomeOverride = dir || null; },
};
