// scope-util.js — pure visibility/scope helpers for the clodex skill + agent
// libraries. Both libraries live FLAT under ~/.clodex/{skills,agents}/*.md;
// scope is expressed by two OPTIONAL frontmatter keys, never by folders:
//
//   workspace: <name>     visible only in the workspace with that DISPLAY name
//   sessions: a, b, c     personal — visible only to the named sessions
//                         (session names are globally unique in clodex)
//
// Neither key present  → GLOBAL (visible everywhere — every pre-scope file is
//                        unchanged, so the feature needs zero migration).
// Both keys present    → UNION (a match on either axis makes it visible).
//
// Two consumers: the OFFER surfaces (catalogs) filter with visibleTo() so a
// scoped file isn't presented to a session it doesn't belong to; the SPAWN
// seam unions the `sessions:`-scoped names into the enabled set (assignment =
// intent) via unionEnabled(). `workspace:` scope only OFFERS, never imposes.
//
// Dependency-free (no electron, no fs) so it unit-tests under plain node,
// mirroring agents-util.js / skills-util.js. Callers feed parsed frontmatter
// meta in; the fs-backed libraries (stores.js) and the spawn path own the I/O.

const _toList = (s) => String(s == null ? '' : s).split(',').map((x) => x.trim()).filter(Boolean);

// Scope keys off a parsed frontmatter `meta` object. `workspace` is a single
// trimmed display name (empty string = unset); `sessions` is the comma-list.
function scopeOf(meta) {
  meta = meta || {};
  return {
    workspace: meta.workspace != null ? String(meta.workspace).trim() : '',
    sessions: meta.sessions != null ? _toList(meta.sessions) : [],
  };
}

// Is a library item (its frontmatter meta) visible to a given session/workspace
// context? No scope keys → global (always visible). Otherwise a match on EITHER
// axis suffices (union). A present scope key that the context can't satisfy
// (missing/unmatched) simply doesn't grant visibility on that axis — an absent
// context field never matches a present key.
function visibleTo(meta, ctx = {}) {
  const { workspace, sessions } = scopeOf(meta);
  if (!workspace && sessions.length === 0) return true; // global
  if (workspace && ctx.workspace && workspace === ctx.workspace) return true;
  if (sessions.length && ctx.session && sessions.includes(ctx.session)) return true;
  return false;
}

// Names of library items auto-INCLUDED for a session by `sessions:` scope —
// assignment is intent, so a personal-scoped file is on for its named sessions
// without a per-session opt-in. `workspace:` scope is NOT auto-included (it only
// offers). library: [{ name, meta }, ...]; returns the matching names in list
// order. No session context → nothing auto-included.
function autoEnabledFor(library, session) {
  if (!session) return [];
  const out = [];
  for (const item of library || []) {
    const { sessions } = scopeOf(item && item.meta);
    if (sessions.includes(session)) out.push(item.name);
  }
  return out;
}

// The effective enabled set at spawn: the session's PERSISTED selection unioned
// with the `sessions:`-scoped auto-includes (dedup, persisted order first). Pure
// — the caller (session-manager for agents, writeSkillPlugin for skills) keeps
// this off the persisted record, so it's recomputed every spawn and never
// mutates the user's saved choices.
function unionEnabled(persisted, library, session) {
  return [...new Set([...(persisted || []), ...autoEnabledFor(library, session)])];
}

// Save semantics for a SCOPE-FILTERED checklist: the popover renders only the
// items in scope, so a naive "save the checked boxes" would DROP any persisted
// selection that fell out of scope (never rendered → never checked). Reconcile
// instead: an item the checklist didn't render survives the persisted set
// untouched; among rendered items, the checked ones win. `auto` names (forced on
// by `sessions:` scope, rendered checked+disabled) are excluded so the spawn-time
// union is never written back to the record. Pure — feeds the three scoped Save
// sites (skills-inject, args-dialog agents, Agents popover).
//   effective = (persisted \ rendered) ∪ (checked \ auto)
function reconcilePartialSelection(persisted, rendered, checked, auto = []) {
  const renderedSet = new Set(rendered || []);
  const autoSet = new Set(auto || []);
  const survived = (persisted || []).filter((n) => !renderedSet.has(n));
  const picked = (checked || []).filter((n) => !autoSet.has(n));
  return [...new Set([...survived, ...picked])];
}

module.exports = { scopeOf, visibleTo, autoEnabledFor, unionEnabled, reconcilePartialSelection };
