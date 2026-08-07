// served-banner.js — the pure decision behind the sidebar notice that says a
// peer has a shell open on this machine (t219): given the set of seats being
// watched right now, is the notice shown and what does it say?
//
// A leaf rather than three lines inside peers-ui because this is the ONLY
// surface for some served seats, not a second opinion. The per-seat mark rides
// a session row, and a live session's row can be invisible: `rowPasses`
// display:none's a row that fails the sidebar search text, and again for a
// collapsed group. The session is alive, so nothing prunes the stream — the row
// simply is not on screen. peers-ui is DOM-bound and untested by the R1 rule, so
// leaving the decision there left load-bearing code with no coverage.
//
// STRINGS ONLY, never markup. The caller assigns these with `textContent` and a
// seat name is operator-supplied; anything here that composed HTML would make
// that assignment unsafe at a distance.

'use strict';

// `seats` is whatever arrived on the wire — the caller has not validated it.
// Non-array and empty are the same answer, and both are the ordinary state.
function servedBannerView(seats) {
  const live = Array.isArray(seats) ? [...new Set(seats.map(String))] : [];
  if (live.length === 0) return { hidden: true, text: '', tip: '' };
  // NAMED while there is one. "A peer has a shell open" alone sends the
  // operator hunting through the sidebar for a row that may not be there —
  // which is the case this notice exists for.
  if (live.length === 1) {
    return {
      hidden: false,
      text: `A peer has a shell open on ${live[0]}`,
      tip: `A peer is watching ${live[0]}'s terminal on this machine`,
    };
  }
  return {
    hidden: false,
    text: `Peers have shells open on ${live.length} sessions`,
    tip: `Peers are watching these terminals on this machine: ${live.join(', ')}`,
  };
}

module.exports = { servedBannerView };
