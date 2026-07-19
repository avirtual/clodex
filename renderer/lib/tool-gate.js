'use strict';
// tool-gate.js — the New Session dialog's tool decisions. Pure leaf: given the
// selected type and the tools:check report, decide (a) whether Create is allowed +
// the inline notice (Task 12), (b) the prominent missing-CLI overlay plan + its
// dismiss policy (Task 18), and (c) the diag banner's install buttons (Task 18).
// bash has no external CLI, so it is NEVER gated. renderer.js only plumbs these
// into the DOM (disable Create, render the notice/overlay/buttons).
//
// NEW leaf (not a renderer.js extraction), so — following the sandbox-view.js
// precedent — deliberately NOT added to test/free-identifier-leaks.test.js
// RENDERER_SCANNED_MODULES: that guard gates move-only extractions, not fresh
// leaves.

const { installSessionName } = require('../../tool-doctor');

// The install-button descriptor shared by the Create-gate, the prominence overlay
// (Task 18) and the diag banner (Task 18): {tool,command,sessionName,label}. `cmd`
// is the spec's install line; consumed by installSessionParams → openInstallSession.
function installDescriptor(tool, cmd) {
  return { tool, command: cmd, sessionName: installSessionName(tool), label: `Install ${tool}…` };
}

// The two agent CLIs the app can spawn sessions with; both the gate and the
// prominence overlay reason over exactly this set.
const AGENT_TOOLS = ['claude', 'codex'];

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
  const install = (!present && rep.install) ? installDescriptor(type, rep.install) : null;
  return {
    ok: present,
    disabled: !present,
    notice: present ? null : (rep.notice || { kind: 'error', text: `${type} CLI not found on PATH` }),
    install,
  };
}

// Is a tool reported missing by the check? A null report (unknown, pre-probe) is
// NOT missing — the overlay/banner must never fire on unknown (clodex's rule).
function toolMissing(check, tool) {
  const rep = check && check.byTool && check.byTool[tool];
  return !!(rep && rep.present === false);
}

// The prominence overlay decision (Task 18): when the New Session dialog opens on
// a type whose CLI is missing, we raise a dominant "popover on the popover" rather
// than the below-the-fold inline notice. Pure — the renderer plumbs {show,headline,
// tools} into the DOM.
//   type: the selected session type; check: the tools:check payload (or null).
// Returns { show, headline, tools:[{tool,install}] } — install is the descriptor
// or null when the spec carries no remedy. NEVER shows when: type isn't an agent
// type (bash/template), check is null/unknown, or the SELECTED type is present.
// When both agent CLIs are missing the headline + buttons cover both (a can't-do-
// anything state); otherwise just the selected one.
function newSessionOverlayPlan(type, check) {
  const none = { show: false, headline: '', tools: [] };
  if (type !== 'claude' && type !== 'codex') return none;
  if (!toolMissing(check, type)) return none; // present, or unknown/null → never show
  const both = toolMissing(check, 'claude') && toolMissing(check, 'codex');
  const entryFor = (t) => {
    const rep = check.byTool[t];
    return { tool: t, install: (rep && rep.install) ? installDescriptor(t, rep.install) : null };
  };
  if (both) {
    return {
      show: true,
      headline: "No agent CLI is installed — Clodex can't start claude or codex sessions",
      tools: AGENT_TOOLS.map(entryFor),
    };
  }
  return { show: true, headline: `${type} CLI isn't installed`, tools: [entryFor(type)] };
}

// Dismiss/re-raise policy (Task 18) as a tiny pure helper: the overlay shows once
// per dialog-open. `dismissed` is the renderer's per-open flag (reset false on
// open, set true on "Continue anyway"); once dismissed, switching to another
// missing type re-uses the inline treatment — no re-pop until a fresh open.
function shouldRaiseOverlay(plan, dismissed) {
  return !!(plan && plan.show && !dismissed);
}

// Install-button descriptors for the MISSING agent CLIs (Task 18), for the startup
// diag banner's both-missing case. Pure over the tools:check payload; [] when the
// check is null or nothing agentic is missing. Gating on WHETHER to show these
// (i.e. a missing CLI is the banner's actual cause) is the diagnostics payload's
// cliMissingIsCause flag — this leaf only enumerates the buttons.
function agentInstallButtons(check) {
  const out = [];
  for (const tool of AGENT_TOOLS) {
    const rep = check && check.byTool && check.byTool[tool];
    if (rep && rep.present === false && rep.install) out.push(installDescriptor(tool, rep.install));
  }
  return out;
}

// Turn a gate `install` descriptor into concrete createSession params for the
// visible bash install session (Task 14). Pure — `homeDir` (the renderer's cwd
// default) is injected; the installer runs from HOME, not the last-picked repo.
// Returns null when there's nothing to install.
function installSessionParams(install, homeDir) {
  if (!install || !install.command) return null;
  return { name: install.sessionName, type: 'bash', cwd: homeDir, command: install.command };
}

module.exports = {
  newSessionToolGate, installSessionParams,
  newSessionOverlayPlan, shouldRaiseOverlay, agentInstallButtons,
};
