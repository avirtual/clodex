'use strict';
// placement.js — pure decisions for the New Session "Run in" placement selector
// (docs/sandbox-plan.md M3). Host vs Sandbox placement: Sandbox routes the
// create through the `sandbox` peer (container-side), so cwd is a container path
// and the rich fields (skills/prompts/tools/proxy/intents/exec) don't cross the
// create-on-peer wire until M5. This leaf holds the branch logic; renderer.js
// does the DOM plumbing. NEW module — deliberately NOT in the leak-scanner's
// RENDERER_SCANNED_MODULES (that guard is for move-only extractions).

// Container-side default working directory for a sandbox session — the bind /
// named-volume mount point in docker/web/{Dockerfile,compose.yaml}.
const SANDBOX_PLACEMENT_CWD = '/home/clodex/work';

// Is the managed sandbox peer registered? The selector is shown ONLY when it is
// — non-sandbox users see zero placement noise.
function hasSandboxPeer(peers) {
  return !!(peers || []).find((p) => p && p.id === 'sandbox');
}

// Placement flips a container path vs a host path, but must not clobber a cwd the
// user typed. Only swap when the field still holds the OTHER placement's default:
// host-default → sandbox default on entering sandbox, and back on leaving. Any
// hand-edited value is preserved.
function nextCwd(placement, currentCwd, hostDefault) {
  if (placement === 'sandbox') {
    return currentCwd === hostDefault ? SANDBOX_PLACEMENT_CWD : currentCwd;
  }
  return currentCwd === SANDBOX_PLACEMENT_CWD ? hostDefault : currentCwd;
}

// The rich per-session fields are unavailable for sandbox placement until the
// create-on-peer wire carries them (M5) — greyed, not sent.
function richFieldsGreyed(placement) {
  return placement === 'sandbox';
}

module.exports = { SANDBOX_PLACEMENT_CWD, hasSandboxPeer, nextCwd, richFieldsGreyed };
