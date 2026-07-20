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
const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

// One display row-model per role in a loaded manifest, in the manifest's key
// order. `readOnly` marks the operator-owned keys (lead/reviewer). Missing
// descriptive fields normalize to '' so the render can show them uniformly.
function teamRoleRows(manifest) {
  const roles = (manifest && manifest.roles) || {};
  return Object.entries(roles).map(([key, def]) => ({
    key,
    brief: (def && def.brief) || '',
    prompt: (def && def.prompt) || '',
    template: (def && def.template) || '',
    instantiate: (def && def.instantiate) || 'session',
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
function buildSavePatch(formValues) {
  const trim = (v) => String(v == null ? '' : v).trim();
  const patch = { brief: trim(formValues && formValues.brief), prompt: trim(formValues && formValues.prompt) };
  const template = trim(formValues && formValues.template);
  if (template) patch.template = template;
  return patch;
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

module.exports = { teamRoleRows, validateAddRole, buildSavePatch, formatBlockedBy };
