'use strict';

// Keep-warm driver: port of proxylab/pinger.py + hold.py. Two halves,
// same as the Python:
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
//   - Persistence is NARROW, not absent. The original reasoning — the CLIs
//     are the app's own PTY children, so a restart respawns every session
//     and its first live turn repopulates the cache — holds for a TIMED
//     hold on an attended seat and is false for a PERPETUAL one, whose
//     whole purpose is a seat nobody is sitting at: no turn arrives, so
//     nothing repopulates, and a measured 5.5-hour restart left an armed
//     `always` hold silently not pinging. So the entries of ARMED-PERPETUAL
//     seats only (never the 2000-entry map) are spilled through
//     wire/hold-store.js and re-armed at startup via restorePerpetual().
//     The warm-only gate is unchanged on that path — restoring is not a
//     reason to pay for a cache write — and a restored credential may well
//     be stale everywhere except the bearer, which ping() re-reads.
//   - NO account registry: headers live in-process, and an entry carries the
//     exact headers of the session's own last request — with ONE exception.
//     The `authorization` bearer is re-read from the CLI's own credential
//     store at ping time (wire/claude-auth.js), because an OAuth token lives
//     ~8h and the CLI refreshes it only on a turn: replaying the captured one
//     401s on precisely the idle seat this feature exists for. A 401 that
//     survives that re-read is a dead credential, not a stale one, and still
//     spends a failure strike.
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
const { readClaudeAuth } = require('./claude-auth');

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
  // A perpetual hold (arm(..., {always:true})) opts out of the two SELF-BOUNDING
  // limits and keeps the third. It must stay pure: `always` rides the hold
  // object, never module state, or this stops being offline-testable.
  //   - deadline: an always hold has until:null, so an unguarded `now > null`
  //     would disarm it on the first tick.
  //   - ping budget: this is the limit that actually bites. maxPings is per
  //     ANCHOR and every organic turn resets it (noteRequest), so on an active
  //     session it is never reached — which is why an infinite hold looks fine
  //     in testing and dies after ~a day on the IDLE session it exists for.
  //   - failures: KEPT. ping() re-reads the CLI's current bearer, so a 401 that
  //     reaches this branch is a credential that is dead rather than stale, and
  //     this is the only thing bounding a perpetual retry loop against one. Do
  //     not add `always` to this branch.
  // Third element is a stable machine-readable `cause` (the disarm emits carry
  // it so persistence-clearing keys on it, never on the human `reason` text —
  // rewording a message must not silently break holdUntil-clearing).
  if (!hold.always && now > hold.until) return ['disarm', 'hold period over', 'expired'];
  if (!hold.always && hold.pings >= maxPings) return ['disarm', `max pings (${maxPings}) reached`, 'max-pings'];
  if (hold.failures >= maxFailures) {
    return ['disarm', `${hold.failures} consecutive ping failures (stale credentials?)`, 'failures'];
  }
  if (!hasEntry) return ['skip', 'no replayable request cached'];
  if (!warmthQ || !warmthQ.found) return ['skip', 'prefix not in ledger'];
  if (warmthQ.remaining_s <= 0) return ['skip', 'prefix already cold'];
  if (warmthQ.remaining_s >= margin) return ['skip', 'not yet due'];
  return ['ping', 'due'];
}

// How one ping result scores against the failure budget — PURE
// (offline-testable). Returns [kind, label]; only 'failure' spends a strike,
// and only 'warmed' clears the count.
//
// The 2-strike disarm exists for exactly ONE condition: a credential that is
// genuinely dead — revoked, or a logout. Staleness is no longer in that set:
// ping() re-reads the CLI's current bearer and declines outright when it cannot
// get a live one. Only a credential-shaped rejection may spend it. Everything transient must decline
// instead — a transport error or a retryable upstream status is not evidence of
// a dead credential, and on a perpetual hold it is fatal to treat it as one:
// `failures` resets only on a warmed ping or an organic turn, so on an idle seat
// strikes accumulate across an unbounded lifetime and two unrelated blips weeks
// apart disarm it. Worse, a failed ping never restamps the ledger, so the prefix
// stays due and strike two lands on the NEXT tick — one minute without network
// would permanently erase the operator's setting on an unattended seat.
//
// Declining is self-bounding rather than an unbounded retry loop: the prefix
// only stays due while it is still warm, and an outage that outlasts the cache
// turns it cold, at which point holdDecision skips on its own.
function pingOutcome(res) {
  if (res.warmed) return ['warmed', 'warmed'];
  if (res.skipped) return ['decline', `declined:${res.skipped}`]; // warm-only gate (race to cold)
  const s = res.status_code;
  if (s == null) return ['decline', 'declined:transport']; // DNS, refused, reset, closed lid
  if (s === 408 || s === 429 || s >= 500) return ['decline', `declined:${s}`]; // retryable upstream
  return ['failure', `fail:${s}`]; // 401/403 and friends: the credential shape this bounds
}

// PURE re-arm planning for a persisted hold INTENT seen on a session's first
// main-line turn after an app restart. The keeper itself is in-memory by design
// (header), so the intent — not the last-request bytes — is what survives on the
// sessions.json record. Returns:
//   { arm: true, always: true }  the seat is perpetual (keepWarmAlways) → re-arm
//                         with no deadline
//   { arm: true, hours }  re-arm the keeper for the REMAINING window (arm()
//                         re-clamps against maxHours on its own, so no clamp here)
//   { clear: true }       the persisted deadline already lapsed → drop the field
//   null                  nothing persisted (no hold to restore) → no-op
// `always` is checked FIRST and independently of holdUntil: a perpetual seat has
// no deadline to store, so it arrives here with holdUntil undefined and the
// `> 0` guard below would read it as "nothing persisted".
function rearmPlan(holdUntil, nowMs, always = false) {
  if (always) return { arm: true, always: true };
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
  //   entryStore  optional wire/hold-store HoldEntryStore. Absent (the
  //             default) the keeper is exactly as in-memory as it was: no
  //             file is written and no restart survival exists. Only a host
  //             that has a durable userData dir supplies one.
  //   maxEntries/maxHours/marginSeconds/intervalSeconds/maxPings/maxFailures
  //             cap overrides, defaults above
  constructor(opts = {}) {
    super();
    if (!opts.warmth) throw new Error('HoldKeeper needs a WarmthStore');
    this.warmth = opts.warmth;
    this._now = opts.now || (() => Date.now() / 1000);
    this._request = opts.request || postJson;
    this._auth = opts.auth || readClaudeAuth;
    this._entryStore = opts.entryStore || null;
    for (const k of Object.keys(DEFAULTS)) this[k] = opts[k] ?? DEFAULTS[k];
    this._entries = new Map(); // sessionId → { obj, headers, url, ts }
    this._holds = new Map(); // sessionId → { until, armedAt, hours, pings, failures, lastPingTs, lastResult }
    this._timer = null;
    this._inTick = false;
  }

  // Spill the entries of ARMED-PERPETUAL seats, and only those. Called on
  // every mutation of what that set contains (arm/disarm/endSession) and on
  // each noteRequest for an already-perpetual seat, so the persisted bytes
  // track the live ones rather than a snapshot from arming time — a replay of
  // a stale prefix is a cold write, exactly what the warm-only gate exists to
  // avoid.
  //
  // Writing the EMPTY set matters as much as writing a full one: it is what
  // takes a token off the disk when the last perpetual hold goes away.
  // `keep` carries records that must survive the rewrite even though they are
  // not armed — the startup restore uses it for a seat it could not JUDGE (see
  // restorePerpetual). Dropping those would convert a transient failure into a
  // permanent one.
  _flushPerpetual(keep = []) {
    if (!this._entryStore) return;
    const records = [];
    const seen = new Set();
    for (const [sid, hold] of this._holds) {
      if (!hold.always) continue; // constraint 1: perpetual only, never the map
      const e = this._entries.get(sid);
      if (!e) continue; // nothing replayable yet — a record with no obj buys nothing
      seen.add(sid);
      records.push({ sessionId: sid, obj: e.obj, headers: e.headers, url: e.url, ts: e.ts });
    }
    for (const r of keep) {
      if (r && r.sessionId && !seen.has(r.sessionId)) records.push(r);
    }
    this._entryStore.save(records);
  }

  // Startup re-arm: seed the entry map from disk and arm the seats that were
  // perpetual, WITHOUT waiting for a turn. That wait is the whole bug — an
  // idle seat never takes one.
  //
  // `accept(sessionId)` is supplied by the caller and is the authority on
  // whether a persisted session is still one this host should be pinging (the
  // seat still exists, still carries keepWarmAlways, is not archived). It is
  // passed IN rather than read here so this stays offline-testable, the same
  // reason rearmPlan takes its inputs.
  //
  // arm() is the NORMAL arm: it is cold-gated, so a prefix that went cold
  // during the downtime declines here exactly as it would anywhere else. A
  // restart is not a reason to force a cache write. Declining drops the
  // record — the seat's keepWarmAlways flag survives in persistence and
  // _maybeRearmHold still restores it on the next turn, so nothing is lost
  // beyond the unattended case, which a cold prefix has already lost anyway.
  //
  // ONE EXCEPTION, and it is the difference between a recoverable loss and a
  // permanent one: a warmth-store ERROR is not a cold prefix. warmth.js's gate
  // philosophy is that ABSENCE is evidence and a BROKEN STORE is not, and that
  // distinction has to reach the rewrite below — a store that failed to answer
  // at startup told us nothing about this seat, so erasing its record on the
  // strength of that non-answer leaves the NEXT launch with nothing to retry.
  // An attended seat would recover via _maybeRearmHold on its next turn; the
  // unattended seat this whole feature exists for would not. So an errored
  // decline keeps its record on disk and is retried next launch.
  //
  // Returns { restored, declined, dropped } for logging — counts only, never
  // the records: nothing here may put request bytes or headers in a log.
  restorePerpetual({ accept } = {}) {
    const out = { restored: 0, declined: 0, dropped: 0 };
    if (!this._entryStore) return out;
    const ok = typeof accept === 'function' ? accept : () => true;
    const keep = []; // records to preserve unjudged (see the store-error note above)
    for (const r of this._entryStore.load()) {
      let allowed = false;
      try { allowed = !!ok(r.sessionId); } catch { allowed = false; }
      if (!allowed) { out.dropped += 1; continue; }
      // Seeded directly rather than through noteRequest: that method re-anchors
      // holds and is the main-line-turn seam. This is a restore, not a turn.
      this._entries.set(r.sessionId, { obj: r.obj, headers: { ...(r.headers || {}) }, url: r.url, ts: r.ts ?? this._now() });
      let res = null;
      let threw = false;
      try { res = this.arm(r.sessionId, 0, { always: true }); } catch { threw = true; }
      if (res && res.armed) { out.restored += 1; continue; }
      out.declined += 1;
      this._entries.delete(r.sessionId);
      // A throw is the same class of non-answer as an explicit wq.error.
      if (threw || (res && res.warmth && res.warmth.error)) keep.push(r);
    }
    // Rewrite the file down to what actually re-armed, PLUS anything we could
    // not judge. A seat that was dropped or genuinely declined stops carrying a
    // token on disk within one launch instead of waiting for some future write.
    this._flushPerpetual(keep);
    return out;
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
        // An armed-PERPETUAL seat is exempt, and it is the one that would
        // otherwise always lose: `ts` is stamped by noteRequest only — a ping
        // never refreshes it — so an idle perpetual seat holds the OLDEST
        // timestamp by construction and is the FIRST thing churn evicts. Losing
        // it is not a cache miss: _flushPerpetual then finds no entry, and the
        // seat's disk record goes with it, silently ending the hold. The cap
        // still holds; the exemption is bounded by the number of armed holds,
        // which is small by construction.
        const h = this._holds.get(sid);
        if (h && h.always) continue;
        if (!oldest || e.ts < oldest[1].ts) oldest = [sid, e];
      }
      if (oldest) this._entries.delete(oldest[0]);
    }
    const hold = this._holds.get(sessionId);
    if (hold) {
      // A perpetual hold keeps until:null through an organic turn. Recomputing
      // it would yield `now` (hours is null, and null*3600 is 0), which is a
      // FINITE past timestamp — so the 're-anchored' emit below would pass the
      // `ev.until > 0` gate in session-manager and persist a bogus,
      // already-lapsed holdUntil on a perpetual seat on every single turn,
      // producing the both-fields-set state this design forbids.
      if (!hold.always) hold.until = now + hold.hours * 3600;
      hold.pings = 0;
      hold.failures = 0;
      this.emit('hold', { session: sessionId, event: 're-anchored', until: hold.until });
      // Only a perpetual seat has anything on disk to refresh; _flushPerpetual
      // filters anyway, but the guard keeps an organic turn on any of the other
      // (up to 2000) tracked sessions off the write path entirely.
      if (hold.always) this._flushPerpetual();
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
    // Re-read the bearer instead of replaying the captured one. `entry.headers`
    // is a snapshot from the last forwarded turn and nothing restamps it, so on
    // the idle seat this whole feature exists for it is stale by construction —
    // an OAuth access token lives ~8h and the CLI refreshes it only on a turn.
    //
    // Gated on the token SHAPE, not the provider: `sk-ant-oat` is the OAuth
    // token that expires. An `sk-ant-api` key does not, and a codex entry's
    // bearer is neither — both keep the header they came with.
    //
    // Both failure branches DECLINE rather than send. A decline spends no
    // failure strike (pingOutcome), which is the point: the 2-strike disarm has
    // to keep meaning "this credential is dead", and a token we could not read
    // or one that is merely mid-refresh is not evidence of that. The retry is
    // the next tick — a failed ping never restamps the ledger, so the prefix
    // stays due for the rest of its margin window and then goes cold on its own.
    const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
    if (authKey && /^Bearer\s+sk-ant-oat/i.test(headers[authKey] || '')) {
      const { accessToken, expiresAt } = this._auth();
      if (!accessToken) {
        return { ok: true, warmed: false, skipped: 'no-credential', session: sessionId,
          hash: hFull, note: 'could not read the current Claude OAuth token; declined rather than replaying a stale bearer' };
      }
      if (typeof expiresAt === 'number' && expiresAt <= Date.now()) {
        return { ok: true, warmed: false, skipped: 'credential-expired', session: sessionId,
          hash: hFull, note: 'the stored OAuth token is past expiry; declined until the CLI refreshes it' };
      }
      headers[authKey] = `Bearer ${accessToken}`;
    }
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
  // always:true arms a PERPETUAL hold — no deadline, no ping budget, failure
  // disarm kept (holdDecision says why). `hours` is ignored on that path rather
  // than set to a large number: maxHours clamps every finite value, so a
  // sentinel duration would silently come back out as 12h.
  arm(sessionId, hours, { force = false, always = false } = {}) {
    if (!sessionId) return { armed: false, reason: 'no_session' };
    if (!always && !(hours > 0)) return this.disarm(sessionId);
    hours = always ? null : Math.min(hours, this.maxHours);
    const entry = this._entries.get(sessionId);
    const wq = this.warmth.query({ session: sessionId });
    if (!wq.warm && !force) {
      const state = wq.found ? 'cold' : 'absent';
      return { armed: false, skipped: state, session: sessionId, warmth: wq,
        note: `prefix is '${state}', not warm — an armed hold could only ` +
          'ping it back at the write premium. Declined (force to arm anyway).' };
    }
    const now = this._now();
    // until:null (not a far-future sentinel) is the honest encoding of "no
    // deadline": every downstream `until > 0` guard then declines to persist or
    // render a timestamp that would be read back as a real one.
    const hold = { until: always ? null : now + hours * 3600, always, armedAt: now, hours,
      pings: 0, failures: 0, lastPingTs: null, lastResult: null };
    this._holds.set(sessionId, hold);
    // Before the emit: the emit is observed by session-manager, and a listener
    // that inspected the store must not see it lagging the hold it just heard about.
    this._flushPerpetual();
    this.emit('hold', { session: sessionId, event: 'armed', hours, always, until: hold.until });
    return { armed: true, session: sessionId, hours, always, until: hold.until,
      warmth: wq, pingable: !!entry };
  }

  disarm(sessionId) {
    const prev = this._holds.get(sessionId);
    this._holds.delete(sessionId);
    if (prev && prev.always) this._flushPerpetual(); // takes the token off disk
    if (prev) this.emit('hold', { session: sessionId, event: 'disarmed', reason: 'off', cause: 'off', pings: prev.pings });
    return { armed: false, disarmed: !!prev, session: sessionId, pings: prev ? prev.pings : 0 };
  }

  // SessionEnd: never spend autonomously on an ended session. The cached
  // entry stays (post-mortem views, and a --resume of the same session_id
  // picks the hold story back up from its next organic turn).
  endSession(sessionId) {
    const prev = this._holds.get(sessionId);
    this._holds.delete(sessionId);
    if (prev && prev.always) this._flushPerpetual();
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
          // This path deletes from _holds directly rather than via disarm(), so
          // it needs its own flush — a perpetual hold reaching the failure stop
          // (the only branch that can disarm one) would otherwise leave its
          // credential on disk until some unrelated write cleared it.
          if (hold.always) this._flushPerpetual();
          this.emit('hold', { session: sid, event: 'disarmed', reason, cause, pings: hold.pings, lastResult: hold.lastResult ?? null });
        } else if (action === 'ping') {
          const res = await this.ping(sid);
          const cur = this._holds.get(sid); // may have been disarmed mid-await
          if (cur) {
            cur.pings += 1;
            cur.lastPingTs = now;
            const [kind, label] = pingOutcome(res);
            cur.lastResult = label;
            // A decline neither spends a strike nor clears the count: it is not
            // evidence either way about the credential.
            if (kind === 'warmed') cur.failures = 0;
            else if (kind === 'failure') cur.failures += 1;
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

module.exports = { HoldKeeper, holdDecision, pingOutcome, postJson, rearmPlan };
