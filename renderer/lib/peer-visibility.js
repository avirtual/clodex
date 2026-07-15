'use strict';
// peer-visibility.js — pure decision for a peer's "visible sessions" selection.
// A peer's visible set is either UNMATERIALIZED (no explicit array yet ⇒ every
// known session shows) or an explicit whitelist array, which the sidebar
// materializes the moment the user hides one row. A session created on the peer
// AFTER the set was materialized isn't in that array, so it never renders until
// the user eye-toggles it — the create-on-peer "lands invisible" bug.
// ensurePeerSessionVisible patches that by appending the new name; this leaf
// holds the array math, peers-ui.js does the IPC (peerSetVisible) + renderPeers.
// NEW pure leaf — deliberately NOT in the leak-scanner's RENDERER_SCANNED_MODULES
// (that guard is for move-only extractions).

// The next visible array after ensuring `name` is present, or null when nothing
// needs to change: an unmaterialized selection (not an array) already shows all
// sessions, and a name already in the whitelist is a no-op. Otherwise append.
function nextVisibleWithName(sel, name) {
  if (!Array.isArray(sel) || sel.includes(name)) return null;
  return [...sel, name];
}

module.exports = { nextVisibleWithName };
