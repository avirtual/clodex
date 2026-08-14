// team-tickets.js — the teams/tickets half of SessionManager: ticket board
// verbs, seat shaping/spawn, spec delivery, review/verdict/auto-merge, the
// ticket loop + suite, watchdog/stall sweep, team role editing, retire.
//
// ─── GRAFT CONTRACT ─────────────────────────────────────────────────────────
//
// This module returns METHODS, not an API. createSessionManager grafts them
// onto SessionManager.prototype, so every one of them runs with `this` = the
// manager instance and NOT with `this` = anything this file constructs.
//
// Three consequences that decide how to change code here:
//
//   1. STATE LIVES ON THE INSTANCE, never in this module. `this._ticketWatch`,
//      `this._stallProbing`, `this.sessions` and the per-session latches are
//      the manager's; this file must not hold ticket state in a closure, which
//      would be per-FACTORY rather than per-manager and would leak across two
//      managers in one process (every test file builds several).
//
//   2. CROSS-BOUNDARY CALLS STAY `this.<name>()`. Reaching core is
//      `this._gatedDeliver(…)`, not an injected handle — that is what let the
//      move be byte-identical. It also means the coupling is INVISIBLE to
//      test/free-identifier-leaks.test.js, which scans module-scope names and
//      can never see a prototype-chain lookup. The seam is gated instead by
//      test/ticket-mixin-surface.test.js. Deleting a core method these bodies
//      call is a runtime TypeError that only that gate will catch.
//
//   3. This is a FILE SPLIT, NOT A DECOUPLING (t380). The coupling graph after
//      the move is the coupling graph before it. Do not read this boundary as a
//      claim that tickets are independent of the session core; the mixin
//      surface test's inventory is the starting spec for that work, not its
//      result.
//
// Everything the methods need from the coordinator arrives through `deps` (all
// names already destructured by createSessionManager, so engine.js is
// unchanged) or through `shared`, which carries the two core-OWNED values the
// cluster reads rather than constructs.

function createTicketMethods(deps, shared) {
  const {
  } = deps;
  const {
    // ticketsStore is constructed ONCE, by createSessionManager, and borrowed
    // here. Constructing a second instance would work (it is fs-backed) and
    // would still be wrong: core's list() badge and these verbs must agree
    // about cache and ordering, and two stores are free to disagree silently.
    ticketsStore,
    // Module-scope in session-manager.js, used by core's create() AND by
    // _taskAssign, AND exported (ipc-handlers imports it). Passed in rather
    // than moved so the export keeps its home and no require cycle is created.
    nameConflict,
  } = shared;

  // Referenced so the scaffold's unused-binding shape matches the post-move
  // one; the move replaces this with the real method set.
  void ticketsStore; void nameConflict;

  return {};
}

module.exports = { createTicketMethods };
