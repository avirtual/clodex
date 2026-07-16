'use strict';
// sandbox-view.js — pure presentation decisions for the Sandbox dialog
// (docs/sandbox-plan.md M2). Kept as a leaf (no DOM, no window.api) so the
// copy-selection logic — which is the part with real branches — is unit-tested
// directly; renderer.js does only the DOM plumbing around these returns.
//
// NEW module (not a renderer.js extraction), so it is deliberately NOT added to
// test/free-identifier-leaks.test.js RENDERER_SCANNED_MODULES — that guard gates
// move-only extractions, not fresh leaves.

// Docker detection → the dialog's top line. The install-vs-start distinction is
// the whole reason detect() separates present from running: the remedy differs.
function detectNotice(detect) {
  const d = detect || {};
  if (!d.present) {
    return { kind: 'error', text: 'Docker isn’t installed. Install Docker Desktop to use the sandbox.' };
  }
  if (!d.running) {
    return { kind: 'warn', text: 'Docker is installed but the daemon isn’t running. Start Docker Desktop, then reopen this dialog.' };
  }
  return { kind: 'ok', text: 'Docker is running.' };
}

// Compose lifecycle state → the status line + whether Start/Stop should read as
// running. absent (never created) and exited both present as "stopped" for the
// button, but the copy differs so the user knows if there's anything to resume.
function statusNotice(state) {
  switch (state) {
    case 'running': return { kind: 'ok', text: 'Sandbox is running.', running: true };
    case 'exited': return { kind: 'idle', text: 'Sandbox is stopped.', running: false };
    default: return { kind: 'idle', text: 'Sandbox has not been created yet.', running: false };
  }
}

// The browser-reachable address of the container's web frontend (the host web
// port publish). localhost, not 127.0.0.1, to match the compose comment + what
// users type.
function openUrl(webPort) {
  return `http://localhost:${webPort}`;
}

// The effective-ports line shown while a box runs (M6b bug #4 follow-on). Ports are
// engine-managed (collision-bumped at Start) with no editable field, so there's no
// "configured vs bumped" to reconcile — just state what the box IS listening on.
// `effective` is status.ports ({web,wirescope,wire} or a subset) or null when
// stopped/absent → '' (the caller hides the line, nothing true to say).
function portsLineText(effective) {
  if (!effective) return '';
  const roles = [['web', 'Web'], ['wirescope', 'Wirescope'], ['wire', 'Peer wire']];
  const parts = [];
  for (const [role, label] of roles) {
    const p = Number(effective[role]);
    if (Number.isFinite(p)) parts.push(`${label} ${p}`);
  }
  return parts.join(' · ');
}

module.exports = { detectNotice, statusNotice, openUrl, portsLineText };
