// session-args.js — the pure field-resolution core of Edit Session, split out of
// main.js's applySessionArgs so it can be unit-tested without loading the
// electron-heavy main process. `resolveSessionArgsPatch(patch, prev)` applies the
// "undefined means untouched" rule: a field left undefined in the patch keeps the
// session's persisted value; any explicit value (including [] or null) overwrites.
// prev is the persisted entry (or null/undefined for a not-yet-persisted name).
//
// applySessionArgs owns the side effects (persist calls, kill+respawn, stripLevel
// re-assert, catch-and-upsert); this owns only the value decisions, which is the
// part worth pinning against drift. Both the local session:setArgs path and the
// peer session-args POST endpoint route through applySessionArgs, so they share
// this resolver transitively.

'use strict';

// sanitizeFlat re-applies the env key/deny/newline gate on the resolved value so
// the deny-list bites "at the door" of every edit (local + peer), not only in the
// textarea parse. env-scopes is a pure (electron-free) leaf, so requiring it here
// keeps this module unit-testable.
const { sanitizeFlat } = require('./env-scopes');
// The intents allowlist is now COLLAPSED HERE rather than in the renderer (plugin
// plan R-INT-4 / MUST-FIX 3): the renderer sends the raw CHECKED set and the
// engine, where the registry is authoritative, decides whether that set collapses
// to the all-enabled default. A renderer computing it from its own catalog copy
// would get the collapse wrong the moment a plugin verb exists — or, in the web
// bundle, the moment its build-time copy went stale. intent-registry is a pure
// leaf, so requiring it keeps this module unit-testable.
const { allowlistFromChecked } = require('./intent-registry');

function resolveSessionArgsPatch(patch = {}, prev = null) {
  const {
    agents, denyBuiltins, disabledTools, disabledSkills, injectSkills,
    systemPrompt, systemPromptFile, appendPromptFiles, intents, execCommands, env, plugins,
  } = patch;
  return {
    agents: agents !== undefined ? (agents || []) : (prev?.agents || []),
    denyBuiltins: denyBuiltins !== undefined ? (denyBuiltins || []) : (prev?.denyBuiltins || []),
    disabledTools: disabledTools !== undefined ? (disabledTools || []) : (prev?.disabledTools || []),
    disabledSkills: disabledSkills !== undefined ? (disabledSkills || []) : (prev?.disabledSkills || []),
    injectSkills: injectSkills !== undefined ? (injectSkills || []) : (prev?.injectSkills || []),
    // Exec-command GRANT allowlist — array-shaped like agents/disabledTools above
    // (undefined = untouched keeps the persisted grants; an explicit value, incl []
    // = revoke all, overwrites). The Edit dialog OWNS it as a Claude-only section
    // and sends the checked grants; a peer patch NEVER carries it (exec is local-
    // only — stripped at the wire in both directions, see withoutExecGrants), so
    // over-the-wire this always resolves to undefined = the box's grants preserved.
    execCommands: execCommands !== undefined
      ? (Array.isArray(execCommands) ? execCommands.map(String) : [])
      : (Array.isArray(prev?.execCommands) ? prev.execCommands : []),
    // undefined = "untouched": keep the persisted value. The edit dialog no longer
    // surfaces the legacy inline body, so it passes systemPrompt undefined and a
    // legacy inline prompt survives editing other settings.
    systemPrompt: systemPrompt !== undefined ? (systemPrompt || null) : (prev?.systemPrompt || null),
    systemPromptFile: systemPromptFile !== undefined ? (systemPromptFile || null) : (prev?.systemPromptFile || null),
    appendPromptFiles: appendPromptFiles !== undefined ? (appendPromptFiles || []) : (prev?.appendPromptFiles || []),
    // Intents gate allowlist. Unlike the fields above (empty = a real clear), the
    // gate's shapes are: an array (incl [] = everything gated, a real value) or null
    // (all-enabled — the absent/default state). The Edit dialog now OWNS it and sends
    // the CHECKED set (an array; null when the section is hidden); undefined =
    // untouched keeps the persisted gate for any patch that omits intents.
    // `allowlistFromChecked` is what turns the checked set into the persisted
    // value: every non-privileged core box checked → null (the living all-enabled
    // default, stored as ABSENCE), otherwise the subset in catalog order followed
    // by any granted plugin verbs. It is idempotent on an already-collapsed value,
    // so a peer patch echoing a previously persisted array resolves to itself.
    intents: intents !== undefined
      ? (Array.isArray(intents) ? allowlistFromChecked(intents.map(String)) : null)
      : (Array.isArray(prev?.intents) ? prev.intents : null),
    // Session env — the Edit dialog OWNS it (LOCAL-only, like execCommands: a peer
    // patch never carries the key, so over the wire this always resolves to
    // undefined = the box's env preserved). undefined = untouched keeps the
    // persisted env; an explicit map is sanitizeFlat'd (deny-list/key/newline gate
    // applied server-side); null/empty = a real clear. sanitizeFlat({}) is {}, and
    // persistence.setEnv drops the key on an empty result, so "cleared" is stored
    // as ABSENCE — matching create(), which only writes env when non-empty.
    env: env !== undefined
      ? sanitizeFlat(env)
      : ((prev?.env && typeof prev.env === 'object') ? prev.env : {}),
    // The seat's plugin list. Same two shapes as `intents` — an array (incl []
    // = this seat has no plugins, a real value) or null (all enabled, stored as
    // absence) — and the same undefined = untouched rule. A peer patch never
    // carries the key, so over the wire this resolves to the box's list.
    plugins: plugins !== undefined
      ? (Array.isArray(plugins) ? plugins.map(String) : null)
      : (Array.isArray(prev?.plugins) ? prev.plugins : null),
  };
}

// Exec grants are a LOCAL-ONLY capability — they must never cross the peer wire
// in either direction (a viewer editing a box session can't read the box's grants
// nor set them; grants ride operator-authored spawn templates on the owning box).
// This returns a shallow clone with `execCommands` removed, used to sanitize BOTH
// the readSessionArgs result the box hands out AND the patch a peer POSTs back
// (belt and suspenders — the renderer already hides the section on a peer row).
// A nullish input passes through unchanged.
function withoutExecGrants(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { execCommands, ...rest } = obj;
  return rest;
}

// Drop EVERY local-only capability before it crosses the peer wire: exec grants
// (see above) AND per-session env (T46b — values may be credentials and session
// env has no secret masking). Applied by remote-wiring in BOTH directions
// (readSessionArgs result outbound, peer patch inbound), so a viewer can neither
// read nor set the box's env. This is a NAMED barrier on purpose: the outbound
// strip is the only thing between a peer viewer and credential values, so a
// future "simplify: return withoutExecGrants(base)" refactor can't silently
// re-leak env — this function is pinned in both directions. A nullish input
// passes through unchanged.
function withoutLocalOnly(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { execCommands, env, ...rest } = obj;
  return rest;
}

module.exports = { resolveSessionArgsPatch, withoutExecGrants, withoutLocalOnly };
