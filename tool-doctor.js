'use strict';
// tool-doctor.js — external-tool presence detection ("tool doctor", Task 12).
// Electron-free leaf, DI'd like sandbox.js: probe a list of tool specs via an
// INJECTED whichBin, return a presence report + pure UI-copy mappings. The app
// warns / gates on this BEFORE a user tries to spawn a session whose CLI isn't on
// PATH — node-pty's execvp failure in the forked child is silent (a bare code-1
// exit with no stderr), so without a preflight the tab just appears and dies.
//
// NEW leaf (not a renderer/coordinator extraction), so — following the
// sandbox-view.js precedent — deliberately NOT added to free-identifier-leaks
// SCANNED_MODULES / RENDERER_SCANNED_MODULES: that gate covers move-only
// extractions, not fresh leaves.

const { createDetectCache } = require('./detect-cache');

// Tool specs v1. `bins` are tried in order (first on PATH wins); `neededFor` is a
// human phrase for remedy copy; `install` (optional) is the one-line fix shown in
// the notice. python3 is intentionally ABSENT from the probed set — wirescope
// surfaces its own python error; it's listed in FUTURE_TOOLS, not probed here.
const TOOL_SPECS = [
  // The native installer, not npm: the audience for this remedy is a fresh
  // account/machine that quite likely lacks npm too — curl+bash always exist on
  // macOS, and the native install is what Anthropic recommends (installs to
  // ~/.local/bin, no Node needed, auto-updates).
  { name: 'claude', bins: ['claude'], neededFor: 'Claude sessions', install: 'curl -fsSL https://claude.ai/install.sh | bash' },
  { name: 'codex',  bins: ['codex'],  neededFor: 'Codex sessions',  install: 'npm i -g @openai/codex' },
  { name: 'git',    bins: ['git'],    neededFor: 'worktrees & version control' },
  { name: 'gh',     bins: ['gh'],     neededFor: 'GitHub releases',  install: 'brew install gh' },
  { name: 'docker', bins: ['docker'], neededFor: 'sandboxes' },
  { name: 'ssh',    bins: ['ssh'],    neededFor: 'peer tunnels' },
];
// Future candidates — NOT probed today (their subsystems own their own detection).
const FUTURE_TOOLS = ['python3'];

// Probe one spec: the first bin found on PATH wins. `whichBin(bin)` → absolute
// path | null (engine.js's PATH walk). Returns a stable report shape.
function probeTool(spec, whichBin) {
  for (const bin of spec.bins) {
    const p = whichBin(bin);
    if (p) return { tool: spec.name, present: true, path: p, bin };
  }
  return { tool: spec.name, present: false, path: null, bin: spec.bins[0] };
}

// Probe every spec (default TOOL_SPECS) → report list, in spec order.
function probeTools(whichBin, specs = TOOL_SPECS) {
  return specs.map((s) => probeTool(s, whichBin));
}

// Look up a spec by tool name (a New-Session type maps to a tool: claude/codex).
function specFor(name, specs = TOOL_SPECS) {
  return specs.find((s) => s.name === name) || null;
}

// ── Install sessions (Task 14) ─────────────────────────────────────────────
// The "Install <tool>…" button spawns a PLAIN BASH session that runs the spec's
// `install` line VISIBLY (transparency — the user watches the official installer
// and answers any prompt it raises). Its name follows a single convention so the
// exit→invalidate decision below can recognize it without a side registry.
const INSTALL_SESSION_PREFIX = 'install-';

// Canonical name for a tool's install session (global namespace; the session is a
// private bash shell — no registry/socket).
function installSessionName(tool) {
  return `${INSTALL_SESSION_PREFIX}${tool}`;
}

// Does a session name denote a tool-install session whose completion should bust
// the tool cache? True only for `install-<tool>` where <tool> is a probed spec
// that carries an install line — so a user's own `install-foo` bash shell never
// triggers a needless cache invalidation. Pure decision (Task 14), unit-tested in
// lieu of the exit→invalidate IPC.
function isToolInstallSession(name, specs = TOOL_SPECS) {
  if (typeof name !== 'string' || !name.startsWith(INSTALL_SESSION_PREFIX)) return false;
  const spec = specFor(name.slice(INSTALL_SESSION_PREFIX.length), specs);
  return !!(spec && spec.install);
}

// Pure UI copy for a tool's presence: {kind,text}, mirroring sandbox-view's
// detectNotice shape so the dialog renders it identically. Present → ok. Missing →
// error with the install remedy when the spec carries one.
function toolNotice(report, spec) {
  if (report && report.present) return { kind: 'ok', text: `${(report.tool)} found` };
  const name = (spec && spec.name) || (report && report.tool) || 'tool';
  const install = spec && spec.install;
  const base = `${name} CLI not found on PATH`;
  return { kind: 'error', text: install ? `${base} — install: ${install}` : base };
}

// A TTL+dedupe cache around a full probe (shared detect-cache leaf). get()
// resolves to { list, byTool, cachedAt } where byTool[name] = report + its
// precomputed `notice` (so the renderer needs no copy of its own — the gate leaf
// just selects by type). `whichBin` is injected; `now`/`ttlMs` pass through for
// tests.
function createToolCache({ whichBin, specs = TOOL_SPECS, now, ttlMs } = {}) {
  const probe = () => {
    const list = probeTools(whichBin, specs);
    const byTool = {};
    for (const r of list) {
      const spec = specFor(r.tool, specs);
      // `install` is surfaced as a structured field (not just buried in the notice
      // text) so the dialog can render an Install button off it (Task 14).
      byTool[r.tool] = { ...r, notice: toolNotice(r, spec), install: (spec && spec.install) || null };
    }
    return { list, byTool };
  };
  return createDetectCache({ probe, now, ttlMs });
}

module.exports = {
  TOOL_SPECS, FUTURE_TOOLS, INSTALL_SESSION_PREFIX,
  probeTool, probeTools, specFor, toolNotice, createToolCache,
  installSessionName, isToolInstallSession,
};
