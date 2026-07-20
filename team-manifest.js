// team-manifest.js — project/team resolution for the teams feature
// (docs/teams-design.md). Pure leaf like clodex-paths: no electron, injected
// fs, NOT in the leak-scanner SCANNED lists.
//
// THE MODEL (Bogdan ruling 2026-07-19: NO clodex resource lives inside project
// files — opening a repo in clodex leaves zero droppings). A team is defined
// entirely under `~/.clodex/teams/<team-name>/`:
//   teams/<name>/team.json     — the manifest (gains a REQUIRED `root` field:
//                                 the absolute path of the project it manages)
//   teams/<name>/tasks/<id>/   — task artifacts (read by scripts/task-ledger)
//   teams/<name>/…             — decision log etc. later
//
// Resolution is by `root` containment, NOT an upward .clodex walk: a session
// (by cwd) belongs to the team whose `root` contains that cwd. On nesting the
// DEEPEST containing root wins. `root` is the join key; every session has a
// cwd. Workspaces are topical/visual groupings and are deliberately NOT
// involved here.
//
// Manifest shape (all of `roles` optional beyond the lead's entry):
//   {
//     "root": "/Users/me/projects/shop",
//     "lead": "lead",
//     "roles": {
//       "lead":     { "template": "fable-lead", "standing": "prompts/lead.md" },
//       "reviewer": { "template": "sonnet-review", "instantiate": "subagent" },
//       "runner":   { "template": "haiku-runner", "ephemeral": true }
//     }
//   }
//
// `instantiate` is a POLICY (session|subagent, default "session"), not a
// taxonomy — see the design doc's promotion path. `standing` and `template`
// are references resolved elsewhere (project-relative file / library template
// name); this module only validates shape, it does no lookups.
//
// Team-of-1 keeps the bare session name (Bogdan's ruling #3): naming
// conventions like `<project>-<role>` are applied by CALLERS when a team
// grows; this module doesn't mint names.

'use strict';

const path = require('path');
const os = require('os');

const TEAM_FILE = 'team.json';
// Role KEYS in the roles map (shorter than a full seat name; callers compose
// `<team>-<role>` seat names from these).
const ROLE_RE = /^[a-zA-Z0-9._-]{1,32}$/;
// Team names and seat names share the session-name grammar (CLAUDE.md): a team
// name is BOTH a directory under ~/.clodex/teams/ AND the `<team>-` seat-name
// prefix, so it must be name-legal; top-level `lead` is a seat name.
const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const INSTANTIATE = new Set(['session', 'subagent']);

// Stock role definitions the front door mints: createTeam writes lead+reviewer
// into the default manifest; the join flow's `hand` (and the ipc handler) reads
// its canonical def here so every team speaks the same role vocabulary. Each
// carries a one-line `brief` — what the role is for, in the lead's terms — that
// rides the roster (never the system prompt). Spread a copy before writing so a
// caller can't mutate the shared object.
const STOCK_ROLE_DEFS = {
  lead: { prompt: 'clodex-team-lead', brief: 'team lead; holds durable context, dispatches specs, verifies and integrates the work.' },
  hand: { instantiate: 'session', prompt: 'clodex-team-hand', brief: 'implementer; executes a spec to done, one distilled report per task.' },
  reviewer: { instantiate: 'subagent', prompt: 'clodex-team-reviewer', brief: 'reviewer; an independent verification pass, invoked on demand.' },
};

function defaultClodexHome() {
  return process.env.CLODEX_HOME || path.join(os.homedir(), '.clodex');
}

// Validate + default one role def (shared by loadManifest and addRole so both
// speak one schema). Throws Error naming `file` on a bad field. Returns the
// canonical `{ template, standing, prompt, instantiate, ephemeral, brief,
// tools, type }` shape in fixed key order (so JSON.stringify gives a stable
// equality key for addRole's no-op-if-equal check).
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
  // `tools` (optional) is an ALLOWLIST of built-in tool names for the seat —
  // callers invert it against the tool catalog into the existing disabledTools
  // denylist (e.g. a reviewer restricted to Read/Grep/Glob). `type` (optional)
  // is the session type (claude|codex) the role instantiates as; absent → the
  // caller's default. Both additive + backward-compatible: an absent field is
  // null, so a manifest that predates them is unchanged.
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
    tools: def.tools ?? null,
    type: def.type ?? null,
  };
}

function createTeamManifest({ fs, clodexHome } = {}) {
  const home = clodexHome || defaultClodexHome();
  const teamsDir = path.join(home, 'teams');

  // Crash-safe write through the injected fs (mirrors fs-util's tmp+rename
  // convention; no fsync — the injected fs is the real one under test and the
  // durability guarantee we need here is atomic replace, not power-loss).
  function atomicWrite(file, data) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(file)}.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }

  // Every team directory name under ~/.clodex/teams/ (dotfiles excluded).
  // Never throws — an absent/unreadable teams dir means "no teams".
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

  // Parse + validate the manifest for team `name` (a dir under teams/).
  // Returns { name, root, lead, roles, file } with defaults applied. Throws
  // Error with a message suitable for showing to an agent/operator verbatim —
  // callers decide loud-vs-silent.
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
    // `root` is the project this team manages — REQUIRED and absolute (it's the
    // cwd-containment join key; a relative root has no meaning outside a cwd).
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
    // The lead role is a seat by definition — it's the team's point of contact.
    if (roles.lead.instantiate !== 'session') {
      throw new Error(`lead role "lead" must have instantiate: session (${file})`);
    }
    // `watchdogMs` (optional) overrides the ticket stall watchdog's default STALL_MS
    // for this team (Task 25). A positive number of milliseconds; absent → the
    // handler's default. Additive/back-compat — an older manifest is unchanged.
    const watchdogMs = m.watchdogMs;
    if (watchdogMs != null && (typeof watchdogMs !== 'number' || !Number.isFinite(watchdogMs) || watchdogMs <= 0)) {
      throw new Error(`team.json "watchdogMs" must be a positive number (${file})`);
    }
    return { name, root: path.resolve(root), lead, roles, file, watchdogMs: watchdogMs ?? null };
  }

  // A session (by cwd) belongs to project `root` iff its cwd is root or under
  // it. Pure string math; no fs.
  function cwdInProject(cwd, root) {
    if (!cwd || !root) return false;
    const rel = path.relative(path.resolve(root), path.resolve(cwd));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  // Resolve the team owning `cwd`: scan every teams/<name>/team.json, validate,
  // and return the one whose `root` contains cwd. On nesting the DEEPEST root
  // wins (a containing pair is always ancestor/descendant, so the longer
  // resolved root is the descendant). Invalid manifests are skipped, not
  // thrown — one broken team must not break resolution for the rest. Returns
  // the rich { name, root, lead, roles, file } or null.
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

  // Core-facing thin wrapper: the project root STRING (or null). Kept a plain
  // string so the team-retire authorization check's `requesterRoot ===
  // targetRoot` comparison in session-manager stays valid without a core edit
  // (the rich shape is resolveTeam's job).
  function findProjectRoot(cwd) {
    const team = resolveTeam(cwd);
    return team ? team.root : null;
  }

  // Create a team: write teams/<name>/team.json with the default manifest and
  // adopt `lead` (a seat name) as its lead. Atomic tmp+rename. Refusals (throw,
  // message shown verbatim): (1) a team named `name` already exists; (2) `root`
  // exactly equals an existing team's root — nesting is fine (resolveTeam's
  // deepest-root rule disambiguates) but an EXACT duplicate makes resolution
  // ambiguous; (3) `name` off the session-name charset (it becomes both a
  // directory and the `<team>-` seat prefix). Returns the loaded manifest.
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
    // Duplicate team name: a manifest already on disk under this name.
    let exists = false;
    try { fs.readFileSync(file, 'utf-8'); exists = true; } catch {}
    if (exists) throw new Error(`team "${name}" already exists`);
    // Duplicate exact root: scan existing teams and refuse an equal root.
    const resolvedRoot = path.resolve(root);
    for (const other of listTeams()) {
      let m;
      try { m = loadManifest(other); } catch { continue; }
      if (m.root === resolvedRoot) {
        throw new Error(`team "${other}" already owns root ${resolvedRoot}`);
      }
    }
    // Default roles scaffold: lead + hand + reviewer, so a fresh team is
    // briefed out of the box (T26) — each seat carries its stock role prompt,
    // and the reviewer is a read-only subagent (Read/Grep/Glob). A caller may
    // pass its own non-empty `roles` map to override; caller-supplied roles win
    // and are never overwritten by the scaffold.
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

  // Add a role to an existing team (the join flow). On an EXISTING role name:
  // NO-OP if the normalized def deep-equals the stored one (the second hand
  // riding the existing `hand` entry), REFUSE (throw) if it differs — a join
  // never mutates a role's definition. Validates `def` through the shared role
  // schema (bad field throws naming the file). Returns the loaded manifest.
  function addRole(teamName, roleName, def) {
    const team = loadManifest(teamName); // throws if the team is missing
    if (!ROLE_RE.test(roleName)) {
      throw new Error(`role name "${roleName}" must match ${ROLE_RE} (${team.file})`);
    }
    const normalized = normalizeRoleDef(roleName, def, team.file);
    const existing = team.roles[roleName];
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

  return {
    resolveTeam, findProjectRoot, loadManifest, listTeams, cwdInProject,
    createTeam, addRole, teamsDir, TEAM_FILE,
  };
}

// The seat's role on a team, under the ROLE-KEYED manifest schema. Binding is
// DERIVED, never stored per-seat: the seat named by top-level `lead` holds the
// `lead` role; any other seat binds by the `<team>-<role>` convention — strip
// the `<team>-` prefix and a trailing `-N` collision suffix to get the role
// key. A seat that is neither the lead nor a `<team>-…` name, or whose derived
// key names no role, is a non-member → null. Pure.
function matchSeatRole(team, seatName) {
  if (!team || !seatName || !team.roles) return null;
  if (seatName === team.lead) return 'lead' in team.roles ? 'lead' : null;
  const prefix = `${team.name}-`;
  if (!seatName.startsWith(prefix)) return null;
  const key = seatName.slice(prefix.length).replace(/-\d+$/, '');
  return key in team.roles ? key : null;
}

// Render the spawn-time team-context block appended to a seat's system-prompt
// material (session-manager wires this at the prompt-assembly callsite, NOT
// inside ipc-prompt). PER-SEAT-INVARIANT ONLY — the roster listing moved OUT
// (composition changes over a seat's life; the system prompt must stay
// cache-stable), so this is just the identity line that never changes for the
// life of the seat. Live composition arrives as data (roster message + deltas);
// ground truth is the clodex-team roster pull. Pure string work — no fs, no
// electron. Returns the block WITHOUT a leading/trailing blank line.
function formatTeamBlock(team, seatName) {
  const mine = matchSeatRole(team, seatName);
  const yourRole = mine || 'none — not a manifest role';
  return [
    '# Team',
    `You are seat ${seatName} on team ${team.name} (root ${team.root}). Your role: ${yourRole}.`,
    'Team composition arrives in your context; ground truth: [agent:exec clodex-team] roster.',
  ].join('\n');
}

// Render the initial-roster message (sender `team`) injected once after a seat
// registers: the roles, their briefs, which class each is (session|subagent),
// and which seats are currently live per role. `liveSeats` is a list of live
// seat NAMES on the team; roles are derived via matchSeatRole. A role with no
// live seat lists none. Pure.
function formatRoster(team, liveSeats = []) {
  const byRole = new Map();
  for (const seat of liveSeats) {
    const role = matchSeatRole(team, seat);
    if (!role) continue;
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(seat);
  }
  const lines = [`[team ${team.name}] roster (lead: ${team.lead})`];
  for (const [role, def] of Object.entries(team.roles)) {
    const brief = def.brief ? ` — ${def.brief}` : '';
    const live = byRole.get(role);
    const liveStr = live && live.length ? ` · live: ${live.join(', ')}` : '';
    lines.push(`- ${role} (${def.instantiate})${brief}${liveStr}`);
  }
  lines.push('Ground truth on demand: [agent:exec clodex-team] roster.');
  return lines.join('\n');
}

// One-line composition delta (sender `team`, passive class) sent to the OTHER
// live seats when the team changes. `verb` is spawned|retired|archived (seat
// events) or added (a role with no seat). Pure.
function formatCompositionDelta(teamName, verb, { seat = null, role = null } = {}) {
  if (verb === 'added') return `[team ${teamName}] role ${role} added (no seat)`;
  return `[team ${teamName}] seat ${seat} ${verb}${role ? ` (role: ${role})` : ''}`;
}

module.exports = {
  createTeamManifest, matchSeatRole, formatTeamBlock, formatRoster,
  formatCompositionDelta, STOCK_ROLE_DEFS, TEAM_FILE,
};
