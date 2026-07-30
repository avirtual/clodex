// No clodex resource lives inside project files: a team is defined entirely
// under ~/.clodex/teams/<name>/. Pure leaf — no electron, injected fs.

'use strict';

const path = require('path');
const os = require('os');

const TEAM_FILE = 'team.json';
const ROLE_RE = /^[a-zA-Z0-9._-]{1,32}$/;
// Team names and seat names share the session-name grammar (CLAUDE.md): a team
// name is BOTH a directory under ~/.clodex/teams/ AND the `<team>-` seat-name
// prefix, so it must be name-legal; top-level `lead` is a seat name.
const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
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
    tools: def.tools ?? null,
    type: def.type ?? null,
  };
}

function createTeamManifest({ fs, clodexHome } = {}) {
  const home = clodexHome || defaultClodexHome();
  const teamsDir = path.join(home, 'teams');

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

  function cwdInProject(cwd, root) {
    if (!cwd || !root) return false;
    const rel = path.relative(path.resolve(root), path.resolve(cwd));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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

function matchSeatRole(team, seatName) {
  if (!team || !seatName || !team.roles) return null;
  if (seatName === team.lead) return 'lead' in team.roles ? 'lead' : null;
  const prefix = `${team.name}-`;
  if (!seatName.startsWith(prefix)) return null;
  const key = seatName.slice(prefix.length).replace(/-\d+$/, '');
  return key in team.roles ? key : null;
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
  if (sessionRoles.length) parts.push('Dispatch: [agent:task add <role>] <spec>.');
  if (hasReviewer) parts.push('Review: [agent:team-review] <scope>.');
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
    const tmpl = def && typeof def.template === 'string' && def.template ? `, tmpl ${def.template}` : '';
    const brief = def && def.brief ? ` — ${def.brief}` : '';
    const live = byRole.get(role);
    const liveStr = live && live.length ? ` · live: ${live.join(', ')}` : '';
    lines.push(`- ${role} (${def.instantiate}${tmpl})${brief}${liveStr}`);
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
