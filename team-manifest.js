// Pure leaf — no electron, injected fs.

'use strict';

const path = require('path');
const { ensureDir, atomicWriteFileSync } = require('./fs-util');
const { defaultClodexHome } = require('./clodex-paths');

const TEAM_FILE = 'team.json';
const ROLE_RE = /^[a-zA-Z0-9._-]{1,32}$/;
// A team name is BOTH a directory name AND the `<team>-` seat-name prefix, so it
// must satisfy the session-name grammar (CLAUDE.md).
const NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;

const MANIFEST_VERSION = 3;

// Unmodeled keys are dropped at load with a warning, never a throw: every caller
// resolves teams inside a best-effort catch, so a throw reads as "no team".
const ROLE_KEYS = new Set(['template', 'prompt', 'brief', 'dispatch', 'cwd']);

const ROLE_DISPATCH_VALUES = new Set(['standing', 'spawn', 'worktree']);
const DEFAULT_ROLE_DISPATCH = 'standing';

// The legibility test asserts EDITABLE_ROLE_FIELDS ∪ this ≡ ROLE_KEYS, so a new
// field is either reachable or listed here. Empty is the steady state; do not
// delete the constant.
const UNREACHABLE_ROLE_FIELDS = new Set([]);

// Named rather than derived as "anything not in ROLE_KEYS": the mutators DELETE
// these from disk, so a derived set would swallow hand-authored keys and the
// migration would become data loss.
const CUT_ROLE_FIELDS = ['instantiate', 'standing', 'tools', 'type', 'ephemeral', 'worktree'];

// Membership is only a gate — "this key can be honored, so measure whether it
// was", never "this occurrence is honored".
const HONORED_CUT_FIELDS = new Map([['worktree', 'dispatch: "worktree"']]);

const EDITABLE_ROLE_FIELDS = ['brief', 'cwd', 'dispatch', 'prompt', 'template'];

// team.json is agent-writable and these keys are trusted downstream: the mutators
// must never create, destroy or rename them.
const RESERVED_ROLE_KEYS = new Set(['lead', 'reviewer']);

const WATCHDOG_MIN_MS = 5 * 60 * 1000;
const WATCHDOG_MAX_MS = 7 * 24 * 60 * 60 * 1000;

const STOCK_ROLE_DEFS = {
  lead: { prompt: 'clodex-team-lead', brief: 'team lead; holds durable context, dispatches specs, verifies and integrates the work.' },
  // The template is what gives the hand's seat a working directory: the shipped
  // clodex-team-hand.json writes "${TEAM_ROOT}", so a new team's hand boots in
  // its own root, not the project the template was authored against.
  hand: { prompt: 'clodex-team-hand', brief: 'implementer; executes a spec to done, one distilled report per task.', template: 'clodex-team-hand' },
  reviewer: { prompt: 'clodex-team-reviewer', brief: 'reviewer; an independent verification pass, invoked on demand.' },
};

// A field may live here only if exactly one resolver consumes it and every spawn
// path reaches that resolver; variation belongs in a template.
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
    // The v2 `worktree: true` boolean is READ here, not merely migrated: migration
    // runs on mutator writes, so a file nobody edits would keep opting a role into
    // a worktree on disk while every dispatch silently went to a standing seat.
    dispatch: def.dispatch
      ?? ((def.worktree === true && !RESERVED_ROLE_KEYS.has(roleName)) ? 'worktree' : DEFAULT_ROLE_DISPATCH),
    // Relative to team.root: an absolute path would let an agent-writable
    // team.json point a seat at another project. Blank normalizes to null —
    // path.resolve(root, '') is root, so '' would mean what its absence means.
    cwd: (typeof def.cwd === 'string' && def.cwd.trim()) ? def.cwd.trim() : null,
  };
}

// Refused where roles are DEFINED as well as at dispatch: team.json is
// hand-editable. Stated as an inversion so a future fourth value is refused by
// default; a check that lists the bad values admits every value nobody listed.
function assertDispatchAllowed(roleName, def, file) {
  if (!def || typeof def !== 'object') return;
  if (RESERVED_ROLE_KEYS.has(roleName) && def.dispatch != null && def.dispatch !== DEFAULT_ROLE_DISPATCH) {
    throw new Error(`the "${roleName}" role is standing — it cannot dispatch to a worktree or a one-shot spawn seat (got "${def.dispatch}") (${file})`);
  }
}

// Returned rather than warned in place: normalizeRoleDef runs on the write paths
// too, where a drop is the caller's answer, not a console line.
function unknownRoleKeys(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return [];
  return Object.keys(def).filter((k) => !ROLE_KEYS.has(k));
}

// Every mutator writes through this: dropping a key only on the way OUT leaves it
// on disk, where `tools: ["Read"]` reads as a restriction nothing enforces. A
// non-object passes through untouched so a malformed def still reaches the
// validators that throw on it, rather than being laundered into a valid `{}`.
function pickRoleKeys(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return def;
  const out = {};
  for (const [k, v] of Object.entries(def)) {
    // Trimmed so the bytes on disk are the ones assertRoleCwd validated, which
    // checks the trimmed form. Only this field: `brief`/`prompt` are prose whose
    // whitespace is the author's.
    if (ROLE_KEYS.has(k)) out[k] = (k === 'cwd' && typeof v === 'string') ? v.trim() : v;
  }
  return out;
}

// One console line per (file, dropped-key-set), for the life of the process:
// resolveTeam loads every team on every call and _sweepTickets runs it every 60s
// per live seat, so an ungated warn is several lines a minute forever.
const warnedDrops = new Set();

function createTeamManifest({ fs, clodexHome } = {}) {
  const home = clodexHome || defaultClodexHome();
  const teamsDir = path.join(home, 'teams');

  // fs-util's atomicWriteFileSync, not a local write+rename: a bare rename is
  // atomic but not durable, and it fsyncs the bytes and the directory entry. Not
  // taken from the injected `fs` — durability is not a seam a caller may vary.
  // ensureDir stays: atomicWriteFileSync's own mkdir carries no mode, and
  // ~/.clodex/teams/<name>/ must not widen to the umask default.
  function atomicWrite(file, data) {
    ensureDir(path.dirname(file));
    atomicWriteFileSync(file, data);
  }

  // Run on EVERY mutator write, not conditionally: a conditional stamp could
  // never fire on a legacy file, since every mutator refuses the reserved roles
  // the v1 scaffold put the stale keys on. Scoped to CUT_ROLE_FIELDS, not
  // ROLE_KEYS: keys we do not model are hand-authored data and stay untouched.
  function migrateRoles(raw) {
    const roles = (raw && raw.roles && typeof raw.roles === 'object' && !Array.isArray(raw.roles))
      ? raw.roles : null;
    if (!roles) return raw;
    for (const [roleName, def] of Object.entries(roles)) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
      // Must run BEFORE the delete loop: `worktree` is in CUT_ROLE_FIELDS, so
      // reading it afterwards yields undefined and every role that opted into a
      // worktree silently becomes standing, with no error anywhere.
      if (def.worktree === true && def.dispatch == null && !RESERVED_ROLE_KEYS.has(roleName)) {
        def.dispatch = 'worktree';
      }
      for (const k of CUT_ROLE_FIELDS) {
        if (k in def) delete def[k];
      }
      roles[roleName] = def;
    }
    // Conditional: a hand-authored key outside the cut set is not ours to delete,
    // and a file carrying one has not finished migrating.
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
    // Built once and rendered twice — the warns below and formatRoster both read
    // it; a surface that re-decides `honored` for itself is the drift this
    // prevents. 'ignored' and 'honored' may never be merged into one line: the
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
      // on the value and the role, so a name-only test claims "this still takes
      // effect" where it does not, and the remedy it carries is harmful there.
      // Sound because `without` is a subset of `def` and `k` is never in
      // ROLE_KEYS, so no validator that passed on `def` can throw on `without`.
      const normalized = normalizeRoleDef(roleName, def, file);
      for (const k of unknownRoleKeys(def)) {
        let honored = false;
        if (HONORED_CUT_FIELDS.has(k)) {
          const without = { ...def };
          delete without[k];
          honored = JSON.stringify(normalizeRoleDef(roleName, without, file)) !== JSON.stringify(normalized);
        }
        // Per occurrence: one line may name several keys, so a hardcoded
        // "write X instead" is wrong once the map holds two entries.
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
    const named = (st) => droppedFields
      .filter((d) => d.status === st)
      // Keyed on status, never on `remedy`'s truthiness: an empty remedy would
      // drop the suffix here while the roster rendered a bare "write `` instead".
      .map((d) => (d.status === 'honored' ? `${d.role}.${d.field} (write \`${d.remedy}\` instead)` : `${d.role}.${d.field}`));
    const dropped = named('unknown');
    const droppedCut = named('ignored');
    const droppedHonored = named('honored');
    // Absent reads as 1: defaulting to current would let a stale manifest claim a
    // schema it was never checked against.
    const version = (typeof m.version === 'number' && Number.isInteger(m.version) && m.version > 0)
      ? m.version : 1;
    // Warn, never throw: a manifest that refuses to load reads as "this cwd is on
    // no team" at every call site. Version-gated: this is for the migration, not
    // a linter.
    if (dropped.length && version < MANIFEST_VERSION) {
      const seen = `unknown|${file}|${dropped.join(',')}`;
      if (!warnedDrops.has(seen)) {
        warnedDrops.add(seen);
        console.warn(`team "${name}": ignoring role keys this schema no longer models — ${dropped.join(', ')} (${file})`);
      }
    }
    // NOT under the version gate, unlike the warn above: a file claiming the
    // current schema while carrying a retired field would drop it in silence.
    if (droppedCut.length) {
      const seen = `cut|${file}|${droppedCut.join(',')}`;
      if (!warnedDrops.has(seen)) {
        warnedDrops.add(seen);
        console.warn(`team "${name}": these role keys are IGNORED — they are retired fields this schema no longer honors, and setting them enforces or configures nothing: ${droppedCut.join(', ')} (${file})`);
      }
    }
    // Ungated like the line above, but the opposite message: this key still takes
    // effect, so the only safe edit is a rewrite, not a delete.
    if (droppedHonored.length) {
      const seen = `honored|${file}|${droppedHonored.join(',')}`;
      if (!warnedDrops.has(seen)) {
        warnedDrops.add(seen);
        console.warn(`team "${name}": these role keys are RETIRED but STILL READ — they are not modeled by this schema, yet a compatibility branch honors them HERE, so deleting one CHANGES BEHAVIOUR: ${droppedHonored.join(', ')}; a future schema will stop reading them (${file})`);
      }
    }
    // Clamped at READ, the choke point every consumer passes, since team.json is
    // agent-writable. Never throw: one bad number must not break the whole team.
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

  // A security boundary: `cwd` flows to create() as a PTY working directory and
  // team.json is agent-writable. Confinement is decided by resolving and
  // comparing (containsPath), never a prefix match — a check for a leading ".."
  // misses `api/../../elsewhere`. Not in normalizeRoleDef, because a LOAD must
  // not throw: loadManifest runs inside every caller's best-effort catch.
  function assertRoleCwd(roleName, def, root, file) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) return;
    const raw = def.cwd;
    if (raw == null || (typeof raw === 'string' && !raw.trim())) return;
    if (typeof raw !== 'string') {
      throw new Error(`role "${roleName}" cwd must be a string (${file})`);
    }
    const rel = raw.trim();
    // resolveSeatShape is never called with roleKey 'lead', so a cwd here is inert
    // but believed.
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
    // Refused, never created: a seat in an invented empty directory looks exactly
    // like one working correctly.
    let isDir = false;
    try { isDir = fs.statSync(resolved).isDirectory(); } catch { isDir = false; }
    if (!isDir) {
      throw new Error(`role "${roleName}" cwd "${rel}" is not an existing directory under the team root (${resolvedRoot}) — create it first; Clodex never makes it for you (${file})`);
    }
    // Re-decided on the REAL paths: containsPath compares strings, so `cwd: "link"`
    // pointing at another project satisfies it while aiming a PTY out of the tree.
    // BOTH sides are realpath'd — a project root under /tmp is itself a symlink on
    // macOS, so realpathing only the candidate refuses every legitimate role cwd.
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

  // A linked worktree's `.git` is a FILE reading `gitdir: <main>/.git/worktrees/
  // <id>`, so one read derives the main checkout. No `git` subprocess: resolveTeam
  // runs on every roster render and every ticket resolution.
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

  // Path containment alone excludes worktrees: git's default puts one at
  // `<repo>/../<repo>-<branch>`, a SIBLING of the root, so a seat working in one
  // falls off its team — no roster entry, and `_ticketAssigneeSeat` returns null.
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
    // any cwd, while loadManifest still opens it by path.
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
      // session-manager, the one path that can enforce it.
      reviewer: { ...STOCK_ROLE_DEFS.reviewer },
    };
    const callerRoles = roles && typeof roles === 'object' && !Array.isArray(roles) && Object.keys(roles).length
      ? roles : null;
    const seedRoles = {};
    for (const [k, v] of Object.entries(callerRoles || defaultRoles)) {
      seedRoles[k] = pickRoleKeys(v);
      // createTeam takes an arbitrary caller `roles` object, so it is a write path
      // too: without this a new file could be born naming lead a worktree role.
      assertDispatchAllowed(k, seedRoles[k], file);
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
    // `def` is IGNORED, not merged and not validated, so remove-then-re-add gains
    // an attacker nothing. Do not "fix" this into honouring the caller's def; that
    // hands back the bypass. Ahead of the def validation below, so a def nobody
    // reads cannot refuse the write.
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
      assertRoleCwd(roleName, rawMint.roles[roleName], team.root, team.file);
      atomicWrite(team.file, JSON.stringify(migrateRoles(rawMint), null, 2));
      return loadManifest(teamName);
    }
    // Read on the load path, but must never enter through a WRITE: pickRoleKeys
    // drops it and emits no `dispatch`, so an addRole carrying `worktree: true`
    // would store a standing role and answer {ok:true}.
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
    // attacker-authored def.
    if (RESERVED_ROLE_KEYS.has(roleName) && !existing) {
      throw new Error(`the "${roleName}" role is operator-owned topology; add it via the app, not an intent/mutator (${team.file})`);
    }
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(normalized)) return team; // no-op
      throw new Error(`role "${roleName}" already exists on team "${teamName}" with a different definition`);
    }
    // Re-read raw to preserve hand-authored fields on the OTHER roles. The new
    // role goes through pickRoleKeys, not verbatim: a verbatim write lands
    // `tools: ["Read"]` on disk, where read-back drops it but the file reads as
    // a policy.
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
    // `template` is descriptive-only: validated as a name here and resolved
    // nowhere. Any future consumption must go through the normal spawn gate.
    if ('template' in clean && (typeof clean.template !== 'string' || !NAME_RE.test(clean.template))) {
      throw new Error(`role "${roleName}" template must be a library-template name matching ${NAME_RE} (${team.file})`);
    }
    if ('dispatch' in clean && !ROLE_DISPATCH_VALUES.has(clean.dispatch)) {
      throw new Error(`role "${roleName}" dispatch must be one of ${[...ROLE_DISPATCH_VALUES].join(', ')} (${team.file})`);
    }
    // Validated on `clean` (the patch), not the merged def, which preserves an
    // EXISTING cwd a stale check could re-refuse. Gated on CHANGE, not presence:
    // the popover's save patch always carries `cwd`, so re-validating an unchanged
    // value makes an unrelated edit fail once that directory is deleted.
    const storedCwd = typeof team.roles[roleName].cwd === 'string' ? team.roles[roleName].cwd : '';
    const patchCwd = typeof clean.cwd === 'string' ? clean.cwd.trim() : null;
    if ('cwd' in clean && !(patchCwd !== null && patchCwd === storedCwd)) {
      assertRoleCwd(roleName, clean, team.root, team.file);
    }
    // Trimmed AFTER the gate: this write does not go through pickRoleKeys, so
    // without it the merge below lands untrimmed bytes assertRoleCwd never saw.
    if (typeof clean.cwd === 'string') clean.cwd = clean.cwd.trim();
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.roles = raw.roles || {};
    // NOT picked down to the schema, unlike addRole's new role: this preserves an
    // existing role's hand-authored keys, and `clean` is already EDITABLE-only.
    raw.roles[roleName] = { ...raw.roles[roleName], ...clean };
    // A blank cwd is a CLEAR and deletes the key rather than storing '':
    // path.resolve(root, '') is the root, so '' means what its absence means.
    if ('cwd' in clean && !String(clean.cwd == null ? '' : clean.cwd).trim()) {
      delete raw.roles[roleName].cwd;
    }
    normalizeRoleDef(roleName, raw.roles[roleName], team.file);
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  // `opts.operator` is the renderer's opt-in and nothing else passes it: the
  // `[agent:team role-rm]` intent calls this with two args, so an agent still gets
  // the refusal below.
  function removeRole(teamName, roleName, opts) {
    const team = loadManifest(teamName);
    const operator = !!(opts && opts.operator === true);
    // Non-removable for everyone, operator included: loadManifest hard-requires
    // the key and every caller resolves teams in a best-effort catch, so a team
    // that lost its lead would read as "no team at all" everywhere at once.
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

  // Re-points the lead SEAT pointer, NOT the `lead` role, which stays reserved.
  // Only the charset is gated — every team has a stopped lead sometimes, so an
  // existence check would refuse the legitimate case.
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

// A name this cannot decompose resolves to no role at all — off the roster, no
// role prompt, and past the fail-CLOSED `_roleInUse` guard in session-manager.js.
//
// The collision suffix is not only `-N`: `shop-hand2` must strip too. EXACT MATCH
// WINS before any stripping, since a role may be named `hand2`. Only digit
// suffixes strip. `-rN` is the one lettered tail, stripped ahead of the numeric
// one — a ticket's reviewer is `<team>-reviewer-<ticket>-r<round>` and both tails
// must go or the key keeps the ticket number.
function matchSeatRole(team, seatName) {
  if (!team || !seatName || !team.roles) return null;
  if (seatName === team.lead) return 'lead' in team.roles ? 'lead' : null;
  const prefix = `${team.name}-`;
  if (!seatName.startsWith(prefix)) return null;
  // hasOwnProperty, not `in`: `in` walks the prototype, so a seat named
  // `<team>-toString` would otherwise "resolve" to a role that is Object's method.
  const has = (k) => Object.prototype.hasOwnProperty.call(team.roles, k);
  const suffix = seatName.slice(prefix.length);
  if (has(suffix)) return suffix;
  const key = suffix.replace(/-r\d+$/, '').replace(/[-_]?\d+$/, '');
  return key && has(key) ? key : null;
}

function rosterExecPayload(seatName) {
  // Serialized, not interpolated: this pure leaf cannot see the caller's name
  // grammar, so an unvalidated seat name could break the JSON.
  return `[agent:exec clodex-team] ${JSON.stringify({ action: 'roster', agent: seatName || '<your name>' })}`;
}

// Per-role invariants ONLY — this text is part of the cache-stable system prompt,
// so the roster listing stays out and the output carries the role, never the
// seat name.
function formatTeamBlock(team, seatName) {
  const mine = matchSeatRole(team, seatName);
  const yourRole = mine || 'none — not a manifest role';
  return [
    '# Team',
    `You are on team ${team.name} (root ${team.root}). Your role: ${yourRole}.`,
    `Team composition arrives in your context. Ground truth on demand: ${rosterExecPayload(null)}`,
  ].join('\n');
}

// Derived from the manifest rather than stored on the def: reachability is a
// consequence of the reserved `reviewer` key plus the code that routes the spawn.
function leadActionLine(team) {
  const sessionRoles = [];
  let hasReviewer = false;
  for (const role of Object.keys(team.roles || {})) {
    // `team.lead` is a SEAT name — comparing against it here would drop an
    // unrelated role from a team whose lead seat shares its name.
    if (role === 'lead') continue;
    if (role === 'reviewer') { hasReviewer = true; continue; }
    sessionRoles.push(role);
  }
  const parts = [];
  // The "Dispatch:" prefix is the token three roster tests assert the ABSENCE of
  // for a non-lead seat. Rewording the line without it defangs all three silently.
  if (sessionRoles.length) parts.push('Dispatch: TWO steps. [agent:task add <role>] <spec> writes the ticket and starts NOTHING, then [agent:task start <id>] mints its tree and seat and delivers the spec. A "do not start" line in the body is NOT read by anything — an unstarted ticket is simply one you have not started.');
  // Spells out that the intent does the spawning: a lead that reaches for its
  // harness subagent tool instead gets a reviewer with no tools cap, no verdict
  // intent, and no seat the operator can see.
  if (hasReviewer) parts.push('Review: [agent:team-review] <scope> — the intent spawns the cold reviewer seat itself; do NOT spawn or subagent one by hand.');
  if (sessionRoles.length) {
    parts.push(`New session seat: [agent:spawn name:${team.name}-<role> template:<tmpl>].`);
  }
  return parts.length ? parts.join(' ') : null;
}

// The two statuses never share a line: 'ignored' says the field configures
// nothing, 'honored' says deleting it changes behaviour.
//
// 'unknown' is rendered by neither, and that exclusion is what keeps this SAFE:
// an 'unknown' field name is an arbitrary agent-authored string from team.json,
// this roster is baked into the digest re-read on every context reset, and the
// intent parser is `^`-anchored — a key carrying a newline and a column-1 verb
// would fire in the lead's context. A surface that renders 'unknown' must refuse
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
    lines.push(`  retired but STILL READ here: ${role}.${d.field} — deleting it CHANGES BEHAVIOUR; write \`${d.remedy}\` instead`);
  }
  return lines;
}

// The label is never computed here — team-manifest is a pure leaf and warmth is a
// wire-layer property, so it arrives as data.
function formatRoster(team, liveSeats = [], { seat = null } = {}) {
  const byRole = new Map();
  const roleless = [];
  for (const entry of liveSeats) {
    const name = typeof entry === 'string' ? entry : (entry && entry.name);
    if (!name) continue;
    const label = typeof entry === 'string' ? null : (entry && entry.label) || null;
    const suffix = name === seat ? ' (you)' : (label ? ` (${label})` : '');
    const role = matchSeatRole(team, name);
    if (!role) { roleless.push(`${name}${suffix}`); continue; }
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(`${name}${suffix}`);
  }
  const lines = [`[team ${team.name}] roster (lead: ${team.lead})`];
  for (const [role, def] of Object.entries(team.roles)) {
    // Name [agent:team-review] ONLY to the seat allowed to use it:
    // _handleTeamReview bounces a non-lead.
    const cls = role !== 'reviewer' ? 'session'
      : (seat && seat === team.lead ? 'via [agent:team-review]' : 'lead-only');
    // Suppressed on the reviewer: [agent:team-review] resolves the template
    // itself, so printing one invites the hand-spawn the row exists to prevent.
    const tmpl = (role !== 'reviewer' && def && typeof def.template === 'string' && def.template) ? `, tmpl ${def.template}` : '';
    const brief = def && def.brief ? ` — ${def.brief}` : '';
    // Liveness is STATED in this slot, never inferred from a missing tail: a
    // definition row and a live row are otherwise identical in shape, and a
    // reader scanning for teammates dm's a seat that does not exist.
    const live = byRole.get(role);
    const liveStr = live && live.length
      ? ` · live: ${live.join(', ')}`
      : ' · no live seat — role definition only, not addressable';
    lines.push(`- ${role} (${cls}${tmpl})${brief}${liveStr}`);
    for (const l of retiredFieldLines(team, role)) lines.push(l);
  }
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
