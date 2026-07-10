// wirescope-proxy.js — the client + poller half of the wirescope integration.
// ProxyClient is the HTTP client for a wirescope base (probe/status/compact/
// report/hold/strip-thinking/prune…); ProxyPoller is the one-per-process status
// poller that fans a single /_status fetch per distinct base out to the live
// routed sessions each tick. The PROXY_* tuning constants they own move here too
// (PROXY_REPORT_TIMEOUT is re-exported — main.js still reads it for one /_report
// call).
//
// ProxyClient needs only http/https + the consts, so it stays a module-level
// object (byte-identical). ProxyPoller reads three main.js globals — the logger,
// stripLevelOf (transcript strip level), and WIRE_TELEMETRY_LIVE (env flag) —
// injected via createProxyPoller so the class body stays byte-identical modulo
// the +2 factory indent; `manager` is still the ctor param (existing shape).
//
// Live HTTP + a SessionManager make these integration-only; no unit tests here.

const http = require('http');
const https = require('https');
const { PROXY_AGENT_PREFIX, pickProxyRecord, shapeProxyRecord, shouldAutoCompact, autoCompactDecision, AUTO_COMPACT } = require('./proxy-util');

const PROXY_POLL_INTERVAL = 5000; // ms
const PROXY_HTTP_TIMEOUT = 4000;  // ms — default; keeps polling/handshake snappy
// Reports disk-scan the whole session on the proxy side, so they can take much
// longer than a normal call on large/old sessions or slower machines. Give the
// /_report fetch its own generous budget instead of the snappy default.
const PROXY_REPORT_TIMEOUT = 20000; // ms
const PROXY_PROBE_TTL = 60000;    // ms — re-confirm identity at most this often
// Link hysteresis: the proxy's /_status doesn't always list a session every tick
// (idle between turns, count-token probe churn), so a single missing record would
// otherwise flip the bar to "unlinked" and tear down the clickable cost/wirescope/
// ctx affordances — they reappear next good tick, which reads as the links blinking
// on and off. Tolerate misses for this long (clodex still knows the live sessionId
// independently) before declaring a genuine unlink; the renderer dims the held-over
// payload via its existing stale/dead aging in the meantime.
const PROXY_LINK_GRACE = 20000;   // ms (~4 polls)
const PROXY_STRIP_REPOST_MS = 4000; // ms — debounce identical strip re-POSTs to at
                                    // most once per poll cycle (~5s), so a genuine
                                    // retry on the next tick is never suppressed
// /_identity product names we recognize. A set so the formerly-logproxy
// rename (now wirescope, protocols.identity 2) stays trivial to extend.
const PROXY_PRODUCTS = new Set(['wirescope']);

const ProxyClient = {
  _req(base, pathname, method = 'GET', timeout = PROXY_HTTP_TIMEOUT) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(base + pathname); } catch (e) { return reject(e); }
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(url, { method, timeout }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch {}
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
  },
  _getJson(base, pathname, timeout) { return this._req(base, pathname, 'GET', timeout); },

  // Arm/disarm a cache hold. hours=0 disarms. The proxy may decline a cold
  // prefix (200 with armed:false, skipped:<state>) unless force=1. HTTP status
  // reflects request validity, not the side-effect — branch on the body.
  async hold(base, sessionId, hours, force) {
    const qs = new URLSearchParams({ session: sessionId, hours: String(hours) });
    if (force) qs.set('force', '1');
    return this._req(base, `/_hold?${qs.toString()}`, 'POST');
  },

  // Set the per-session strip LEVEL override on /_strip. level 0 = revert to the
  // proxy's global default — via `action=clear` (drop the override) when that
  // default is OFF, or an explicit `&level=0` override (explicitZero) to hold a
  // session OFF when the global default is ON (clear would fall back to the
  // on-default and the poller would flap). 1 = strip prior thinking (`&on=1`);
  // 2 = thinking + edit-acks + failed-call stubs (`&level=2`). One mechanism, three
  // levels — there's no separate stale-tools endpoint. The setter is an in-memory
  // write on the proxy (no turn, no credit), so it's cheap + idempotent — safe to
  // re-fire on every relink. Body carries the resolved `effective`; branch on the
  // body, not the HTTP status.
  async stripThinking(base, sessionId, level, explicitZero = false) {
    const qs = new URLSearchParams({ session: sessionId });
    if (level === 2) qs.set('level', '2');
    else if (level === 1) qs.set('on', '1');
    else if (explicitZero) qs.set('level', '0');
    else qs.set('action', 'clear');
    return this._req(base, `/_strip?${qs.toString()}`, 'POST');
  },

  // Ask wirescope to BAKE a session's transcript down to its safe-to-drop set
  // (prior thinking; at L2 also the edit-ack / failed-call folds). A one-time
  // source rewrite — pay one re-cache, then run permanently slimmer with ~0
  // repeat live-strip work (see the strip arc: this is NOT a free recycle).
  // File-level op keyed by transcript PATH so it works on a COLD session the
  // proxy no longer holds in memory. wirescope owns the transform (bake ⊆ the
  // session's effective strip level, kept in-repo so it can't drift), backs up
  // (.bak-<ts>), atomic-renames, and integrity-gates the chain; on any !ok the
  // caller MUST resume the ORIGINAL transcript untouched.
  async compact(base, sessionId, transcriptPath, level = 0) {
    const qs = new URLSearchParams({ session: sessionId, path: transcriptPath });
    // Tell wirescope our INTENDED strip level so the bake depth matches it: at
    // cold resume the proxy holds no live override to read, so clodex is the
    // source of intent. Thinking is always safe to bake (level-independent);
    // level>=2 also opts into the edit-ack / failed-call folds.
    if (level >= 1) qs.set('level', String(level));
    return this._req(base, `/_compact?${qs.toString()}`, 'POST');
  },

  // Confirm a base is our telemetry proxy (wirescope) and read its live
  // capabilities. Prefers the /_identity handshake (v0.2.8+); falls back to
  // /_status + proxy.version/flags for older deployments. Returns null when
  // it's not recognized / unreachable.
  async probe(base) {
    try {
      const id = await this._getJson(base, '/_identity');
      if (id.status === 200 && id.json && PROXY_PRODUCTS.has(id.json.product)) {
        return {
          product: id.json.product,
          version: id.json.version || null,
          capabilities: id.json.capabilities || {},
        };
      }
    } catch {}
    try {
      const st = await this._getJson(base, '/_status');
      const p = st.json && st.json.proxy;
      if (st.status === 200 && p && p.version) {
        const flags = p.flags || {};
        return {
          // /_status carries no product field; this fallback only matches
          // pre-/_identity deployments, which predate the wirescope rename.
          product: 'logproxy',
          version: p.version,
          capabilities: {
            stats: true,
            hold: !!flags.hold,
            warmth: !!flags.pinger,
            subscribers: !!(p.subscribers && p.subscribers.enabled),
          },
        };
      }
    } catch {}
    return null;
  },

  async status(base) {
    const st = await this._getJson(base, '/_status');
    if (st.status === 200 && st.json && Array.isArray(st.json.sessions)) {
      return st.json.sessions;
    }
    return [];
  },

  // On-demand detail for one subagent instance (the live-activity popover).
  // Deliberately NOT in the 5s poll — the request body it reads is heavy. Returns
  // `{ found, last_text, last_tool, last_tool_input, turn_ts, ... }`; on a miss
  // the body carries `{ found:false, reason }` with a 200 (wirescope's
  // action-endpoint convention — HTTP status = request validity, outcome in the
  // body). `maxlen` clamps string VALUES inside last_tool_input server-side so we
  // don't pull whole file bodies for a one-line preview. `child` is the
  // sub_agents[].key (== agent_id when present, else role).
  async subagentDetail(base, sessionId, child, maxlen) {
    const qs = new URLSearchParams({ session: sessionId, child, detail: '1' });
    if (maxlen) qs.set('maxlen', String(maxlen));
    return this._getJson(base, `/_subagents?${qs.toString()}`);
  },

  // On-demand cache-bust forensics for one session (the bust-inspector popover).
  // Reads /_bust — per-transition divergence: severity, magnitude, locus (what
  // changed), and (v0.6.20+) per-transition class/fault/fix_hint. DISK-based +
  // heavy like the report; NOT in the 5s poll. Same timeout budget as /_report.
  async bustSeries(base, sessionId) {
    return this._getJson(base, `/_bust?session=${encodeURIComponent(sessionId)}`, PROXY_REPORT_TIMEOUT);
  },

  // Capture-log retention (wirescope v0.6.23+, gated on capabilities.prune —
  // presence of a 200/ok GET is the capability signal). MACHINE-WIDE, not
  // per-session: operates on the whole LOG_DIR. wirescope owns which files are
  // safe to drop (active/warm/recent skipped server-side); clodex only reads the
  // size/reclaimable readout and triggers a prune. GET = free size readout +
  // reclaimable estimate per scope. POST executes; older_than is REQUIRED (1h
  // floor, 400 if missing/malformed). tier=receipts (default) collapses old
  // sessions to billing receipts so /_report still prices them (only /_bust
  // byte-forensics die); tier=full deletes the receipts too. scope=all (default)
  // = sessions + the no-session probe bucket.
  pruneInfo(base) { return this._getJson(base, '/_prune', PROXY_REPORT_TIMEOUT); },
  prune(base, { olderThan, tier, scope, dryRun } = {}) {
    const qs = new URLSearchParams({ older_than: String(olderThan) });
    if (tier) qs.set('tier', tier);
    if (scope) qs.set('scope', scope);
    if (dryRun) qs.set('dry_run', '1');
    return this._req(base, `/_prune?${qs.toString()}`, 'POST', PROXY_REPORT_TIMEOUT);
  },
};


function createProxyPoller({
  log, stripLevelOf, WIRE_TELEMETRY_LIVE,
  // Fix for the M3 leak set (free identifiers that killed the poller tick
  // silently — .catch(() => {}) ate the ReferenceError and the status bar
  // never populated): autoCompactOf/peerProxyView are main.js helpers by
  // value; persistence/remoteServer are whenReady-assigned so they cross as
  // getters; getContextCommands defers SessionManager.CONTEXT_COMMANDS past
  // the class's construction (this factory runs before it).
  autoCompactOf, peerProxyView, getPersistence, getRemoteServer, getContextCommands,
}) {
  // App-global poller (one per process, shared across windows): a single
  // /_status fetch per distinct proxy base each tick, regardless of window
  // count, fanned out to live routed sessions. Pauses entirely when no session
  // is routed through a proxy.
  class ProxyPoller {
    constructor(manager) {
      this.manager = manager;
      this.timer = null;
      this.probeCache = new Map(); // base -> { result, ts }
      this.last = new Map();       // session name -> last shaped payload
      // session name -> { sessionId, level } we've pushed to the proxy's in-memory
      // strip overrides. Cleared when a session goes unlinked so the next linked
      // tick re-asserts (covers proxy restarts, which wipe the overrides).
      this.stripAsserted = new Map();
      // Bases that have advertised strip_thinking on a genuine wirescope probe,
      // mapped to the LAST genuine cap object (so max_level/levels survive a
      // downgrade tick — see the re-impose below). strip_thinking.available is a
      // hardcoded-true STATIC property of a wirescope deployment (confirmed by
      // wirescope: it's a dict literal, not a runtime flag), so once a real
      // wirescope probe shows it we latch it PERMANENTLY per base and never let a
      // later failed/foreign/fallback probe retract it. The 🧠 strip button's DOM
      // presence is a deployment property, not a per-tick network fact — this is
      // what stops the button from vanishing (or L2 relocking) on a probe hiccup.
      this.stripCapBases = new Map();
      // session name -> last auto-compact fire ts (cooldown latch — the 5s poll
      // gets ~12 ticks inside the warmth headroom window; fire once).
      this.autoCompacted = new Map();
      this._busy = false;
    }

    // Keep the strip re-assert tracking in sync after an explicit level change
    // (proxy:setStripLevel POSTs directly), so the next tick's reconcile doesn't
    // redundantly re-fire within the debounce window. Stamps `ts` for any level
    // (incl. 0) so the recent-POST debounce covers a manual clear too.
    noteStripAsserted(name, sessionId, level) {
      if (sessionId) this.stripAsserted.set(name, { sessionId, level, ts: Date.now() });
      else this.stripAsserted.delete(name);
    }

    start() {
      if (this.timer) return;
      this.timer = setInterval(() => this._tick().catch(() => {}), PROXY_POLL_INTERVAL);
      this._tick().catch(() => {});
    }

    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    snapshot(name) { return this.last.get(name) || null; }

    _activeBases() {
      const bases = new Map(); // base -> [session]
      for (const s of this.manager.sessions.values()) {
        if (!s.agentType || !s.proxyBase || !s.proxyAgent) continue;
        if (!bases.has(s.proxyBase)) bases.set(s.proxyBase, []);
        bases.get(s.proxyBase).push(s);
      }
      return bases;
    }

    async _probe(base) {
      const cached = this.probeCache.get(base);
      if (cached && Date.now() - cached.ts < PROXY_PROBE_TTL) return cached.result;
      const result = await ProxyClient.probe(base);
      this.probeCache.set(base, { result, ts: Date.now() });
      return result;
    }

    async _tick() {
      if (this._busy) return;
      // Prune telemetry for sessions that have gone away.
      for (const name of this.last.keys()) {
        if (!this.manager.sessions.has(name)) this.last.delete(name);
      }
      for (const name of this.autoCompacted.keys()) {
        if (!this.manager.sessions.has(name)) this.autoCompacted.delete(name);
      }
      if (this.manager._wireTelemetry) {
        this.manager._wireTelemetry.prune(new Set(this.manager.sessions.keys()));
      }
      const bases = this._activeBases();
      if (bases.size === 0) return; // nobody cares — skip all HTTP
      this._busy = true;
      try {
        for (const [base, sess] of bases) {
          const probe = await this._probe(base);
          if (!probe || !probe.capabilities.stats) continue;
          // Latch strip capability per base (see this.stripCapBases). Only a genuine
          // wirescope probe may SET the latch; a foreign/fallback probe (the legacy
          // logproxy /_status downgrade carries no strip_thinking key) may only READ
          // it. Once latched, re-impose the LAST GENUINE cap on this tick's probe so a
          // downgraded payload can't retract the button OR drop max_level (which would
          // relock L2 to "coming soon"). We replace probe.capabilities rather than
          // mutate it in place to avoid poisoning the 60s probe cache.
          const probeStripThinking = probe.capabilities.strip_thinking;
          const probeStripCap = !!(probeStripThinking && probeStripThinking.available);
          if (probe.product === 'wirescope' && probeStripCap) {
            this.stripCapBases.set(base, probeStripThinking);
          } else if (this.stripCapBases.has(base) && !probeStripCap) {
            probe.capabilities = { ...probe.capabilities, strip_thinking: this.stripCapBases.get(base) };
          }
          let records;
          try { records = await ProxyClient.status(base); } catch { continue; }
          const byAgent = new Map();
          for (const r of records) {
            // Prefilter to our namespace. One agent id can map to MANY records:
            // /clear keeps the id but mints a new session, so collect per agent
            // and let pickProxyRecord choose the live one (see proxy-util).
            if (r && typeof r.agent === 'string' && r.agent.startsWith(PROXY_AGENT_PREFIX)) {
              let arr = byAgent.get(r.agent);
              if (!arr) byAgent.set(r.agent, arr = []);
              arr.push(r);
            }
          }
          const stripThinkingCap = probe.capabilities && probe.capabilities.strip_thinking;
          const stripCap = !!(stripThinkingCap && stripThinkingCap.available);
          // Highest strip level this proxy serves: max_level when advertised (L2
          // build), else L1. A persisted L2 on a pre-L2 proxy degrades to L1 on the
          // wire (and auto-upgrades the moment the proxy advertises max_level:2).
          const proxyMaxLevel = (stripThinkingCap && typeof stripThinkingCap.max_level === 'number')
            ? stripThinkingCap.max_level : 1;
          for (const s of sess) {
            const payload = shapeProxyRecord(pickProxyRecord(byAgent.get(s.proxyAgent), s.sessionId), probe);
            payload.base = base; // poller context, not record shape — for the session-page link
            // clodex-side authoritative strip level (the proxy overrides are
            // in-memory and not trustworthy pre-relink). Surfaced for the bar menu.
            const entry = getPersistence().get(s.name);
            const level = stripLevelOf(entry);
            payload.stripLevel = level;
            // Auto-compact-before-cold state, surfaced for the warm menu toggle.
            payload.autoCompact = autoCompactOf(entry);
            // Link hysteresis: don't tear the bar down on a single missing record.
            // If we were linked very recently, keep showing the last-good payload
            // (the renderer ages it to stale/dead on its own) and skip this tick's
            // strip re-assert — clodex still knows the live sessionId, so a held-over
            // snapshot keeps the cost/wirescope/ctx links clickable and IPC fetches
            // (proxy:hold, cost report) working through the blip.
            if (!payload.linked) {
              const prev = this.last.get(s.name);
              if (prev && prev.linked && (Date.now() - (prev.ts || 0)) < PROXY_LINK_GRACE) {
                continue; // transient miss — leave last-good in place, don't re-emit
              }
            }
            // Lifetime-totals seed: one-time per session_id, must precede both
            // the overlay (bar shows the continuous number immediately) and
            // diffPoll (the diff anchors its epoch after the seed).
            if (this.manager._wireTelemetry) this.manager._wireTelemetry.seedLifetime(s.name, payload);
            // W2 cutover preview: with CLODEX_WIRE_TELEMETRY=1 the wire-carried
            // fields overwrite the poll's before emission (per-agent, all-or-
            // nothing — see WireTelemetry.overlay). The snapshot map stores the
            // emitted shape so attach/switch renders match the live bar.
            let emitted = payload;
            if (WIRE_TELEMETRY_LIVE && this.manager._wireTelemetry) {
              emitted = this.manager._wireTelemetry.overlay(s.name, payload);
            }
            this.last.set(s.name, emitted);
            this.manager._sendToSession(s.name, 'session-proxy', s.name, emitted);
            // Mirror the status-bar payload to attached peers (trimmed to the
            // info-only view). No-op when nobody is attached.
            if (getRemoteServer()) {
              try { getRemoteServer().pushTelemetry(s.name, { proxy: peerProxyView(emitted) }); } catch {}
            }
            // W2 step-4 dark bridge: diff this live emission against the wire's
            // shaped payload into the shadow log (validation evidence for the
            // cutover). Always diffs the RAW poll record — the overlay must not
            // contaminate its own evidence. No-op unless CLODEX_WIRE_SHADOW
            // brought the wire up.
            if (this.manager._wireTelemetry) this.manager._wireTelemetry.diffPoll(s.name, payload);
            // Reconcile the wire strip state against proxy TRUTH every tick rather
            // than fire-once asserting. The old latch recorded "asserted" the moment
            // a POST was dispatched and only retried on a REJECTED promise — so a
            // silent-200, an id roll, or a single missed link left the override unset
            // for the session's life (observed: clodex believed L2 while the proxy
            // was L0 and shipped full thinking every turn). Now: re-POST exactly when
            // the proxy's `configuredLevel`/`source` disagree with our persisted
            // intent, and go quiet once they match. The asserted level is clamped to
            // what this proxy serves (proxyMaxLevel) so a persisted L2 rides as L1 on
            // a pre-L2 proxy and upgrades on its own. `payload.strip` is wirescope
            // v0.6.10+ truth; absent on older proxies → skip (degrade to off).
            if (!payload.linked) {
              this.stripAsserted.delete(s.name);
            } else if (stripCap && payload.sessionId && payload.strip) {
              const desired = Math.min(level, proxyMaxLevel);
              const ps = payload.strip;
              // desired>=1 also requires an explicit override: a coincidental
              // global-default match isn't a recorded, durable intent.
              const mismatch = ps.configuredLevel !== desired
                || (desired >= 1 && ps.source !== 'override');
              const last = this.stripAsserted.get(s.name);
              const justPosted = last && last.sessionId === payload.sessionId
                && last.level === desired && (Date.now() - (last.ts || 0)) < PROXY_STRIP_REPOST_MS;
              if (mismatch && !justPosted) {
                this.stripAsserted.set(s.name, { sessionId: payload.sessionId, level: desired, ts: Date.now() });
                // desired 0: clear (drop the override → off default) normally, but
                // POST an explicit 0-override when the global default is ON, else
                // clear would fall back to that on-default and we'd flap every tick.
                const explicitZero = desired === 0 && (ps.globalDefaultLevel || 0) >= 1;
                ProxyClient.stripThinking(base, payload.sessionId, desired, explicitZero).catch(() => {
                  // Failed to push — forget so the next tick retries.
                  const cur = this.stripAsserted.get(s.name);
                  if (cur && cur.sessionId === payload.sessionId) this.stripAsserted.delete(s.name);
                });
              }
            }
            // Auto-compact-before-cold rides the same tick, on the emitted
            // payload (the overlay may carry fresher warmth than the raw poll).
            // Unlinked-grace ticks `continue`d above — stale data never fires.
            this._maybeAutoCompact(s, emitted, entry);
          }
        }
      } finally {
        this._busy = false;
      }
    }

    // Fire /compact into a session that is about to go cache-cold with a heavy
    // context and no keep-warm hold (see shouldAutoCompact in proxy-util for the
    // full policy + why pre-cold is the cheap moment). Facts come from the poll
    // payload (wirescope) and the session's wire-stamped prompt state; the
    // decision is clodex POLICY, per-session, default on.
    _maybeAutoCompact(s, payload, entry) {
      try {
        if (s.agentType !== 'claude' || s._dead) return;
        const decision = autoCompactDecision({
          payload,
          enabled: autoCompactOf(entry),
          // Wire-stamped: terminal main-line stop = CLI parked at its prompt.
          // No wire (legacy jsonl path) → never stamped → never fires. That's
          // deliberate: without it we can't rule out a pending permission
          // dialog, where the injected Enter would answer the dialog. The
          // Notification-hook fact is the direct veto for the same hazard —
          // belt over the wire-inference suspenders.
          atPrompt: !!(s.lastMainStop && s.lastMainStop.isTurn) && !s.needsAttention,
          lastInputTs: s.lastUserInputTs || 0,
          lastFiredTs: this.autoCompacted.get(s.name) || 0,
        });
        if (!decision.fire) {
          // Observability for the silent-never-fired class: log a suppression
          // ONLY for a heavy-context near-miss (a session light on context isn't
          // a candidate, so its reason is noise), and only when the reason CHANGES
          // — this runs on the 5s poll, so per-poll logging would flood. That
          // yields exactly "crossed the threshold but didn't fire, and here's why"
          // once per reason transition per session.
          try {
            const heavy = payload && payload.context && typeof payload.context.inputTokens === 'number'
              && payload.context.inputTokens >= AUTO_COMPACT.MIN_INPUT_TOKENS;
            if (heavy) {
              // Suspect-A distinguisher (laptop2 silent-never-fire): a session
              // that isn't wire-routed NEVER stamps lastMainStop, so atPrompt is
              // permanently false and auto-compact is structurally dead — but the
              // reason-transition log would only ever show 'not-at-prompt', which
              // can't tell "structural-never" from "transient mid-turn". A
              // distinct once-per-session WARN kills that ambiguity.
              if (s.intentSource !== 'wire' && !s._acNotWiredLogged) {
                s._acNotWiredLogged = true;
                log.warn('autocompact', `unavailable for ${s.name}: not wire-routed (lastMainStop never stamped → can't fire) (~${Math.round(payload.context.inputTokens / 1000)}k ctx)`);
              }
              // Dedup on the CLASS, not the full reason — warmth-headroom embeds
              // the decaying countdown, so the full string differs every poll.
              if (s._lastAcSuppressReason !== decision.reasonClass) {
                s._lastAcSuppressReason = decision.reasonClass;
                log.info('autocompact', `${s.name} suppressed: ${decision.reason} (~${Math.round(payload.context.inputTokens / 1000)}k ctx)`);
              }
            }
          } catch { /* logging must never break the poll */ }
          return;
        }
        const cmd = (getContextCommands()[s.type] || {}).compact;
        if (!cmd) return;
        this.autoCompacted.set(s.name, Date.now());
        s._lastAcSuppressReason = null;   // fired — reset so the next near-miss logs
        // Include the computed band so the wild data confirms the threshold choice.
        log.info('autocompact', `${s.name} fired → ${cmd} (~${Math.round(payload.context.inputTokens / 1000)}k ctx, warmth ${decision.remaining_s}s/band ${decision.band}s)`);
        // bypassHold: shouldAutoCompact already proved the prompt is parked and
        // dialog-free, and a bare slash command must never queue (a '\n'-joined
        // flush batch would corrupt it).
        this.manager._injectText(s, cmd, { bypassHold: true });
        this.manager._broadcast('ipc-message', {
          type: 'context', from: s.name, to: s.name,
          body: `auto-compact → ${cmd} (cache expiring, ~${Math.round(payload.context.inputTokens / 1000)}k context, no keep-warm)`,
        });
      } catch { /* policy is observer-grade — never break the poll */ }
    }
  }


  return ProxyPoller;
}

module.exports = { ProxyClient, createProxyPoller, PROXY_REPORT_TIMEOUT };
