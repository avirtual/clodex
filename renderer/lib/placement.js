'use strict';
// placement.js — pure decisions for the New Session "Run in" placement selector
// (docs/sandbox-plan.md M3, generalized to N boxes in M6b P3). A placement is
// either 'host' (this Mac) or a sandbox BOX ID: the selector carries the box id as
// its <option> value, and everything box-side (create routing, catalogs, cwd) is
// keyed by that id. 'host' is reserved and can never be a box id (guarded at box
// create + in the store's sanitizer), so the two value-spaces never collide. A box
// placement routes the create through THAT box's peer (container-side), so cwd is a
// container path and the rich fields (skills/prompts/tools/proxy/intents/exec)
// don't cross the create-on-peer wire unless the box advertises create2. This leaf
// holds the branch logic; renderer.js does the DOM plumbing. NEW module —
// deliberately NOT in the leak-scanner's RENDERER_SCANNED_MODULES (that guard is
// for move-only extractions).

// The reserved placement value for "this Mac" — never a valid box id.
const HOST_PLACEMENT = 'host';

// Container-side default working directory for a box session — the bind /
// named-volume mount point in docker/web/{Dockerfile,compose.yaml}. Same for every
// box (they share the image), so it isn't box-id-scoped.
const SANDBOX_PLACEMENT_CWD = '/home/clodex/work';

// Is this placement a sandbox box (i.e. anything that isn't the host)? Empty /
// undefined / 'host' → false. The box id itself is opaque here.
function isBoxPlacement(placement) {
  return !!placement && placement !== HOST_PLACEMENT;
}

// Should the placement selector be shown at all? Only when at least one box is
// registered — zero boxes → zero placement noise (host-only, selector hidden).
// Driven by the box REGISTRY, not peer presence: a stopped box still offers a
// placement (create pre-checks the peer is up and errors clearly if not).
function showPlacementSelector(boxes) {
  return Array.isArray(boxes) && boxes.length > 0;
}

// Placement flips a container path vs a host path, but must not clobber a cwd the
// user typed. Only swap when the field still holds the OTHER placement's default:
// host-default → box default on entering a box, and back on leaving. Any
// hand-edited value is preserved. Box→box keeps the container default (both sides
// are box placements → no swap).
function nextCwd(placement, currentCwd, hostDefault) {
  if (isBoxPlacement(placement)) {
    return currentCwd === hostDefault ? SANDBOX_PLACEMENT_CWD : currentCwd;
  }
  return currentCwd === SANDBOX_PLACEMENT_CWD ? hostDefault : currentCwd;
}

// Whether the rich per-session fields are greyed (disabled, not sent) for the
// current placement. Host is never greyed. A box is greyed UNLESS it advertises the
// `create2` capability (M5): a create2 box takes the full-param create body and
// serves its own catalogs, so the fields are live and box-true. A non-create2 box
// (old, or offline → no caps) keeps the M3 greyed behaviour — the cap gate is
// load-bearing: never send rich fields to a box that can't honour them. hasCreate2
// defaults false so an un-updated caller stays safe (greyed).
function richFieldsGreyed(placement, hasCreate2 = false) {
  if (!isBoxPlacement(placement)) return false;
  return !hasCreate2;
}

module.exports = {
  HOST_PLACEMENT, SANDBOX_PLACEMENT_CWD,
  isBoxPlacement, showPlacementSelector, nextCwd, richFieldsGreyed,
};
