'use strict';

// W2 step-4 telemetry bridge — DARK phase (CLODEX_WIRE_SHADOW only).
//
// Shapes the in-process wire's turn.completed receipts into the same payload
// shapeProxyRecord (proxy-util.js) builds from a /_status poll, and diffs the
// two every time ProxyPoller emits — ProxyPoller stays the LIVE source; this
// module renders nothing. The diff stream is the evidence for the reviewer's
// cutover condition (CLODEUX-PLAN.md): est cost within 1%, warmth verdicts
// exact. Once live-shadow validation passes, the cutover commit points the
// renderer at payload() and the 9 poll-era guards die (w2-glue-inventory.md).
//
// Contract with the wire (fable's, wire/proxy.js header):
//   - consume events only; NOTHING here may touch the client byte path.
//   - every public method swallows its own errors (a telemetry bug must
//     degrade to a missing diff line, never to a broken wire listener).
//
// Field parity notes (docs/w2-telemetry-flow.md):
//   - cost/turns/refusals/requests: sessionTotals snapshot off ANY
//     turn.completed for the agent (side-calls and subagents bill into the
//     same session key, matching the poll record's per-session totals).
//     count_tokens spend accumulates wire-side without an event, so between
//     turns the wire totals can trail the poll's by in-flight probes —
//     the diff is only meaningful at turn boundaries, which is when both
//     sides move anyway.
//   - sessionId/model/inputTokens: MAIN-LINE turns only (subagent/title
//     traffic must not rotate the session identity or the last-turn tokens).
//   - inputTokens = uncached input + cache read + cache write of the last
//     main-line turn — same formula wirescope uses for context.input_tokens.
//   - warmth: WarmthStore.query({session}) at diff time; two-state verdict
//     (warm / not-warm) is what the reviewer condition compares. The poll
//     side's state string is compared raw.
//   - context window SIZE stays off-wire (CLI statusline side-channel +
//     MODEL_WINDOWS override in main.js) — not this module's field.

const { isSubagentRole } = require('./wire/role');

// The four cumulative totals subject to epoch baselining (see diffPoll).
function snapCumulative(p) {
  return {
    cost: p.cost && typeof p.cost.usd === 'number' ? p.cost.usd : null,
    requests: p.cost && typeof p.cost.requests === 'number' ? p.cost.requests : null,
    turns: typeof p.turns === 'number' ? p.turns : null,
    refusals: typeof p.refusals === 'number' ? p.refusals : 0,
  };
}

// Increment since baseline; null when either endpoint is unobservable.
// round6 mirrors billing.js — increments of two round6 values stay exact.
function inc(now, base) {
  if (now == null || base == null) return null;
  return Math.round((now - base) * 1e6) / 1e6;
}

class WireTelemetry {
  constructor({ warmth = null, hold = null, log = () => {} } = {}) {
    this._warmth = warmth;
    this._hold = hold; // wire/hold HoldKeeper — hold/pingable payload fields + overlay ownership
    this._log = log;
    this._agents = new Map();   // name -> { sessionId, model, totals, inputTokens, ts }
    this._lastDiff = new Map(); // name -> JSON of last logged diff (dedupe)
    this._baseline = new Map(); // name -> co-observation epoch base (see diffPoll)
  }

  // Wire listener body. Never throws.
  noteTurn(t) {
    try {
      if (!t || typeof t.agent !== 'string') return;
      let a = this._agents.get(t.agent);
      if (!a) {
        a = { sessionId: null, model: null, totals: null, inputTokens: null, ts: 0 };
        this._agents.set(t.agent, a);
      }
      a.ts = Date.now();
      // Totals snapshot: latest wins, whatever line it rode in on.
      if (t.sessionTotals) a.totals = t.sessionTotals;
      if (t.sideCall || isSubagentRole(t.role)) return;
      if (t.sessionId) a.sessionId = t.sessionId;
      if (t.model) a.model = t.model;
      const tok = t.billing && t.billing.tokens;
      if (tok) {
        const w = (tok.cache_write_5m_tokens != null || tok.cache_write_1h_tokens != null)
          ? (tok.cache_write_5m_tokens || 0) + (tok.cache_write_1h_tokens || 0)
          : (tok.cache_write_flat_tokens || 0);
        const used = (tok.input_tokens || 0) + (tok.cache_read_input_tokens || 0) + w;
        if (used > 0) a.inputTokens = used; // error receipts (all-null usage) keep the last real value
      }
    } catch { /* consume-only: a bad receipt is a missing sample, not a crash */ }
  }

  // shapeProxyRecord-parity subset (the fields the validation compares and
  // the cutover will render). null = wire hasn't seen this agent yet.
  payload(name) {
    try {
      const a = this._agents.get(name);
      if (!a) return null;
      const t = a.totals || {};
      let warmth = null;
      if (this._warmth && a.sessionId) {
        // Own try: a broken warmth store costs the warmth field, not the
        // whole payload (cost/turns samples must keep flowing).
        try {
          const q = this._warmth.query({ session: a.sessionId });
          if (q && q.found) {
            warmth = { state: q.warm ? 'warm' : 'cold', remaining_s: q.remaining_s ?? null, ttl_s: q.ttl_s ?? null };
          }
        } catch { /* warmth degrades alone */ }
      }
      // Keep-warm state off the in-process HoldKeeper, shaped like the poll's
      // r.hold / r.pingable (renderer contract: hold.until in epoch seconds).
      // Own try, same reasoning as warmth: a hold bug costs the fire button,
      // not the cost samples.
      let hold = null;
      let pingable = false;
      if (this._hold && a.sessionId) {
        try {
          pingable = !!this._hold.entry(a.sessionId);
          const h = this._hold.holds()[a.sessionId];
          if (h) hold = { until: h.until, hours: h.hours, pings: h.pings, last_result: h.lastResult ?? null };
        } catch { /* hold degrades alone */ }
      }
      return {
        linked: true,
        sessionId: a.sessionId,
        model: a.model,
        cost: { usd: t.est_usd ?? null, requests: t.requests ?? null },
        turns: t.turns ?? null,
        refusals: t.refusals || 0,
        context: { inputTokens: a.inputTokens },
        warmth,
        pingable,
        hold,
      };
    } catch { return null; }
  }

  // Cutover preview (CLODEX_WIRE_TELEMETRY=1 in main.js): overwrite the
  // wire-carried fields on a live poll payload before it is emitted to the
  // renderer, leaving every field the wire does not carry yet (strip,
  // capabilities, subagents, sessionId for the poll-backed IPC endpoints,
  // context messages/turns, base) on the poll's value. This IS the W2
  // renderer cutover, previewed per-field: at guard-deletion time the poll
  // side of the merge disappears rather than the renderer changing again.
  //
  // Known semantic change, deliberate: wire cost/requests/turns totals are
  // per-app-launch (in-process ledger), not wirescope's persisted session-
  // lifetime totals. Recorded in CLODEUX-PLAN.md with the validation readout.
  //
  // Returns the poll payload untouched when the wire has no main-line
  // identity for the agent yet (Codex sessions, pre-first-turn) — degradation
  // is per-agent, never partial within an agent tick. Never throws.
  overlay(name, poll) {
    try {
      if (!poll || !poll.linked) return poll;
      const wire = this.payload(name);
      if (!wire || !wire.sessionId) return poll;
      const out = { ...poll, telemetrySource: 'wire' };
      out.cost = wire.cost;
      out.turns = wire.turns;
      out.refusals = wire.refusals;
      out.context = { ...(poll.context || { turns: null, messages: null }), inputTokens: wire.context.inputTokens };
      out.warmth = wire.warmth;
      if (this._hold) {
        // The in-process HoldKeeper owns keep-warm for this session: surface
        // its state and route the renderer's fire button to wire:hold.
        out.holdSource = 'wire';
        out.hold = wire.hold;
        out.pingable = wire.pingable;
        out.capabilities = { ...(poll.capabilities || {}), hold: true };
      }
      return out;
    } catch { return poll; }
  }

  // Called by ProxyPoller right after it emits the live payload. Logs one
  // wire-telemetry-diff record per material change (consecutive identical
  // diffs are deduped — the poller ticks every 5s, the log shouldn't).
  //
  // EPOCH BASELINE (live finding, first shadow run 2026-07-02): the poll
  // side reports wirescope's PERSISTED session-lifetime totals while the
  // in-process wire's ledger starts at zero on app restart — compared raw,
  // every restarted session reads delta_pct:100 forever and the 1% cutover
  // condition is unsatisfiable by construction. So cumulative fields
  // (cost/requests/turns/refusals) are baselined per (agent, poll-session,
  // wire-session) at the first tick both sides are observable, and the
  // record compares INCREMENTS since that tick — the co-observed window is
  // the only stretch where both ledgers saw the same traffic. A session
  // rotation on either side re-baselines (rec.baselined marks those ticks;
  // increments are trivially 0 — readouts skip them). input_tokens is
  // last-turn state, not cumulative: compared raw, no baseline.
  diffPoll(name, poll) {
    try {
      if (!poll || !poll.linked) return; // nothing to compare against
      const wire = this.payload(name);
      const rec = { type: 'wire-telemetry-diff', agent: name, wire_seen: !!wire };
      // Gate on the wire having seen a MAIN-LINE turn (sessionId set): before
      // that, identity/warmth are structurally unknowable (nothing stamped
      // since the wire came up) and would read as false mismatches.
      if (wire && wire.sessionId) {
        let b = this._baseline.get(name);
        if (!b || b.pollSession !== poll.sessionId || b.wireSession !== wire.sessionId) {
          b = {
            pollSession: poll.sessionId, wireSession: wire.sessionId,
            poll: snapCumulative(poll), wire: snapCumulative(wire),
          };
          this._baseline.set(name, b);
          // Anchor record: which epoch this baseline binds. Also keeps a
          // re-baseline (session rotation) from deduping against the previous
          // anchor — increments are 0 on both, only the ids differ.
          rec.baselined = true;
          rec.sessions = { poll: poll.sessionId || null, wire: wire.sessionId };
        }
        rec.session_match = !!poll.sessionId && poll.sessionId === wire.sessionId;
        const pNow = snapCumulative(poll);
        const wNow = snapCumulative(wire);
        for (const f of ['cost', 'requests', 'turns', 'refusals']) {
          const pInc = inc(pNow[f], b.poll[f]);
          const wInc = inc(wNow[f], b.wire[f]);
          rec[f] = { poll_inc: pInc, wire_inc: wInc };
          if (f === 'cost' && pInc != null && wInc != null && pInc > 0) {
            rec.cost.delta_pct = Math.round(Math.abs(wInc - pInc) / pInc * 10000) / 100;
          }
        }
        rec.input_tokens = {
          poll: poll.context ? poll.context.inputTokens : null,
          wire: wire.context.inputTokens,
        };
        const pWarm = poll.warmth ? poll.warmth.state : null;
        const wWarm = wire.warmth ? wire.warmth.state : null;
        // No wire stamp yet (first cache-confirmed turn since wire-up still
        // pending) → pending, not a mismatch; self-heals on the next turn.
        rec.warmth = wWarm == null
          ? { poll: pWarm, wire: null, pending: true }
          : { poll: pWarm, wire: wWarm, match: pWarm === wWarm };
      }
      const key = JSON.stringify(rec);
      if (this._lastDiff.get(name) === key) return;
      this._lastDiff.set(name, key);
      this._log(rec);
    } catch { /* diffing must never break the poller tick */ }
  }

  // Mirror ProxyPoller's telemetry pruning so dead sessions don't accrete.
  prune(liveNames) {
    try {
      for (const name of this._agents.keys()) {
        if (!liveNames.has(name)) {
          this._agents.delete(name); this._lastDiff.delete(name); this._baseline.delete(name);
        }
      }
    } catch { /* never breaks the tick */ }
  }
}

module.exports = { WireTelemetry };
