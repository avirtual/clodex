// activity-badge.js — whether a subagent badges the Activity tab, as pure
// state. Three maps and a set go in, a list of keys to badge comes out.
//
// THE UNIT IS THE AWAY-PERIOD, NOT THE WINDOW. The badge answers "what did
// something while you were not looking", which is not "what is new": three subs
// that appeared while the tab was open and then ran for ten minutes are not new,
// and a badge keyed on novelty reads 0 for all of it. So an away-period is
// bounded by the operator looking away (`arm`) and looking back (the host's own
// badge clear), and BOTH halves of "did something" count — a sub first observed
// this away-period, and a known sub whose turn count advanced.
//
// `requests` is the advance signal deliberately, even though the feed counts
// turns itself: it rides the free 5s chip payload, whereas the feed poll is
// stopped while the tab is hidden — which is exactly when the badge has to work.
// It is used ONLY as an advanced/not-advanced EDGE and must never be rendered:
// `requests` counts forwarded requests (~4 per user turn) and the ring counts
// completed turns, so the two legitimately disagree and only the ring's `seq`
// may reach the screen.
//
// Extracted from activity-tab.js because almost none of this is DOM-bound, and
// it has already produced two operator-visible defects that only arithmetic
// tests can hold shut.

// One key space for both halves of the UI — a chip and its feed must agree, and
// a parent session name plus a child key is the only identifier the wire gives.
// The space is a safe separator BECAUSE session names cannot contain one
// (`[a-zA-Z0-9._-]{1,64}`), which is also what makes `dropParent`'s prefix match
// exact rather than a guess. Single-sourced here: `dropParent` below is only
// correct while the separator it splits on is the one the keys were built with.
const feedKeyOf = (name, key) => `${name} ${key}`;

function createBadgeState() {
  const notified = new Set();   // subs already badged in the CURRENT away-period
  const lastReq = new Map();    // feedKey -> newest `requests` seen
  const awayReq = new Map();    // feedKey -> `requests` when this away-period began
  // feedKey -> a monotonic stamp taken when the key is FIRST observed. The chip
  // strip orders by this and never by anything the wire controls: the payload
  // arrives in RECENCY order (proxylab meta.py sorts sub_agents by last_seen
  // descending) and that order permutes every time two subs take turns, so
  // rendering it directly makes chips trade places under the operator's cursor
  // every 5s. Position is an operator affordance — you learn where a chip is —
  // and it must be stable for the life of the window, including after the sub
  // ends. Never renumbered, so an ended chip keeps its slot.
  const firstSeen = new Map();
  let seenSeq = 0;

  function stamp(fk) {
    if (!firstSeen.has(fk)) firstSeen.set(fk, ++seenSeq);
    return firstSeen.get(fk);
  }

  // One observation of the live roster. `live` is the chip map, `feedKey ->
  // { sub }`, and the only field read off it is `sub.requests`.
  //
  // Returns the keys that should badge, in iteration order — a LIST and not a
  // count, so the caller notifies once per sub and a test can name which sub was
  // held back. Still at most ONCE per sub per away-period, never per turn: a
  // per-turn badge ticks several times a minute per sub and stops meaning
  // anything.
  function notice(live) {
    const badged = [];
    for (const [fk, l] of live) {
      // Stamped HERE, in payload-iteration order, rather than lazily in the
      // caller's sort comparator: a comparator assigns in whatever order it
      // happens to visit pairs, which would make the very first ordering depend
      // on the sort algorithm. This also runs while the pane is unmounted, so a
      // sub observed before the operator ever opened the tab keeps its slot.
      stamp(fk);
      const sub = l && l.sub;
      const req = sub && typeof sub.requests === 'number' ? sub.requests : null;
      // Absent from the snapshot = not seen when this away-period began, so its
      // mere presence is the activity. `requests` can be null on the wire, and a
      // sub we can never count turns for badges on appearance only.
      const fresh = !awayReq.has(fk);
      const base = awayReq.get(fk);
      const advanced = !fresh && req !== null && typeof base === 'number' && req > base;
      if (req !== null) lastReq.set(fk, req);
      if ((fresh || advanced) && !notified.has(fk)) {
        notified.add(fk);
        badged.push(fk);
      }
    }
    return badged;
  }

  // Re-arm for the next away-period. Called on the hide edge ONLY: an
  // away-period is bounded by the operator looking away and looking back, and
  // the host's badge clear on show is the other half of the same edge.
  // Snapshotting `lastReq` here rather than counting from zero is what keeps a
  // sub that was already mid-run from badging for turns the operator watched
  // happen.
  function arm() {
    notified.clear();
    awayReq.clear();
    for (const [fk, n] of lastReq) awayReq.set(fk, n);
  }

  // The parent session is gone from the sidebar, so none of its keys can ever be
  // observed again. `seenSeq` is deliberately NOT rewound — reusing a stamp
  // would place a future chip in a dead one's slot.
  function dropParent(name) {
    const prefix = `${name} `;
    for (const fk of [...notified]) {
      if (fk.startsWith(prefix)) notified.delete(fk);
    }
    for (const fk of [...lastReq.keys()]) {
      if (fk.startsWith(prefix)) { lastReq.delete(fk); awayReq.delete(fk); }
    }
    for (const fk of [...firstSeen.keys()]) {
      if (fk.startsWith(prefix)) firstSeen.delete(fk);
    }
  }

  // Whole-state read, for tests: a partial assertion on this machine reads
  // around exactly the bookkeeping the two shipped defects lived in.
  function snapshot() {
    return {
      notified: [...notified],
      lastReq: Object.fromEntries(lastReq),
      awayReq: Object.fromEntries(awayReq),
      firstSeen: Object.fromEntries(firstSeen),
      seenSeq,
    };
  }

  return { stamp, notice, arm, dropParent, snapshot };
}

module.exports = { createBadgeState, feedKeyOf };
