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

// Whether the rich per-session fields are greyed (disabled, not sent) for the
// current placement. Host is never greyed. Sandbox is greyed UNLESS the box
// advertises the `create2` capability (M5): a create2 box takes the full-param
// create body and serves its own catalogs, so the fields are live and box-true.
// A non-create2 sandbox peer (an older box that would silently DROP unknown body
// keys) keeps the M3 greyed behaviour — the cap gate is load-bearing: never send
// rich fields to a box that can't honour them. hasCreate2 defaults false so an
// un-updated caller stays safe (greyed).
function richFieldsGreyed(placement, hasCreate2 = false) {
  if (placement !== 'sandbox') return false;
  return !hasCreate2;
}

module.exports = { SANDBOX_PLACEMENT_CWD, hasSandboxPeer, nextCwd, richFieldsGreyed };
