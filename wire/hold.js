'use strict';

// Keep-warm driver: port of proxylab/pinger.py + hold.py (W2 step 5,
// CLODEUX-PLAN.md). Two halves, same as the Python:
//   PING answers HOW to keep a prefix warm: the wire already saw the exact
//   last request of every session — the precise bytes the backend
//   content-addressed — so keeping it warm collapses to replaying that
//   request with thinking off and max_tokens:1. Identical cacheable prefix
//   => a cache READ that slides the TTL, for ~1 output token.
//   HOLD answers WHEN: an armed session is auto-pinged whenever its WARM
//   prefix nears expiry, until a deadline. Every organic turn re-anchors
//   the window (the hold is insurance on IDLE time: N hours after the
//   user's LAST real turn, not N hours after arming) and resets the ping
//   budget.
//
// Never-higher-cost gate (proxylab decision, unchanged): a ping is ONLY
// ever a win on a WARM prefix — a 0.10x cache read that buys a future
// write. On anything else (cold, absent, store error) replaying is a cache
// WRITE at the premium "for the sake of the ping". So ping IFF warm;
// everything else declines. force is the only override.
//
// Deliberate differences from the Python (all consequences of running
// IN-PROCESS instead of as a standalone proxy):
//   - NO persistence, NO restart-amnesia machinery: the CLIs are the app's
//     own PTY children, so the wire and its sessions share process fate —
//     after an app restart every session respawns and its first live turn
//     repopulates the cache. There is no window where a hold outlives its
//     session's credentials.
//   - NO auth bootstrap / account registry: headers live in-process; an
//     entry always carries the exact headers of the session's own last
//     request. A 401 on a replay means the CLI's OAuth expired mid-idle —
//     nothing in-process can refresh it (the CLI owns the credential
//     file), so it counts as a failure strike and the 2-strike disarm
//     bounds the waste. The session's next organic turn re-caches fresh
//     headers anyway.
//   - Arming is PROGRAMMATIC only (app-side call), the twin of proxylab's
//     POST /_hold: cold-gated like a ping, because with no forwarded turn
//     there is nothing that would re-establish a cold cache. The
//     /warm-cache echo transform is a W3 transform — the wire doesn't
//     transform yet.
//
// Events (HoldKeeper is an EventEmitter):
//   'hold' { session, event: 'armed'|'re-anchored'|'disarmed'|'ping', ... }

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { URL } = require('url');

const { prefixHash } = require('./warmth');

const DEFAULTS = {
  maxEntries: 2000, // last-request cap (WARMTH_PINGER_MAX)
  maxHours: 12, // hold duration clamp   (WARMTH_HOLD_MAX_HOURS)
  marginSeconds: 300, // ping inside (0, margin) of expiry (WARMTH_HOLD_MARGIN)
  intervalSeconds: 60, // tick cadence           (WARMTH_HOLD_INTERVAL)
  maxPings: 24, // ping budget per anchor  (WARMTH_HOLD_MAX_PINGS)
  maxFailures: 2, // consecutive FAILURES (not declines) -> disarm
};

// One tick's verdict for an armed session — PURE (offline-testable).
// warmthQ = WarmthStore.query() result for the entry's full prefix hash.
// Not-warm only SKIPS (never disarms): warmth can come back with the
// user's next real turn, and a skipping hold costs nothing — it
// self-bounds at `until`.
function holdDecision(hold, hasEntry, warmthQ, now, caps = {}) {
  const maxPings = caps.maxPings ?? DEFAULTS.maxPings;
  const maxFailures = caps.maxFailures ?? DEFAULTS.maxFailures;
  const margin = caps.marginSeconds ?? DEFAULTS.marginSeconds;
  // Third element is a stable machine-readable `cause` (the disarm emits carry
  // it so persistence-clearing keys on it, never on the human `reason` text —
  // rewording a message must not silently break holdUntil-clearing).
  if (now > hold.until) return ['disarm', 'hold period over', 'expired'];
  if (hold.pings >= maxPings) return ['disarm', `max pings (${maxPings}) reached`, 'max-pings'];
  if (hold.failures >= maxFailures) {
    return ['disarm', `${hold.failures} consecutive ping failures (stale credentials?)`, 'failures'];
  }
  if (!hasEntry) return ['skip', 'no replayable request cached'];
  if (!warmthQ || !warmthQ.found) return ['skip', 'prefix not in ledger'];
  if (warmthQ.remaining_s <= 0) return ['skip', 'prefix already cold'];
  if (warmthQ.remaining_s >= margin) return ['skip', 'not yet due'];
  return ['ping', 'due'];
}

// PURE re-arm planning for a persisted hold INTENT (holdUntil, epoch ms) seen
// on a session's first main-line turn after an app restart. The keeper itself
// is in-memory by design (header), so the intent — not the last-request bytes
// — is what survives on the sessions.json record. Returns:
//   { arm: true, hours }  re-arm the keeper for the REMAINING window (arm()
//                         re-clamps against maxHours on its own, so no clamp here)
//   { clear: true }       the persisted deadline already lapsed → drop the field
//   null                  nothing persisted (no hold to restore) → no-op
function rearmPlan(holdUntil, nowMs) {
  if (!(holdUntil > 0)) return null;
  if (holdUntil <= nowMs) return { clear: true };
  return { arm: true, hours: (holdUntil - nowMs) / 3600e3 };
}

// Minimal JSON POST on node http/https — injectable (opts.request) so
// tests never open sockets. Resolves { status, headers, body:Buffer };
// rejects on transport errors only (HTTP error statuses resolve).
function postJson(urlString, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlString); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(bodyBuf);
  });
}

class HoldKeeper extends EventEmitter {
  // opts:
  //   warmth    a wire/warmth WarmthStore (REQUIRED — the warm-only gate
  //             and the TTL-slide restamp both live there)
  //   now       clock override, seconds (tests)
  //   request   postJson override (tests)
  //   maxEntries/maxHours/marginSeconds/intervalSeconds/maxPings/maxFailures
  //             cap overrides, defaults above
  constructor(opts = {}) {
    super();
    if (!opts.warmth) throw new Error('HoldKeeper needs a WarmthStore');
    this.warmth = opts.warmth;
    this._now = opts.now || (() => Date.now() / 1000);
    this._request = opts.request || postJson;
    for (const k of Object.keys(DEFAULTS)) this[k] = opts[k] ?? DEFAULTS[k];
    this._entries = new Map(); // sessionId → { obj, headers, url, ts }
    this._holds = new Map(); // sessionId → { until, armedAt, hours, pings, failures, lastPingTs, lastResult }
    this._timer = null;
    this._inTick = false;
  }

  // Stash the just-forwarded main-line messages request so a later ping can
  // replay it, and re-anchor any armed hold (an organic turn re-warmed the
  // session itself, so the insurance window restarts: until = now + hours,
  // ping budget + failure strikes reset). The caller (wire/proxy.js) owns
  // the main-line/side-call/subagent gating — see its call site. Headers
  // are kept whole (auth + anthropic-beta, so the replay rides the same
  // cache namespace) — IN MEMORY ONLY, never written anywhere.
  noteRequest(sessionId, obj, headers, url) {
    if (!sessionId || !obj || typeof obj !== 'object') return;
    const now = this._now();
    this._entries.set(sessionId, { obj, headers: { ...headers }, url, ts: now });
    if (this._entries.size > this.maxEntries) {
      let oldest = null;
      for (const [sid, e] of this._entries) {
        if (!oldest || e.ts < oldest[1].ts) oldest = [sid, e];
      }
      if (oldest) this._entries.delete(oldest[0]);
    }
    const hold = this._holds.get(sessionId);
    if (hold) {
      hold.until = now + hold.hours * 3600;
      hold.pings = 0;
      hold.failures = 0;
      this.emit('hold', { session: sessionId, event: 're-anchored', until: hold.until });
    }
  }

  entry(sessionId) {
    return this._entries.get(sessionId) || null;
  }

  // Replay a session's cached last request as a minimal keep-warm ping.
  // Ping IFF the prefix is warm (see header); force is the only override
  // (deliberately (re)establish a cache). Result shape mirrors proxylab's
  // /_ping body: { ok, warmed, skipped?, reason?, ... }.
  async ping(sessionId, { force = false } = {}) {
    const entry = this._entries.get(sessionId);
    if (!entry) {
      return { ok: false, warmed: false, session: sessionId,
        reason: 'no cached request for this session yet (it must have made ' +
          '>=1 main-line messages call through the wire since app start)' };
    }
    const src = entry.obj;
    const msgs = Array.isArray(src.messages) ? src.messages : [];
    if (!msgs.length) {
      return { ok: false, warmed: false, session: sessionId, reason: 'cached request has no messages' };
    }
    const hFull = prefixHash(src, msgs.length);
    const prior = this.warmth.state(hFull);
    if (prior !== 'warm' && !force) {
      return { ok: true, warmed: false, skipped: prior, session: sessionId,
        hash: hFull, prior_warmth: prior,
        note: `prefix is '${prior}', not warm; a ping only refreshes a warm ` +
          'cache — replaying would be a cold-write at the write premium. ' +
          'Declined (force to establish it).' };
    }
    // Minimal warming variant: identical cacheable prefix (tools/system/
    // messages untouched -> same content hash), one output token,
    // non-streaming. thinking OFF so max_tokens can be 1; a
    // context_management thinking-clearing strategy then 400s "requires
    // thinking to be enabled", so drop it too. Neither field is part of
    // the cached prefix, so the cache READ is preserved. tools MUST stay
    // (it's IN the prefix).
    const warm = { ...src };
    delete warm.thinking;
    delete warm.context_management;
    warm.max_tokens = 1;
    warm.stream = false;
    const body = Buffer.from(JSON.stringify(warm), 'utf8');
    const headers = {};
    for (const [k, v] of Object.entries(entry.headers)) {
      if (k.toLowerCase() !== 'content-length') headers[k] = v;
    }
    headers['content-type'] = 'application/json';
    headers['accept-encoding'] = 'identity';
    let r;
    try {
      r = await this._request(entry.url, headers, body);
    } catch (e) {
      return { ok: false, warmed: false, session: sessionId,
        status_code: null, reason: `upstream error: ${e.message}` };
    }
    let data = {};
    try { data = JSON.parse(r.body.toString('utf8')); } catch { /* non-JSON error body */ }
    const u = (data && data.usage) || {};
    const usage = {
      input_tokens: u.input_tokens ?? null,
      output_tokens: u.output_tokens ?? null,
      cache_read_input_tokens: u.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
    };
    const ok = r.status === 200;
    const res = { ok, warmed: ok, session: sessionId, status_code: r.status,
      prior_warmth: prior, hash: hFull, usage,
      request_id: (r.headers || {})['request-id'] || null };
    if (ok) {
      // refresh the ledger off this replay — the TTL slide the ping bought
      const rec = this.warmth.record(warm, usage, sessionId);
      if (rec) {
        res.ttl_s = rec.ttl;
        res.remaining_s = rec.ttl; // just stamped: full ttl left
      }
      res.cache_read_input_tokens = usage.cache_read_input_tokens;
      res.cache_hit = (usage.cache_read_input_tokens || 0) > 0;
    } else {
      res.error = (data && Object.keys(data).length) ? data : r.body.toString('utf8').slice(0, 500);
    }
    return res;
  }

  // Arm n hours of idle insurance for a session. Cold-gated like a ping
  // (proxylab's programmatic /_hold): with no forwarded turn there is
  // nothing that would re-establish a cold cache, so arming a non-warm
  // prefix declines — { armed:false, skipped:<state> } — unless force.
  // hours <= 0 disarms (the Python 'off' spelling).
  arm(sessionId, hours, { force = false } = {}) {
    if (!sessionId) return { armed: false, reason: 'no_session' };
    if (!(hours > 0)) return this.disarm(sessionId);
    hours = Math.min(hours, this.maxHours);
    const entry = this._entries.get(sessionId);
    const wq = this.warmth.query({ session: sessionId });
    if (!wq.warm && !force) {
      const state = wq.found ? 'cold' : 'absent';
      return { armed: false, skipped: state, session: sessionId, warmth: wq,
        note: `prefix is '${state}', not warm — an armed hold could only ` +
          'ping it back at the write premium. Declined (force to arm anyway).' };
    }
    const now = this._now();
    const hold = { until: now + hours * 3600, armedAt: now, hours,
      pings: 0, failures: 0, lastPingTs: null, lastResult: null };
    this._holds.set(sessionId, hold);
    this.emit('hold', { session: sessionId, event: 'armed', hours, until: hold.until });
    return { armed: true, session: sessionId, hours, until: hold.until,
      warmth: wq, pingable: !!entry };
  }

  disarm(sessionId) {
    const prev = this._holds.get(sessionId);
    this._holds.delete(sessionId);
    if (prev) this.emit('hold', { session: sessionId, event: 'disarmed', reason: 'off', cause: 'off', pings: prev.pings });
    return { armed: false, disarmed: !!prev, session: sessionId, pings: prev ? prev.pings : 0 };
  }

  // SessionEnd: never spend autonomously on an ended session. The cached
  // entry stays (post-mortem views, and a --resume of the same session_id
  // picks the hold story back up from its next organic turn).
  endSession(sessionId) {
    const prev = this._holds.get(sessionId);
    this._holds.delete(sessionId);
    if (prev) this.emit('hold', { session: sessionId, event: 'disarmed', reason: 'session ended', cause: 'session-ended', pings: prev.pings });
    return { session: sessionId, holdDisarmed: !!prev };
  }

  holds() {
    const out = {};
    for (const [sid, h] of this._holds) out[sid] = { ...h };
    return out;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch((e) => this.emit('hold', { session: null, event: 'tick-error', error: e.message }));
    }, Math.max(5, this.intervalSeconds) * 1000);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // One pass over the armed holds. Serialized (a slow upstream must not
  // stack ticks); pings run sequentially — the fleet is small and a ping
  // is one round-trip.
  async tick(now) {
    if (this._inTick) return;
    this._inTick = true;
    try {
      now = now ?? this._now();
      for (const [sid, hold] of [...this._holds]) {
        const entry = this._entries.get(sid);
        let wq = null;
        if (entry) {
          try {
            const msgs = Array.isArray(entry.obj.messages) ? entry.obj.messages : [];
            wq = this.warmth.query({ hash: prefixHash(entry.obj, msgs.length) });
          } catch { wq = null; }
        }
        const [action, reason, cause] = holdDecision(hold, !!entry, wq, now, this);
        if (action === 'disarm') {
          this._holds.delete(sid);
          this.emit('hold', { session: sid, event: 'disarmed', reason, cause, pings: hold.pings });
        } else if (action === 'ping') {
          const res = await this.ping(sid);
          const cur = this._holds.get(sid); // may have been disarmed mid-await
          if (cur) {
            cur.pings += 1;
            cur.lastPingTs = now;
            if (res.warmed) {
              cur.failures = 0;
              cur.lastResult = 'warmed';
            } else if (res.skipped) {
              // clean warm-only decline (race to cold) — not a failure
              cur.lastResult = `declined:${res.skipped}`;
            } else {
              cur.failures += 1;
              cur.lastResult = `fail:${res.status_code ?? 'transport'}`;
            }
          }
          this.emit('hold', { session: sid, event: 'ping', result: res,
            pings: cur ? cur.pings : hold.pings + 1 });
        }
      }
    } finally {
      this._inTick = false;
    }
  }
}

module.exports = { HoldKeeper, holdDecision, postJson, rearmPlan };
