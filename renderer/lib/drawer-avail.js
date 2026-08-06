'use strict';
// drawer-avail.js — which drawer tabs a given seat can be served by.
//
// A pure leaf rather than a line inside term-tab.js because term-tab is
// DOM-bound and therefore untested (the R1 rule), while this predicate is the
// whole content of two defects and is exactly the part worth pinning.

// The terminal tenant, per seat. Both exclusions are defects that shipped, not
// preferences:
//
//   bash   — the session IS a shell. A second one in the drawer shares nothing
//            with it (different process, different cwd, different history) and
//            the tab reads as if it were that session's terminal.
//   remote — a peer session lives on ANOTHER BOX, so a LOCAL shell is not its
//            terminal in any sense. Worse than merely misleading: the renderer
//            keys a peer as `name@id` (peers-ui.js), `@` fails the seat grammar
//            in ipc-handlers' `seatOf`, and a rejected seat becomes null — which
//            is the key of the SEATLESS workspace shell. So every peer row was
//            handed the one workspace-wide terminal, sharing it with each other
//            and with the no-session drawer.
//
// A null type is the seatless drawer (no session selected), which is that
// workspace-wide shell's legitimate home — so it stays available.
function termAvailableFor(type) {
  return type !== 'bash' && type !== 'remote';
}

module.exports = { termAvailableFor };
