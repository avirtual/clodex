'use strict';

// Per-subagent turn feed, fed from the wire's own tee (wire/proxy.js
// turn.completed) rather than polled off wirescope's /_subagents.
//
// Why this exists at all: wirescope keeps ONE slot per subagent, overwritten per
// request (proxylab/meta.py _SUBAGENT_LAST_REQ), and serves it from the REQUEST
// body's transcript — so its view is both lossy and one turn stale by
// construction, and no poll rate reaches either. Clodex is the first proxy: the
// same turns cross our tee complete and in order, so we accumulate them here.
// Ownership rule (t208): Clodex owns per-session facts it observes first,
// wirescope owns aggregates across sessions/time. Cost, status and last_seen
// stay wirescope's and are NOT duplicated here.
//
// Kept electron-free and dependency-free so ring semantics are unit-testable
// without booting the app (file-touch.js precedent).
//
// KEY COMPATIBILITY, load-bearing: `key` must be the x-claude-code-agent-id
// header VERBATIM, falling back to the role name when absent — byte-identical
// to proxylab/meta.py `key = agent_id or role`. The chip strip stays
// wirescope-driven and the feed is looked up BY the chip's key, so a divergence
// here does not fail loudly: it silently shows an empty feed for a live
// subagent. Splitting the header on '@' (which meta.py does, for the DISPLAY
// name only) collides every anonymous spawn into one row.

// Bounds, all enforced here rather than by callers — a feed lives as long as
// its session, so nothing upstream is in a position to remember.
const FEED_CAP = 100;   // entries per subagent
const SUB_CAP = 24;     // subagents per session, LRU by last turn
const TEXT_CAP = 1024;  // chars of assistant text per entry
// A single turn can open many tool_use blocks; without this an entry's size is
// set by the model rather than by us.
const TOOLS_CAP = 12;

function createSubagentStore() {
  // Map iteration order IS the LRU order: `note` deletes and re-sets a feed on
  // every turn, so the oldest-touched key is always first.
  return { feeds: new Map(), seq: 0 };
}

// `seq` is monotonic per SESSION, not per feed: one cursor then orders every
// subagent's turns against each other, and a renderer asking `since` for one
// feed still gets a gap-free answer. It is also the only turn count the UI may
// render — wirescope's `requests` counts forwarded REQUESTS, so the two
// legitimately disagree and showing both invites the reader to reconcile them.
function noteSubagentTurn(store, turn) {
  if (!store || !turn) return null;
  const key = turn.key;
  if (typeof key !== 'string' || !key) return null;

  const rawText = typeof turn.text === 'string' ? turn.text : '';
  const tools = Array.isArray(turn.tools)
    ? turn.tools.filter((t) => typeof t === 'string' && t)
    : [];
  // Nothing to show: a tool-loop hop that streamed neither text nor a tool call
  // would render as a blank row.
  if (!rawText && !tools.length) return null;

  let feed = store.feeds.get(key);
  if (feed) {
    store.feeds.delete(key); // re-set below = move to the LRU tail
  } else {
    feed = { key, role: null, displayName: null, model: null, entries: [], evictedThrough: null };
  }
  // Identity is sticky once seen: a later turn can arrive without the fields
  // (a classifier that fell back to 'unknown' mid-run), and letting that null
  // out a known role would blank the header the operator is reading.
  if (turn.role) feed.role = turn.role;
  if (turn.displayName) feed.displayName = turn.displayName;
  if (turn.model) feed.model = turn.model;

  // The Buffer round-trip is a FORCED FLATTEN and must not be "simplified" back
  // to a bare `.slice()`. A slice yields a V8 SlicedString that pins its parent,
  // and the parent is the tee's turn text — a rope up to TURN_TEXT_CAP (4MB, see
  // wire/proxy.js). This ring is the sole retainer of subagent text after the
  // emit, so nothing else drops that parent: measured at 800MB retained for 200
  // clamped entries versus 0.2MB flattened. The reversion is silent because
  // `.length` is identical either way and every assertion still passes.
  const textClamped = rawText.length > TEXT_CAP;
  const text = textClamped
    ? Buffer.from(rawText.slice(0, TEXT_CAP), 'utf8').toString('utf8')
    : rawText;
  store.seq += 1;
  feed.entries.push({
    seq: store.seq,
    ts: typeof turn.ts === 'number' ? turn.ts : null,
    text: text || null,
    tools: tools.slice(0, TOOLS_CAP),
    // Tool overflow gets its OWN count rather than riding `truncated`: the
    // renderer prints "(truncated)" under the TEXT, so a dropped tool name
    // reported through that flag is a false statement about the text.
    toolsOmitted: Math.max(0, tools.length - TOOLS_CAP),
    // Text only — ours, or the tee's own 4MB cap upstream. Either way the
    // reader needs to know the text they can see is partial.
    truncated: textClamped || turn.truncated === true,
  });
  if (feed.entries.length > FEED_CAP) {
    // Record the last seq that no longer exists, so a cursor predating the
    // eviction can be told rows were deleted from the middle of its view.
    // `from + 1` cannot substitute: seq is monotonic per SESSION, so one feed's
    // entries are not consecutive.
    feed.evictedThrough = feed.entries.shift().seq;
  }

  store.feeds.set(key, feed);
  // Evict whole feeds only after the insert, so the feed just written is never
  // the one dropped even at cap.
  while (store.feeds.size > SUB_CAP) {
    const oldest = store.feeds.keys().next().value;
    if (oldest === undefined) break;
    store.feeds.delete(oldest);
  }
  return feed.entries[feed.entries.length - 1];
}

// Everything after `since` for one subagent. `seq` in the reply is the store's
// HEAD, not the last entry's — a caller that polls a quiet feed advances its
// cursor anyway and cannot be handed the same rows twice.
//
// `known:false` distinguishes "no such subagent here" from "nothing new": the
// chip strip is wirescope's, so a chip can legitimately exist before its first
// turn crosses our tee, and rendering that as an error would be wrong.
//
// `missed` is EXACT, not an estimate: a caller whose cursor predates a FEED_CAP
// eviction would otherwise receive the survivors and paint them contiguously,
// with no admission that rows were dropped from the middle of its own view.
function feedSince(store, key, since) {
  if (!store) return { known: false, entries: [], seq: 0, missed: false };
  const head = store.seq;
  const feed = store.feeds.get(key);
  if (!feed) return { known: false, entries: [], seq: head, missed: false };
  const from = Number.isFinite(since) ? since : 0;
  return {
    known: true,
    key: feed.key,
    role: feed.role,
    displayName: feed.displayName,
    model: feed.model,
    entries: feed.entries.filter((e) => e.seq > from),
    seq: head,
    missed: feed.evictedThrough != null && from < feed.evictedThrough,
  };
}

// Keys with at least one captured turn, LRU order reversed (most recent first).
// Diagnostic//test surface — the UI enumerates subagents from wirescope's chips.
function feedKeys(store) {
  return store ? [...store.feeds.keys()].reverse() : [];
}

module.exports = {
  FEED_CAP, SUB_CAP, TEXT_CAP, TOOLS_CAP,
  createSubagentStore, noteSubagentTurn, feedSince, feedKeys,
};
