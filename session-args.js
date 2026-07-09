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

function resolveSessionArgsPatch(patch = {}, prev = null) {
  const {
    agents, denyBuiltins, disabledTools, disabledSkills, injectSkills,
    systemPrompt, systemPromptFile, appendPromptFiles,
  } = patch;
  return {
    agents: agents !== undefined ? (agents || []) : (prev?.agents || []),
    denyBuiltins: denyBuiltins !== undefined ? (denyBuiltins || []) : (prev?.denyBuiltins || []),
    disabledTools: disabledTools !== undefined ? (disabledTools || []) : (prev?.disabledTools || []),
    disabledSkills: disabledSkills !== undefined ? (disabledSkills || []) : (prev?.disabledSkills || []),
    injectSkills: injectSkills !== undefined ? (injectSkills || []) : (prev?.injectSkills || []),
    // undefined = "untouched": keep the persisted value. The edit dialog no longer
    // surfaces the legacy inline body, so it passes systemPrompt undefined and a
    // legacy inline prompt survives editing other settings.
    systemPrompt: systemPrompt !== undefined ? (systemPrompt || null) : (prev?.systemPrompt || null),
    systemPromptFile: systemPromptFile !== undefined ? (systemPromptFile || null) : (prev?.systemPromptFile || null),
    appendPromptFiles: appendPromptFiles !== undefined ? (appendPromptFiles || []) : (prev?.appendPromptFiles || []),
  };
}

module.exports = { resolveSessionArgsPatch };
