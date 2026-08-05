// subagent-feed.js — the accumulating turn feed for one subagent, as pure
// state. One `/_subagents` detail response goes in; what the operator has seen
// so far comes out.
//
// The detail endpoint only ever returns the LATEST COMPLETED turn (keyed by
// turn_ts), so a consumer that replaced its view each poll would render a
// slideshow. Instead every newly-seen turn is appended, which is why dedup is
// the whole job here: the same turn arrives on every poll until the next one
// completes. Honest caveat, and the reason the UI must not claim to be live: we
// observe only the latest completed turn per poll, so a sub finishing several
// turns inside our 1.5s cadence skips the in-between ones. The feed is "the
// turns we caught", not a transcript.
//
// Extracted from subagent-popover.js (t204) — the popover's only logic worth
// testing, which as DOM-bound code it was never allowed to have.

// A persistent tenant polls one feed for as long as the operator leaves it
// selected, so history is capped; the popover's version died with its DOM.
const MAX_FEED_ENTRIES = 500;

function createSubagentFeed() {
  let entries = [];          // [{ ts, tool, toolInput, truncated, text }]
  let seen = new Set();      // turn signatures already appended
  let meta = null;           // { role, model } captured once
  let ended = false;         // session went cold — stop polling, keep history
  let reason = null;         // last found:false reason, for the empty state

  // Fold one detail response into the feed. Returns `{ appended }` — true iff a
  // new entry landed, which is the consumer's cue to re-pin the scroll.
  function ingest(d) {
    if (!d || typeof d !== 'object') return { appended: false };

    if (d.found === false) {
      reason = d.reason || null;
      // session_cold means the proxy's in-memory bodies are gone: nothing more
      // will ever arrive, so the poll must stop. Any other reason is transient
      // (the child may not have made its first request yet).
      if (d.reason === 'session_cold') ended = true;
      return { appended: false };
    }
    reason = null;

    if (!meta && (d.role || d.model)) {
      meta = { role: d.role || null, model: d.model || null };
    }
    if (!d.last_tool && !d.last_text) return { appended: false }; // nothing to show this turn

    // Dedup by turn_ts (the per-turn key); without one, fall back to a content
    // signature so identical repeats don't pile up.
    const sig = (typeof d.turn_ts === 'number')
      ? `t:${d.turn_ts}`
      : `c:${d.last_tool || ''}|${(d.last_text || '').slice(0, 80)}`;
    if (seen.has(sig)) return { appended: false };
    seen.add(sig);
    entries.push({
      ts: typeof d.turn_ts === 'number' ? d.turn_ts : null,
      tool: d.last_tool || null,
      toolInput: d.last_tool_input || null,
      truncated: !!d.truncated,
      text: d.last_text || null,
    });
    // Oldest turns drop; `seen` keeps their signatures, so a dropped turn that
    // is still the endpoint's "latest" does not reappear at the bottom.
    if (entries.length > MAX_FEED_ENTRIES) entries.shift();
    return { appended: true };
  }

  return {
    ingest,
    entries: () => entries,
    meta: () => meta,
    ended: () => ended,
    reason: () => reason,
  };
}

// Pull a compact one-line preview out of a tool_use input object. The keys are
// whatever the model emitted (wirescope forwards it verbatim) so we probe the
// common primaries and fall back to compact JSON — the caller still truncates on
// render, since an unexpected key could be large even past the server-side
// maxlen clamp.
function toolPreview(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description']) {
    if (typeof input[k] === 'string' && input[k]) return input[k];
  }
  try { return JSON.stringify(input); } catch { return ''; }
}

module.exports = { createSubagentFeed, toolPreview, MAX_FEED_ENTRIES };
