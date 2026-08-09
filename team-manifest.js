// No clodex resource lives inside project files: a team is defined entirely
// under ~/.clodex/teams/<name>/. Pure leaf — no electron, injected fs.

'use strict';

const path = require('path');
const os = require('os');
const { ensureDir, atomicWriteFileSync } = require('./fs-util');

const TEAM_FILE = 'team.json';
const ROLE_RE = /^[a-zA-Z0-9._-]{1,32}$/;
// Team names and seat names share the session-name grammar (CLAUDE.md): a team
// name is BOTH a directory under ~/.clodex/teams/ AND the `<team>-` seat-name
// prefix, so it must be name-legal; top-level `lead` is a seat name.
const NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const INSTANTIATE = new Set(['session', 'subagent']);

// team.json is agent-writable and these role keys are trusted downstream, so the
// mutators below must never create, destroy or rename them; only the operator
// GUI/approval may mint or replace them.
const RESERVED_ROLE_KEYS = new Set(['lead', 'reviewer']);

const WATCHDOG_MIN_MS = 5 * 60 * 1000;
const WATCHDOG_MAX_MS = 7 * 24 * 60 * 60 * 1000;

const STOCK_ROLE_DEFS = {
  lead: { prompt: 'clodex-team-lead', brief: 'team lead; holds durable context, dispatches specs, verifies and integrates the work.' },
  hand: { instantiate: 'session', prompt: 'clodex-team-hand', brief: 'implementer; executes a spec to done, one distilled report per task.' },
  reviewer: { instantiate: 'subagent', prompt: 'clodex-team-reviewer', brief: 'reviewer; an independent verification pass, invoked on demand.' },
};

function defaultClodexHome() {
  return process.env.CLODEX_HOME || path.join(os.homedir(), '.clodex');
}

// Fixed key order: addRole's no-op check compares JSON.stringify of two
// normalized defs, so reordering these keys breaks equality.
function normalizeRoleDef(roleName, def, file) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw new Error(`role "${roleName}" must be an object (${file})`);
  }
  const inst = def.instantiate ?? 'session';
  if (!INSTANTIATE.has(inst)) {
    throw new Error(`role "${roleName}" instantiate must be session|subagent, got "${inst}" (${file})`);
  }
  if (def.template != null && typeof def.template !== 'string') {
    throw new Error(`role "${roleName}" template must be a string (${file})`);
  }
  if (def.standing != null && typeof def.standing !== 'string') {
    throw new Error(`role "${roleName}" standing must be a string (${file})`);
  }
  if (def.prompt != null && typeof def.prompt !== 'string') {
    throw new Error(`role "${roleName}" prompt must be a string (${file})`);
  }
  if (def.brief != null && typeof def.brief !== 'string') {
    throw new Error(`role "${roleName}" brief must be a string (${file})`);
  }
  if (def.tools != null && (!Array.isArray(def.tools) || def.tools.some((t) => typeof t !== 'string'))) {
    throw new Error(`role "${roleName}" tools must be an array of strings (${file})`);
  }
  // An empty allowlist is a silent-lockout trap: it can't mean "allow nothing"
  // (a seat with no tools is useless) and must NOT quietly read as "unrestricted"
  // (the disabledTools inverter treats []-length as "no restriction"). Fail loud
  // at manifest load — omit `tools` for unrestricted, or list what's allowed.
  if (Array.isArray(def.tools) && def.tools.length === 0) {
    throw new Error(`role "${roleName}" tools must not be empty — omit it for unrestricted, or list the allowed tools (${file})`);
  }
  if (def.type != null && typeof def.type !== 'string') {
    throw new Error(`role "${roleName}" type must be a string (${file})`);
  }
  return {
    template: def.template ?? null,
    standing: def.standing ?? null,
    prompt: def.prompt ?? null,
    instantiate: inst,
    ephemeral: def.ephemeral === true,
    brief: def.brief ?? null,
    // SCOPE OF `tools`, stated because it was believed to be wider (F008).
    // The ONLY consumer of a role's tools is the cold-reviewer spawn in
    // session-manager.js, which intersects it with REVIEWER_TOOL_CAP and inverts
    // the result into disabledTools. Every other role carries the field and
    // NOTHING reads it: `tools: ['Read']` on a `hand` restricts that hand by
    // exactly nothing.
    //
    // Why the scope is real and not an oversight to widen casually: disabledTools
    // is enforced through the claude settings hook (setupClaudeHook), and codex
    // ignores a denylist entirely. The reviewer path can rely on it only because
    // it FORCES type claude — a choke point an arbitrary role does not have, so
    // enforcing tools generally would produce a cap that silently evaporates on
    // any codex seat. That is a fail-open dressed as a restriction, which is the
    // same defect this comment exists to stop, one layer down.
    //
    // So the field stays reviewer-scoped, and addRole below REFUSES to write it
    // on any other role rather than storing a restriction nobody applies. A
    // hand-authored manifest that already carries one still LOADS (throwing here
    // would take the whole team layer down: every caller resolves teams inside a
    // best-effort catch, so a hard failure reads as "no team" everywhere) — it is
    // inert, documented, and refused at the front door.
    tools: def.tools ?? null,
    type: def.type ?? null,
  };
}

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
    for (const [roleName, def] of Object.entries(rolesIn)) {
      if (!ROLE_RE.test(roleName)) {
        throw new Error(`role name "${roleName}" must match ${ROLE_RE} (${file})`);
      }
      roles[roleName] = normalizeRoleDef(roleName, def, file);
    }
    if (roles.lead.instantiate !== 'session') {
      throw new Error(`lead role "lead" must have instantiate: session (${file})`);
    }
    // team.json is agent-writable, so a hand-written watchdogMs is neutralized at
    // READ, the choke point every consumer passes. Never throw on a bad value — one
    // bad number must not break the whole team's resolution; it reads as absent.
    const rawWatchdog = m.watchdogMs;
    const watchdogMs = (typeof rawWatchdog === 'number' && Number.isFinite(rawWatchdog) && rawWatchdog > 0)
      ? Math.min(WATCHDOG_MAX_MS, Math.max(WATCHDOG_MIN_MS, rawWatchdog))
      : null;
    return { name, root: path.resolve(root), lead, roles, file, watchdogMs };
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
      reviewer: { ...STOCK_ROLE_DEFS.reviewer, tools: ['Read', 'Grep', 'Glob'] },
    };
    const callerRoles = roles && typeof roles === 'object' && !Array.isArray(roles) && Object.keys(roles).length
      ? roles : null;
    const manifest = {
      lead,
      root: resolvedRoot,
      roles: callerRoles || defaultRoles,
    };
    atomicWrite(file, JSON.stringify(manifest, null, 2));
    return loadManifest(name);
  }

  function addRole(teamName, roleName, def) {
    const team = loadManifest(teamName); // throws if the team is missing
    if (!ROLE_RE.test(roleName)) {
      throw new Error(`role name "${roleName}" must match ${ROLE_RE} (${team.file})`);
    }
    const normalized = normalizeRoleDef(roleName, def, team.file);
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
    // `tools` is enforced ONLY on the reviewer (see normalizeRoleDef). Writing it
    // on any other role stores a restriction nothing applies — a knob that reads
    // as a grant of safety and grants none, which is worse than its absence
    // because it is written down and believed (F008). Refused, not stripped:
    // setRole drops authority-bearing fields silently by spec, but that is an
    // EDIT of an existing role, where the field was never promised; here the
    // caller is defining the role and must not walk away thinking it capped one.
    if (!RESERVED_ROLE_KEYS.has(roleName) && normalized.tools) {
      throw new Error(`role "${roleName}" cannot declare tools — a tools allowlist is only enforced for the reviewer role; use a template's disabledTools to restrict a seat (${team.file})`);
    }
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(normalized)) return team; // no-op
      throw new Error(`role "${roleName}" already exists on team "${teamName}" with a different definition`);
    }
    // Re-read raw to preserve any hand-authored fields/formatting we don't model,
    // then append the new role and write atomically.
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.roles = raw.roles || {};
    raw.roles[roleName] = def;
    atomicWrite(team.file, JSON.stringify(raw, null, 2));
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
    // Only DESCRIPTIVE fields are editable. C6: tools/type are authority-bearing —
    // dropped by NOT being in this whitelist (silent, per spec). Anything else a
    // caller echoes (e.g. ephemeral) is likewise ignored — this op edits metadata,
    // it doesn't redefine a role's class.
    const EDITABLE = ['brief', 'prompt', 'template', 'standing', 'instantiate'];
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
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.roles = raw.roles || {};
    raw.roles[roleName] = { ...raw.roles[roleName], ...clean };
    normalizeRoleDef(roleName, raw.roles[roleName], team.file);
    atomicWrite(team.file, JSON.stringify(raw, null, 2));
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
    atomicWrite(team.file, JSON.stringify(raw, null, 2));
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
    atomicWrite(team.file, JSON.stringify(raw, null, 2));
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
    atomicWrite(team.file, JSON.stringify(raw, null, 2));
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
// than stored on the def: a role's reachability is a consequence of its
// instantiate class plus the reserved `reviewer` key, and a stored copy would
// drift from the code that actually routes the spawn.
function leadActionLine(team) {
  const sessionRoles = [];
  const subagentRoles = [];
  let hasReviewer = false;
  for (const [role, def] of Object.entries(team.roles || {})) {
    // `team.lead` is a SEAT name, not a role key — comparing against it here
    // would drop an unrelated role from a team whose lead seat happens to
    // share its name.
    if (role === 'lead') continue;
    if (role === 'reviewer') { hasReviewer = true; continue; }
    if (def && def.instantiate === 'subagent') subagentRoles.push(role);
    else sessionRoles.push(role);
  }
  const parts = [];
  if (sessionRoles.length) parts.push('Dispatch: [agent:task add <role>] <spec> — it starts the seat IMMEDIATELY. To file one for later, [agent:task add park <role>] <spec>: the assignee is recorded, the spec is not delivered, and [agent:task assign <id> <role>] releases it. A "do not start" line in the body is NOT read by anything.');
  // Spells out that the intent does the spawning. A lead reading "Review:
  // [agent:team-review]" next to a roster line that said `reviewer (subagent)`
  // reached for its harness subagent tool instead — which gets a reviewer with
  // no tools cap, no verdict intent, and no seat the operator can see.
  if (hasReviewer) parts.push('Review: [agent:team-review] <scope> — the intent spawns the cold reviewer seat itself; do NOT spawn or subagent one by hand.');
  if (subagentRoles.length) {
    parts.push(`Subagent roles (${subagentRoles.join(', ')}): your harness subagent tool, not a seat spawn.`);
  }
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
    // `reviewer` is a reserved key reached by [agent:team-review], which spawns a
    // real ephemeral SESSION seat — its manifest `instantiate` is an internal
    // detail, and printing it as "subagent" told the lead to use its harness
    // subagent tool instead of the intent. Print how the role is reached, and
    // name the intent ONLY to the seat allowed to use it: _handleTeamReview
    // bounces a non-lead, so advertising it to a hand invites a wasted turn.
    const cls = role !== 'reviewer' ? def.instantiate
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
};
