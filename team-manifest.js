// No clodex resource lives inside project files: a team is defined entirely
// under ~/.clodex/teams/<name>/. Pure leaf — no electron, injected fs.

'use strict';

const path = require('path');
const { ensureDir, atomicWriteFileSync } = require('./fs-util');
const { defaultClodexHome } = require('./clodex-paths');

const TEAM_FILE = 'team.json';
const ROLE_RE = /^[a-zA-Z0-9._-]{1,32}$/;
// Team names and seat names share the session-name grammar (CLAUDE.md): a team
// name is BOTH a directory under ~/.clodex/teams/ AND the `<team>-` seat-name
// prefix, so it must be name-legal; top-level `lead` is a seat name.
const NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;

// Bumped when the role schema loses or gains a key.
const MANIFEST_VERSION = 3;

// Anything else is dropped at load with a warning rather than a throw: a hard
// failure here would read as "no team" everywhere, since every caller resolves
// teams inside a best-effort catch.
const ROLE_KEYS = new Set(['template', 'prompt', 'brief', 'dispatch', 'cwd']);

const ROLE_DISPATCH_VALUES = new Set(['standing', 'spawn', 'worktree']);
const DEFAULT_ROLE_DISPATCH = 'standing';

// The legibility test asserts EDITABLE_ROLE_FIELDS ∪ this ≡ ROLE_KEYS, so a new
// field is either reachable or listed here with a reason — never merely absent.
// Empty is the steady state; do not delete the constant.
const UNREACHABLE_ROLE_FIELDS = new Set([]);

// The fields a version bump deleted. Named rather than derived as "anything not
// in ROLE_KEYS", because the mutators delete these from disk: a derived set would
// grow to include hand-authored keys nobody asked us to remove, and the migration
// would become data loss.
const CUT_ROLE_FIELDS = ['instantiate', 'standing', 'tools', 'type', 'ephemeral', 'worktree'];

// Cut from the schema but sometimes still read, mapped to the remedy a reader
// should write instead. A key belongs here for exactly as long as a compatibility
// branch reads it. Membership is only a gate — it says "this key can be honored,
// so measure whether it was", never "this occurrence is honored". The remedy
// travels with the key so the map cannot grow a member whose advice nobody wrote.
const HONORED_CUT_FIELDS = new Map([['worktree', 'dispatch: "worktree"']]);

// Every role field a front door (setRole, the Add Role form, the popover row
// model) may set.
const EDITABLE_ROLE_FIELDS = ['brief', 'cwd', 'dispatch', 'prompt', 'template'];

// team.json is agent-writable and these role keys are trusted downstream, so the
// mutators below must never create, destroy or rename them; only the operator
// GUI/approval may.
const RESERVED_ROLE_KEYS = new Set(['lead', 'reviewer']);

const WATCHDOG_MIN_MS = 5 * 60 * 1000;
const WATCHDOG_MAX_MS = 7 * 24 * 60 * 60 * 1000;

const STOCK_ROLE_DEFS = {
  lead: { prompt: 'clodex-team-lead', brief: 'team lead; holds durable context, dispatches specs, verifies and integrates the work.' },
  // The hand is the only stock role that names a template, because it is the only
  // one whose seat needs a working directory: the shipped clodex-team-hand.json
  // writes "${TEAM_ROOT}" there, so a new team's hand boots in its own root.
  hand: { prompt: 'clodex-team-hand', brief: 'implementer; executes a spec to done, one distilled report per task.', template: 'clodex-team-hand' },
  reviewer: { prompt: 'clodex-team-reviewer', brief: 'reviewer; an independent verification pass, invoked on demand.' },
};

// A field may live here only if exactly one resolver consumes it and every spawn
// path reaches that resolver — five fields failed that test and were cut.
// Variation belongs in a template, which is data and cheap to vary.
//
// Fixed key order: addRole's no-op check compares JSON.stringify of two
// normalized defs, so reordering these keys breaks equality.
function normalizeRoleDef(roleName, def, file) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw new Error(`role "${roleName}" must be an object (${file})`);
  }
  if (def.template != null && typeof def.template !== 'string') {
    throw new Error(`role "${roleName}" template must be a string (${file})`);
  }
  if (def.prompt != null && typeof def.prompt !== 'string') {
    throw new Error(`role "${roleName}" prompt must be a string (${file})`);
  }
  if (def.brief != null && typeof def.brief !== 'string') {
    throw new Error(`role "${roleName}" brief must be a string (${file})`);
  }
  if (def.dispatch != null && !ROLE_DISPATCH_VALUES.has(def.dispatch)) {
    throw new Error(`role "${roleName}" dispatch must be one of ${[...ROLE_DISPATCH_VALUES].join(', ')} (${file})`);
  }
  if (def.cwd != null && typeof def.cwd !== 'string') {
    throw new Error(`role "${roleName}" cwd must be a string (${file})`);
  }
  return {
    template: def.template ?? null,
    prompt: def.prompt ?? null,
    brief: def.brief ?? null,
    // The v2 `worktree: true` boolean is read here, not merely migrated: migration
    // runs on mutator writes, so a file nobody edits would keep opting a role into
    // a worktree on disk while every dispatch quietly went to a standing seat —
    // silent, because `standing` is a legitimate value nothing warns about.
    // Not honored on a reserved role, matching migrateRoles.
    dispatch: def.dispatch
      ?? ((def.worktree === true && !RESERVED_ROLE_KEYS.has(roleName)) ? 'worktree' : DEFAULT_ROLE_DISPATCH),
    // Relative to team.root: an absolute path would let an agent-writable
    // team.json point a seat at another project, which assertRoleCwd refuses at
    // every write. Blank normalizes to null — path.resolve(root, '') is root, so
    // storing '' would mean exactly what its absence does.
    cwd: (typeof def.cwd === 'string' && def.cwd.trim()) ? def.cwd.trim() : null,
  };
}

// Refused where roles are DEFINED as well as at dispatch time: team.json is
// hand-editable and a file that predates this check must not start minting trees.
// Stated as an inversion — refuses anything that is not `standing` — so a future
// fourth value is refused by default; a check that lists the bad values admits
// every value nobody thought to list.
function assertDispatchAllowed(roleName, def, file) {
  if (!def || typeof def !== 'object') return;
  if (RESERVED_ROLE_KEYS.has(roleName) && def.dispatch != null && def.dispatch !== DEFAULT_ROLE_DISPATCH) {
    throw new Error(`the "${roleName}" role is standing — it cannot dispatch to a worktree or a one-shot spawn seat (got "${def.dispatch}") (${file})`);
  }
}

// Returned rather than warned in place: normalizeRoleDef runs on the write paths
// too, where a drop is the caller's answer, not a console line.
//
// `worktree` is reported here like any other unmodeled key, and must not be
// excluded to spare it the warning: the file would load silently while still
// carrying a key whose meaning lives in a compatibility branch.
function unknownRoleKeys(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return [];
  return Object.keys(def).filter((k) => !ROLE_KEYS.has(k));
}

// Every mutator writes through this: dropping a key only on the way OUT leaves it
// on disk, and `tools: ["Read"]` in team.json is a restriction nothing enforces.
//
// A non-object is returned untouched so a malformed def still reaches the
// validators that throw on it, rather than being laundered into a valid `{}`.
function pickRoleKeys(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return def;
  const out = {};
  for (const [k, v] of Object.entries(def)) {
    // `cwd` is stored trimmed so the bytes on disk are the ones assertRoleCwd
    // validated — it checks the trimmed form, and a stored "  api  " would be a
    // value no gate ever saw. Only this field: `brief`/`prompt` are prose whose
    // surrounding whitespace is the author's.
    if (ROLE_KEYS.has(k)) out[k] = (k === 'cwd' && typeof v === 'string') ? v.trim() : v;
  }
  return out;
}

// One console line per (file, dropped-key-set), for the life of the process.
// loadManifest has no cache and resolveTeam loads every team on every call
// (_sweepTickets runs it every 60s per live seat), so an ungated warn is several
// lines a minute forever for one legacy file.
const warnedDrops = new Set();

function createTeamManifest({ fs, clodexHome } = {}) {
  const home = clodexHome || defaultClodexHome();
  const teamsDir = path.join(home, 'teams');

  // Routed through fs-util's atomicWriteFileSync, not a local write+rename: a
  // bare rename is atomic but not durable, and it fsyncs both the bytes and the
  // directory entry. Deliberately not taken from the injected `fs` — durability
  // is not a seam a caller gets to vary. The dir is still created 0700 first:
  // atomicWriteFileSync's own mkdir carries no mode, and ~/.clodex/teams/<name>/
  // must not widen to the umask default.
  function atomicWrite(file, data) {
    ensureDir(path.dirname(file));
    atomicWriteFileSync(file, data);
  }

  // Run on EVERY mutator write, not conditionally: a conditional stamp could
  // never fire on a real legacy file, since every mutator refuses the reserved
  // roles the v1 scaffold put the stale keys on.
  //
  // Scoped to CUT_ROLE_FIELDS, not ROLE_KEYS: this strips a named set this schema
  // already drops at load, so it changes no read semantics. Keys we simply do not
  // model are hand-authored data and must stay untouched.
  function migrateRoles(raw) {
    const roles = (raw && raw.roles && typeof raw.roles === 'object' && !Array.isArray(raw.roles))
      ? raw.roles : null;
    if (!roles) return raw;
    for (const [roleName, def] of Object.entries(roles)) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
      // Carry-over must run BEFORE the delete loop below: `worktree` is in
      // CUT_ROLE_FIELDS, so reading it afterwards yields undefined and every role
      // that opted into a worktree quietly becomes standing, with no error.
      // Reserved roles are excepted — `worktree: true` on lead/reviewer was
      // already refused at dispatch.
      if (def.worktree === true && def.dispatch == null && !RESERVED_ROLE_KEYS.has(roleName)) {
        def.dispatch = 'worktree';
      }
      for (const k of CUT_ROLE_FIELDS) {
        if (k in def) delete def[k];
      }
      roles[roleName] = def;
    }
    // Still conditional: a hand-authored key outside the cut set is not ours to
    // delete, and a file carrying one has not finished migrating.
    const clean = Object.values(roles).every((d) => unknownRoleKeys(d).length === 0);
    if (clean) raw.version = MANIFEST_VERSION;
    return raw;
  }

  function listTeams() {
    let entries;
    try {
      entries = fs.readdirSync(teamsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  }

  function loadManifest(name) {
    const file = path.join(teamsDir, name, TEAM_FILE);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      throw new Error(`no team manifest at ${file}: ${err.message}`);
    }
    let m;
    try {
      m = JSON.parse(raw);
    } catch (err) {
      throw new Error(`team.json is not valid JSON (${file}): ${err.message}`);
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      throw new Error(`team.json must be an object (${file})`);
    }
    const root = m.root;
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new Error(`team.json "root" must be an absolute path (${file})`);
    }
    // `lead` here is a SEAT name, not a role key; the roles map is keyed by role
    // name and always carries a literal `lead` role.
    const lead = m.lead;
    if (typeof lead !== 'string' || !NAME_RE.test(lead)) {
      throw new Error(`team.json "lead" must be a seat name matching ${NAME_RE} (${file})`);
    }
    const rolesIn = m.roles;
    if (!rolesIn || typeof rolesIn !== 'object' || Array.isArray(rolesIn)) {
      throw new Error(`team.json "roles" must be an object (${file})`);
    }
    if (!('lead' in rolesIn)) {
      throw new Error(`team.json roles must include a "lead" role (${file})`);
    }
    const roles = {};
    // The classification as data, built once and rendered twice: the warn lines
    // below derive from it and formatRoster reads it off the returned manifest.
    // A surface that re-decides `honored` for itself is the drift this prevents.
    //
    //   'unknown' — a key this schema never modelled (version-gated warn)
    //   'ignored' — a retired key that configures nothing
    //   'honored' — retired but still read here, so deleting it changes behaviour
    // 'ignored' and 'honored' may never be merged or rendered in one line: the
    // second's text is the negation of the first's.
    //
    // This rides on the object `team:get` returns, so it crosses into the
    // nodeIntegration renderer. `field` is safe by construction only for the two
    // retired statuses; an 'unknown' field name is an arbitrary agent-authored
    // string out of team.json, so a UI consumer inherits the security rule in
    // renderer/popovers/team-roles-popover.js and a text surface rendering
    // 'unknown' must refuse newlines.
    const droppedFields = [];
    for (const [roleName, def] of Object.entries(rolesIn)) {
      if (!ROLE_RE.test(roleName)) {
        throw new Error(`role name "${roleName}" must match ${ROLE_RE} (${file})`);
      }
      // Partitioned by MEASURED EFFECT, not by key name: honoring is conditional
      // on the value, the role and the absence of an explicit `dispatch`, so a
      // name-only test claims "this still takes effect" where it does not, and
      // the remedy it carries is actively harmful there.
      //
      // Sound because `without` is a subset of `def` and `k` is never in
      // ROLE_KEYS, so no validator that passed on `def` can throw on `without`;
      // and normalizeRoleDef returns a fixed-key-order literal.
      const normalized = normalizeRoleDef(roleName, def, file);
      for (const k of unknownRoleKeys(def)) {
        let honored = false;
        if (HONORED_CUT_FIELDS.has(k)) {
          const without = { ...def };
          delete without[k];
          honored = JSON.stringify(normalizeRoleDef(roleName, without, file)) !== JSON.stringify(normalized);
        }
        // The remedy rides with the occurrence, not the message: one line may
        // name several keys, and a hardcoded "write X instead" is wrong the
        // moment the map holds two entries.
        if (honored) {
          droppedFields.push({
            role: roleName, field: k, status: 'honored', remedy: HONORED_CUT_FIELDS.get(k),
          });
          continue;
        }
        droppedFields.push({
          role: roleName, field: k, remedy: null,
          status: CUT_ROLE_FIELDS.includes(k) ? 'ignored' : 'unknown',
        });
      }
      roles[roleName] = normalized;
    }
    // A rendering of the classification above, never a second pass over the defs:
    // a warn that decides membership for itself is how the console and the roster
    // end up disagreeing about one key.
    const named = (st) => droppedFields
      .filter((d) => d.status === st)
      // Keyed on status, never on `remedy`'s truthiness: an honored member whose
      // remedy came out empty would drop the suffix here while the roster still
      // rendered a bare "write `` instead".
      .map((d) => (d.status === 'honored' ? `${d.role}.${d.field} (write \`${d.remedy}\` instead)` : `${d.role}.${d.field}`));
    const dropped = named('unknown');
    const droppedCut = named('ignored');
    const droppedHonored = named('honored');
    // Absent reads as 1, not as current: defaulting to current would let a stale
    // manifest claim a schema it was never checked against.
    const version = (typeof m.version === 'number' && Number.isInteger(m.version) && m.version > 0)
      ? m.version : 1;
    // Warn, never throw: a manifest that refuses to load reads as "this cwd is on
    // no team" at every call site, so the whole team layer would vanish over a key
    // nothing consumes any more. A current-version file with unknown keys is
    // silent by design — the warn exists for the migration, not as a linter.
    if (dropped.length && version < MANIFEST_VERSION) {
      const seen = `unknown|${file}|${dropped.join(',')}`;
      if (!warnedDrops.has(seen)) {
        warnedDrops.add(seen);
        console.warn(`team "${name}": ignoring role keys this schema no longer models — ${dropped.join(', ')} (${file})`);
      }
    }
    // NOT under the version gate, unlike the unknown-key warn above: a file
    // claiming the current schema while still carrying a retired field would drop
    // it in total silence. The gate's rationale holds for a key this schema never
    // modelled, not for one it deliberately retired.
    //
    // Says IGNORED, not "dropped": the point of the line is that the field
    // changes no behaviour anywhere. It must never reach a key whose removal
    // changed the normalized def — that text would be a lie about a live opt-in.
    if (droppedCut.length) {
      const seen = `cut|${file}|${droppedCut.join(',')}`;
      if (!warnedDrops.has(seen)) {
        warnedDrops.add(seen);
        console.warn(`team "${name}": these role keys are IGNORED — they are retired fields this schema no longer honors, and setting them enforces or configures nothing: ${droppedCut.join(', ')} (${file})`);
      }
    }
    // Ungated for the same reason as the line above, but the opposite message:
    // this key still takes effect, so the only safe edit is a rewrite, not a
    // delete.
    if (droppedHonored.length) {
      const seen = `honored|${file}|${droppedHonored.join(',')}`;
      if (!warnedDrops.has(seen)) {
        warnedDrops.add(seen);
        console.warn(`team "${name}": these role keys are RETIRED but STILL READ — they are not modeled by this schema, yet a compatibility branch honors them HERE, so deleting one CHANGES BEHAVIOUR: ${droppedHonored.join(', ')}; a future schema will stop reading them (${file})`);
      }
    }
    // team.json is agent-writable, so a hand-written watchdogMs is clamped at
    // READ, the choke point every consumer passes. Never throw on a bad value —
    // one bad number must not break the whole team's resolution.
    const rawWatchdog = m.watchdogMs;
    const watchdogMs = (typeof rawWatchdog === 'number' && Number.isFinite(rawWatchdog) && rawWatchdog > 0)
      ? Math.min(WATCHDOG_MAX_MS, Math.max(WATCHDOG_MIN_MS, rawWatchdog))
      : null;
    return { name, root: path.resolve(root), lead, roles, file, watchdogMs, version, droppedFields };
  }

  function containsPath(root, cwd) {
    const rel = path.relative(path.resolve(root), path.resolve(cwd));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  // The write-time gate on a role's `cwd`. Every mutator that can land one on
  // disk runs it: the field flows to create() as a PTY working directory and
  // team.json is agent-writable, so this is a security boundary.
  //
  // Confinement is decided by resolving and comparing (containsPath), never by a
  // prefix match on the raw string: a check for a leading ".." misses
  // `api/../../elsewhere`.
  //
  // Not in normalizeRoleDef, because a LOAD must not throw on these: loadManifest
  // runs inside every caller's best-effort catch, so a hand-edited bad cwd would
  // read as "no team at all" everywhere. On the load path it is neutralized at
  // spawn time instead.
  function assertRoleCwd(roleName, def, root, file) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) return;
    const raw = def.cwd;
    if (raw == null || (typeof raw === 'string' && !raw.trim())) return;
    if (typeof raw !== 'string') {
      throw new Error(`role "${roleName}" cwd must be a string (${file})`);
    }
    const rel = raw.trim();
    // resolveSeatShape is never called with roleKey 'lead', so a cwd here would
    // be inert but believed. Refused at the door, with the reason: the operator
    // can still set that directory when creating the seat.
    if (roleName === 'lead') {
      throw new Error(`role "lead" cannot take a cwd: the lead's seat is not spawned by the team, so its directory is set when the operator creates the seat (${file})`);
    }
    if (path.isAbsolute(rel)) {
      throw new Error(`role "${roleName}" cwd must be RELATIVE to the team root — "${rel}" is absolute, and an absolute cwd could point a seat at another project (${file})`);
    }
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, rel);
    if (!containsPath(resolvedRoot, resolved)) {
      throw new Error(`role "${roleName}" cwd "${rel}" resolves outside the team root ${resolvedRoot} (${file})`);
    }
    // Refused, never created: a seat working in an invented empty directory looks
    // exactly like a seat working correctly.
    let isDir = false;
    try { isDir = fs.statSync(resolved).isDirectory(); } catch { isDir = false; }
    if (!isDir) {
      throw new Error(`role "${roleName}" cwd "${rel}" is not an existing directory under the team root (${resolvedRoot}) — create it first; Clodex never makes it for you (${file})`);
    }
    // Confinement re-decided on the REAL paths: containsPath compares strings, so
    // `cwd: "link"` pointing at another project satisfies it while aiming a PTY
    // out of the tree (statSync follows the link, so the check above passes too).
    // BOTH sides are realpath'd — a project root under /tmp is itself a symlink on
    // macOS, and realpathing only the candidate would refuse every legitimate role
    // cwd there.
    let realRoot = null;
    let realCwd = null;
    try { realRoot = fs.realpathSync(resolvedRoot); } catch { realRoot = null; }
    try { realCwd = fs.realpathSync(resolved); } catch { realCwd = null; }
    if (!realRoot || !realCwd) {
      throw new Error(`role "${roleName}" cwd "${rel}" is not an existing directory under the team root (${resolvedRoot}) — create it first; Clodex never makes it for you (${file})`);
    }
    if (!containsPath(realRoot, realCwd)) {
      throw new Error(`role "${roleName}" cwd "${rel}" resolves outside the team root ${resolvedRoot} — it is a symlink to ${realCwd} (${file})`);
    }
  }

  // The checkout a linked git worktree belongs to, or null. A linked worktree's
  // `.git` is a FILE reading `gitdir: <main>/.git/worktrees/<id>`, so the main
  // checkout is derivable with one read — no `git` subprocess, which is what makes
  // this safe to call from resolveTeam, which runs on every roster render and
  // every ticket resolution.
  const WORKTREE_MARKER = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  function mainCheckoutOf(cwd) {
    let dir = path.resolve(cwd);
    // Bounded: an unbounded walk on a symlink cycle would hang the caller.
    for (let i = 0; i < 64; i++) {
      let raw;
      try {
        const st = fs.lstatSync(path.join(dir, '.git'));
        // A directory `.git` is the main checkout, which containsPath already
        // handled; returning it here would mask a genuine miss.
        if (!st.isFile()) return null;
        raw = fs.readFileSync(path.join(dir, '.git'), 'utf-8');
      } catch {
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
        continue;
      }
      const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(raw);
      if (!m) return null;
      const gitdir = path.resolve(dir, m[1]);
      const at = gitdir.indexOf(WORKTREE_MARKER);
      if (at < 0) return null;   // a `.git` file that is not a linked worktree
      // The marker leads with the separator, so the prefix is exactly the main
      // checkout with no trailing slash to strip.
      return gitdir.slice(0, at);
    }
    return null;
  }

  // Path containment alone silently excludes worktrees: git's default puts one at
  // `<repo>/../<repo>-<branch>`, a SIBLING of the root, so a seat working in one
  // falls off its team entirely — no roster entry, and `_ticketAssigneeSeat`
  // returns null, which surfaces as "no live seat yet".
  function cwdInProject(cwd, root) {
    if (!cwd || !root) return false;
    if (containsPath(root, cwd)) return true;
    const main = mainCheckoutOf(cwd);
    return main ? containsPath(root, main) : false;
  }

  // Deepest root wins: a containing pair is always ancestor/descendant, so the
  // longer resolved root is the descendant. One broken manifest must not throw.
  function resolveTeam(cwd) {
    if (!cwd) return null;
    let best = null;
    for (const name of listTeams()) {
      let m;
      try {
        m = loadManifest(name);
      } catch {
        continue; // broken/invalid team — not a candidate
      }
      if (!cwdInProject(cwd, m.root)) continue;
      if (!best || m.root.length > best.root.length) best = m;
    }
    return best;
  }

  function findProjectRoot(cwd) {
    const team = resolveTeam(cwd);
    return team ? team.root : null;
  }

  function createTeam({ name, root, lead, roles } = {}) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(`team name "${name}" must match ${NAME_RE}`);
    }
    // NAME_RE accepts `.hidden`, but listTeams skips dot-directories — so a
    // dot-named team would be written and then never listed, never resolved for
    // any cwd, while loadManifest still opens it by path. The free-text name field
    // in Create Team… makes that state reachable by typing.
    if (name.startsWith('.')) {
      throw new Error(`team name "${name}" must not start with "." — listTeams skips dot-directories, so the team would be invisible`);
    }
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new Error(`team "${name}" root must be an absolute path`);
    }
    if (typeof lead !== 'string' || !NAME_RE.test(lead)) {
      throw new Error(`team "${name}" lead must be a seat name matching ${NAME_RE}`);
    }
    const file = path.join(teamsDir, name, TEAM_FILE);
    let exists = false;
    try { fs.readFileSync(file, 'utf-8'); exists = true; } catch {}
    if (exists) throw new Error(`team "${name}" already exists`);
    const resolvedRoot = path.resolve(root);
    for (const other of listTeams()) {
      let m;
      try { m = loadManifest(other); } catch { continue; }
      if (m.root === resolvedRoot) {
        throw new Error(`team "${other}" already owns root ${resolvedRoot}`);
      }
    }
    const defaultRoles = {
      lead: { ...STOCK_ROLE_DEFS.lead },
      hand: { ...STOCK_ROLE_DEFS.hand },
      // No `tools` here: the reviewer's cap is REVIEWER_TOOL_CAP in
      // session-manager, the one path that can enforce it. Restating it as data
      // makes a manifest look like an authority it is not.
      reviewer: { ...STOCK_ROLE_DEFS.reviewer },
    };
    const callerRoles = roles && typeof roles === 'object' && !Array.isArray(roles) && Object.keys(roles).length
      ? roles : null;
    // Picked down to the schema: a brand-new file must not be born carrying a
    // field no resolver reads.
    const seedRoles = {};
    for (const [k, v] of Object.entries(callerRoles || defaultRoles)) {
      seedRoles[k] = pickRoleKeys(v);
      // createTeam takes an arbitrary caller `roles` object, so it is a write
      // path too: without this a new file could be born naming lead as a worktree
      // role, which every other door refuses.
      assertDispatchAllowed(k, seedRoles[k], file);
      // Against `resolvedRoot`: there is no manifest to load yet, and this is the
      // root the file is about to name.
      assertRoleCwd(k, seedRoles[k], resolvedRoot, file);
    }
    const manifest = {
      version: MANIFEST_VERSION,
      lead,
      root: resolvedRoot,
      roles: seedRoles,
    };
    atomicWrite(file, JSON.stringify(manifest, null, 2));
    return loadManifest(name);
  }

  function addRole(teamName, roleName, def, opts) {
    const team = loadManifest(teamName); // throws if the team is missing
    const operator = !!(opts && opts.operator === true);
    if (!ROLE_RE.test(roleName)) {
      throw new Error(`role name "${roleName}" must match ${ROLE_RE} (${team.file})`);
    }
    // Re-mints a reserved key the operator removed. `def` is IGNORED, not merged
    // and not validated, so remove-then-re-add gains an attacker nothing. Do not
    // "fix" this into honouring the caller's def; that hands back the bypass.
    //
    // Ahead of the def validation below because a def nobody reads must not be
    // able to refuse the write.
    if (operator && RESERVED_ROLE_KEYS.has(roleName) && !team.roles[roleName]) {
      const stock = STOCK_ROLE_DEFS[roleName];
      if (!stock) {
        throw new Error(`no stock definition ships for the "${roleName}" role (${team.file})`);
      }
      const rawMint = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
      rawMint.roles = rawMint.roles || {};
      rawMint.roles[roleName] = pickRoleKeys({ ...stock });
      // Inert while the stock defs carry only prompt/brief, but this is the one
      // write path that would not otherwise refuse a reserved role paired with
      // `dispatch: "worktree"`.
      assertDispatchAllowed(roleName, rawMint.roles[roleName], team.file);
      // Inert and present for the same reason as the line above: no stock def
      // carries a cwd, and this is the one write path that would not refuse one.
      assertRoleCwd(roleName, rawMint.roles[roleName], team.root, team.file);
      atomicWrite(team.file, JSON.stringify(migrateRoles(rawMint), null, 2));
      return loadManifest(teamName);
    }
    // The legacy key is read on the load path but must never enter through a
    // WRITE: pickRoleKeys drops it and emits no `dispatch`, so an addRole carrying
    // `worktree: true` would store a standing role and answer {ok:true} — the
    // opt-in discarded with no error.
    if (def && typeof def === 'object' && !Array.isArray(def) && 'worktree' in def) {
      throw new Error(`role "${roleName}": "worktree" was replaced by "dispatch" — use dispatch: "worktree" (${team.file})`);
    }
    const normalized = normalizeRoleDef(roleName, def, team.file);
    assertDispatchAllowed(roleName, normalized, team.file);
    assertRoleCwd(roleName, normalized, team.root, team.file);
    if (normalized.template != null && !NAME_RE.test(normalized.template)) {
      throw new Error(`role "${roleName}" template must be a library-template name matching ${NAME_RE} (${team.file})`);
    }
    const existing = team.roles[roleName];
    // Never mint an absent reserved key from a def: loadManifest only requires
    // `lead`, so a hand-deleted `reviewer` could otherwise be re-added with an
    // attacker-authored def. team:join reaches this without the operator opt-in,
    // so it keeps refusing.
    if (RESERVED_ROLE_KEYS.has(roleName) && !existing) {
      throw new Error(`the "${roleName}" role is operator-owned topology; add it via the app, not an intent/mutator (${team.file})`);
    }
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(normalized)) return team; // no-op
      throw new Error(`role "${roleName}" already exists on team "${teamName}" with a different definition`);
    }
    // Re-read raw to preserve hand-authored fields on the OTHER roles. The new
    // role itself goes through pickRoleKeys, not verbatim: `team:addRole` takes an
    // arbitrary def, and a verbatim write lands `tools: ["Read"]` in team.json,
    // where read-back drops it but the file still reads as a policy.
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.roles = raw.roles || {};
    raw.roles[roleName] = pickRoleKeys(def);
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  function setRole(teamName, roleName, patch) {
    const team = loadManifest(teamName); // throws if the team is missing
    if (RESERVED_ROLE_KEYS.has(roleName)) {
      throw new Error(`the "${roleName}" role is operator-owned topology; edit it via the app, not an intent/mutator (${team.file})`);
    }
    if (!team.roles[roleName]) {
      throw new Error(`role "${roleName}" not found on team "${teamName}" — use addRole (${team.file})`);
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error(`setRole patch must be an object (${team.file})`);
    }
    const EDITABLE = EDITABLE_ROLE_FIELDS;
    const clean = {};
    for (const k of EDITABLE) {
      if (k in patch) clean[k] = patch[k];
    }
    // C4: `template` is DESCRIPTIVE-ONLY in this slice — validated as a NAME here
    // and resolved NOWHERE. Any FUTURE consumption MUST resolve NAMED library
    // templates through the normal spawn gate (H3), validated at consume; do NOT
    // wire this field into auto-instantiate without that gate.
    if ('template' in clean && (typeof clean.template !== 'string' || !NAME_RE.test(clean.template))) {
      throw new Error(`role "${roleName}" template must be a library-template name matching ${NAME_RE} (${team.file})`);
    }
    // Validated here as well as in normalizeRoleDef below, in `template`'s shape:
    // the patch is the front door, and a caller that sends a junk value should be
    // refused by the door it knocked on, naming the field it got wrong.
    if ('dispatch' in clean && !ROLE_DISPATCH_VALUES.has(clean.dispatch)) {
      throw new Error(`role "${roleName}" dispatch must be one of ${[...ROLE_DISPATCH_VALUES].join(', ')} (${team.file})`);
    }
    // Validated on `clean` (the patch), not on the merged def below: the merge
    // preserves an EXISTING cwd that a stale/foreign check could re-refuse, and
    // the caller must be told about the value THEY sent. setRole cannot reach
    // `lead` at all (RESERVED_ROLE_KEYS refuses above), so D3's refusal is
    // structural here rather than restated.
    //
    // Gated on CHANGE, not on presence: the popover's save patch always carries
    // `cwd`, so re-validating an unchanged value makes an unrelated edit (the
    // brief) fail once that directory is deleted — and the operator then cannot
    // fix the brief without also clearing a cwd they never touched. A value
    // already on disk is not a new grant (dropping the key from the patch would
    // preserve it regardless), and it is still refused the moment it CHANGES; a
    // bad one already stored is neutralized at spawn time with a reported
    // fallback, which is the same treatment a hand-edited manifest gets.
    const storedCwd = typeof team.roles[roleName].cwd === 'string' ? team.roles[roleName].cwd : '';
    const patchCwd = typeof clean.cwd === 'string' ? clean.cwd.trim() : null;
    if ('cwd' in clean && !(patchCwd !== null && patchCwd === storedCwd)) {
      assertRoleCwd(roleName, clean, team.root, team.file);
    }
    // Trimmed AFTER the gate, for the same reason pickRoleKeys trims: this write
    // does not go through pickRoleKeys, so without this the merge below lands the
    // untrimmed bytes that assertRoleCwd never saw.
    if (typeof clean.cwd === 'string') clean.cwd = clean.cwd.trim();
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.roles = raw.roles || {};
    // NOT picked down to the schema, unlike addRole's new role: this write
    // preserves an EXISTING role's hand-authored keys (pinned below), and `clean`
    // is already EDITABLE-only, so no cut field can enter here. The cut fields
    // that are already on disk leave via migrateRoles, which names them.
    raw.roles[roleName] = { ...raw.roles[roleName], ...clean };
    // A blank cwd is a CLEAR, and it deletes the key rather than storing '': the
    // popover's text input sends '' for "no cwd", and path.resolve(root, '') is
    // the root — so an empty string on disk would be a value meaning exactly what
    // its absence means, which is the state migrateRoles exists to keep out.
    // Unlike `template`, blank is reachable and legitimate here (there is a
    // clear-cwd semantic); unlike `brief`, '' is not a displayable value.
    if ('cwd' in clean && !String(clean.cwd == null ? '' : clean.cwd).trim()) {
      delete raw.roles[roleName].cwd;
    }
    normalizeRoleDef(roleName, raw.roles[roleName], team.file);
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  // `opts.operator` is the RENDERER's opt-in (team:removeRole — Bogdan clicking),
  // and nothing else passes it: the `[agent:team role-rm]` intent calls this with
  // two args, so an agent still gets the refusal below verbatim, which is what
  // makes its "remove it via the app" literally true rather than aspirational.
  function removeRole(teamName, roleName, opts) {
    const team = loadManifest(teamName);
    const operator = !!(opts && opts.operator === true);
    // `lead` is non-removable for EVERYONE, operator included, and needs its own
    // reason: loadManifest hard-requires the key and throws without it, while
    // every caller resolves teams in a best-effort catch — so a team that lost
    // its lead would not report a missing role, it would read as "no team at
    // all" everywhere at once, with no surface left that could add it back.
    if (roleName === 'lead') {
      throw new Error(`the "lead" role cannot be removed: a team.json without it fails to load, and the team would read as missing everywhere (${team.file})`);
    }
    if (RESERVED_ROLE_KEYS.has(roleName) && !operator) {
      throw new Error(`the "${roleName}" role is operator-owned topology; remove it via the app, not an intent/mutator (${team.file})`);
    }
    if (!team.roles[roleName]) {
      throw new Error(`role "${roleName}" not found on team "${teamName}" (${team.file})`);
    }
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    if (raw.roles) delete raw.roles[roleName];
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  function renameRole(teamName, fromName, toName) {
    const team = loadManifest(teamName);
    if (RESERVED_ROLE_KEYS.has(fromName) || RESERVED_ROLE_KEYS.has(toName)) {
      throw new Error(`the "lead"/"reviewer" roles are operator-owned topology and cannot be renamed (${team.file})`);
    }
    if (!ROLE_RE.test(toName)) {
      throw new Error(`role name "${toName}" must match ${ROLE_RE} (${team.file})`);
    }
    if (!team.roles[fromName]) {
      throw new Error(`role "${fromName}" not found on team "${teamName}" (${team.file})`);
    }
    if (team.roles[toName]) {
      throw new Error(`role "${toName}" already exists on team "${teamName}" (${team.file})`);
    }
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.roles = raw.roles || {};
    raw.roles[toName] = raw.roles[fromName];
    delete raw.roles[fromName];
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  // The team's lead SEAT — a top-level pointer, NOT the `lead` role. The role is
  // reserved (RESERVED_ROLE_KEYS) and stays locked; this only re-points which
  // seat fills it, so the two must not be conflated: setRole('lead') still
  // throws, and this never touches raw.roles.
  //
  // Reassignment is a POINTER change and nothing more — tickets and roster lines
  // follow it immediately, and the new seat inherits none of the old one's
  // context. Any "hand over the lead's state" semantics would have to live
  // somewhere else; this cannot lose anything precisely because it moves nothing.
  //
  // A seat that is not running is ACCEPTED on purpose: every team is in that
  // state whenever its lead is stopped, and the record restarts by name. Only
  // the charset is gated (NAME_RE, the same regex createTeam validates `lead`
  // with) — an existence check here would refuse the legitimate stopped case.
  function setLead(teamName, seatName) {
    const team = loadManifest(teamName); // throws if the team is missing
    if (typeof seatName !== 'string' || !NAME_RE.test(seatName)) {
      throw new Error(`team "${teamName}" lead must be a seat name matching ${NAME_RE} (${team.file})`);
    }
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.lead = seatName;
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  function setTeamWatchdog(teamName, ms) {
    const team = loadManifest(teamName); // throws if the team is missing
    if (ms != null && (typeof ms !== 'number' || !Number.isFinite(ms))) {
      throw new Error(`watchdogMs must be a finite number or null (${team.file})`);
    }
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    if (ms == null) delete raw.watchdogMs;
    else raw.watchdogMs = ms;
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  return {
    resolveTeam, findProjectRoot, loadManifest, listTeams, cwdInProject,
    createTeam, addRole, setRole, removeRole, renameRole, setTeamWatchdog, setLead,
    teamsDir, TEAM_FILE,
  };
}

// Seat name → role. Two forms answer: the lead SEAT, and `<team>-<role>` with an
// optional numeric collision suffix.
//
// THE SUFFIX IS NOT ONLY `-N` (F008). The old strip was `/-\d+$/` — a hyphen
// REQUIRED before the digits — so `shop-hand2` derived the key `hand2`, matched
// no role, and resolved to null. That is not cosmetic: every team verb resolves
// its target through this function, so an unresolved seat cannot be ticketed and
// cannot be retired, and `_roleInUse` (session-manager.js) — a guard built to
// fail CLOSED — does not see the seat filling the role it is about to let you
// remove. The numbered form is the obvious way to make several seats of one
// role, which is exactly why it must not be the form that silently fails.
//
// EXACT MATCH WINS, before any stripping: a role may legitimately be named with
// a trailing digit (`hand2`), and a seat named for it must resolve to it rather
// than to `hand`. The old code had the same hazard for a role named `hand-2`.
//
// Only DIGIT suffixes strip. `shop-hand-wire` still resolves to nothing unless a
// role of that name exists — a non-numeric tail names a different thing, and
// waving it through to `hand` would make role resolution guess.
//
// `-rN` is the ONE lettered tail that strips, and only ahead of the numeric one:
// a ticket's reviewer is named `<team>-reviewer-<ticket>-r<round>` so a watchdog
// can address one review rather than whoever holds a recycled counter name. Both
// tails must go or the key keeps the ticket number. This is a round, not a
// second numbering scheme for collisions — the constraint at _mintTicketSeat
// (session-manager.js) still holds, and a name this cannot decompose resolves to
// no role at all: off the roster, no role prompt, and past the fail-CLOSED
// _roleInUse guard.
function matchSeatRole(team, seatName) {
  if (!team || !seatName || !team.roles) return null;
  if (seatName === team.lead) return 'lead' in team.roles ? 'lead' : null;
  const prefix = `${team.name}-`;
  if (!seatName.startsWith(prefix)) return null;
  // hasOwnProperty, not `in`: `in` walks the prototype, so a seat named
  // `<team>-toString` would otherwise "resolve" to a role that is Object's
  // method. The old code had this on its single lookup; adding a second lookup
  // without fixing it would have widened it.
  const has = (k) => Object.prototype.hasOwnProperty.call(team.roles, k);
  const suffix = seatName.slice(prefix.length);
  if (has(suffix)) return suffix;
  const key = suffix.replace(/-r\d+$/, '').replace(/[-_]?\d+$/, '');
  return key && has(key) ? key : null;
}

// The exec runner requires a payload on every call and this schema requires
// both keys (resources/library/exec/clodex-team.json), so the bare word
// `roster` bounces. Rendered concrete, with the reader's own name, so the line
// can be copied rather than reconstructed.
function rosterExecPayload(seatName) {
  // Serialized, not interpolated: a seat name reaching here unvalidated would
  // otherwise be able to break the JSON, and this pure leaf cannot see the
  // caller's name grammar to know it never does.
  return `[agent:exec clodex-team] ${JSON.stringify({ action: 'roster', agent: seatName || '<your name>' })}`;
}

// Per-role invariants ONLY — the roster listing must stay OUT: composition
// changes over a seat's life and this text is part of the cache-stable system
// prompt. Live composition arrives as data.
//
// The OUTPUT must not carry the seat name, only the role `seatName` resolves
// to, so same-role seats share this text verbatim. Scope of that,
// measured rather than assumed: for a seat whose role prompt rides
// --system-prompt-file (every ticket seat — session-manager's
// `promptRidesAsSystem` skips the append) this block is the TAIL of the append
// channel, so ~180 bytes are all there is to share and nothing trails it.
// Where that append is NOT skipped, the concatenation strands the whole
// role prompt behind a varying token instead. Worth doing for the
// invariant, not for a KB-scale saving.
//
// The name is already conversation content — cli-hooks.js's SessionStart
// additionalContext leads with it and re-fires on clear AND compact — and the
// concrete copyable roster invocation is the hook roster's own
// `Ground truth on demand:` line.
function formatTeamBlock(team, seatName) {
  const mine = matchSeatRole(team, seatName);
  const yourRole = mine || 'none — not a manifest role';
  return [
    '# Team',
    `You are on team ${team.name} (root ${team.root}). Your role: ${yourRole}.`,
    `Team composition arrives in your context. Ground truth on demand: ${rosterExecPayload(null)}`,
  ].join('\n');
}

// How the lead reaches each class of role. Derived from the manifest rather
// than stored on the def: reachability is a consequence of the reserved
// `reviewer` key plus the code that routes the spawn, and a stored copy would
// drift from it — which is exactly what the deleted `instantiate` field did.
function leadActionLine(team) {
  const sessionRoles = [];
  let hasReviewer = false;
  for (const role of Object.keys(team.roles || {})) {
    // `team.lead` is a SEAT name, not a role key — comparing against it here
    // would drop an unrelated role from a team whose lead seat happens to
    // share its name.
    if (role === 'lead') continue;
    if (role === 'reviewer') { hasReviewer = true; continue; }
    // Every non-reserved role is staffable: a ticket assigned to it spawns a
    // seat. There is no boolean gate any more.
    sessionRoles.push(role);
  }
  const parts = [];
  // The "Dispatch:" prefix is the token three roster tests assert the ABSENCE of
  // for a non-lead seat. Rewording the line without it defangs all three silently.
  if (sessionRoles.length) parts.push('Dispatch: TWO steps. [agent:task add <role>] <spec> writes the ticket and starts NOTHING, then [agent:task start <id>] mints its tree and seat and delivers the spec. A "do not start" line in the body is NOT read by anything — an unstarted ticket is simply one you have not started.');
  // Spells out that the intent does the spawning. A lead reading "Review:
  // [agent:team-review]" next to a roster line that said `reviewer (subagent)`
  // reached for its harness subagent tool instead — which gets a reviewer with
  // no tools cap, no verdict intent, and no seat the operator can see.
  if (hasReviewer) parts.push('Review: [agent:team-review] <scope> — the intent spawns the cold reviewer seat itself; do NOT spawn or subagent one by hand.');
  if (sessionRoles.length) {
    parts.push(`New session seat: [agent:spawn name:${team.name}-<role> template:<tmpl>].`);
  }
  return parts.length ? parts.join(' ') : null;
}

// The retired keys a role carries, as the lines to print UNDER its roster row.
// Reads loadManifest's classification; decides nothing about membership itself.
//
// A CONTINUATION line rather than a column, because the roster row is already
// dense and this must never push `tmpl`/brief/live off the end — and because a
// role with a clean def then renders byte-identically to before by construction,
// not by a formatting coincidence someone can break.
//
// The two statuses never share a line: 'ignored' says the field configures
// nothing, 'honored' says deleting it changes behaviour. One sentence covering
// both would repeat, in the surface the lead actually reads, the exact falsehood
// that made `reviewer.tools` read as a tool cap. 'unknown' is rendered by
// NEITHER: that warn is version-gated because it exists for the migration and
// not as a linter, and a hand-added key on today's schema has no business
// appearing in every context reset forever. That exclusion also happens to be
// what keeps this text SAFE: an 'unknown' field name is an arbitrary
// agent-authored string from team.json, this roster is baked into the digest
// re-read on every context reset, and the intent parser is `^`-anchored — so a
// key carrying a newline and a column-1 verb would fire in the lead's context.
// Every byte rendered here comes from ROLE_RE-constrained role names and the two
// fixed field lists. A surface that decides to render 'unknown' must refuse
// newlines first.
function retiredFieldLines(team, role) {
  const all = Array.isArray(team && team.droppedFields) ? team.droppedFields : [];
  const mine = all.filter((d) => d && d.role === role);
  const lines = [];
  const inert = mine.filter((d) => d.status === 'ignored').map((d) => d.field);
  if (inert.length) {
    lines.push(`  retired, configures nothing: ${inert.map((f) => `${role}.${f}`).join(', ')} — this schema does not read ${inert.length > 1 ? 'them' : 'it'}`);
  }
  for (const d of mine.filter((x) => x.status === 'honored')) {
    // Per occurrence, not folded: the remedy is per-key (HONORED_CUT_FIELDS maps
    // each to its own replacement), so a joined line would carry one key's advice
    // over another key's occurrence.
    lines.push(`  retired but STILL READ here: ${role}.${d.field} — deleting it CHANGES BEHAVIOUR; write \`${d.remedy}\` instead`);
  }
  return lines;
}

/**
 * `liveSeats` entries are `{ name, label }`; bare strings are accepted as a
 * label-less form. The label is never computed here — team-manifest is a pure
 * leaf and warmth is a wire-layer property, so it arrives as data from
 * session-manager's peerStatusLabel.
 */
function formatRoster(team, liveSeats = [], { seat = null } = {}) {
  const byRole = new Map();
  const roleless = [];
  for (const entry of liveSeats) {
    const name = typeof entry === 'string' ? entry : (entry && entry.name);
    if (!name) continue;
    const label = typeof entry === 'string' ? null : (entry && entry.label) || null;
    // The reading seat knows its own warmth; `(you)` is the useful thing to
    // say in that slot instead.
    const suffix = name === seat ? ' (you)' : (label ? ` (${label})` : '');
    const role = matchSeatRole(team, name);
    if (!role) { roleless.push(`${name}${suffix}`); continue; }
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(`${name}${suffix}`);
  }
  const lines = [`[team ${team.name}] roster (lead: ${team.lead})`];
  for (const [role, def] of Object.entries(team.roles)) {
    // `reviewer` is a reserved key reached by [agent:team-review]. Name the
    // intent ONLY to the seat allowed to use it: _handleTeamReview bounces a
    // non-lead, so advertising it to a hand invites a wasted turn. Every other
    // role is reached the same way — a ticket assigned to it — so the row says
    // so instead of printing a class that used to lie.
    const cls = role !== 'reviewer' ? 'session'
      : (seat && seat === team.lead ? 'via [agent:team-review]' : 'lead-only');
    // Suppressed on the reviewer: [agent:team-review] resolves the template
    // itself, so printing one invites the hand-spawn the row exists to prevent.
    const tmpl = (role !== 'reviewer' && def && typeof def.template === 'string' && def.template) ? `, tmpl ${def.template}` : '';
    const brief = def && def.brief ? ` — ${def.brief}` : '';
    // Liveness is STATED in this slot, never left to be inferred from a missing
    // tail: a definition row and a live row were otherwise identical in shape,
    // and a reader scanning for teammates read the role key as an addressable
    // name and dm'd a seat that did not exist. The two branches are mutually
    // exclusive text in one position, so absence of evidence can't read as a
    // teammate. Wording tracks formatCompositionDelta's `(no seat)`.
    const live = byRole.get(role);
    const liveStr = live && live.length
      ? ` · live: ${live.join(', ')}`
      : ' · no live seat — role definition only, not addressable';
    lines.push(`- ${role} (${cls}${tmpl})${brief}${liveStr}`);
    // Under the row it belongs to, so the field is read while the reader is
    // reasoning about THAT role — a footnote at the bottom is read after the
    // decision it exists to change.
    for (const l of retiredFieldLines(team, role)) lines.push(l);
  }
  // A live seat off the naming convention is still warm and still DM-able;
  // dropping it defeats the point of a listing of who is live.
  if (roleless.length) lines.push(`also live, no role: ${roleless.join(', ')}`);
  if (seat && seat === team.lead) {
    const action = leadActionLine(team);
    if (action) lines.push(action);
  }
  lines.push(`Ground truth on demand: ${rosterExecPayload(seat)}`);
  return lines.join('\n');
}

function formatCompositionDelta(teamName, verb, { seat = null, role = null } = {}) {
  if (verb === 'added') return `[team ${teamName}] role ${role} added (no seat)`;
  return `[team ${teamName}] seat ${seat} ${verb}${role ? ` (role: ${role})` : ''}`;
}

module.exports = {
  createTeamManifest, matchSeatRole, formatTeamBlock, formatRoster,
  formatCompositionDelta, STOCK_ROLE_DEFS, TEAM_FILE,
  // Exported so the retired-field warn test iterates the REAL list — a copy in
  // the test would keep passing over a field added here and never warned about.
  ROLE_KEYS, CUT_ROLE_FIELDS, HONORED_CUT_FIELDS, EDITABLE_ROLE_FIELDS, UNREACHABLE_ROLE_FIELDS, MANIFEST_VERSION,
  ROLE_DISPATCH_VALUES, DEFAULT_ROLE_DISPATCH,
};
