'use strict';

/**
 * tickets-viewer — engine half. The board belongs to the PROJECT (t301), so
 * this half enumerates `~/.clodex/projects/*` directly and a team is only ever
 * enrichment: which team names a project, and whose watchdogMs sets its stall
 * threshold. Nothing here requires a team to exist.
 *
 * It WRITES, as of t304. What a write through this file does NOT do is the
 * reason the surface stays narrow: `[agent:task …]` also drains the closed
 * seat's queue (_advanceSeat), rebuilds the sidebar's ticket badges
 * (_reconcileTickets), writes COST.json, and enforces the lead-only gates. A
 * plugin can reach none of those — the host surface has no seam for them — so a
 * viewer write is deliberately the operator's OWN edit of the board, not an
 * impersonation of the intent path. Spec DELIVERY is the one side effect that
 * IS reachable (host.sessions.get(name).inject) and it is done, because an
 * assignment nobody is told about is the one failure that looks like success.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Written ONLY by _internals.setClodexHomeForTest at the bottom of this file;
// nothing on the plugin's own code path assigns it, so in the app it is always
// null and clodexHome() is the expression below it.
let clodexHomeOverride = null;

// Latched true the first time a test points this module at a temp home, and
// NEVER cleared. It exists because clodexHome() falls back to the operator's
// REAL ~/.clodex, which was harmless while this module only read and is not now
// that it writes: a mutating call that lands outside a live boot()/cleanup()
// pair — a test that forgot to boot, one whose cleanup already ran, an await
// resolving late — would rewrite the operator's live tickets.json, and there is
// no undo.
//
// So: once a test has overridden the home, an override of null means the test
// tree is GONE, not that we are in production, and every write refuses. Reads
// are deliberately unaffected — a test asserts the un-overridden root is the
// real homedir join, and that must stay reachable.
//
// Inert in the app by construction: nothing but a test calls
// setClodexHomeForTest, so this stays false and no production write consults it.
let everOverridden = false;

// A bare homedir join, byte-identical to engine.js:133's REGISTRY_DIR. Reading
// CLODEX_HOME here would make the board report on a different tree than the app
// hosting it: core's root does not honour the variable.
//
// The HOME, not a subdirectory: teams/ is where a team is discovered, projects/
// is where every board lives, and both hang off this one root.
function clodexHome() {
  return path.join(clodexHomeOverride || path.join(os.homedir(), '.clodex'));
}

function teamsRoot() {
  return path.join(clodexHome(), 'teams');
}

function projectsRoot() {
  return path.join(clodexHome(), 'projects');
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

/**
 * Core's tickets-store.nextTicketId / ticketTitle / extractTaskDir, copied for
 * the same §4 reason and pinned against drift by
 * test/tickets-viewer-path-parity.test.js alongside projectDirFor.
 *
 * nextTicketId scans the WHOLE array including closed records, which is what
 * makes an id permanent: ids are public references (branch names, artifact
 * dirs, commit messages), so re-issuing one still resolves — to the wrong work.
 */
function nextTicketId(tickets) {
  let max = 0;
  for (const t of tickets || []) {
    const m = /^t(\d+)$/.exec(t && t.id);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return `t${max + 1}`;
}

function ticketTitle(specText) {
  const lines = String(specText == null ? '' : specText).split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t) return t.length > 80 ? `${t.slice(0, 77)}…` : t;
  }
  return '(untitled)';
}

// The absolute form is matched FIRST because `tasks/` appears inside it — bare
// first would truncate an absolute path to its tail. Scanned line by line,
// earliest line wins: a single match over the whole text would apply
// abs-before-rel globally and change the answer for specs that resolve today.
function extractTaskDir(specText) {
  const lines = String(specText == null ? '' : specText).split('\n');
  for (const line of lines) {
    const abs = line.match(/(?:~|\/)[A-Za-z0-9._/-]*\/tasks\/[A-Za-z0-9._/-]+/);
    if (abs) return abs[0];
    const m = line.match(/tasks\/[A-Za-z0-9._/-]+/);
    if (m) return m[0];
  }
  return null;
}

// Core's tickets-store.ticketStarted, copied for the same §4 reason and read by
// `stalled` below. Keep every arm: the ABSENT-key arm is the legacy shape and
// the easy one to drop — records written before `startedAt` existed have no such
// key and were all dispatched, so reading them as unstarted would empty the
// stalled column of exactly the oldest tickets, which is the direction nobody
// notices. `parked` carves out the one legacy shape that provably never
// dispatched. `role`/`worktree` are a second reading for records
// `_repinTicketToSeat` left without a `role`.
function ticketStarted(ticket) {
  if (!ticket) return false;
  if (ticket.startedAt != null) return true;
  if (ticket.role || (ticket.worktree && ticket.worktree.path)) return true;
  if (!Object.prototype.hasOwnProperty.call(ticket, 'startedAt')) return !ticket.parked;
  return false;
}

/**
 * Core's fs-util.atomicWriteFileSync, copied for the same §4 reason. Every
 * clause is load-bearing and none may be simplified into a plain writeFileSync:
 * the board is a single JSON array rewritten whole, so a torn write does not
 * lose an edit — it truncates the entire registry. Temp in the SAME directory
 * (rename is only atomic within a volume), fsync the contents, rename, then
 * fsync the DIRECTORY so the rename itself is durable and not just the bytes.
 */
function atomicWriteFileSync(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  let dfd;
  try {
    dfd = fs.openSync(dir, 'r');
    fs.fsyncSync(dfd);
  } catch (_) {} finally {
    if (dfd !== undefined) { try { fs.closeSync(dfd); } catch (_) {} }
  }
}

const TICKETS_FILE = 'tickets.json';
// A directory under teams/ is a team when it carries this. Without the check the
// board would list any stray directory as an empty team.
const TEAM_FILE = 'team.json';
// Optional, and treated as a HINT rather than a source of truth: nothing in the
// app writes it, so a project dir may not have one and one that exists may name
// a path that no longer hashes to the directory holding it. Verified before it
// is believed — see projectRootFor.
const PROJECT_FILE = '.project';

// The actor recorded in `opener` / `closedBy` for a write made HERE. Core writes
// session.name; a viewer edit has no session behind it, and borrowing a seat's
// name would attribute the operator's decision to an agent. A name no session
// can hold keeps the two distinguishable in the record forever.
const VIEWER_ACTOR = 'viewer';

/**
 * Core's path-confine.js, copied rather than required: §12 of
 * plugins/plugin-api.md refuses a relative require that leaves this directory,
 * and §4's rule for a utility a plugin needs is to copy it in. Keep the
 * semantics identical — resolve, then demand the result be a DIRECT child.
 *
 * Positive containment, not a name pattern: `.` and `..` are spelled entirely
 * in legal name characters, so no charset filter can reject them. The team name
 * and the project key both arrive over IPC from the renderer and this is the
 * only sanctioned way to turn either into a path.
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
// seat would contradict the nudge the lead already saw. A project with NO team
// has no override to read, so it gets core's default — which is also the
// threshold core would apply to it.
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
 * `{ ok: true, tickets, malformed }` or `{ ok: false, error }`, for a board
 * directory that has already been resolved and confined.
 *
 * Deliberately NOT tickets-store.js's `load()`, which is best-effort by design
 * and answers `[]` for a missing file, an unreadable one, invalid JSON and a
 * non-array alike. That is right for a writer that must not crash a session on
 * a corrupt registry, and wrong for a viewer: it would render a project whose
 * tickets.json is broken exactly like one that has never opened a ticket. It is
 * doubly wrong now that this file WRITES — saving an array rebuilt from a
 * best-effort `[]` would erase the very registry it failed to parse.
 *
 * A missing file is the one read failure that genuinely IS empty — the file is
 * created by the first ticket opened.
 */
function readTicketsAt(boardDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(boardDir, TICKETS_FILE), 'utf8');
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
 * The same read, keyed by the project ROOT — the form a team manifest gives.
 * Kept as the seam that maps root → directory so `projectDirFor` has exactly
 * one caller on the read path.
 */
function readTickets(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot) {
    // Not locatable is a read FAILURE, not an empty board — rendering "no
    // tickets" here would report a board nobody can find as a project that has
    // never opened one.
    return { ok: false, error: `cannot locate ${TICKETS_FILE}: no project root` };
  }
  return readTicketsAt(projectDirFor(clodexHome(), projectRoot));
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
 */
function stallMsFor(manifest) {
  const raw = manifest && manifest.watchdogMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_STALL_MS;
  return Math.min(WATCHDOG_MAX_MS, Math.max(WATCHDOG_MIN_MS, raw));
}

/**
 * Every team that resolves, indexed by the PROJECT KEY its root hashes to.
 *
 * This is the whole of the team's remaining role on this board: it supplies a
 * display name and a watchdogMs, and its absence costs neither. Built by
 * hashing each manifest's root FORWARD rather than by inverting a project key,
 * which is not invertible — sha256 is the point.
 *
 * A root claimed by two teams keeps the FIRST in sorted order, so the pick is
 * stable across reloads rather than readdir-order dependent.
 */
function teamIndex() {
  const out = new Map();
  let entries;
  try {
    entries = fs.readdirSync(teamsRoot(), { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const d of entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!d.isDirectory()) continue;
    const man = readManifest(path.join(teamsRoot(), d.name));
    const root = man.manifest && man.manifest.root;
    if (typeof root !== 'string' || !root) continue;
    const key = path.basename(projectDirFor(clodexHome(), root));
    if (!out.has(key)) out.set(key, { team: d.name, root, manifest: man.manifest, warning: man.warning || '' });
  }
  return out;
}

/**
 * The project's own root path, or ''. Three sources in falling order of trust,
 * and the ORDER is the point: a team manifest is written by core and is
 * authoritative; `.project` is a marker nothing in the app currently writes, so
 * it is believed only when it still hashes to the directory holding it.
 *
 * That check is not ceremony. A project directory is named for the hash of the
 * root, so a `.project` naming some OTHER path is a stale file left behind by a
 * moved checkout — and a board that displayed it would name a directory whose
 * tickets it is not showing.
 */
function projectRootFor(key, known) {
  if (known && known.root) return known.root;
  let raw;
  try {
    raw = fs.readFileSync(path.join(projectsRoot(), key, PROJECT_FILE), 'utf8');
  } catch (_) {
    return '';
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch (_) {
    return '';
  }
  const p = m && typeof m.path === 'string' ? m.path : '';
  if (!p) return '';
  return path.basename(projectDirFor(clodexHome(), p)) === key ? p : '';
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
    // the rest of the body is a scroll away rather than gone. The editor also
    // reads this field, so a truncation here would be saved back as the spec.
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
    // `ticketStarted` is the third exemption, and the one the `assignee` test
    // alone does not cover: `[agent:task add <role>]` writes the ROLE into
    // `assignee`, so a filed-but-never-dispatched backlog ticket is assigned by
    // that test and quiet forever by construction. Core exempts it
    // (`!ticketStarted(t)` in _sweepTeamTickets); without this term the board
    // would flag a stall for a seat that does not exist yet.
    stalled: assignee !== '' && !t.parked && ticketStarted(t)
      && quietMs !== null && quietMs >= stallMs,
    // The same condition said in the affirmative, and kept OUT of the stalled
    // count and the section head on purpose: how long a backlog ticket has sat
    // is worth seeing, and it is not a stall.
    backlog: assignee === '',
    // Distinct from `backlog`: both are undispatched, but a parked ticket
    // already names its seat, so the lead's action is to release it rather than
    // to decide who gets it.
    parked: t.parked === true,
    // A COUNT, not the entries: shipping the array would put every superseded
    // title on a surface that renders none of them. Absent on the overwhelming
    // majority of tickets, so it reads 0 rather than undefined.
    //
    // Projected but NOT DRAWN: no renderer reads this yet, so the visible mark
    // for a superseded spec is core's `[agent:task list]` row alone. Stated
    // because the obvious assumption is that a shaped field reaches the board UI.
    respecCount: Array.isArray(t.respecs) ? t.respecs.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * `{ ok: true, projects }` or `{ ok: false, error }`. Every project with a board
 * directory, whether or not a team names it — this is the listing that replaced
 * the team list as the board's index, because a project is what a board belongs
 * to and a team is one optional consumer of it.
 *
 * A missing projects/ directory is "no projects yet" — nothing has ever opened a
 * ticket — and every other readdir failure is a failure, reported as one.
 *
 * Per-project read failures do NOT fail the list: one corrupt registry must not
 * hide the projects that are fine, so the row carries its own `error` and the
 * renderer paints that row differently.
 */
function projects() {
  const root = projectsRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, projects: [] };
    return { ok: false, error: `could not read ${root} (${(e && e.code) || (e && e.message) || 'unknown error'})` };
  }

  const teams = teamIndex();
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const known = teams.get(d.name);
    const row = {
      key: d.name,
      leaf: d.name.replace(/-[0-9a-f]{8}$/, ''),
      root: projectRootFor(d.name, known),
      team: known ? known.team : '',
      warning: known ? known.warning : '',
    };
    const read = readTicketsAt(path.join(root, d.name));
    if (!read.ok) {
      out.push({ ...row, error: read.error });
      continue;
    }
    const now = Date.now();
    const stallMs = stallMsFor(known && known.manifest);
    const open = read.tickets.filter((t) => t.state === 'open').map((t) => shape(t, now, stallMs));
    out.push({
      ...row,
      open: open.length,
      stalled: open.filter((t) => t.stalled).length,
      // Separate from `stalled` for the same reason it is separate on a row:
      // an unassigned ticket needs assigning, not chasing.
      backlog: open.filter((t) => t.backlog).length,
      parked: open.filter((t) => t.parked).length,
    });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { ok: true, projects: out };
}

/**
 * `{ ok: true, teams }` or `{ ok: false, error }` — every team, with the project
 * key its board lives under.
 *
 * Kept after the board moved to the project because a team is still how most
 * boards are reached by name, and NO team is a normal state: an empty list is
 * `{ ok: true, teams: [] }`, never an error. A missing teams/ directory is the
 * same normal state — on a box that has never created a team the directory does
 * not exist at all, so treating ENOENT as a failure would make the ordinary
 * solo install look broken.
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
    // team.json is what makes a directory a team (team-manifest's TEAM_FILE).
    // Without this a stray directory would list as a team.
    const man = readManifest(path.join(root, d.name));
    if (man.missing) continue;
    if (man.error) {
      out.push({ team: d.name, error: man.error });
      continue;
    }
    const troot = man.manifest && man.manifest.root;
    out.push({
      team: d.name,
      root: typeof troot === 'string' ? troot : '',
      // The join to the board. Empty when the manifest names no usable root —
      // which is exactly the case manifestWarning already explains.
      project: typeof troot === 'string' && troot ? path.basename(projectDirFor(clodexHome(), troot)) : '',
      warning: man.warning || '',
    });
  }
  out.sort((a, b) => (a.team < b.team ? -1 : a.team > b.team ? 1 : 0));
  return { ok: true, teams: out };
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/**
 * Resolves a renderer-supplied project key to a board directory, or an error.
 * Every read and every write goes through this — it is the only place a string
 * from the renderer becomes a path, and the existence probe is part of it.
 */
function resolveProject(key) {
  const dir = confine(projectsRoot(), key);
  if (dir === null) return { ok: false, error: 'a valid project key is required' };
  // Containment is not existence. `confine` accepts any legal single path
  // component — `...` among them — so without this a project that does not
  // exist reads as a project with nothing open, which is the same false green as
  // a corrupt registry rendering empty.
  let st;
  try {
    st = fs.statSync(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, error: `no project "${key}" under ${projectsRoot()}` };
    return { ok: false, error: `could not read ${key} (${(e && e.code) || (e && e.message) || 'unknown error'})` };
  }
  if (!st.isDirectory()) return { ok: false, error: `no project "${key}" under ${projectsRoot()}` };
  return { ok: true, dir };
}

function board(projectKey) {
  const loc = resolveProject(projectKey);
  if (!loc.ok) return loc;

  const known = teamIndex().get(projectKey);
  const read = readTicketsAt(loc.dir);
  if (!read.ok) return known && known.warning ? { ...read, warning: known.warning } : read;

  const now = Date.now();
  const stallMs = stallMsFor(known && known.manifest);
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
    project: projectKey,
    root: projectRootFor(projectKey, known),
    // '' when no team names this project — the ordinary solo case, and NOT a
    // warning: the board is the project's and a team is optional.
    team: known ? known.team : '',
    now,
    stallMs,
    // A manifest core would reject, when the tickets themselves read fine. Not
    // a false green about the tickets — they are real — but a team the app
    // cannot resolve must not look entirely healthy here.
    warning: known ? known.warning : '',
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

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The refusal described at `everOverridden`, as a result object or null.
 *
 * Checked at the write choke point rather than at each verb so a verb added
 * later cannot forget it.
 */
function writeEscapedTestTree() {
  if (everOverridden && clodexHomeOverride === null) {
    return {
      ok: false,
      error: 'refusing to write: the test clodex home was cleared, so this write '
        + 'would land in the real ~/.clodex board',
    };
  }
  return null;
}

/**
 * Load the board, hand it to `mutate`, and save it back — the ONE path every
 * write takes.
 *
 * The load happens HERE rather than in the caller, as late as it can: core's
 * ticket handlers carry the same note (`_taskDone`'s "an early load would be a
 * wider window for a concurrent clodex-team write to be clobbered by the save")
 * because the whole array is rewritten, so anything another writer added
 * between the read and the save is lost. There is no lock to take — core does
 * not take one either — so narrowing the window is the entire mitigation.
 *
 * `mutate` returns `{ error }` to refuse without writing, or `{ result }` to
 * commit. Refusing BEFORE any save is what keeps a rejected edit from leaving
 * half a change on disk.
 */
function mutateBoard(projectKey, mutate) {
  // Ahead of resolveProject, so the refusal cannot depend on what happens to
  // exist under the real home.
  const escaped = writeEscapedTestTree();
  if (escaped) return escaped;
  const loc = resolveProject(projectKey);
  if (!loc.ok) return loc;
  // Not tickets-store's best-effort load: saving an array rebuilt from a `[]`
  // that actually meant "this file did not parse" would erase the registry.
  const read = readTicketsAt(loc.dir);
  if (!read.ok) return { ok: false, error: `refusing to write: ${read.error}` };

  const outcome = mutate(read.tickets);
  if (outcome && outcome.error) return { ok: false, error: outcome.error };

  try {
    atomicWriteFileSync(path.join(loc.dir, TICKETS_FILE), JSON.stringify(read.tickets, null, 2));
  } catch (e) {
    return { ok: false, error: `could not write ${TICKETS_FILE} (${(e && e.code) || (e && e.message) || 'unknown error'})` };
  }
  return { ok: true, ...(outcome && outcome.result ? outcome.result : {}) };
}

function findOpen(tickets, id) {
  const t = tickets.find((x) => str(x.id) === id);
  if (!t) return { error: `no ticket "${id}" on this board` };
  if (t.state !== 'open') return { error: `ticket ${id} is ${str(t.state) || 'in no state'}, not open` };
  return { ticket: t };
}

/**
 * Deliver the spec to a live session, best effort.
 *
 * Best effort DELIBERATELY, and it must stay that way: the record is already
 * written when this runs, so throwing here would report a failed write over a
 * board that did change. The return value says whether the seat was actually
 * told, and every caller passes it back to the renderer so the operator learns
 * that the ticket exists but nobody was notified — the alternative is an
 * assignment that looks delivered and is not.
 *
 * Format matches core's _deliverTicketSpec so a seat cannot tell the two apart.
 */
function deliverSpec(name, ticket) {
  if (!name || !host || !host.sessions) return false;
  let handle;
  try {
    handle = host.sessions.get(name);
  } catch (_) {
    return false;
  }
  if (!handle || !handle.isAlive()) return false;
  try {
    handle.inject(`[ticket ${ticket.id}] ${str(ticket.spec)}`, { parkable: true });
    return true;
  } catch (e) {
    host.log.error(`could not deliver ${ticket.id} to ${name}`, e);
    return false;
  }
}

/**
 * Open a ticket. `assignee` is optional — an unassigned ticket is BACKLOG, the
 * normal state for a project with no team, not a degraded one.
 *
 * The record is minted field for field as session-manager mints it, including
 * the two conditionals: `parked` is written ONLY when true (a stored
 * `parked: false` is a state core refuses to produce, and every reader tests
 * truthiness) and `taskDir` only when the spec's first line names one.
 */
function add(payload) {
  const { project, spec, assignee } = payload || {};
  const text = str(spec);
  if (!text.trim()) return { ok: false, error: 'a ticket needs a spec' };
  const who = str(assignee);

  let delivered = false;
  const res = mutateBoard(project, (tickets) => {
    const now = Date.now();
    const ticket = {
      id: nextTicketId(tickets),
      title: ticketTitle(text),
      spec: text,
      assignee: who,
      opener: VIEWER_ACTOR,
      state: 'open',
      openedAt: now,
      closedAt: null,
      lastActivityAt: now,
      nudgedAt: null,
      // An explicit key, never omitted: `ticketStarted` reads an ABSENT
      // `startedAt` as a pre-upgrade record the old `add` dispatched, so a
      // record minted without one files as already STARTED — a shape core
      // cannot produce, from the writer that also reads it as legacy.
      //
      // Stamped rather than null when an assignee is given, which is where this
      // parts from core's `add`: core split dispatch out into `_taskStart` and
      // always writes null, but delivery happens HERE (deliverSpec below), and a
      // delivered spec whose record says unstarted is exempt from the stall
      // watchdog for as long as the seat holds it.
      startedAt: who ? now : null,
    };
    const taskDir = extractTaskDir(text);
    if (taskDir) ticket.taskDir = taskDir;
    tickets.push(ticket);
    return { result: { id: ticket.id, ticket } };
  });
  if (!res.ok) return res;
  if (who) delivered = deliverSpec(who, res.ticket);
  return { ok: true, id: res.id, delivered };
}

/**
 * Replace a ticket's spec. Title and taskDir are DERIVED from the spec, so both
 * are recomputed here — leaving either stale would make the board's summary
 * line and its artifact path describe a spec that no longer exists.
 *
 * `taskDir` is deleted when the new spec names none, rather than left at its old
 * value: a stale path pointing at another ticket's artifacts is worse than the
 * absence the row already knows how to render.
 */
function editSpec(payload) {
  const { project, id, spec } = payload || {};
  const ticketId = str(id);
  const text = str(spec);
  if (!ticketId) return { ok: false, error: 'a ticket id is required' };
  if (!text.trim()) return { ok: false, error: 'a ticket needs a spec' };

  return mutateBoard(project, (tickets) => {
    const t = tickets.find((x) => str(x.id) === ticketId);
    // Editable in any state on purpose, unlike the lifecycle verbs: correcting
    // the record of a closed ticket is not a lifecycle change.
    if (!t) return { error: `no ticket "${ticketId}" on this board` };
    t.spec = text;
    t.title = ticketTitle(text);
    const taskDir = extractTaskDir(text);
    if (taskDir) t.taskDir = taskDir; else delete t.taskDir;
    t.lastActivityAt = Date.now();
    return { result: {} };
  });
}

/**
 * Assign or reassign an open ticket. With no team the name is a LIVE SESSION;
 * with a team it may equally be a role, and neither is resolved here — the
 * string is stored as core stores it and delivery is attempted against a
 * session of that name.
 *
 * `role` is DELETED, matching core's plain-name assign branch: the field means
 * "this ticket was filed under a role and re-pinned to a seat", and leaving a
 * stale one behind would make `shownFor` render the old role over the new
 * assignee — the board would name the wrong holder.
 *
 * Clearing `parked` is likewise core's behaviour: assigning is what releases a
 * parked ticket.
 */
function assign(payload) {
  const { project, id, assignee } = payload || {};
  const ticketId = str(id);
  const who = str(assignee);
  if (!ticketId) return { ok: false, error: 'a ticket id is required' };
  if (!who) return { ok: false, error: 'an assignee is required' };

  const res = mutateBoard(project, (tickets) => {
    const found = findOpen(tickets, ticketId);
    if (found.error) return { error: found.error };
    const t = found.ticket;
    t.assignee = who;
    t.lastActivityAt = Date.now();
    // The new holder has not been chased, whatever the old one had accrued.
    t.nudgedAt = null;
    delete t.role;
    delete t.parked;
    // Assign IS a dispatch here — deliverSpec runs below — so it records the
    // dispatch, exactly as core's `_taskAssign` does. Without this an
    // undispatched ticket assigned FROM THE BOARD stays unstarted forever, and
    // both the stall flag above and core's watchdog exempt it: a seat holds it,
    // goes quiet for a week, and nothing says so. Not re-stamped when already
    // set: this is the moment work FIRST started, and a re-send must not
    // restate it.
    if (!ticketStarted(t)) t.startedAt = t.lastActivityAt;
    return { result: { ticket: t } };
  });
  if (!res.ok) return res;
  return { ok: true, delivered: deliverSpec(who, res.ticket) };
}

/**
 * Close an open ticket, done or cancelled.
 *
 * One shape across both close verbs, as core writes them: `state`, `closedAt`,
 * `closedBy` and a `lastActivityAt` equal to `closedAt`. The two differ only in
 * the state, which is what keeps "what got shipped" and "what got dropped"
 * countable apart.
 */
function closeTicket(payload, state) {
  const { project, id } = payload || {};
  const ticketId = str(id);
  if (!ticketId) return { ok: false, error: 'a ticket id is required' };

  return mutateBoard(project, (tickets) => {
    const found = findOpen(tickets, ticketId);
    if (found.error) return { error: found.error };
    const t = found.ticket;
    const now = Date.now();
    t.state = state;
    t.closedAt = now;
    t.closedBy = VIEWER_ACTOR;
    t.lastActivityAt = now;
    return { result: {} };
  });
}

/**
 * Live session names the assign picker can offer.
 *
 * Bash sessions are filtered out because they are private — no registry, no
 * socket, not DM-able (see the app's own gotcha list) — so offering one would
 * produce an assignment whose spec can never be delivered.
 */
function sessions() {
  if (!host || !host.sessions) return { ok: true, sessions: [] };
  let rows;
  try {
    rows = host.sessions.listAll() || [];
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'could not list sessions' };
  }
  const names = rows
    .filter((s) => s && s.name && s.type && s.type !== 'bash')
    .map((s) => String(s.name));
  names.sort();
  return { ok: true, sessions: names };
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

module.exports.activate = (h) => {
  host = h;

  host.ipc.handle('projects', () => projects());
  host.ipc.handle('teams', () => teams());
  host.ipc.handle('board', (key) => board(key));
  host.ipc.handle('sessions', () => sessions());

  // The write half. Deliberately absent from manifest.json's `surfaces`, which
  // is what keeps them desktop-only: plugin-api.md §"What to mark any" leaves
  // off anything that writes a file, and a board reachable from a browser is a
  // board a browser can close tickets on.
  host.ipc.handle('add', (p) => add(p));
  host.ipc.handle('editSpec', (p) => editSpec(p));
  host.ipc.handle('assign', (p) => assign(p));
  host.ipc.handle('close', (p) => closeTicket(p, 'done'));
  host.ipc.handle('cancel', (p) => closeTicket(p, 'cancelled'));

  host.log.info('activated');
};

module.exports.deactivate = () => {
  host = null;
};

// Exported for the test suite. Not part of the plugin contract — the host only
// ever calls activate/deactivate and the ipc methods above.
module.exports._internals = {
  confine, readTickets, readTicketsAt, readManifest, stallMsFor, shape,
  board, teams, projects, teamsRoot, projectsRoot, teamIndex, projectRootFor,
  clodexHome, projectDirFor, nextTicketId, ticketTitle, extractTaskDir, ticketStarted,
  atomicWriteFileSync, resolveProject,
  add, editSpec, assign, closeTicket, sessions,
  VIEWER_ACTOR,
  DEFAULT_STALL_MS, WATCHDOG_MIN_MS, WATCHDOG_MAX_MS, RECENT_DONE_MS, RECENT_DONE_CAP,
  // The tree is no longer env-derived, so a test needs a seam that is not an
  // environment variable. It overrides the HOME rather than teams/ or projects/,
  // because they must move together — a test that repointed only one would read
  // fixture data against the operator's real boards.
  // Deliberately NOT on the host surface: hostApi is frozen at "1", and a plugin
  // able to ask core where things live is a contract change. Pass null to restore.
  setClodexHomeForTest(dir) {
    if (dir) everOverridden = true;
    clodexHomeOverride = dir || null;
  },
  // Read back so a test can assert WHERE a write would land before making one.
  boardPathForTest(key) { return path.join(projectsRoot(), key, TICKETS_FILE); },
  // The engine half holds `host` in module state, so a test driving the write
  // path without the real plugin host needs a way to stand one in.
  setHostForTest(h) { host = h; },
};
