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

const { installSessionName } = require('../../tool-doctor');

// type: the New Session selector value ('claude' | 'codex' | 'bash').
// check: the tools:check IPC payload —
//   { byTool: { <tool>: { present, notice, install } } } (or null pre-probe).
// Returns { ok, disabled, notice, install } — notice is null when ok; install is
// the button descriptor { tool, command, sessionName, label } when the CLI is
// missing AND the spec carries an install remedy, else null (Task 14).
function newSessionToolGate(type, check) {
  // Only the CLI-backed types are gated; bash (and any unknown type) is free.
  if (type !== 'claude' && type !== 'codex') {
    return { ok: true, disabled: false, notice: null, install: null };
  }
  const rep = check && check.byTool && check.byTool[type];
  // Before the probe resolves (check null), treat as OK — the probe result
  // re-gates the moment it lands; a pessimistic pre-probe block would flash a
  // disabled Create on every open. (The dialog only opens on an explicit action,
  // and the enriched exit toast is the backstop if a stale-present slips through.)
  if (!rep) return { ok: true, disabled: false, notice: null, install: null };
  const present = !!rep.present;
  const install = (!present && rep.install)
    ? { tool: type, command: rep.install, sessionName: installSessionName(type), label: `Install ${type}…` }
    : null;
  return {
    ok: present,
    disabled: !present,
    notice: present ? null : (rep.notice || { kind: 'error', text: `${type} CLI not found on PATH` }),
    install,
  };
}

// Turn a gate `install` descriptor into concrete createSession params for the
// visible bash install session (Task 14). Pure — `homeDir` (the renderer's cwd
// default) is injected; the installer runs from HOME, not the last-picked repo.
// Returns null when there's nothing to install.
function installSessionParams(install, homeDir) {
  if (!install || !install.command) return null;
  return { name: install.sessionName, type: 'bash', cwd: homeDir, command: install.command };
}

module.exports = { newSessionToolGate, installSessionParams };
