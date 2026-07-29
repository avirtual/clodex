
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
// The proxy's /_status doesn't list a session every tick (idle between turns,
// count-token probe churn), so a single missing record must not flip the bar to
// unlinked and tear down the clickable cost/wirescope/ctx affordances.
const PROXY_LINK_GRACE = 20000;   // ms (~4 polls)
const PROXY_STRIP_REPOST_MS = 4000; // ms — debounce identical strip re-POSTs to at
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

  async stripThinking(base, sessionId, level, explicitZero = false) {
    const qs = new URLSearchParams({ session: sessionId });
    if (level === 2) qs.set('level', '2');
    else if (level === 1) qs.set('on', '1');
    else if (explicitZero) qs.set('level', '0');
    else qs.set('action', 'clear');
    return this._req(base, `/_strip?${qs.toString()}`, 'POST');
  },

  // Keyed by exact route name, and MUST be set before the seat's first turn — a
  // mid-session flip busts the system prefix. Omitting `on` clears it at retire so
  // ephemeral names don't accrete rows in wirescope's TTL-less hint table.
  // Best-effort: any rejection is ignorable, never fail/delay a spawn or teardown.
  async spawnerHint(base, agent, { on, clear } = {}) {
    const qs = new URLSearchParams({ agent });
    if (clear) qs.set('action', 'clear');
    else qs.set('on', on ? '1' : '0');
    return this._req(base, `/_hint?${qs.toString()}`, 'POST', 2000);
  },

  // Keyed by transcript PATH so it works on a COLD session the proxy no longer
  // holds in memory. Backs up (.bak-<ts>), atomic-renames, integrity-gates; on any
  // !ok the caller MUST resume the ORIGINAL transcript untouched.
  async compact(base, sessionId, transcriptPath, level = 0) {
    const qs = new URLSearchParams({ session: sessionId, path: transcriptPath });
    if (level >= 1) qs.set('level', String(level));
    return this._req(base, `/_compact?${qs.toString()}`, 'POST');
  },

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

  async subagentDetail(base, sessionId, child, maxlen) {
    const qs = new URLSearchParams({ session: sessionId, child, detail: '1' });
    if (maxlen) qs.set('maxlen', String(maxlen));
    return this._getJson(base, `/_subagents?${qs.toString()}`);
  },

  async bustSeries(base, sessionId) {
    return this._getJson(base, `/_bust?session=${encodeURIComponent(sessionId)}`, PROXY_REPORT_TIMEOUT);
  },

  async potSeries(base) {
    const r = await this._getJson(base, '/_pot', PROXY_REPORT_TIMEOUT);
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.files)) return { ok: false, files: [] };
    const files = r.json.files.map((f) => ({
      file: f.file,
      reads: f.reads,
      redundantReads: f.redundant_reads,
      redundantTokens: f.redundant_tokens,
    }));
    return { ok: true, files };
  },

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
  // persistence/remoteServer/CONTEXT_COMMANDS are assigned after this factory runs,
  // so they cross as getters — passing the values here captures undefined.
  autoCompactOf, peerProxyView, getPersistence, getRemoteServer, getContextCommands,
}) {
  class ProxyPoller {
    constructor(manager) {
      this.manager = manager;
      this.timer = null;
      this.probeCache = new Map(); // base -> { result, ts }
      this.last = new Map();       // session name -> last shaped payload
      this.stripAsserted = new Map();
      this.stripCapBases = new Map();
      this.autoCompacted = new Map();
      this._busy = false;
    }

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
          // Only a genuine wirescope probe may SET the latch; a foreign/fallback probe
          // may only read it. Replace probe.capabilities rather than mutate in place —
          // mutation poisons the 60s probe cache.
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
          const proxyMaxLevel = (stripThinkingCap && typeof stripThinkingCap.max_level === 'number')
            ? stripThinkingCap.max_level : 1;
          for (const s of sess) {
            const payload = shapeProxyRecord(pickProxyRecord(byAgent.get(s.proxyAgent), s.sessionId), probe);
            payload.base = base; // poller context, not record shape — for the session-page link
            const entry = getPersistence().get(s.name);
            const level = stripLevelOf(entry);
            payload.stripLevel = level;
            payload.autoCompact = autoCompactOf(entry);
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
            let emitted = payload;
            if (WIRE_TELEMETRY_LIVE && this.manager._wireTelemetry) {
              emitted = this.manager._wireTelemetry.overlay(s.name, payload);
            }
            this.last.set(s.name, emitted);
            this.manager._sendToSession(s.name, 'session-proxy', s.name, emitted);
            if (getRemoteServer()) {
              try { getRemoteServer().pushTelemetry(s.name, { proxy: peerProxyView(emitted) }); } catch {}
            }
            // Always diffs the RAW poll record — the overlay must not contaminate its
            // own evidence.
            if (this.manager._wireTelemetry) this.manager._wireTelemetry.diffPoll(s.name, payload);
            // Level-triggered against proxy truth, not a fire-once latch: a silent 200,
            // an id roll or a missed link would otherwise leave the override unset for
            // the session's life. Clamped to proxyMaxLevel so a persisted L2 rides as L1
            // on a pre-L2 proxy. `payload.strip` is absent on older proxies → skip.
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
                  const cur = this.stripAsserted.get(s.name);
                  if (cur && cur.sessionId === payload.sessionId) this.stripAsserted.delete(s.name);
                });
              }
            }
            this._maybeAutoCompact(s, emitted, entry);
          }
        }
      } finally {
        this._busy = false;
      }
    }

    _maybeAutoCompact(s, payload, entry) {
      try {
        if (s.agentType !== 'claude' || s._dead) return;
        const decision = autoCompactDecision({
          payload,
          enabled: autoCompactOf(entry),
          // Without the wire stamp we can't rule out a pending permission dialog,
          // where the injected Enter would answer the dialog. No wire → never stamped
          // → never fires, deliberately.
          atPrompt: !!(s.lastMainStop && s.lastMainStop.isTurn) && !s.needsAttention,
          lastInputTs: s.lastUserInputTs || 0,
          lastFiredTs: this.autoCompacted.get(s.name) || 0,
        });
        if (!decision.fire) {
          try {
            const heavy = payload && payload.context && typeof payload.context.inputTokens === 'number'
              && payload.context.inputTokens >= AUTO_COMPACT.MIN_INPUT_TOKENS;
            if (heavy) {
              if (s.intentSource !== 'wire' && !s._acNotWiredLogged) {
                s._acNotWiredLogged = true;
                log.warn('autocompact', `unavailable for ${s.name}: not wire-routed (lastMainStop never stamped → can't fire) (~${Math.round(payload.context.inputTokens / 1000)}k ctx)`);
              }
              // Dedup on the CLASS, not the full reason — warmth-headroom embeds
              // the decaying countdown, so the full string differs every poll.
              // One shadow record per class transition, never per poll.
              if (s._lastAcSuppressReason !== decision.reasonClass) {
                s._lastAcSuppressReason = decision.reasonClass;
                this.manager._shadowLog({
                  type: 'autocompact-suppressed', agent: s.name,
                  reason: decision.reason, reasonClass: decision.reasonClass,
                  ctxK: Math.round(payload.context.inputTokens / 1000),
                });
              }
            }
          } catch { /* logging must never break the poll */ }
          return;
        }
        const cmd = (getContextCommands()[s.type] || {}).compact;
        if (!cmd) return;
        this.autoCompacted.set(s.name, Date.now());
        s._lastAcSuppressReason = null;   // fired — reset so the next near-miss logs
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
