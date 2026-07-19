'use strict';
// tool-gate.js — the New Session dialog's Create-gate decision for the selected
// session type (Task 12). Pure leaf: given the selected type and the tools:check
// report, decide whether Create is allowed + the inline notice to show. bash has
// no external CLI, so it is NEVER gated. renderer.js only plumbs this into the DOM
// (disable Create, render the notice) — the same shape as the docker action gate.
//
// NEW leaf (not a renderer.js extraction), so — following the sandbox-view.js
// precedent — deliberately NOT added to test/free-identifier-leaks.test.js
// RENDERER_SCANNED_MODULES: that guard gates move-only extractions, not fresh
// leaves.

// type: the New Session selector value ('claude' | 'codex' | 'bash').
// check: the tools:check IPC payload — { byTool: { <tool>: { present, notice } } }
//   (or null before the first probe resolves).
// Returns { ok, disabled, notice } — notice is null when ok, else {kind,text}.
function newSessionToolGate(type, check) {
  // Only the CLI-backed types are gated; bash (and any unknown type) is free.
  if (type !== 'claude' && type !== 'codex') {
    return { ok: true, disabled: false, notice: null };
  }
  const rep = check && check.byTool && check.byTool[type];
  // Before the probe resolves (check null), treat as OK — the probe result
  // re-gates the moment it lands; a pessimistic pre-probe block would flash a
  // disabled Create on every open. (The dialog only opens on an explicit action,
  // and the enriched exit toast is the backstop if a stale-present slips through.)
  if (!rep) return { ok: true, disabled: false, notice: null };
  const present = !!rep.present;
  return {
    ok: present,
    disabled: !present,
    notice: present ? null : (rep.notice || { kind: 'error', text: `${type} CLI not found on PATH` }),
  };
}

module.exports = { newSessionToolGate };
