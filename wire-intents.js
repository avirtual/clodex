'use strict';

// W3 intent cutover — wire replaces JsonlWatcher as the live intent path.
//
// The JSONL path inferred everything from transcript-file side effects: turn
// text buffered by requestId and flushed on 1s silence, activity guessed from
// whether text was still arriving, session identity from a symlink. The wire
// SEES the actual protocol: turn.started when a messages request enters,
// turn.completed with stop.is_turn when a response genuinely ends a user turn
// (tool_use hops and side-calls say so). This module holds the app-side
// pieces of that cutover, all consume-only (a bug here degrades to a missed
// intent/notification, never a broken wire or PTY):
//
//   ActivityTracker   thinking/idle off wire events instead of text-silence
//                     heuristics. idle fires either on a terminal main-line
//                     stop (turnEnd:true — the only one worth a notification)
//                     or after a quiet-gap timer when requests stop mid-turn
//                     (tool running >GAP with nothing in flight).
//   IntentDeduper     claim-once ledger keyed by (agent, intent-key) with a
//                     TTL. Both dispatch paths (wire live + transcript
//                     recovery) claim before dispatching, so their overlap
//                     window during tee-failure recovery can't double-fire.
//   TranscriptSentinel the JSONL machinery demoted to what only it can do:
//                     (1) session identity from the run/<name>/transcript.jsonl
//                     symlink (repointed by the SessionStart hook at CLI
//                     boot — the wire only learns an id on the first turn,
//                     too late for /clear-then-quit resume correctness);
//                     (2) the compact-summary rendezvous (isCompactSummary
//                     is a transcript fact; nothing rides the wire for it);
//                     (3) tee-failure recovery — arm a real JsonlWatcher on
//                     the transcript tail until the wire produces a healthy
//                     turn again. The always-on 250ms transcript PARSING is
//                     gone; steady-state cost is one readlink per poll.

const DEDUPE_TTL_MS = 60_000;
const IDLE_GAP_MS = 30_000; // no in-flight request for this long mid-turn -> idle
const COMPACT_ARM_TIMEOUT_MS = 10 * 60_000; // abandoned compact: stop parsing

class IntentDeduper {
  constructor({ ttl = DEDUPE_TTL_MS, now = Date.now } = {}) {
    this._ttl = ttl;
    this._now = now;
    this._seen = new Map(); // agent -> Map<key, ts>
  }

  // Source-aware claim. Returns { ok, reason } — ok true = the caller dispatches;
  // reason (non-null only when ok is false) names WHY the drop happened, so the
  // dispatch sites can log it (a generic call-site string would lie about which
  // case fired). `source` is 'wire' (live receipt) or 'recovery' (tee-failure
  // transcript replay).
  //
  // The deduper exists for exactly ONE overlap: tee-failure recovery replays the
  // handover turn's tail through onText AFTER the wire already dispatched it — the
  // two paths must not double-fire. So the rules are source-shaped, NOT
  // claim-once:
  //   - reject when a non-expired prior claim came from the OTHER source
  //     (cross-path overlap — the real dedupe case, both directions), OR
  //   - reject recovery-after-recovery (the replay tail repeats each poll).
  //   - ALLOW wire-after-wire: distinct wire turns are distinct emissions and a
  //     turn can't legitimately dispatch twice from the wire (verified: one
  //     turn.completed per reqId, close()-guarded). Collapsing them would eat a
  //     deliberate retry — the exact bug this fix closes. (Intra-turn duplicate
  //     intents in ONE turn's text are deduped by the per-batch Set at the call
  //     site, not here — that Set is load-bearing precisely because this allows
  //     wire-after-wire.)
  claim(agent, key, source = 'wire') {
    const now = this._now();
    let m = this._seen.get(agent);
    if (!m) { m = new Map(); this._seen.set(agent, m); }
    for (const [k, rec] of m) { if (now - rec.ts > this._ttl) m.delete(k); }
    const prior = m.get(key);
    if (prior) {
      if (source === 'recovery' || prior.source === 'recovery') {
        const reason = (source === 'recovery' && prior.source === 'recovery')
          ? 'recovery replay repeat'
          : `cross-path overlap (${prior.source}→${source})`;
        return { ok: false, reason };
      }
      // wire-after-wire: allow, and re-stamp so the TTL tracks the latest turn.
    }
    m.set(key, { ts: now, source });
    return { ok: true, reason: null };
  }

  prune(liveNames) {
    for (const agent of this._seen.keys()) {
      if (!liveNames.has(agent)) this._seen.delete(agent);
    }
  }
}

class ActivityTracker {
  // emit(agent, 'thinking' | 'idle', { turnEnd }) — deduped, turnEnd true only
  // on a terminal main-line stop (the notification-worthy idle).
  constructor(emit, { idleGapMs = IDLE_GAP_MS } = {}) {
    this._emit = emit;
    this._gap = idleGapMs;
    this._agents = new Map(); // agent -> { inflight:Set, state, timer }
  }

  _a(agent) {
    let a = this._agents.get(agent);
    if (!a) { a = { inflight: new Set(), state: 'idle', timer: null }; this._agents.set(agent, a); }
    return a;
  }

  _set(agent, a, state, turnEnd = false) {
    if (a.timer) { clearTimeout(a.timer); a.timer = null; }
    if (a.state === state) return;
    a.state = state;
    try { this._emit(agent, state, { turnEnd }); } catch { /* consume-only */ }
  }

  turnStarted(agent, { reqId, sideCall } = {}) {
    if (sideCall) return; // title/probe traffic isn't the agent working
    const a = this._a(agent);
    a.inflight.add(reqId);
    if (a.timer) { clearTimeout(a.timer); a.timer = null; }
    this._set(agent, a, 'thinking');
  }

  turnCompleted(agent, { reqId, sideCall, stop } = {}) {
    const a = this._a(agent);
    a.inflight.delete(reqId);
    if (sideCall) return;
    if (stop && stop.is_turn) { this._set(agent, a, 'idle', true); return; }
    this._maybeGapIdle(agent, a);
  }

  // Request died without a receipt (tee-failure, upstream error): the turn
  // may still be alive client-side, so don't wedge 'thinking' — fall back to
  // the quiet-gap timer, same as a mid-turn tool run.
  requestFailed(agent, reqId) {
    const a = this._a(agent);
    a.inflight.delete(reqId);
    this._maybeGapIdle(agent, a);
  }

  _maybeGapIdle(agent, a) {
    if (a.inflight.size > 0 || a.state === 'idle' || a.timer) return;
    a.timer = setTimeout(() => {
      a.timer = null;
      if (a.inflight.size === 0) this._set(agent, a, 'idle');
    }, this._gap);
    if (a.timer.unref) a.timer.unref();
  }

  prune(liveNames) {
    for (const [agent, a] of this._agents) {
      if (!liveNames.has(agent)) {
        if (a.timer) clearTimeout(a.timer);
        this._agents.delete(agent);
      }
    }
  }
}

class TranscriptSentinel {
  // opts:
  //   linkPath     run/<name>/transcript.jsonl (the SessionStart hook's symlink)
  //   onSessionId  fired with the new id whenever the symlink repoints
  //   makeWatcher  ({ onText?, onCompactSummary? }) => JsonlWatcher-shaped
  //                object with start()/stop() that begins at transcript EOF.
  //                Injected so this module never owns transcript parsing.
  //   fs, pollMs, now — test seams
  constructor({ linkPath, onSessionId, makeWatcher, fs = require('fs'), pollMs = 250, now = Date.now } = {}) {
    this._linkPath = linkPath;
    this._onSessionId = onSessionId || (() => {});
    this._makeWatcher = makeWatcher;
    this._fs = fs;
    this._pollMs = pollMs;
    this._now = now;
    this._target = null;
    this._timer = null;
    this._stopped = false;
    this._compact = null;  // { watcher, armedAt }
    this._recovery = null; // watcher
  }

  start() { this._poll(); }

  _poll() {
    if (this._stopped) return;
    try {
      const target = this._fs.realpathSync(this._linkPath);
      if (target !== this._target) {
        this._target = target;
        const sessionId = require('path').basename(target, '.jsonl');
        if (sessionId) { try { this._onSessionId(sessionId); } catch {} }
      }
    } catch { /* link absent/dangling: CLI not booted yet */ }
    if (this._compact && (this._now() - this._compact.armedAt) > COMPACT_ARM_TIMEOUT_MS) {
      this._disarmCompact(); // abandoned compact — stop parsing the transcript
    }
    this._timer = setTimeout(() => this._poll(), this._pollMs);
    if (this._timer.unref) this._timer.unref();
  }

  // Compact rendezvous: parse the transcript tail ONLY between "self-compact
  // fired" and "summary entry landed". The armed watcher's text callbacks are
  // noops — intent dispatch stays on the wire the whole time.
  armCompact(onSummary) {
    this._disarmCompact();
    const watcher = this._makeWatcher({
      onCompactSummary: () => {
        this._disarmCompact();
        try { onSummary(); } catch {}
      },
    });
    this._compact = { watcher, armedAt: this._now() };
    watcher.start();
  }

  _disarmCompact() {
    if (this._compact) { try { this._compact.watcher.stop(); } catch {} this._compact = null; }
  }

  // Tee-failure recovery: the wire's observer died for a request, so its text
  // never produced a receipt — replay the transcript tail (the CLI writes the
  // turn there regardless) through the normal intent scan until the wire
  // proves healthy again. Dispatch overlap on the handover turn is the
  // IntentDeduper's job, not ours. Idempotent while already armed.
  armRecovery(onText) {
    if (this._recovery) return;
    this._recovery = this._makeWatcher({ onText });
    this._recovery.start();
  }

  get recovering() { return !!this._recovery; }

  // A healthy main-line wire turn ends recovery. stop() flushes the watcher's
  // pending text through onText — the deduper drops whatever the wire already
  // dispatched.
  noteWireHealthy() {
    if (this._recovery) { try { this._recovery.stop(); } catch {} this._recovery = null; }
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._disarmCompact();
    this.noteWireHealthy();
  }
}

module.exports = { IntentDeduper, ActivityTracker, TranscriptSentinel, DEDUPE_TTL_MS, IDLE_GAP_MS };
