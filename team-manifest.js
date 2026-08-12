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

// Bumped when the ROLE schema loses or gains a key. 2 dropped the five fields no
// resolver consumed (instantiate, standing, tools, type, ephemeral); 3 replaced
// the `worktree` boolean with the `dispatch` enum. A file without one is a
// version-1 file, which is why absent reads as 1 rather than
// current — a current-by-default would let a stale file claim to be new.
const MANIFEST_VERSION = 3;

// Everything a role def may carry. Anything else is dropped at load with a
// warning rather than throwing: team.json is agent-writable and old files carry
// the version-1 keys, so a hard failure here would read as "no team" everywhere
// (every caller resolves teams inside a best-effort catch).
const ROLE_KEYS = new Set(['template', 'prompt', 'brief', 'dispatch']);

// What dispatching a ticket to this role DOES. The predecessor was named
// `worktree`, after one artifact of the behaviour rather than the behaviour, and
// that is what let it read as an implementation detail nobody needed a front
// door for. Absent reads as `standing`.
const ROLE_DISPATCH_VALUES = new Set(['standing', 'worktree']);
const DEFAULT_ROLE_DISPATCH = 'standing';

// Schema fields NO front door sets, each with the reason it is exempt. The
// legibility test asserts EDITABLE_ROLE_FIELDS ∪ this ≡ ROLE_KEYS, so a new
// field is either reachable or listed here with a reason — never merely absent.
// EMPTY is the intended steady state, not a leftover: the one entry it ever held
// was closed by giving that field a front door. Do not delete the constant —
// the next field that wants an exemption has to add itself back explicitly.
const UNREACHABLE_ROLE_FIELDS = new Set([]);

// The fields a version bump deleted (five in v2, plus v3's `worktree`). Named
// rather than derived as "anything not
// in ROLE_KEYS", because the mutators DELETE these from disk: a derived set would
// silently grow to include hand-authored keys nobody asked us to remove, and the
// migration would become data loss. Every one of these is already dropped at
// load by every reader that routes through loadManifest, so removing it from the
// file changes no behavior there — only the bytes. scripts/clodex-team.js parses
// team.json itself and does NOT route through here; keep it off these fields.
//
// `worktree` is cut-AND-REPLACED, not cut: migrateRoles carries its value onto
// `dispatch` BEFORE this delete runs. Reorder those two and every live role that
// opted into a worktree silently stops getting one, with nothing failing.
const CUT_ROLE_FIELDS = ['instantiate', 'standing', 'tools', 'type', 'ephemeral', 'worktree'];

// Cut from the schema but STILL READ. The load-time warning partitions on this:
// every other cut field enforces nothing, and saying so is the whole point of
// that line — but `worktree` is resolved onto `dispatch` in normalizeRoleDef, so
// telling a reader it configures nothing invites them to delete it and silently
// converts every worktree role to standing. A key belongs here for exactly as
// long as a compatibility branch reads it, and leaves when that branch does.
const HONORED_CUT_FIELDS = new Set(['worktree']);

// Every role field a front door (setRole, the Add Role form, the popover row
// model) may set. Exported so the legibility test compares the real list against
// the schema instead of a copy that can drift from it.
const EDITABLE_ROLE_FIELDS = ['brief', 'dispatch', 'prompt', 'template'];

// team.json is agent-writable and these role keys are trusted downstream, so the
// mutators below must never create, destroy or rename them; only the operator
// GUI/approval may mint or replace them.
const RESERVED_ROLE_KEYS = new Set(['lead', 'reviewer']);

const WATCHDOG_MIN_MS = 5 * 60 * 1000;
const WATCHDOG_MAX_MS = 7 * 24 * 60 * 60 * 1000;

const STOCK_ROLE_DEFS = {
  lead: { prompt: 'clodex-team-lead', brief: 'team lead; holds durable context, dispatches specs, verifies and integrates the work.' },
  hand: { prompt: 'clodex-team-hand', brief: 'implementer; executes a spec to done, one distilled report per task.' },
  reviewer: { prompt: 'clodex-team-reviewer', brief: 'reviewer; an independent verification pass, invoked on demand.' },
};

// A field may live here only if exactly one resolver consumes it and every spawn
// path reaches that resolver. Five fields failed that test and were cut:
// `instantiate` (a declaration two display sites compensated for), `standing`
// (zero consumers anywhere), `tools` (a restriction enforced on one role and
// inert-but-believed on the rest), `type` (honored on one spawn path, overridden
// with a warning on the other), and `ephemeral` (one word, two stores — the
// persistence record is now the single source). Variation belongs in a TEMPLATE,
// which is data and cheap to vary; a new role field is code semantics and is how
// every one of those divergences was born.
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
  return {
    template: def.template ?? null,
    prompt: def.prompt ?? null,
    brief: def.brief ?? null,
    // What a ticket dispatched to this role does. `standing` delivers the spec to
    // the live seat holding the role; `worktree` mints its own branch, spawns a
    // one-shot seat in a git worktree on it, and re-pins the ticket from the ROLE
    // to that seat. Enforced — session-manager reads it on the dispatch path.
    //
    // The v2 `worktree: true` boolean is READ here, not merely migrated. Migration
    // runs on mutator WRITES, so a file nobody edits would otherwise keep opting a
    // role into a worktree on disk while every dispatch quietly went to a standing
    // seat — silent, because `standing` is a legitimate value nothing warns about.
    // The reader has to understand the file it is handed; migrateRoles then makes
    // the disk say what this already resolved. Delete this and a v2 team.json
    // silently changes behaviour the moment it loads.
    //
    // The LEGACY key is not honored on a reserved role, matching migrateRoles:
    // `worktree: true` on lead/reviewer was already refused at dispatch, so
    // reading it now would invent an opt-in that never took effect. An EXPLICIT
    // `dispatch: "worktree"` hand-written on lead is a different case and is
    // returned as written — the write paths refuse it and the dispatch resolver
    // refuses it, so scrubbing it here would only hide a hand-edit from view.
    //
    // Per-role and per-team on purpose, not a flag on `task add`: the lead would
    // have to remember it on every dispatch, and the one dispatch that forgets
    // lands a hand in the shared checkout holding a spec that assumes isolation.
    dispatch: def.dispatch
      ?? ((def.worktree === true && !RESERVED_ROLE_KEYS.has(roleName)) ? 'worktree' : DEFAULT_ROLE_DISPATCH),
  };
}

// lead and reviewer are STANDING roles: the lead is the team's durable context
// and the reviewer is invoked on demand against work that already exists, so
// neither has a ticket that wants its own tree. Refused where roles are DEFINED
// rather than only at dispatch time — but the dispatch-time resolver still holds
// the same line, because team.json is hand-editable and a file that predates
// this check must not start minting trees for them.
function assertDispatchAllowed(roleName, def, file) {
  if (!def || typeof def !== 'object') return;
  if (RESERVED_ROLE_KEYS.has(roleName) && def.dispatch === 'worktree') {
    throw new Error(`the "${roleName}" role is standing — it cannot dispatch to a worktree (${file})`);
  }
}

// Keys a role def carries that this schema no longer models, for the load-time
// warning. Returned rather than warned in place: normalizeRoleDef runs on the
// write paths too, where a drop is the caller's answer, not a console line.
//
// `worktree` is reported here like any other unmodeled key, which keeps a stale
// v2 file loud until a mutator rewrites it. It must NOT be excluded to spare it
// the warning: the file would then load silently while still carrying a key
// whose meaning lives in a compatibility branch, which is the state the warning
// exists for. It is still READ (normalizeRoleDef resolves it onto `dispatch`),
// so the caller partitions it into HONORED_CUT_FIELDS and gives it a line
// saying it takes effect — telling a reader it "enforces nothing" is what makes
// deleting it look safe.
function unknownRoleKeys(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return [];
  return Object.keys(def).filter((k) => !ROLE_KEYS.has(k));
}

// The write-path counterpart of the load-time drop: a def carrying only keys this
// schema models. Every mutator writes through this, because dropping a key only on
// the way OUT leaves it on disk — `tools: ["Read"]` in team.json is a restriction
// nothing enforces, and a front door that accepts one is worse than a hand-edit,
// which at least nobody mistakes for a supported feature.
//
// A non-object is returned untouched so a malformed def still reaches the
// validators that throw on it, rather than being laundered into a valid `{}`.
function pickRoleKeys(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return def;
  const out = {};
  for (const [k, v] of Object.entries(def)) {
    if (ROLE_KEYS.has(k)) out[k] = v;
  }
  return out;
}

// One console line per (file, dropped-key-set), for the life of the process.
// loadManifest has no cache and resolveTeam loads EVERY team on EVERY call —
// _sweepTickets alone runs it every 60s per live seat — so an ungated warn is a
// line several times a minute, forever, for one legacy file anywhere on the
// machine. A main-process log nobody can read is where a real error goes to hide.
const warnedDrops = new Set();

function createTeamManifest({ fs, clodexHome } = {}) {
  const home = clodexHome || defaultClodexHome();
  const teamsDir = path.join(home, 'teams');

  // Routed through fs-util's atomicWriteFileSync, not a local write+rename
  // (F010). The pair here was the same shape but WITHOUT the fsyncs: the rename
  // was atomic, so no reader ever saw a half file, but neither the bytes nor the
  // directory entry were durable — a power loss after the rename could leave a
  // team.json that names roles whose contents never reached the disk. fs-util is
  // the audited choke point every other JSON store already uses, and it fsyncs
  // both.
  //
  // The durability primitive is deliberately NOT taken from the injected `fs`:
  // it is a single audited implementation, not a seam a caller gets to vary, and
  // every caller (engine.js and every test) injects the real fs anyway. The dir
  // is still created 0700 first — atomicWriteFileSync's own mkdir carries no
  // mode, and ~/.clodex/teams/<name>/ must not widen to the umask default.
  function atomicWrite(file, data) {
    ensureDir(path.dirname(file));
    atomicWriteFileSync(file, data);
  }

  // Migrate every role off the cut fields, then stamp the schema version. Run on
  // EVERY mutator write, which is what makes the version mean something: a
  // conditional stamp alone could never fire on a real legacy file, because the
  // v1 stock scaffold put `instantiate`/`tools` on `reviewer` and every mutator
  // refuses the reserved roles — so the one file that motivated the warning was
  // the one file that could never stop emitting it.
  //
  // Scoped to CUT_ROLE_FIELDS, not to ROLE_KEYS: this strips a NAMED set of keys
  // this schema already drops at load, so it changes no read semantics anywhere —
  // it only makes the disk agree with what every reader already does. Keys we
  // simply do not model (setRole's `customField` case) are hand-authored data and
  // stay untouched; that distinction is the whole justification for stripping
  // here at all.
  function migrateRoles(raw) {
    const roles = (raw && raw.roles && typeof raw.roles === 'object' && !Array.isArray(raw.roles))
      ? raw.roles : null;
    if (!roles) return raw;
    for (const [roleName, def] of Object.entries(roles)) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
      // CARRY-OVER BEFORE DELETE. `worktree` is in CUT_ROLE_FIELDS, so the loop
      // below removes it; reading it after that runs yields undefined and every
      // role that opted into a worktree quietly becomes standing, with no error
      // anywhere. v2 `false`/absent migrates to ABSENT rather than an explicit
      // "standing" — absent already reads as standing, so writing the default
      // would be noise on disk.
      //
      // Reserved roles are excepted: `worktree: true` on lead/reviewer was
      // already refused at dispatch, so carrying it would migrate a claim that
      // was never true into a schema where the front door refuses to write it.
      if (def.worktree === true && def.dispatch == null && !RESERVED_ROLE_KEYS.has(roleName)) {
        def.dispatch = 'worktree';
      }
      for (const k of CUT_ROLE_FIELDS) {
        if (k in def) delete def[k];
      }
      roles[roleName] = def;
    }
    // Only now can this be true of a file whose stale keys lived on a reserved
    // role. Still conditional: a hand-authored key outside the cut set is not
    // ours to delete, and a file carrying one has not finished migrating.
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
    // `lead` is now a SEAT name (the session adopted as lead), not a role key —
    // the roles map is keyed by ROLE name and always carries a literal `lead`
    // role. matchSeatRole binds the lead SEAT to that role.
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
    const dropped = [];
    // Split from `dropped` because the two warn under DIFFERENT conditions (see
    // the version gate below), not merely with different wording. A cut field
    // once had meaning and still READS as policy — `tools: ["Read"]` on a role
    // is the measured case: it looks like a capability restriction, enforces
    // nothing, and cost a reader a full round before this warned.
    const droppedCut = [];
    // Third population, not a special case of the second: a key that is still
    // READ cannot share a line whose text is "this enforces nothing".
    const droppedHonored = [];
    for (const [roleName, def] of Object.entries(rolesIn)) {
      if (!ROLE_RE.test(roleName)) {
        throw new Error(`role name "${roleName}" must match ${ROLE_RE} (${file})`);
      }
      for (const k of unknownRoleKeys(def)) {
        const bucket = HONORED_CUT_FIELDS.has(k) ? droppedHonored
          : CUT_ROLE_FIELDS.includes(k) ? droppedCut
            : dropped;
        bucket.push(`${roleName}.${k}`);
      }
      roles[roleName] = normalizeRoleDef(roleName, def, file);
    }
    // Absent reads as 1, not as current: a file written before the version
    // existed IS a version-1 file, and defaulting to current would let a stale
    // manifest claim a schema it was never checked against.
    const version = (typeof m.version === 'number' && Number.isInteger(m.version) && m.version > 0)
      ? m.version : 1;
    // Warn, never throw: a version-1 file still on disk carries `instantiate`
    // and friends, and a manifest that refuses to load reads as "this cwd is on
    // no team" at every call site — the whole team layer would vanish over a key
    // nothing consumes any more.
    //
    // This is `version`'s consumer, and the pair is what makes the drop
    // self-healing rather than merely quiet: an out-of-date file warns (once per
    // key set) until a mutator rewrites it clean and restamps, after which the
    // version gate alone silences it. A CURRENT-version file with unknown keys is
    // silent by design — that is a hand-added key on today's schema, which the
    // legibility gate covers; the warn exists for the migration, not as a linter.
    if (dropped.length && version < MANIFEST_VERSION) {
      const seen = `unknown|${file}|${dropped.join(',')}`;
      if (!warnedDrops.has(seen)) {
        warnedDrops.add(seen);
        console.warn(`team "${name}": ignoring role keys this schema no longer models — ${dropped.join(', ')} (${file})`);
      }
    }
    // NOT under the version gate, unlike the unknown-key warn above. A cut field
    // reads as authority and enforces nothing, and the version stamp is exactly
    // what hides the dangerous case: a file claiming the CURRENT schema while
    // still carrying `reviewer.tools` dropped in total silence, which is the
    // shape that burned a reader. The gate's rationale — "the warn exists for
    // the migration, not as a linter" — holds for a key this schema never
    // modelled; it does not hold for one it deliberately retired.
    //
    // Says IGNORED, not "dropped": a reader who sees "dropped" asks what it was
    // dropped FROM and may still believe the file means something. The point of
    // the line is that the field changes no behaviour anywhere.
    //
    // Reaches HONORED_CUT_FIELDS never — that text would be a lie about a key a
    // compatibility branch still reads, and a reader who acts on it loses the
    // opt-in silently. The partition is what keeps this sentence true.
    if (droppedCut.length) {
      const seen = `cut|${file}|${droppedCut.join(',')}`;
      if (!warnedDrops.has(seen)) {
        warnedDrops.add(seen);
        console.warn(`team "${name}": these role keys are IGNORED — they are retired fields this schema no longer honors, and setting them enforces or configures nothing: ${droppedCut.join(', ')} (${file})`);
      }
    }
    // Ungated on version for the same reason as the line above, but the OPPOSITE
    // message: this key still takes effect. It names the replacement because the
    // only safe edit is a rewrite, not a delete — and it warns rather than going
    // quiet because the meaning lives in a compatibility branch that will
    // eventually be removed, at which point a silent file would change behaviour.
    if (droppedHonored.length) {
      const seen = `honored|${file}|${droppedHonored.join(',')}`;
      if (!warnedDrops.has(seen)) {
        warnedDrops.add(seen);
        console.warn(`team "${name}": these role keys are RETIRED but STILL READ — they are not modeled by this schema, yet a compatibility branch still honors them, so deleting one CHANGES BEHAVIOUR: ${droppedHonored.join(', ')} — write \`dispatch: "worktree"\` instead; a future schema will stop reading them (${file})`);
      }
    }
    // team.json is agent-writable, so a hand-written watchdogMs is neutralized at
    // READ, the choke point every consumer passes. Never throw on a bad value — one
    // bad number must not break the whole team's resolution; it reads as absent.
    const rawWatchdog = m.watchdogMs;
    const watchdogMs = (typeof rawWatchdog === 'number' && Number.isFinite(rawWatchdog) && rawWatchdog > 0)
      ? Math.min(WATCHDOG_MAX_MS, Math.max(WATCHDOG_MIN_MS, rawWatchdog))
      : null;
    return { name, root: path.resolve(root), lead, roles, file, watchdogMs, version };
  }

  function containsPath(root, cwd) {
    const rel = path.relative(path.resolve(root), path.resolve(cwd));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  // The checkout a linked git worktree belongs to, or null. A linked worktree's
  // `.git` is a FILE reading `gitdir: <main>/.git/worktrees/<id>`, so the main
  // checkout is derivable with one read — no `git` subprocess, which is what makes
  // this safe to call from resolveTeam. That matters: resolveTeam runs on every
  // roster render and every ticket resolution, and spawning a process there would
  // turn team membership into a latency problem.
  //
  // Deliberately NOT clodex- or even git-specific in its effect: the rule this
  // encodes is "a team is a repository, not a path", so any tool that lays out
  // sibling checkouts the way git does resolves onto the same team.
  const WORKTREE_MARKER = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  function mainCheckoutOf(cwd) {
    let dir = path.resolve(cwd);
    // Bounded walk: a worktree's root is an ancestor of the agent's cwd, but an
    // unbounded loop on a symlink cycle would hang the caller.
    for (let i = 0; i < 64; i++) {
      let raw;
      try {
        const st = fs.lstatSync(path.join(dir, '.git'));
        // A directory `.git` is the MAIN checkout, which containsPath already
        // handled — returning it here would be a no-op at best and would mask a
        // genuine miss at worst.
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
      // Slice ENDS at the marker: the marker leads with the separator, so the
      // prefix is exactly the main checkout with no trailing slash to strip.
      return gitdir.slice(0, at);
    }
    return null;
  }

  // A cwd belongs to a project when it sits under the project root, OR when it is
  // a git worktree of the checkout at that root. Path containment alone was the
  // rule, and it silently excluded worktrees: git's own default puts one at
  // `<repo>/../<repo>-<branch>`, a SIBLING of the root, so a seat working in one
  // fell off its team — no roster entry, and `_ticketAssigneeSeat` returned null,
  // which surfaces to the lead as "no live seat yet" (a timing message for a
  // membership fault). Worktree isolation is unusable without this.
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
    // NAME_RE accepts `.hidden` (t115, deliberate for SESSION names), but listTeams
    // skips dot-directories — so a dot-named team would be written and then never
    // listed, never resolved for any cwd, and never shown in the Teams menu, while
    // loadManifest still opens it by path. Refuse at the writer: the free-text name
    // field in Create Team… (t288) makes that state reachable by typing.
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
      // session-manager, a code constant on the one path that can enforce it.
      // Restating it as data made a manifest look like the authority it wasn't.
      reviewer: { ...STOCK_ROLE_DEFS.reviewer },
    };
    const callerRoles = roles && typeof roles === 'object' && !Array.isArray(roles) && Object.keys(roles).length
      ? roles : null;
    // Caller roles are picked down to the schema for the same reason addRole's
    // are: a brand-new file must not be born carrying a field no resolver reads.
    const seedRoles = {};
    for (const [k, v] of Object.entries(callerRoles || defaultRoles)) {
      seedRoles[k] = pickRoleKeys(v);
      // createTeam takes an arbitrary caller `roles` object, so it is a write
      // path too — without this a brand-new file could be born naming lead as a
      // worktree role, which every other door refuses.
      assertDispatchAllowed(k, seedRoles[k], file);
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

  function addRole(teamName, roleName, def) {
    const team = loadManifest(teamName); // throws if the team is missing
    if (!ROLE_RE.test(roleName)) {
      throw new Error(`role name "${roleName}" must match ${ROLE_RE} (${team.file})`);
    }
    // The legacy key is READ on the load path (a v2 file on disk must keep
    // working), but it must never enter through a WRITE: pickRoleKeys drops it
    // and emits no `dispatch`, so an addRole carrying `worktree: true` would
    // store a standing role and answer {ok:true} — the opt-in discarded with no
    // error. Throwing names the replacement instead of silently disagreeing
    // with the caller.
    if (def && typeof def === 'object' && !Array.isArray(def) && 'worktree' in def) {
      throw new Error(`role "${roleName}": "worktree" was replaced by "dispatch" — use dispatch: "worktree" (${team.file})`);
    }
    const normalized = normalizeRoleDef(roleName, def, team.file);
    assertDispatchAllowed(roleName, normalized, team.file);
    if (normalized.template != null && !NAME_RE.test(normalized.template)) {
      throw new Error(`role "${roleName}" template must be a library-template name matching ${NAME_RE} (${team.file})`);
    }
    const existing = team.roles[roleName];
    // Never MINT an absent reserved key: loadManifest only REQUIRES `lead`, so a
    // hand-deleted `reviewer` could otherwise be re-added with an attacker-authored
    // def. The `!existing` carve-out keeps join's no-op re-ride of a stock def.
    if (RESERVED_ROLE_KEYS.has(roleName) && !existing) {
      throw new Error(`the "${roleName}" role is operator-owned topology; add it via the app, not an intent/mutator (${team.file})`);
    }
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(normalized)) return team; // no-op
      throw new Error(`role "${roleName}" already exists on team "${teamName}" with a different definition`);
    }
    // Re-read raw to preserve any hand-authored fields/formatting we don't model
    // on the OTHER roles, then append the new role and write atomically.
    //
    // The new role is written through pickRoleKeys, not verbatim: this is the
    // front door (`team:addRole` takes an arbitrary def), and a verbatim write
    // lands `tools: ["Read"]` — a restriction enforced by nothing — in team.json,
    // where read-back drops it but the file still reads as a policy. That
    // preservation rule above is about roles this call did not author.
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
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.roles = raw.roles || {};
    // NOT picked down to the schema, unlike addRole's new role: this write
    // preserves an EXISTING role's hand-authored keys (pinned below), and `clean`
    // is already EDITABLE-only, so no cut field can enter here. The cut fields
    // that are already on disk leave via migrateRoles, which names them.
    raw.roles[roleName] = { ...raw.roles[roleName], ...clean };
    normalizeRoleDef(roleName, raw.roles[roleName], team.file);
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  function removeRole(teamName, roleName) {
    const team = loadManifest(teamName);
    if (RESERVED_ROLE_KEYS.has(roleName)) {
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
    createTeam, addRole, setRole, removeRole, renameRole, setTeamWatchdog,
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
  const key = suffix.replace(/[-_]?\d+$/, '');
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

// Per-seat invariants ONLY — the roster listing must stay OUT: composition
// changes over a seat's life and this text is part of the cache-stable system
// prompt. Live composition arrives as data.
function formatTeamBlock(team, seatName) {
  const mine = matchSeatRole(team, seatName);
  const yourRole = mine || 'none — not a manifest role';
  return [
    '# Team',
    `You are seat ${seatName} on team ${team.name} (root ${team.root}). Your role: ${yourRole}.`,
    `Team composition arrives in your context; ground truth: ${rosterExecPayload(seatName)}`,
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
