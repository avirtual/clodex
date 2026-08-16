// lib/team-roles.js — pure helpers for the team-management popover (T29 Layer A
// Slice 3). The popover's DOM wiring is imperative + untested (like the checklist
// popovers); these three side-effect-free helpers hold the logic that IS worth a
// unit test: the row-model derived from a manifest, the client-side add-role
// pre-validation, and the C5 block → inline-message formatter.
//
// Pure leaf: no DOM, no window, no requires. Mirrors renderer/lib/checklists.js's
// testable-split convention.

'use strict';

// Operator-owned topology (T29 C1) — the popover shows these rows but offers no
// edit/rename/remove controls (the mutators would bounce them anyway). Kept in
// lockstep with team-manifest.js RESERVED_ROLE_KEYS; the backend is the real gate.
const RESERVED_ROLE_KEYS = new Set(['lead', 'reviewer']);
// Mirror of team-manifest's ROLE_RE (role key) and NAME_RE (template name). These
// are for EARLY client-side feedback only — the backend re-validates via the real
// regexes on every write regardless.
const ROLE_RE = /^[a-zA-Z0-9._-]{1,32}$/;
const NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
// Mirror of team-manifest's ROLE_DISPATCH_VALUES / DEFAULT_ROLE_DISPATCH. An
// absent value on disk IS `standing`, so the row model normalizes to it rather
// than showing a blank the operator would have to interpret.
const DISPATCH_VALUES = ['standing', 'worktree'];
const DEFAULT_DISPATCH = 'standing';

// One display row-model per role in a loaded manifest, in the manifest's key
// order. `readOnly` marks the operator-owned keys (lead/reviewer). Missing
// descriptive fields normalize to '' so the render can show them uniformly.
//
// The editable keys here are pinned against the manifest schema by the
// legibility test: a row model that shows a field no front door sets, or omits
// one that is set, is the drift that test exists to catch.
function teamRoleRows(manifest) {
  const roles = (manifest && manifest.roles) || {};
  return Object.entries(roles).map(([key, def]) => ({
    key,
    brief: (def && def.brief) || '',
    dispatch: (def && def.dispatch) || DEFAULT_DISPATCH,
    prompt: (def && def.prompt) || '',
    template: (def && def.template) || '',
    readOnly: RESERVED_ROLE_KEYS.has(key),
  }));
}

// Client-side pre-check of the add-role form. Returns {ok:true, name, template}
// (template normalized to null when blank) or {ok:false, error}. The backend's
// addRole re-validates + owns the reserved-key mint refusal; this is fast feedback.
function validateAddRole({ name, template } = {}) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return { ok: false, error: 'a role name is required' };
  if (!ROLE_RE.test(n)) return { ok: false, error: 'role name must be 1-32 chars of A-Z a-z 0-9 . _ -' };
  if (RESERVED_ROLE_KEYS.has(n)) return { ok: false, error: `"${n}" is operator-owned — it can't be added here` };
  const t = String(template == null ? '' : template).trim();
  if (t && !NAME_RE.test(t)) return { ok: false, error: 'template must be a bare library-template name (no path)' };
  return { ok: true, name: n, template: t || null };
}

// Build the setRole patch from the row's edit-form values. brief/prompt are
// always sent (blank is a legitimate clear — setRole stores '' for them). A blank
// `template`, however, is OMITTED: backend setRole re-validates `template` as a
// NAME whenever the key is present, and both '' and null throw — this slice has
// no clear-template semantics (flagged as a Slice-2 backend gap). All values are
// trimmed. (Takes the form values only; the role name isn't needed to shape the
// patch — the caller addresses the role separately.)
// `dispatch` is sent whenever the form offers a value the schema knows, INCLUDING
// the default: a two-value picker has no blank state, and omitting `standing`
// would make worktree→standing unreachable from the only door that can undo it.
// An unrecognized value is omitted rather than forwarded — the backend would
// throw and lose the brief/prompt edits sent alongside it.
function buildSavePatch(formValues) {
  const trim = (v) => String(v == null ? '' : v).trim();
  const patch = { brief: trim(formValues && formValues.brief), prompt: trim(formValues && formValues.prompt) };
  const template = trim(formValues && formValues.template);
  if (template) patch.template = template;
  const dispatch = trim(formValues && formValues.dispatch);
  if (DISPATCH_VALUES.includes(dispatch)) patch.dispatch = dispatch;
  return patch;
}

// One-line, newcomer-facing explanation of WHY a reserved (Clodex-managed) role is
// locked, shown on its read-only row (Slice 4 C2). Conveys (a) nothing to do here
// and (b) the reason. lead/reviewer are the only reserved keys today; an unknown
// reserved key gets a safe generic line.
function reservedRoleNote(key) {
  if (key === 'lead') return 'Runs the team. Its role is fixed so the team always has one.';
  if (key === 'reviewer') return "Independently checks the lead's work — locked so a lead can never rewrite its own reviewer.";
  return 'Managed by Clodex — no changes needed here.';
}

// Friendly-units parse for the stall-watchdog field (Slice 4 C1): "30m", "2h",
// "90s", "1d", "1.5h", or a bare number read as MINUTES (the operator-friendly
// default — the old raw-ms field was hostile). Returns {ok:true, ms} (ms>0) or
// {ok:false, error}. The backend re-clamps to [5min, 7d] at read regardless; this
// is input ergonomics only.
const DURATION_UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
function parseDuration(input) {
  const s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) return { ok: false, error: 'enter a duration — e.g. 30s, 5m, 2h, or 500ms' };
  // NB: "ms" must precede "m"/"s" in the alternation or it can never match
  // (this is what lets formatDuration's `${ms}ms` fallback round-trip).
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s);
  if (!m) return { ok: false, error: 'use a number with a unit ms, s, m, h, or d — e.g. 30s, 5m, 2h, 500ms' };
  const ms = Math.round(parseFloat(m[1]) * DURATION_UNITS[m[2] || 'm']);
  if (!(ms > 0)) return { ok: false, error: 'duration must be greater than zero' };
  return { ok: true, ms };
}

// ms → the friendliest EXACT unit for display (1800000 → "30m", 300000 → "5m",
// 7200000 → "2h", 86400000 → "1d"); falls back to seconds, then a bare ms, when
// nothing divides evenly. '' for absent/invalid. Round-trips with parseDuration
// for the values it produces. Used to show a stored/clamped watchdog value back.
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  for (const [unit, mult] of [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]]) {
    if (ms % mult === 0) return `${ms / mult}${unit}`;
  }
  return `${ms}ms`;
}

// A backend C5 fail-close ({seats:[…], tickets:[…]}) → a one-line inline reason
// for the popover, or '' when nothing blocks. Names the blocking seats + open
// tickets so the operator knows what to reassign/retire first (no force/migrate v1).
function formatBlockedBy(blockedBy) {
  if (!blockedBy) return '';
  const parts = [];
  if (Array.isArray(blockedBy.seats) && blockedBy.seats.length) {
    parts.push(`seat(s): ${blockedBy.seats.join(', ')}`);
  }
  if (Array.isArray(blockedBy.tickets) && blockedBy.tickets.length) {
    parts.push(`open ticket(s): ${blockedBy.tickets.join(', ')}`);
  }
  return parts.join('; ');
}

// Can this session row hold a role at all? AGENT types only, as a whitelist so a
// future non-agent type is ineligible by default rather than by being remembered.
// A bash session has no registry entry and no socket, is invisible to
// `[agent:who]` and cannot be DM'd, so a team pointed at one looks configured and
// silently delivers nothing — the exact failure this row exists to expose.
function isAgentSeat(s) {
  return !!s && (s.type === 'claude' || s.type === 'codex');
}

// Which seats may be offered as a team's LEAD (t420). Takes the session rows the
// renderer already holds and the team NAME, returning eligible names in order.
//
// Membership is the row's own `team` field, not a path comparison: session-manager
// computes it as `teamFor(s.cwd)` through resolveTeam → cwdInProject, so this
// inherits BOTH git-worktree widening (a seat in a linked worktree of the root is
// a member) and deepest-root-wins (a nested team's seats belong to the nested
// team, not to this one). Re-deriving it here from `root` would need a `.git` read
// a renderer leaf must not do, and would silently disagree with the engine on
// both counts.
function leadSeatCandidates(sessions, teamName) {
  const team = String(teamName == null ? '' : teamName).trim();
  if (!team) return [];
  return (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && typeof s.name === 'string' && s.name)
    .filter(isAgentSeat)
    .filter((s) => !s.archivedAt)
    .filter((s) => s.team === team)
    .map((s) => s.name);
}

// How the CURRENT lead pointer resolves, for the row's status line. Five states,
// because they have five different fixes and collapsing any two hides one:
//   'live'       — an AGENT session by that name is running now.
//   'ineligible' — a session by that name is running, but it cannot be a lead
//                  (bash: no registry, no socket, unreachable). This must NOT read
//                  as 'live': the pointer is already on disk and already broken,
//                  and "running now" is the single most misleading thing the row
//                  could say about it. setLead accepts the name (NAME_RE only, and
//                  correctly — the writer does not know session types), so the
//                  status line is the only place this can surface.
//   'stopped'    — no live session in THIS window, but a record exists: it restarts
//                  by name, so this is FINE and must not read as broken.
//   'missing'    — nothing by that name, live or persisted. The crypto-app case:
//                  resolves to nothing, and will forever, until it is changed.
// `unset` covers a manifest with no lead string at all.
//
// Takes session ROWS rather than names: the type is what separates the first two
// states, and a name list cannot carry it.
function leadResolution(lead, { sessions, known } = {}) {
  const name = String(lead == null ? '' : lead).trim();
  if (!name) return { state: 'unset', name: '', note: 'No lead seat is set for this team.' };
  const rows = Array.isArray(sessions) ? sessions : [];
  const knownNames = Array.isArray(known) ? known : [];
  const row = rows.find((s) => s && s.name === name);
  if (row) {
    if (isAgentSeat(row)) return { state: 'live', name, note: 'running now' };
    return {
      state: 'ineligible',
      name,
      note: 'this is a bash session — it has no messaging registry, so nothing can reach it; pick or create an agent seat',
    };
  }
  if (knownNames.includes(name)) {
    // "in this window" is load-bearing: the live rows are workspace-scoped while
    // the known names are global, so a lead running in ANOTHER workspace lands
    // here. Without the qualifier this line states a falsehood on the one row
    // whose whole job is to be accurate about what resolves.
    return { state: 'stopped', name, note: 'not running in this window — it restarts under this name' };
  }
  return {
    state: 'missing',
    name,
    note: 'no session by this name exists — this team has no lead until you pick or create one',
  };
}

// teamPreflight findings (a flat array over the whole team) → the per-role
// buckets renderRows needs, in the order the resolver emitted them. A role with
// nothing unresolved is ABSENT from the map rather than present-and-empty: the
// findings array carries problems only, so "no key" is the resolved state and a
// caller that iterates the map gets exactly the rows that owe something.
//
// Pure, and split out for that reason — the popover's DOM wiring is untestable,
// this fold is where a badge could quietly attach to the wrong role.
function preflightByRole(findings) {
  const out = new Map();
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f || typeof f !== 'object') continue;
    const role = typeof f.role === 'string' ? f.role : '';
    if (!role) continue;
    if (!out.has(role)) out.set(role, []);
    out.get(role).push(f);
  }
  return out;
}

module.exports = {
  teamRoleRows, validateAddRole, buildSavePatch, reservedRoleNote, preflightByRole,
  parseDuration, formatDuration, formatBlockedBy,
  leadSeatCandidates, leadResolution,
  DISPATCH_VALUES, DEFAULT_DISPATCH,
};
