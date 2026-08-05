// subagent-feed.js — the accumulating turn feed for one subagent, as pure
// state. One `proxy:subagentFeed` reply goes in; what the operator has seen so
// far comes out.
//
// Fed from Clodex's OWN wire tee (subagent-ring.js). The cursor IS the dedup:
// a monotonic per-session seq cannot repeat or skip, so do not reintroduce
// dedup by content signature — that guesswork discarded distinct turns.
//
// The feed no longer has an `ended` state. Whether a subagent is still running
// is wirescope's call (the chip strip's classifySubagent), and this module
// having its own opinion would be the second running/idle/done policy the repo
// has a standing rule against.

// A persistent tenant polls one feed for as long as the operator leaves it
// selected. The main-process ring is bounded too (subagent-ring.js FEED_CAP);
// this is the renderer's own bound on what it has accumulated across polls.
const MAX_FEED_ENTRIES = 500;

function createSubagentFeed() {
  let entries = [];   // [{ seq, ts, text, tools, truncated }]
  let cursor = 0;     // highest seq ingested; what the next poll asks past
  let meta = null;    // { role, model } captured once
  // Sticky: once a reply reports rows were evicted past our cursor, later polls
  // ask from a cursor that no longer predates the eviction and report false.
  // Clearing it would retract an admission that is still true of what is shown.
  let missed = false;

  // Fold one reply into the feed. Returns `{ appended }` — true iff a new entry
  // landed, which is the consumer's cue to re-pin the scroll.
  function ingest(d) {
    if (!d || typeof d !== 'object') return { appended: false };

    if (d.missed === true) missed = true;
    if (!meta && (d.role || d.model)) {
      meta = { role: d.role || null, model: d.model || null };
    }

    let appended = false;
    for (const e of Array.isArray(d.entries) ? d.entries : []) {
      // A row at or below the cursor is a server that ignored `since` or a reply
      // that overtook an earlier one; either way re-appending it would duplicate
      // a turn already on screen.
      if (!e || typeof e.seq !== 'number' || e.seq <= cursor) continue;
      cursor = e.seq;
      entries.push({
        seq: e.seq,
        ts: typeof e.ts === 'number' ? e.ts : null,
        text: e.text || null,
        tools: Array.isArray(e.tools) ? e.tools : [],
        // Distinct from `truncated`, which is about the TEXT only.
        toolsOmitted: typeof e.toolsOmitted === 'number' && e.toolsOmitted > 0 ? e.toolsOmitted : 0,
        truncated: e.truncated === true,
      });
      appended = true;
    }
    // The reply's `seq` is the store HEAD, so a poll that returned nothing still
    // advances past turns that belong to OTHER subagents (seq is per-session).
    // Without this the cursor would stall at this feed's last turn and every
    // poll would re-ask for a range the server has to walk.
    if (typeof d.seq === 'number' && d.seq > cursor) cursor = d.seq;

    if (entries.length > MAX_FEED_ENTRIES) {
      entries = entries.slice(-MAX_FEED_ENTRIES);
    }
    return { appended };
  }

  return {
    ingest,
    entries: () => entries,
    cursor: () => cursor,
    meta: () => meta,
    missed: () => missed,
  };
}

module.exports = { createSubagentFeed, MAX_FEED_ENTRIES };
