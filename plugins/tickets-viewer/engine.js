'use strict';

/**
 * tickets-viewer — engine half. The write surface must stay narrow: a plugin can
 * reach none of what `[agent:task …]` also does (_advanceSeat,
 * _reconcileTickets, COST.json, the lead-only gates), so a viewer write is the
 * operator's OWN edit, not an impersonation of the intent path. Spec delivery is
 * the one exception — an assignment nobody is told about looks like success.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// The utilities below marked as core's are COPIED, not required: §12 of
// plugins/plugin-api.md refuses a require leaving this directory. Each fails
// SILENTLY when it drifts, so each is pinned against core's in
// test/tickets-viewer-path-parity.test.js. Keep them byte-equivalent.

let clodexHomeOverride = null;

// Latched at the first test override, NEVER cleared: after one, a null override
// means the test tree is GONE, not that we are in production, so every write
// refuses rather than landing in the operator's real ~/.clodex, where there is no
// undo. Reads stay unaffected on purpose.
let everOverridden = false;

// Must NOT honour CLODEX_HOME: core's REGISTRY_DIR does not, so reading it would
// report on a different tree than the app hosting the board.
function clodexHome() {
  return path.join(clodexHomeOverride || path.join(os.homedir(), '.clodex'));
}

function teamsRoot() {
  return path.join(clodexHome(), 'teams');
}

function projectsRoot() {
  return path.join(clodexHome(), 'projects');
}

// Core's clodex-paths.projectDirFor. The sha256 is over the RESOLVED path: a
// "cleaner" realpath here hashes a symlink's target and points the board at a
// directory nobody wrote.
function projectDirFor(root, projectPath) {
  const real = path.resolve(projectPath);
  const hash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 8);
  return path.join(root, 'projects', `${path.basename(real)}-${hash}`);
}

// Core's tickets-store.nextTicketId / ticketTitle / extractTaskDir. nextTicketId
// scans the WHOLE array, closed records included: an id is a public reference, so
// a re-issued one still resolves — to the wrong work.
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

// Absolute form FIRST, because `tasks/` appears inside it — bare-first truncates
// an absolute path to its tail. Line by line, earliest line wins: one match over
// the whole text would apply abs-before-rel globally.
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

// Core's tickets-store.ticketStarted. Keep every arm — the ABSENT-key one is the
// legacy shape and the easy one to drop: those records were all dispatched, so
// reading them as unstarted empties the stalled column of the oldest tickets.
function ticketStarted(ticket) {
  if (!ticket) return false;
  if (ticket.startedAt != null) return true;
  if (ticket.role || (ticket.worktree && ticket.worktree.path)) return true;
  if (!Object.prototype.hasOwnProperty.call(ticket, 'startedAt')) return !ticket.parked;
  return false;
}

/**
 * Core's team-tickets `_ticketTaskDirRefusal`. `assign` below is the other
 * dispatch door: without this copy the same act is refused when typed and allowed
 * when clicked. The SENTENCE is as load-bearing as the predicate — it carries the
 * fix instruction the lead acts on.
 */
function ticketTaskDirRefusal(team, ticket, verb, reSend) {
  if (ticket.taskDir) return null;
  // Core spells this `team.solo`, never persisted and unobservable here; "no team
  // names this project" is the equivalent. A solo ticket mints no worktree, so it
  // cannot reach the verify-time refusal this gate prevents.
  if (team && team.solo) return null;
  // A re-send is a redelivery — refusing it strands the recovery a respawned or
  // stuck seat depends on.
  if (reSend) return null;
  // `respec`, not `reject`: the ticket is still OPEN here.
  return `ticket ${ticket.id} has no task dir, so nothing was ${verb === 'start' ? 'started' : 'assigned'} — its spec names no \`tasks/…\` path on any line, `
    + `and the review step has nowhere to write its diff. Nothing was changed. `
    + `Fix: re-file it with the artifact dir on the spec's first line, or \`[agent:task respec ${ticket.id}]\` <the corrected spec> to replace it in place.`;
}

/**
 * Core's fs-util.atomicWriteFileSync. Not simplifiable to a writeFileSync: the
 * board is one JSON array rewritten whole, so a torn write truncates the entire
 * registry. Temp in the SAME directory (rename is atomic only within a volume),
 * fsync contents, rename, then fsync the DIRECTORY — the rename must be durable,
 * not just the bytes.
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
// A directory under teams/ is a team only when it carries this — without the
// check the board lists any stray directory as an empty team.
const TEAM_FILE = 'team.json';
// A HINT, not a source of truth: one that exists may name a path that no longer
// hashes to the directory holding it. Verified before believed — projectRootFor.
const PROJECT_FILE = '.project';

// Borrowing a seat's name would attribute the operator's decision to an agent; a
// name no session can hold keeps the two distinguishable in the record forever.
const VIEWER_ACTOR = 'viewer';

// Copied from core's _deliverTicketSpec. It denies BY NAME the two beliefs that
// have left finished tickets open — that closing needs an exec grant, and that a
// report-shaped dm closes one — so a paraphrase drops the point of the line.
const closeLine = (id) => `CLOSE WITH: [agent:task done ${id}] <your report> — one intent, at the end: it delivers the report to the lead AND marks the ticket done. `
  + `It is a line you emit yourself, like any [agent:…] intent — NOT an exec command, and nothing needs to be granted for it. `
  + `A dm carrying your report does NOT close the ticket: the ticket stays open, and everything downstream of the close (tree verify, review) never runs.\n`;

/**
 * Core's path-confine.js. Positive containment, never a name pattern: `.` and `..`
 * are spelled entirely in legal name characters, so no charset filter can reject
 * them — resolve, then demand a DIRECT child. Both inputs arrive over IPC from the
 * renderer, and this is the only sanctioned way to turn either into a path.
 */
function confine(root, name) {
  if (typeof root !== 'string' || !root) return null;
  if (typeof name !== 'string' || !name) return null;
  const dir = path.resolve(root, name);
  if (path.dirname(dir) !== path.resolve(root)) return null;
  return dir;
}

// Split out because `confineUnder` needs the FATAL form: an escaping segment must
// abort the walk, not return a null the loop would then resolve against.
function confineOrThrow(root, name, label = 'name') {
  const dir = confine(root, name);
  if (dir === null) throw new Error(`invalid ${label}: ${name}`);
  return dir;
}

/**
 * Core's team-cost `confineUnder` + `stripFileTail` + `resolveTaskDir`, copied
 * WHOLE and not narrowed to a "good enough" version: `taskDir` is spec TEXT an
 * agent wrote, and the viewer renders it into a dispatch a hand then cds into. A
 * reimplementation covering the shapes seen so far is how a traversal gets in.
 */

// A task dir is `tasks/<name>[/…]` and path-confine admits ONE segment, so the
// walk is segment by segment: a target outside the root produces leading `..`
// segments, each failing the direct-child test at the step that introduces it. An
// empty relative path is the root ITSELF, which is not a task dir.
function confineUnder(root, target) {
  const base = path.resolve(root);
  const rel = path.relative(base, path.resolve(target));
  if (!rel) throw new Error(`invalid taskDir: ${base} is not a task dir`);
  let cur = base;
  for (const seg of rel.split(path.sep)) cur = confineOrThrow(cur, seg, 'taskDir segment');
  return cur;
}

// CLOSED, never "any short alnum tail": a dir named `round.2` or `v2.beta` is a
// directory, and eating its last level names a directory one level up where
// nothing looks for it. Widen by adding an extension, never by loosening it.
const FILE_TAIL_RE = /\.(?:md|json|txt|log|patch|diff)$/i;
function stripFileTail(p) {
  const parts = p.split(path.sep);
  const i = parts.lastIndexOf('tasks');
  if (i < 0 || parts.length - i < 3) return p;
  if (!FILE_TAIL_RE.test(parts[parts.length - 1])) return p;
  return parts.slice(0, -1).join(path.sep);
}

function resolveTaskDir({ taskDir, projectDir, projectsRoot: root, homedir }) {
  const raw = String(taskDir == null ? '' : taskDir).trim();
  if (!raw) return null;
  let abs;
  if (raw === '~' || raw.startsWith('~/')) {
    if (!homedir) return null;
    abs = path.join(homedir, raw.slice(1));
  } else if (path.isAbsolute(raw)) {
    abs = raw;
  } else {
    if (!projectDir) return null;
    abs = path.join(projectDir, raw);
  }
  abs = stripFileTail(path.resolve(abs));
  if (!root) return null;
  return confineUnder(root, abs);
}

/**
 * Core's team-tickets `taskDirRuleClause` / `taskDirCreateClause` /
 * `ticketTaskDirLine`. The WORDING is the deliverable: most live pointers are
 * relative, the repo carries a gitignored `tasks/` decoy many collide with by
 * name, and this clause is the only thing stopping a hand resolving the pointer
 * against its cwd. A paraphrase passes a shape check and teaches a different rule.
 */
const taskDirRelative = (raw) => !!raw && !raw.startsWith('~') && !path.isAbsolute(raw);

const taskDirRuleClause = (raw) => (taskDirRelative(raw)
  ? ` — the spec's \`${raw}\` is relative to the PROJECT'S ARTIFACT DIR, `
    + `not to your cwd, and a same-named directory inside the repo is NOT it. `
    + `This is the directory itself (the pointer may name a file inside it); it may not exist yet, `
    + `and its absence is not evidence that there is no artifact.`
  : '');
const taskDirCreateClause = ` So create it rather than working without one.`;
const ticketTaskDirLine = (dir, raw) => {
  const rule = taskDirRuleClause(raw);
  return `TASK DIR: ${dir}${rule}${rule ? taskDirCreateClause : ''}\n`;
};

/**
 * The viewer's half of core's `_ticketTaskDirRender(...).line`.
 *
 * The outer `rule ?` guard is NOT a redundant recomputation of the clause inside
 * `ticketTaskDirLine`: it suppresses the WHOLE line for a `~`- or `/`-prefixed
 * pointer. Every dispatch already spills past the 500-byte threshold, so a line
 * restating what an absolute path means costs the seat a Read turn.
 *
 * Best effort: a taskDir that refuses confinement drops the line and never
 * throws — a dispatch must not die over a display line.
 */
function ticketTaskDirLineFor(projectDir, ticket) {
  const raw = String((ticket && ticket.taskDir) || '').trim();
  if (!raw) return '';
  let dir = null;
  try {
    dir = resolveTaskDir({
      taskDir: raw,
      projectDir,
      projectsRoot: projectsRoot(),
      homedir: os.homedir(),
    });
  } catch (_) {
    return '';
  }
  if (!dir) return '';
  const rule = taskDirRuleClause(raw);
  return rule ? ticketTaskDirLine(dir, raw) : '';
}

// Core's TICKET_STALL_MS, from _sweepTickets: a board calling a ticket stalled on
// a different threshold than the nudge uses would contradict the nudge the lead
// already saw.
const DEFAULT_STALL_MS = 30 * 60 * 1000;

// team-manifest.js's WATCHDOG_MIN_MS / WATCHDOG_MAX_MS. team.json is
// agent-writable and every other consumer clamps via loadManifest, which this
// plugin cannot reach — so it must clamp itself. Unbounded is the dangerous
// direction: `1e400` parses to Infinity, a number greater than zero, and an
// unclamped board never calls anything stalled while core nudges on 30 minutes.
const WATCHDOG_MIN_MS = 5 * 60 * 1000;
const WATCHDOG_MAX_MS = 7 * 24 * 60 * 60 * 1000;

// Core's RECENT_DONE_MS / RECENT_DONE_CAP from _taskList.
const RECENT_DONE_MS = 24 * 60 * 60 * 1000;
const RECENT_DONE_CAP = 10;

let host = null;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * NOT tickets-store.js's `load()`, which answers `[]` for a missing file, an
 * unreadable one, invalid JSON and a non-array alike: a broken tickets.json would
 * render like a project that never opened a ticket, and — since this file WRITES —
 * saving an array rebuilt from that `[]` erases the registry it failed to parse.
 * A missing file is the one read failure that genuinely IS empty.
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
  // Counted, not dropped: a registry half-eaten by a bad hand-edit would
  // otherwise render as a shorter but perfectly healthy board.
  return { ok: true, tickets, malformed: parsed.length - tickets.length };
}

function readTickets(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot) {
    // A read FAILURE, not an empty board: "no tickets" here would report a board
    // nobody can find as a project that never opened one.
    return { ok: false, error: `cannot locate ${TICKETS_FILE}: no project root` };
  }
  return readTicketsAt(projectDirFor(clodexHome(), projectRoot));
}

/**
 * Reading the file IS the existence probe, never an existsSync: that answers false
 * for EACCES, EPERM and ELOOP alike, making a team nobody can read
 * indistinguishable from one that was never created.
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
 * A deliberate SUBSET of core's loadManifest checks, and one-directional: what it
 * names, core also rejects; what it misses renders with no warning. It must never
 * call a manifest good — a full copy here would be a third validator to drift.
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
 * Both halves are load-bearing: _sweepTickets's precedence keeps this board's
 * verdict equal to the watchdog's, and the clamp keeps a hand-edited `watchdogMs`
 * from silently emptying the stalled column.
 */
function stallMsFor(manifest) {
  const raw = manifest && manifest.watchdogMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_STALL_MS;
  return Math.min(WATCHDOG_MAX_MS, Math.max(WATCHDOG_MIN_MS, raw));
}

/**
 * Indexed by hashing each manifest's root FORWARD: a project key is not
 * invertible. A root claimed by two teams keeps the FIRST in sorted order, so the
 * pick is stable across reloads rather than readdir-order dependent.
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
 * The ORDER is the point: a team manifest is core's and authoritative, while
 * `.project` is believed only when it still hashes to the directory holding it.
 * One naming another path is a stale file left by a moved checkout, and a board
 * displaying it would name a directory whose tickets it is not showing.
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
 * One board row. Timestamps cross as raw numbers alongside the engine's `now`, so
 * every age on screen is measured against the single clock reading the `stalled`
 * flag was computed from.
 */
function shape(t, now, stallMs) {
  const openedAt = num(t.openedAt);
  // `??`, not `||`: a timestamp of 0 is not "no timestamp", and num() has already
  // turned every genuinely absent value into null.
  const lastActivityAt = num(t.lastActivityAt) ?? openedAt;
  const quietMs = lastActivityAt === null ? null : Math.max(0, now - lastActivityAt);
  // `shownFor` prefers the ROLE: core re-pins `assignee` to a concrete seat at
  // delivery, so rendering it raw names a seat where both boards name the role.
  // `assignee` itself stays RAW — `stalled` and `backlog` key off it.
  const assignee = str(t.assignee);
  const role = str(t.role);
  return {
    id: str(t.id) || '(no id)',
    title: str(t.title) || '(untitled)',
    role,
    shownFor: role || assignee,
    // Uncapped: the editor reads this field, so a truncation here would be saved
    // back AS the spec. The renderer caps the HEIGHT in CSS instead.
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
    nudged: num(t.nudgedAt) !== null,
    // Three exemptions, each mirroring one _sweepTickets makes: unassigned,
    // parked, never-dispatched. Flagging any invents a stall core can neither
    // produce nor clear. `ticketStarted` is the one `assignee` does not cover —
    // `[agent:task add <role>]` writes the ROLE into `assignee`, so a
    // filed-but-never-dispatched ticket reads as assigned and is quiet forever.
    stalled: assignee !== '' && !t.parked && ticketStarted(t)
      && quietMs !== null && quietMs >= stallMs,
    // Kept OUT of the stalled count and the section head: a backlog ticket's age
    // is worth seeing, and it is not a stall.
    backlog: assignee === '',
    // Distinct from `backlog`: a parked ticket already names its seat, so the
    // action is to release it rather than to decide who gets it.
    parked: t.parked === true,
    // A COUNT, not the entries: shipping the array would put every superseded
    // title on a surface that renders none of them.
    respecCount: Array.isArray(t.respecs) ? t.respecs.length : 0,
    // The STORED strings verbatim: a phrase of the viewer's own would assert a
    // state the record does not carry. Two fields and NOT one merge-state enum —
    // mergeError reads as "needs a human" and a ticket waiting its turn does not,
    // so collapsing them re-merges on the wire what core keeps apart on disk.
    mergeWaiting: str(t.mergeWaiting),
    mergeError: str(t.mergeError),
  };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * A missing projects/ directory is "no projects yet"; every other readdir failure
 * is reported as a failure. Per-project read failures do NOT fail the list — one
 * corrupt registry must not hide the projects that are fine.
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
      // Separate from `stalled`: an unassigned ticket needs assigning, not chasing.
      backlog: open.filter((t) => t.backlog).length,
      parked: open.filter((t) => t.parked).length,
    });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { ok: true, projects: out };
}

/**
 * NO team is a normal state: an empty list is `{ ok: true, teams: [] }`, never an
 * error, and a missing teams/ directory is the same — treating its ENOENT as a
 * failure would make the ordinary solo install look broken.
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
 * The only place a string from the renderer becomes a path.
 */
function resolveProject(key) {
  const dir = confine(projectsRoot(), key);
  if (dir === null) return { ok: false, error: 'a valid project key is required' };
  // Containment is not existence: `confine` accepts any legal single path
  // component, so without this probe a project that does not exist reads as one
  // with nothing open.
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
    // Newest first, NOT quietest-first: the stall flag, the `tv-stalled` class and
    // the header count already surface stalls wherever the row sits, and ordering
    // by quiet buried the ticket just filed. No usable openedAt sorts to the TOP.
    .sort((a, b) => {
      if (a.openedAt === b.openedAt) return 0;
      if (a.openedAt === null) return -1;
      if (b.openedAt === null) return 1;
      return b.openedAt - a.openedAt;
    });

  const doneAll = all.filter((t) => t.state === 'done');
  const cancelledAll = all.filter((t) => t.state === 'cancelled');

  // done only, matching _taskList: mixing in cancelled gives a number answering
  // neither "what got done" nor "what got dropped".
  const recentAll = doneAll
    .filter((t) => num(t.closedAt) !== null && now - t.closedAt < RECENT_DONE_MS)
    .sort((a, b) => b.closedAt - a.closedAt);
  const recent = recentAll.slice(0, RECENT_DONE_CAP).map((t) => shape(t, now, stallMs));

  return {
    ok: true,
    project: projectKey,
    root: projectRootFor(projectKey, known),
    team: known ? known.team : '',
    now,
    stallMs,
    // A manifest core would reject while the tickets read fine: a team the app
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
      // Surfaced rather than filtered: these records are invisible in every other
      // listing too.
      unknownState: all.length - open.length - doneAll.length - cancelledAll.length,
      malformed: read.malformed,
    },
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The refusal described at `everOverridden`. At the write choke point rather than
 * at each verb, so a verb added later cannot forget it.
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
 * The ONE path every write takes.
 *
 * The load happens HERE, not in the caller, and as late as it can: the whole array
 * is rewritten, so anything another writer added between the read and the save is
 * lost. There is no lock to take, so narrowing that window is the whole mitigation.
 *
 * `mutate` returns `{ error }` to refuse without writing, or `{ result }` to
 * commit — refusing BEFORE any save is what keeps a rejected edit from leaving
 * half a change on disk.
 */
function mutateBoard(projectKey, mutate) {
  // Ahead of resolveProject, so the refusal cannot depend on what happens to exist
  // under the real home.
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
 * Deliver the spec to a live session.
 *
 * Best effort, and it must stay that way: the record is already written when this
 * runs, so throwing would report a failed write over a board that did change. The
 * return value says whether the seat was told — the alternative is an assignment
 * that looks delivered and is not.
 *
 * Format and ORDER match core's `${taskDirLine}${closeLine}${specText}`: a seat
 * taught to close by one dispatch path and not the other learns the verb is
 * optional. `projectKey` is required, not optional — a defaulted-away key renders
 * nothing for the relative pointers this exists to serve, which are most of them.
 */
function deliverSpec(name, ticket, projectKey) {
  if (!name || !host || !host.sessions) return false;
  let handle;
  try {
    handle = host.sessions.get(name);
  } catch (_) {
    return false;
  }
  if (!handle || !handle.isAlive()) return false;
  // Resolved from the project dir the board was READ from, never from a cwd.
  const loc = resolveProject(str(projectKey));
  // Unreachable from either live caller; here for a future one that forgets the
  // argument, whose only other symptom is a dispatch silently missing its TASK DIR
  // line — which is why this arm logs rather than returning quietly.
  if (!loc.ok) host.log.error(`no project dir for ${ticket.id} — the dispatch carries no TASK DIR line`);
  const taskDirLine = loc.ok ? ticketTaskDirLineFor(loc.dir, ticket) : '';
  try {
    handle.inject(`[ticket ${ticket.id}] ${taskDirLine}${closeLine(ticket.id)}${str(ticket.spec)}`, { parkable: true });
    return true;
  } catch (e) {
    host.log.error(`could not deliver ${ticket.id} to ${name}`, e);
    return false;
  }
}

/**
 * Open a ticket, minted field for field as session-manager mints it: `parked` is
 * written ONLY when true (a stored `parked: false` is a state core refuses to
 * produce) and `taskDir` only when the spec names one.
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
      // `startedAt` as a legacy record, so one minted without the key files as
      // already STARTED. Stamped rather than null when an assignee is given —
      // delivery happens HERE, and a delivered spec whose record says unstarted is
      // exempt from the stall watchdog for as long as the seat holds it.
      startedAt: who ? now : null,
    };
    const taskDir = extractTaskDir(text);
    if (taskDir) ticket.taskDir = taskDir;
    // `add` WITH an assignee is a dispatch, so it is gated exactly as `assign` is:
    // otherwise a lead refused at assign re-files with the assignee already picked
    // and reaches the state assign just refused. Only WITH one — a backlog `add`
    // delivers nothing and cannot reach the verify-time refusal.
    //
    // The shared predicate makes the DECISION; its SENTENCE must not be reused
    // here. That sentence offers `respec <id>`, and the id above was minted but
    // never filed: `nextTicketId` hands the same id to the next real add, so an
    // operator following it would edit unrelated work. Nothing was written, so
    // there is nothing to respec.
    if (who && !taskDir) {
      const refuses = !!ticketTaskDirRefusal(
        teamIndex().get(str(project)) ? {} : { solo: true }, ticket, 'assign', false);
      // Refused from INSIDE the callback, so mutateBoard returns before the save
      // and `tickets` is discarded unwritten.
      if (refuses) {
        return { error: 'nothing was filed — the spec names no `tasks/…` path on any line, '
          + 'and the review step has nowhere to write its diff. Nothing was changed. '
          + "Fix: add the artifact dir to the spec's first line and file it again." };
      }
    }
    tickets.push(ticket);
    return { result: { id: ticket.id, ticket } };
  });
  if (!res.ok) return res;
  if (who) delivered = deliverSpec(who, res.ticket, project);
  return { ok: true, id: res.id, delivered };
}

/**
 * Title and taskDir are DERIVED, so both are recomputed: leaving either stale makes
 * the summary line and the artifact path describe a spec that no longer exists.
 * `taskDir` is DELETED when the new spec names none — a stale path into another
 * ticket's artifacts is worse than an absence the row knows how to render.
 */
function editSpec(payload) {
  const { project, id, spec } = payload || {};
  const ticketId = str(id);
  const text = str(spec);
  if (!ticketId) return { ok: false, error: 'a ticket id is required' };
  if (!text.trim()) return { ok: false, error: 'a ticket needs a spec' };

  return mutateBoard(project, (tickets) => {
    const t = tickets.find((x) => str(x.id) === ticketId);
    // Editable in any state, unlike the lifecycle verbs: correcting a closed
    // ticket's record is not a lifecycle change.
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
 * Assign or reassign an open ticket. `role` is DELETED, matching core's plain-name
 * assign branch: a stale one makes `shownFor` render the old role over the new
 * assignee, so the board names the wrong holder.
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
    // Core's `_taskAssign` gate: assign is a DISPATCH here, so a ticket the intent
    // verbs refuse must not be dispatchable by clicking. Must stay ABOVE the
    // writes — placed after them it returns this string having already re-pointed
    // the assignee, cleared the park and pushed `lastActivityAt` forward, while
    // promising in words that nothing changed.
    //
    // `reSend` must NOT be widened to `ticketStarted`: a legacy record with no
    // `startedAt` key and no `parked` flag reads as started while owning no seat
    // and no tree, and an assign on it runs the whole job to a verify-time refusal.
    const refusal = ticketTaskDirRefusal(
      teamIndex().get(str(project)) ? {} : { solo: true },
      t, 'assign', !!(t.worktree && t.worktree.path));
    if (refusal) return { error: refusal };
    t.assignee = who;
    t.lastActivityAt = Date.now();
    // The new holder has not been chased, whatever the old one had accrued.
    t.nudgedAt = null;
    delete t.role;
    delete t.parked;
    // Without this an undispatched ticket assigned FROM THE BOARD stays unstarted
    // forever, exempt from both the stall flag above and core's watchdog: a seat
    // holds it, goes quiet for a week, and nothing says so. Not re-stamped when
    // already set — a re-send must not restate when work FIRST started.
    if (!ticketStarted(t)) t.startedAt = t.lastActivityAt;
    return { result: { ticket: t } };
  });
  if (!res.ok) return res;
  return { ok: true, delivered: deliverSpec(who, res.ticket, project) };
}

/**
 * Close an open ticket. One shape across both verbs, differing only in the state —
 * which is what keeps "what got shipped" and "what got dropped" countable apart.
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
 * Live session names the assign picker can offer. Bash sessions are filtered out
 * because they are private — no registry, no socket, not DM-able — so offering one
 * produces an assignment whose spec can never be delivered.
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

  // Deliberately absent from manifest.json's `surfaces`, which is what keeps these
  // desktop-only: a board reachable from a browser is one a browser can close
  // tickets on.
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

// Exported for the test suite, not part of the plugin contract.
module.exports._internals = {
  confine, readTickets, readTicketsAt, readManifest, stallMsFor, shape,
  board, teams, projects, teamsRoot, projectsRoot, teamIndex, projectRootFor,
  clodexHome, projectDirFor, nextTicketId, ticketTitle, extractTaskDir, ticketStarted,
  atomicWriteFileSync, resolveProject, ticketTaskDirRefusal,
  confineOrThrow, confineUnder, stripFileTail, resolveTaskDir,
  taskDirRuleClause, ticketTaskDirLine, ticketTaskDirLineFor,
  add, editSpec, assign, closeTicket, sessions,
  VIEWER_ACTOR, closeLine,
  DEFAULT_STALL_MS, WATCHDOG_MIN_MS, WATCHDOG_MAX_MS, RECENT_DONE_MS, RECENT_DONE_CAP,
  // Overrides the HOME rather than teams/ or projects/, which must move together:
  // repointing only one reads fixture data against the operator's real boards.
  // NOT on the host surface — hostApi is frozen at "1", and a plugin able to ask
  // core where things live is a contract change. Pass null to restore.
  setClodexHomeForTest(dir) {
    if (dir) everOverridden = true;
    clodexHomeOverride = dir || null;
  },
  // Read back so a test can assert WHERE a write would land before making one.
  boardPathForTest(key) { return path.join(projectsRoot(), key, TICKETS_FILE); },
  // `host` is module state, so a test driving the write path without the real
  // plugin host needs a way to stand one in.
  setHostForTest(h) { host = h; },
};
