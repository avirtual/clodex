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
// The reserved keys the OPERATOR may remove and re-add (t421). `lead` is absent
// on purpose and not an oversight: loadManifest hard-requires it, so a team
// without one fails to load and reads as no team at all. Mirrors the backend
// split — removeRole refuses `lead` for everyone, reserved-otherwise only
// without the operator opt-in.
const REMOVABLE_RESERVED_ROLE_KEYS = new Set(['reviewer']);
// Mirror of team-manifest's ROLE_RE (role key) and NAME_RE (template name). These
// are for EARLY client-side feedback only — the backend re-validates via the real
// regexes on every write regardless.
const ROLE_RE = /^[a-zA-Z0-9._-]{1,32}$/;
const NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
// Mirror of team-manifest's ROLE_DISPATCH_VALUES / DEFAULT_ROLE_DISPATCH. An
// absent value on disk IS `standing`, so the row model normalizes to it rather
// than showing a blank the operator would have to interpret.
const DISPATCH_VALUES = ['standing', 'spawn', 'worktree'];
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
    // Relative to the team root; '' means the seat boots at the root itself.
    cwd: (def && def.cwd) || '',
    dispatch: (def && def.dispatch) || DEFAULT_DISPATCH,
    prompt: (def && def.prompt) || '',
    template: (def && def.template) || '',
    readOnly: RESERVED_ROLE_KEYS.has(key),
  }));
}

// What the operator loses by removing a reserved role, shown IN the confirm.
// Removal is destructive, one click away, and the consequence is invisible from
// the popover — it only shows up a ticket later, at the review step.
function reservedRemovalWarning(key) {
  if (key === 'reviewer') {
    return 'Tickets on this team will escalate to you at the review step instead of getting a cold reviewer.';
  }
  return 'This role will no longer exist on the team.';
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
  // Always sent, blank INCLUDED — unlike `template`, blank is a legitimate clear
  // here (setRole deletes the key on an empty value), and omitting it would make
  // "put this role back at the team root" unreachable from the only door that
  // can undo it. Backend validates the non-blank case; a bad path is refused
  // there with the reason, so no mirror of that check belongs in this leaf.
  patch.cwd = trim(formValues && formValues.cwd);
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

// A lead RESOLUTION (not the raw lead string — the caller already holds one, and
// computing it twice invites the two calls to disagree) → which of three layouts
// the popover renders.
//
//   'setup'  — no lead at all: one decision, nothing else on screen.
//   'repair' — the pointer names something that does not resolve.
//   'normal' — the full editor.
//
// `stopped` is NORMAL, not repair: its own note says it restarts under this name,
// so it is known-and-restartable and must not read as broken. An UNKNOWN state
// falls to 'repair' rather than 'normal' — a state this function cannot reason
// about must land in the mode that still shows everything, never in the one that
// hides the lead decision.
//
// 'setup' is UNREACHABLE through the popover's only manifest source today:
// `team:get` goes through loadManifest, which refuses a team.json whose `lead`
// does not match NAME_RE, so a lead-less manifest never reaches a render. It is
// kept because the alternative is an un-mapped state falling into 'normal' if a
// load path is ever loosened — do not "simplify" it away, and do not describe it
// to operators as a state they can be in.
function teamStage(leadRes) {
  const state = leadRes && typeof leadRes.state === 'string' ? leadRes.state : '';
  if (state === 'unset') return 'setup';
  if (state === 'stopped' || state === 'live') return 'normal';
  return 'repair';
}

// One SUMMARY row per role, in manifest key order — the collapsed line the
// popover leads with. Deliberately a separate function from teamRoleRows rather
// than a widening of it: that model's keys are pinned against the manifest schema
// by the legibility test, so any key added there is read as a new schema field.
//
// `seats` answers the question the popover was opened for and could not previously
// answer — which seats are actually filling this role. The rows carry `role`
// already (session-manager's list() resolves it through the same matchSeatRole the
// backend uses); this leaf must NOT re-derive it, because that resolution strips an
// `-r<N>` review tail then a numeric one and guards its lookup with hasOwnProperty,
// and a second copy of that in a second process is the divergence this codebase
// keeps paying for.
//
// The team filter is not decoration: session rows are workspace-scoped, not
// team-scoped, so two teams open in one window both have a `hand` and matching on
// the role key alone would count each other's seats.
function roleSummaries(manifest, sessions, { lead } = {}) {
  const roles = (manifest && manifest.roles) || {};
  const teamName = (manifest && manifest.name) || '';
  const rows = (Array.isArray(sessions) ? sessions : []).filter((s) => s && typeof s.name === 'string' && s.name);
  const leadName = String(lead == null ? '' : lead).trim();
  return Object.entries(roles).map(([key, def]) => {
    // The lead SEAT comes from the pointer, not from role matching, because that
    // is how the backend resolves it (matchSeatRole short-circuits on
    // `seatName === team.lead`). A lead seat whose name does not follow the
    // `<team>-<role>` convention is the normal case, not an edge one. With NO
    // pointer set there is nothing to short-circuit on, so role matching is then
    // the correct answer — the same order the backend takes.
    const mine = key === 'lead' && leadName
      ? rows.filter((s) => s.name === leadName)
      : rows.filter((s) => s.role === key && s.team === teamName);
    const names = mine.map((s) => s.name);
    const working = mine.filter((s) => s.activity && s.activity !== 'idle').length;
    const total = names.length;
    let note;
    // "in this window" is load-bearing for the same reason leadResolution's
    // `stopped` note carries it: these rows are workspace-scoped, so a seat
    // filling this role in ANOTHER window counts zero here. Without the
    // qualifier the row states a falsehood about a running seat.
    if (total === 0) note = 'no seat in this window';
    else if (total === 1) note = names[0];
    else note = `${total} seats · ${working} working`;
    // Fail-closed on an unrecognized value, unlike teamRoleRows: this feeds a
    // display CHIP with no picker behind it to correct it, so a hand-edited
    // team.json must not get a made-up dispatch mode rendered as if the app
    // honoured it. What it actually behaves as is the default.
    const raw = (def && def.dispatch) || DEFAULT_DISPATCH;
    return {
      key,
      dispatch: DISPATCH_VALUES.includes(raw) ? raw : DEFAULT_DISPATCH,
      readOnly: RESERVED_ROLE_KEYS.has(key),
      seats: { total, working, names },
      note,
    };
  });
}

// The stock roles this team does NOT have, offered back as cards. `lead` is
// absent on purpose: loadManifest hard-requires it, so a team without one never
// loads and the lead decision has its own block. `reviewer` is the removable
// reserved key; `hand` is not reserved at all and can simply be removed like any
// other role — the team then silently has no implementer, with no symptom until
// a dispatch has nowhere to go.
const OFFERABLE_STOCK_ROLE_KEYS = ['hand', 'reviewer'];
function absentStockRoles(manifest) {
  const roles = (manifest && manifest.roles) || {};
  return OFFERABLE_STOCK_ROLE_KEYS.filter((k) => !roles[k]);
}

// The one-liner on an absent stock role's offer card. Says what is happening NOW,
// not merely what the role would do — these states are easy to reach by accident
// and give no other symptom until a ticket is already in flight.
//
// A fixed renderer-side string, NOT a mirror of the backend's STOCK_ROLE_DEFS
// brief: nothing here is written to disk (the def the Enable button mints comes
// from the backend), so this cannot drift into a second source of truth for what
// a role IS. It is display copy, like reservedRoleNote beside it.
function absentStockNote(key) {
  if (key === 'reviewer') {
    return 'Not on this team. Tickets escalate to the lead at the review step. Add it back to get an independent review pass.';
  }
  if (key === 'hand') {
    return 'Not on this team. Nothing implements the specs the lead writes — dispatched work has no seat to land on. Add it back to get an implementer.';
  }
  return 'Not on this team.';
}

// How tickets would reach a role this team does not have yet (R2: the dispatch
// CONCEPT stays visible even where its field is not). A FIXED string, not a value
// read off a def: no stock role ships a `dispatch`, so there is nothing to read —
// inventing one here would put a mode on screen that the mint does not write.
function offerDispatchLine() {
  return 'Runs as: standing — the live seat holding this role gets the spec.';
}

// Which of `cwd`/`template` the editor shows for a given dispatch, and in what
// state (R4). Both fields are inert for a `standing` role: `template` is consumed
// only by resolveSeatShape, reached on the spawn paths, and `cwd` likewise — a
// standing role's seat is operator-created and passes through neither.
//
//   'edit'   — spawn/worktree: the field does something, edit it normally.
//   'hidden' — standing AND stored blank: omit the field entirely.
//   'stale'  — standing AND a value IS stored: shown, inactive, with a Clear.
//
// The 'stale' state is not a nicety. buildSavePatch ALWAYS sends `cwd`, blank
// included, because blank is the only way to clear it — so hiding a NON-EMPTY
// cwd would keep submitting a value the operator can neither see nor remove.
// The pleasant consequence of splitting the two: 'hidden' applies only to an
// already-empty value, so hiding a field can never lose data.
//
// Fail-closed like roleSummaries, not like teamRoleRows: an unrecognized
// dispatch reveals AS IF standing, because a hand-edited value this build does
// not model must never cause a field it might depend on to vanish. The value is
// not written back here — normalization for display only.
//
// A separate leaf from teamRoleRows on purpose: that model's keys are pinned
// against the manifest schema by the legibility test, so a reveal key added
// there would read as a sixth schema field.
function fieldReveal(dispatch, { cwd, template } = {}) {
  // Membership, NOT a trim-then-compare: every consumer of this value is strict
  // (loadManifest refuses an off-enum `dispatch` outright, and resolveSeatShape
  // compares with ===), so a padded " spawn " does not behave as spawn anywhere.
  // Trimming here would show two live fields for a role that dispatches standing.
  const active = dispatch === 'spawn' || dispatch === 'worktree';
  const state = (v) => {
    if (active) return 'edit';
    // Trimmed for EMPTINESS only: buildSavePatch trims before sending, so a
    // whitespace-only value already submits as cleared and offering a Clear for
    // it would be a button that changes nothing.
    return String(v == null ? '' : v).trim() ? 'stale' : 'hidden';
  };
  return { cwd: state(cwd), template: state(template) };
}

// Does the reveal need REBUILDING, and what does it reveal now? Split out of the
// popover because the DOM half is untestable and this decision is where unsaved
// operator input gets destroyed.
//
// The rebuild empties a container and re-seeds it, so doing it when nothing
// changed state silently reverts whatever the operator had typed but not saved.
// Two transitions where that bit: typing a new `cwd` and then picking a
// different ACTIVE dispatch (edit → edit, nothing needed rebuilding), and
// clearing a stale `cwd` then switching to spawn to make it live (the cleared
// field came back holding the old stored value, and the next Save wrote it).
//
// The split that makes both halves correct: the STATE is decided from the stored
// def (below), while the VALUE the caller re-seeds with is what the fields
// currently hold. Seeding from the stored def would silently revert unsaved
// input; deciding the state from the live input would write it.
//
// A field going TO `hidden` therefore drops its value, and that stays right:
// `hidden` means nothing is stored, so an unsaved value there is one the
// operator typed under a dispatch that consumed it and then moved away from —
// dropping it writes nothing haunted, which is the whole point.
function reconcileReveal(prevReveal, dispatch, stored) {
  // STATE from what is on DISK, deliberately — `stale` means "a value is stored
  // and this dispatch does not consume it", which is a fact about the manifest,
  // not about the textbox. Deciding it from the live input instead would promote
  // a value the operator merely TYPED into a stale-and-disabled field, and Save
  // reads disabled inputs too: a standing role would be written a cwd that had
  // never been on disk — the haunted config R4 exists to prevent. The VALUE is
  // carried forward separately, by the caller.
  const reveal = fieldReveal(dispatch, stored);
  const rebuild = !prevReveal
    || prevReveal.cwd !== reveal.cwd
    || prevReveal.template !== reveal.template;
  return { reveal, rebuild };
}

// Which fields the editor may offer a CLEAR button for. Not a style choice: a
// Clear is a promise that Save removes the value, and it can only be kept where
// buildSavePatch actually transmits a blank.
//
// `cwd` qualifies — buildSavePatch always sends it, blank included, and setRole
// deletes the key on an empty value. `template` does NOT: buildSavePatch OMITS a
// blank template because setRole validates any present `template` against
// NAME_RE and throws on ''. A Clear there would round-trip to "saved" with the
// value still on disk and no error anywhere — telling the operator a removal
// happened that did not. Derived from buildSavePatch rather than listed, so the
// two cannot drift apart.
function clearableFields() {
  const blanked = buildSavePatch({ brief: '', prompt: '', cwd: '', template: '' });
  return ['cwd', 'template'].filter((f) => f in blanked);
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
  reservedRemovalWarning,
  parseDuration, formatDuration, formatBlockedBy,
  leadSeatCandidates, leadResolution,
  teamStage, roleSummaries, absentStockRoles, absentStockNote, offerDispatchLine, fieldReveal,
  reconcileReveal, clearableFields,
  DISPATCH_VALUES, DEFAULT_DISPATCH, REMOVABLE_RESERVED_ROLE_KEYS, OFFERABLE_STOCK_ROLE_KEYS,
};
