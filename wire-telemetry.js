'use strict';

// W2 step-4 telemetry bridge — PARTIALLY LIVE. Read this before trusting the
// numbers on screen to a poll.
//
// Shapes the in-process wire's turn.completed receipts into the same payload
// shapeProxyRecord (proxy-util.js) builds from a /_status poll, and diffs the
// two every time ProxyPoller emits. ProxyPoller is still the source of the
// payload's SHAPE and cadence — but this module is no longer dark on either
// count that matters:
//
//   - `seedLifetime` runs UNCONDITIONALLY (wirescope-proxy.js:321), on every
//     poll emit, gated by nothing.
//   - `overlay` rewrites the payload the renderer receives whenever
//     WIRE_TELEMETRY_LIVE is set (wirescope-proxy.js:323-325), and that flag
//     DEFAULTS ON: engine.js:264-266 reads CLODEX_WIRE_TELEMETRY, and absent it
//     falls back to WIRE_SHADOW, which is itself `!== '0'`. So the operator's
//     live cost display carries this module's numbers unless someone has
//     explicitly set CLODEX_WIRE_TELEMETRY=0 or CLODEX_WIRE_SHADOW=0.
//
// This header used to say "DARK phase (CLODEX_WIRE_SHADOW only)" and "this
// module renders nothing", describing a phase the code had already left (F004,
// second finding). Whoever changes the default again: change this paragraph in
// the same commit — the contract below is what makes a telemetry bug merely a
// missing diff line, and it is load-bearing precisely because the module is on.
//
// The diff stream remains the evidence for the reviewer's cutover condition
// (CLODEUX-PLAN.md): est cost within 1%, warmth verdicts exact. The remaining
// cutover work is pointing the renderer at payload() outright and retiring the
// 9 poll-era guards (w2-glue-inventory.md [internal design doc, not in this repo]).
//
// Contract with the wire (fable's, wire/proxy.js header):
//   - consume events only; NOTHING here may touch the client byte path.
//   - every public method swallows its own errors (a telemetry bug must
//     degrade to a missing diff line, never to a broken wire listener).
//
// Field parity notes (w2-telemetry-flow.md [internal design doc, not in this repo]):
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
  constructor({ warmth = null, hold = null, log = () => {}, persist = null } = {}) {
    this._warmth = warmth;
    this._hold = hold; // wire/hold HoldKeeper — hold/pingable payload fields + overlay ownership
    this._log = log;
    this._agents = new Map();   // name -> { sessionId, model, totals, inputTokens, ts }
    this._lastDiff = new Map(); // name -> JSON of last logged diff (dedupe)
    this._baseline = new Map(); // name -> co-observation epoch base (see diffPoll)
    // Lifetime-totals continuity (full-independence ledger, CLODEUX-PLAN.md):
    // the wire's sessionTotals are per-app-launch; wirescope's poll payload
    // carried PERSISTED session-lifetime totals. `persist` ({read, write})
    // stores lifetime = base + launch-ledger per session_id so the bar's
    // cost survives restarts without wirescope. base is loaded once here;
    // seedLifetime() imports wirescope's history while it still exists.
    this._persist = persist;
    this._lifetimeBase = new Map(); // sessionId -> { cost, requests, turns, refusals, ts }
    this._saveTimer = null;
    if (persist) {
      try {
        const saved = persist.read();
        if (saved && saved.sessions) {
          for (const [sid, v] of Object.entries(saved.sessions)) this._lifetimeBase.set(sid, v);
        }
      } catch { /* a corrupt totals file costs continuity, not the wire */ }
    }
  }

  // base + per-launch ledger, field-wise; null only when BOTH sides are
  // unobservable (preserves payload()'s null semantics for fresh agents).
  _lifetime(a) {
    const b = (a.sessionId && this._lifetimeBase.get(a.sessionId)) || null;
    const t = a.totals || {};
    const add = (x, y) => (x == null && y == null) ? null : Math.round(((x || 0) + (y || 0)) * 1e6) / 1e6;
    return {
      cost: add(b && b.cost, t.est_usd),
      requests: add(b && b.requests, t.requests),
      turns: add(b && b.turns, t.turns),
      refusals: ((b && b.refusals) || 0) + (t.refusals || 0),
      // Token counts ride the same ledger snapshot as cost (wire/billing.js
      // newTotals) and are carried through so a per-ticket rollup can compute a
      // CACHED FRACTION, which cost alone cannot express. Unlike the four above
      // they have no seed path: seedLifetime imports wirescope's poll payload,
      // which carries no token fields, so a session that predates the wire has
      // base 0 here and its token total is a floor while its cost is not.
      inputTokens: add(b && b.inputTokens, t.input_tokens),
      outputTokens: add(b && b.outputTokens, t.output_tokens),
      cacheReadTokens: add(b && b.cacheReadTokens, t.cache_read_tokens),
      cacheWriteTokens: add(b && b.cacheWriteTokens, t.cache_write_tokens),
    };
  }

  _scheduleSave() {
    if (!this._persist || this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._save(); }, 1000);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _save() {
    try {
      const sessions = {};
      // Dormant sessions keep their last persisted value; live ones overwrite.
      for (const [sid, v] of this._lifetimeBase) sessions[sid] = v;
      for (const a of this._agents.values()) {
        if (!a.sessionId || !a.totals) continue;
        sessions[a.sessionId] = { ...this._lifetime(a), ts: Date.now() };
      }
      const ids = Object.keys(sessions);
      if (ids.length > 500) {
        ids.sort((x, y) => (sessions[x].ts || 0) - (sessions[y].ts || 0));
        for (const sid of ids.slice(0, ids.length - 500)) delete sessions[sid];
      }
      this._persist.write({ version: 1, sessions });
    } catch { /* persistence failure costs continuity, never the tick */ }
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
      if (a.sessionId && a.totals) this._scheduleSave();
    } catch { /* consume-only: a bad receipt is a missing sample, not a crash */ }
  }

  // One-time per session_id: import wirescope's persisted lifetime totals as
  // this session's base while the external proxy still exists, so the bar's
  // number stays continuous across the cutover (base = poll lifetime − the
  // wire's launch-ledger; both saw the same traffic since wire-up). Called
  // from the poller tick BEFORE overlay/diffPoll on that tick — the diff
  // anchors its epoch after the seed, so increments stay clean. Once seeded
  // (or loaded from the totals file) a session is never re-seeded: a lag
  // behind wirescope from un-telemetered stretches is accepted, drift-free.
  seedLifetime(name, poll) {
    try {
      if (!this._persist) return;
      if (!poll || !poll.linked || !poll.sessionId || !poll.cost) return;
      const a = this._agents.get(name);
      if (!a || a.sessionId !== poll.sessionId) return; // both sides must agree on the session
      if (this._lifetimeBase.has(poll.sessionId)) return;
      const t = a.totals || {};
      const sub = (p, l) => (p == null) ? null : Math.max(0, Math.round(((p || 0) - (l || 0)) * 1e6) / 1e6);
      this._lifetimeBase.set(poll.sessionId, {
        cost: sub(poll.cost.usd, t.est_usd),
        requests: sub(poll.cost.requests, t.requests),
        turns: sub(poll.turns, t.turns),
        refusals: sub(poll.refusals, t.refusals) || 0,
        ts: Date.now(),
      });
      this._scheduleSave();
    } catch { /* seeding failure costs continuity, never the tick */ }
  }

  // shapeProxyRecord-parity subset (the fields the validation compares and
  // the cutover will render). null = wire hasn't seen this agent yet.
  payload(name) {
    try {
      const a = this._agents.get(name);
      if (!a) return null;
      const lt = this._lifetime(a); // persisted base + launch ledger
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
          if (h) hold = { until: h.until, hours: h.hours, pings: h.pings, last_result: h.lastResult ?? null, always: !!h.always };
        } catch { /* hold degrades alone */ }
      }
      return {
        linked: true,
        sessionId: a.sessionId,
        model: a.model,
        cost: { usd: lt.cost, requests: lt.requests },
        turns: lt.turns,
        refusals: lt.refusals || 0,
        context: { inputTokens: a.inputTokens },
        // Cumulative billed tokens, NOT context.inputTokens. The two are
        // different scopes and must not be collapsed: context.inputTokens is
        // the LAST main-line turn's window size, while these are the lifetime
        // sums the per-ticket rollup divides to get a cached fraction.
        tokens: {
          input: lt.inputTokens, output: lt.outputTokens,
          cacheRead: lt.cacheReadTokens, cacheWrite: lt.cacheWriteTokens,
        },
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
      // Preserve the poll's own cumulative before clobbering it: wirescope's
      // figure is per-REGISTRATION (zeroes when the agent's CLI process spawns
      // — a GUI restart, not /clear), while wire.cost below is the persisted
      // ALL-TIME ledger (additive across restarts by design). Both are real,
      // different scopes; the renderer labels them "this run" vs "all-time"
      // (operator ruling 07-15 after the three-scopes cost incident — the
      // single unlabeled "total" contradicted the wirescope dashboard).
      // Absent when the overlay is off: pure-wire payloads carry no run figure.
      out.costRun = poll.cost ? { ...poll.cost } : null;
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
