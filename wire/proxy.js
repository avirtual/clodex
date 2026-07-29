'use strict';

// Tee, don't transform: the client receives the exact raw upstream bytes.
// All parsing happens on an observer copy; parser failures degrade to "no
// turn seen", never to a broken session. Ordering: client bytes first,
// always — 'turn.completed' and 'stream-end' fire strictly after the final
// client byte. A 'tee-failure' must disable ALL wire-fed controls, never some.

const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { URL } = require('url');

const { parseAgentPath, inferProvider } = require('./route');
const { SSEFramer, anthropicTextDelta, openaiTextDelta, UsageCollector, OpenAIUsageCollector, FileToolCollector } = require('./sse');
const { Decompressor } = require('./decompress');
const { RoleClassifier, isSubagentRole, isTitleCall, isProbeCall } = require('./role');
const { billing, billingOpenai, Ledger } = require('./billing');

// Hop-by-hop headers per RFC 7230 §6.1, plus content-length/host which the
// HTTP libs manage themselves. content-encoding stays — the client receives
// raw upstream bytes, still compressed when upstream compresses.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

const DEFAULT_UPSTREAMS = {
  anthropic: 'https://api.anthropic.com',
  // Default to the ChatGPT backend so codex uses a ChatGPT subscription
  // without a platform API key (see chatgpt-backend mode below). Override
  // with { upstreams: { openai: 'https://api.openai.com' } } when a platform
  // key is available.
  openai: 'https://chatgpt.com/backend-api/codex',
};

const TURN_TEXT_CAP = 4 * 1024 * 1024;


const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');

function isChatgptBackend(upstream) {
  return (upstream || '').includes('chatgpt.com/backend-api');
}

// Re-read per request so codex's native OAuth refresh (which rewrites the
// file) is picked up without a restart. Nulls on any error — the request is
// forwarded as-is and upstream rejects it cleanly.
function readCodexAuth() {
  try {
    const data = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, 'utf8'));
    const tokens = data.tokens || {};
    return { accessToken: tokens.access_token || null, accountId: tokens.account_id || null };
  } catch {
    return { accessToken: null, accountId: null };
  }
}

function rewriteChatgptRequest(upstreamPath, headers) {
  const { accessToken, accountId } = readCodexAuth();
  if (!accessToken) return upstreamPath;
  if (upstreamPath.startsWith('/v1/')) upstreamPath = upstreamPath.slice(3);
  else if (upstreamPath === '/v1') upstreamPath = '/';
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'authorization') delete headers[k];
  }
  headers['authorization'] = `Bearer ${accessToken}`;
  if (accountId) headers['chatgpt-account-id'] = accountId;
  // Mirror what codex CLI sends natively.
  if (!('originator' in headers)) headers['originator'] = 'codex_cli_rs';
  if (!('openai-beta' in headers)) headers['openai-beta'] = 'responses=experimental';
  return upstreamPath;
}

// Baseline: content-type says SSE. Override: the chatgpt backend's
// Responses-API stream says application/json even though the body IS SSE.
function detectSse(contentType, chatgptMode, method, upstreamPath) {
  if ((contentType || '').toLowerCase().includes('text/event-stream')) return true;
  if (chatgptMode && method === 'POST') {
    const p = upstreamPath.replace(/\/+$/, '');
    if (p === '/responses' || p === '/chat/completions') return true;
  }
  return false;
}

// Claude Code ships session identity in metadata.user_id — currently a
// JSON-encoded string with a session_id field; older builds used
// "..._session_<uuid>". Handle both; null when absent.
function sessionIdFrom(obj) {
  try {
    const uid = (obj.metadata && obj.metadata.user_id) || '';
    if (!uid) return null;
    try {
      const inner = JSON.parse(uid);
      if (inner && typeof inner.session_id === 'string') return inner.session_id;
    } catch { /* not JSON — fall through to regex */ }
    const m = /session[_-]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(uid);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function extractSessionId(bodyBuf) {
  try {
    return sessionIdFrom(JSON.parse(bodyBuf.toString('utf8')));
  } catch {
    return null;
  }
}


class WireProxy extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port ?? 0;
    this.upstreams = { ...DEFAULT_UPSTREAMS, ...(opts.upstreams || {}) };
    this.requireTokens = !!opts.requireTokens;
    this.warmth = opts.warmth || null;
    this.hold = opts.hold || null;
    this._tokens = new Map(); // agent name → token
    this._agentSessions = new Map(); // agent name → last main-line sessionId
    this._agentUpstreams = new Map(); // agent name → { provider: baseUrl } overrides
    this._roles = new RoleClassifier();
    this.billing = new Ledger(); // global + per-session running totals
    this.stats = {
      startedAt: Date.now(),
      requestsTotal: 0,
      requestsErrored: 0,
      bytesForwarded: 0,
      turnsCompleted: 0,
    };
    this.server = http.createServer((req, res) => this._handle(req, res));
    // SSE responses can idle for minutes between deltas.
    this.server.timeout = 0;
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // The token exists only in the app's memory and the spawned CLI's env —
  // nothing else on the machine can speak for this agent. Registration must
  // happen before the PTY spawns, so the proxy never has an unbound agent.
  registerAgent(name, opts = {}) {
    if (opts.sessionId) this._agentSessions.set(name, opts.sessionId);
    if (opts.upstreams) this._agentUpstreams.set(name, { ...opts.upstreams });
    if (this.requireTokens) {
      const token = crypto.randomBytes(16).toString('hex');
      this._tokens.set(name, token);
      return `http://${this.host}:${this.port}/agent/${name}/${token}`;
    }
    return `http://${this.host}:${this.port}/agent/${name}`;
  }

  unregisterAgent(name) {
    this._tokens.delete(name);
    this._agentUpstreams.delete(name);
    const sid = this._agentSessions.get(name);
    if (sid) this._roles.forgetSession(sid);
    this._agentSessions.delete(name);
  }

  sessionOf(name) {
    return this._agentSessions.get(name) || null;
  }

  // Main-line identity binding: only called for parent/unknown non-side-call
  // turns, so a subagent (shared session_id) or title probe can't rebind.
  _bindSession(agent, sessionId) {
    const prev = this._agentSessions.get(agent);
    if (prev === sessionId) return;
    this._agentSessions.set(agent, sessionId);
    if (prev) this._roles.forgetSession(prev); // /clear rotated the id
    this.emit('session', { agent, sessionId, previous: prev || null });
  }

  _json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  }

  _handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/healthz') {
      return this._json(res, 200, { ok: true, ts: Date.now(), component: 'clodeux-wire' });
    }
    if (u.pathname === '/stats') {
      return this._json(res, 200, {
        uptimeSeconds: Math.round((Date.now() - this.stats.startedAt) / 1000),
        ...this.stats,
      });
    }

    this.stats.requestsTotal += 1;

    const parsed = parseAgentPath(u.pathname);
    if (!parsed) {
      return this._json(res, 400, { error: 'path must start with /agent/<name>/...' });
    }
    const agent = parsed.agent;
    let rest = parsed.rest;

    if (this.requireTokens) {
      const want = this._tokens.get(agent);
      const seg = '/' + (want || ' ');
      if (!want || !(rest === seg || rest.startsWith(seg + '/'))) {
        this.stats.requestsErrored += 1;
        return this._json(res, 401, { error: 'bad or missing session token' });
      }
      rest = rest.slice(seg.length) || '/';
    }

    const { provider, upstreamPath } = inferProvider(rest);
    const agentUp = this._agentUpstreams.get(agent);
    const upstreamBase = (agentUp && agentUp[provider]) || this.upstreams[provider];
    const chatgptMode = provider === 'openai' && isChatgptBackend(upstreamBase);

    // chatgpt backend has no platform-style model list; stub codex's
    // startup probe with the shape it expects.
    if (chatgptMode && (upstreamPath === '/v1/models' || upstreamPath === '/v1/models/')) {
      return this._json(res, 200, {
        models: [{ id: 'gpt-5.3-codex', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openai' }],
      });
    }

    const reqId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${agent}-${provider}`;
    this.emit('request', { agent, provider, reqId, method: req.method, path: upstreamPath });

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? Buffer.concat(chunks) : null;
      this._forward(req, res, { agent, provider, reqId, upstreamBase, upstreamPath, chatgptMode, body, query: u.search });
    });
    req.on('error', () => { /* client vanished while sending — nothing to do */ });
  }

  _forward(req, res, ctx) {
    const { agent, provider, reqId, upstreamBase, chatgptMode, body, query } = ctx;
    let upstreamPath = ctx.upstreamPath;

    let sessionId = null;
    let role = null;
    let sideCall = false;
    let model = null;
    let bodyObj = null; // held for the warmth stamp at tee close
    if (body && req.method === 'POST') {
      try {
        const obj = JSON.parse(body.toString('utf8'));
        bodyObj = obj;
        sessionId = sessionIdFrom(obj);
        if (typeof obj.model === 'string') model = obj.model;
        if (provider === 'anthropic') {
          const agentId = req.headers['x-claude-code-agent-id'] || null;
          sideCall = isTitleCall(obj) || isProbeCall(obj);
          role = this._roles.classify(obj, sessionId, agentId);
          if (!sideCall && !isSubagentRole(role)) {
            this._roles.noteMainFingerprint(sessionId, obj);
            if (sessionId) this._bindSession(agent, sessionId);
          }
        }
      } catch { /* not JSON — nothing to observe */ }
    }

    // count_tokens is excluded: it bills but never emits turn.completed, so
    // started/completed stay 1:1 and an in-flight counter can't leak.
    if (provider === 'anthropic' && req.method === 'POST'
        && upstreamPath.replace(/\/+$/, '').endsWith('/v1/messages')) {
      this.emit('turn.started', { agent, provider, reqId, sessionId, role, sideCall, model });
    }

    const fwdHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) fwdHeaders[k] = v;
    }
    if (chatgptMode) {
      upstreamPath = rewriteChatgptRequest(upstreamPath, fwdHeaders);
    }

    let upstreamUrl;
    try {
      upstreamUrl = new URL(upstreamBase.replace(/\/+$/, '') + upstreamPath + (query || ''));
    } catch (e) {
      this.stats.requestsErrored += 1;
      return this._json(res, 502, { error: `bad upstream url: ${e.message}` });
    }

    // Main line only: a subagent, title side-call or quota probe shares the
    // session_id but is transient — caching one as the replayable request
    // would keep a finished subagent warm or pin a one-token probe as body.
    if (this.hold && provider === 'anthropic' && req.method === 'POST'
        && bodyObj && sessionId && !sideCall && !isSubagentRole(role)
        && ctx.upstreamPath.replace(/\/+$/, '').endsWith('/v1/messages')) {
      try {
        this.hold.noteRequest(sessionId, bodyObj, fwdHeaders, upstreamUrl.href);
      } catch { /* keep-warm cache is observer-grade — never the client path */ }
    }

    const lib = upstreamUrl.protocol === 'https:' ? https : http;
    const upReq = lib.request(upstreamUrl, { method: req.method, headers: fwdHeaders }, (upRes) => {
      const respHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) respHeaders[k] = v;
      }
      const sse = detectSse(upRes.headers['content-type'], chatgptMode, req.method, ctx.upstreamPath);
      this.emit('response', { agent, reqId, status: upRes.statusCode, sse });

      // On the first tee throw the tee is dropped for this stream; stream-end
      // must still pair with stream-start so activity state can't wedge.
      let tee = null;
      let streamEnded = !sse; // stream-start/-end pair exists only for SSE
      const teeFail = (e) => {
        tee = null;
        this.emit('tee-failure', { agent, reqId, error: (e && e.message) || String(e) });
        if (!streamEnded) { streamEnded = true; this.emit('stream-end', { agent, reqId }); }
      };
      if (sse) {
        this.emit('stream-start', { agent, reqId });
        const onEnd = (ev) => {
          if (ev.reqId !== reqId) return;
          streamEnded = true;
          this.removeListener('stream-end', onEnd);
        };
        this.on('stream-end', onEnd);
        try {
          tee = this._buildTee(
            { agent, provider, reqId, sessionId, role, sideCall, model, bodyObj,
              requestId: upRes.headers['request-id'] || null,
              status: upRes.statusCode },
            upRes.headers['content-encoding']);
        } catch (e) { teeFail(e); }
      } else if (provider === 'anthropic' && req.method === 'POST') {
        const base = ctx.upstreamPath.replace(/\/+$/, '');
        const isCount = base.endsWith('/count_tokens');
        if (isCount || base.endsWith('/v1/messages')) {
          try {
            tee = this._buildJsonTee(
              { agent, provider, reqId, sessionId, role, sideCall, model,
                requestId: upRes.headers['request-id'] || null,
                status: upRes.statusCode },
              upRes.headers['content-encoding'], isCount);
          } catch (e) { teeFail(e); }
        }
      }

      res.writeHead(upRes.statusCode, respHeaders);
      upRes.on('data', (chunk) => {
        // Client first — the tee must never delay client-bound bytes.
        res.write(chunk);
        this.stats.bytesForwarded += chunk.length;
        if (tee) { try { tee.feed(chunk); } catch (e) { teeFail(e); } }
      });
      upRes.on('end', () => {
        res.end();
        if (tee) { try { tee.close(); } catch (e) { teeFail(e); } }
      });
      upRes.on('error', (e) => {
        this.stats.requestsErrored += 1;
        this.emit('proxy-error', { agent, reqId, error: `upstream read: ${e.message}` });
        res.destroy();
        if (tee) { try { tee.close(); } catch (err) { teeFail(err); } }
      });
      // Some premature-termination paths emit only 'close' (no 'end', no
      // 'error'). Without this backstop the client response would hang
      // open forever — the one unbounded failure mode.
      upRes.on('close', () => {
        if (!res.writableEnded) {
          this.emit('proxy-error', { agent, reqId, error: 'upstream closed mid-stream' });
          res.destroy();
          if (tee) { try { tee.close(); } catch (e) { teeFail(e); } }
        }
      });
      res.on('close', () => {
        if (!res.writableEnded) {
          upRes.destroy();
          if (tee) { try { tee.close(); } catch (e) { teeFail(e); } }
        }
      });
    });

    upReq.on('error', (e) => {
      this.stats.requestsErrored += 1;
      this.emit('proxy-error', { agent, reqId, error: `upstream connect: ${e.message}` });
      if (!res.headersSent) this._json(res, 502, { error: `upstream error: ${e.message}` });
      else res.destroy();
    });

    req.on('aborted', () => upReq.destroy());
    if (body) upReq.end(body);
    else upReq.end();
  }

  // Emission order on close: 'usage' → 'turn.completed' → 'stream-end', all
  // strictly after the client's final byte.
  _buildTee(turnCtx, contentEncoding) {
    const { agent, provider, reqId, sessionId, role, sideCall, model, bodyObj, requestId, status } = turnCtx;
    const usage = provider === 'anthropic' ? new UsageCollector() : new OpenAIUsageCollector();
    const extract = provider === 'anthropic' ? anthropicTextDelta : openaiTextDelta;
    const ftools = provider === 'anthropic' ? new FileToolCollector() : null;
    let text = '';
    let truncated = false;
    // First guard level: zlib delivers on its own ticks, so an exception
    // in the framer/extractor path can't be caught by the forwarding
    // handlers — it must be contained here or it takes down the process.
    let dead = false;
    const fail = (e) => {
      if (dead) return;
      dead = true;
      this.emit('tee-failure', { agent, reqId, error: (e && e.message) || String(e) });
    };
    const framer = new SSEFramer((event, data) => {
      try {
        if (usage) usage.onEvent(event, data);
        if (ftools) ftools.onEvent(event, data);
        const t = extract(event, data);
        if (t && !truncated) {
          if (text.length + t.length > TURN_TEXT_CAP) truncated = true;
          else text += t;
        }
      } catch (e) { fail(e); }
    });
    const decomp = new Decompressor(contentEncoding, (d) => {
      if (dead) return;
      try { framer.feed(d); } catch (e) { fail(e); }
    });
    let closed = false;
    return {
      feed: (chunk) => { if (!dead) decomp.feed(chunk); },
      close: () => {
        if (closed) return;
        closed = true;
        decomp.end(() => {
          try {
            let usageRecord = null;
            let bill = null;
            let stop = null;
            if (!dead) {
              if (provider === 'anthropic') {
                usageRecord = usage.record;
                // proxylab finalizes EVERY messages response — an error
                // stream with no usage still bills (all-null tokens, $0)
                // and counts a request, so totals never under-count.
                bill = billing('messages', {
                  modelResolved: usage.resolvedModel || model,
                  usageFinal: usage.usageFinal,
                  usageStart: usage.usageStart,
                });
                stop = {
                  stop_reason: usage.stopReason,
                  stop_details: usage.stopDetails,
                  request_id: requestId,
                  is_turn: !sideCall && (role === 'parent' || role === 'unknown')
                    && usage.stopReason != null && usage.stopReason !== 'tool_use',
                };
              } else {
                const rec = usage.meta;
                usageRecord = rec.usage;
                if (usageRecord || text) {
                  bill = billingOpenai(rec.resolved_model || model, rec.usage);
                  // a completed response WITH text ends a turn; tool-loop
                  // hops come back text-less (reasoning + calls only).
                  stop = { stop_reason: rec.status, request_id: requestId,
                    is_turn: rec.status === 'completed' && !!text };
                }
              }
            }
            if (usageRecord) this.emit('usage', { agent, reqId, usage: usageRecord });
            // A quietly-dead decompressor saw an unknown truncation; an empty
            // receipt synthesized from that would be a confident lie.
            if (!dead && ((provider === 'anthropic' && !decomp.dead) || text || usageRecord)) {
              this.stats.turnsCompleted += 1;
              let sessionTotals = null;
              if (bill) {
                const sessionKey = sessionId || `agent:${agent}`;
                this.billing.accumulate(bill, sessionKey, stop);
                sessionTotals = { ...this.billing.session(sessionKey) };
              }
              // Stamp from message_start's cache fields ONLY — the merged
              // record can flip a 0→nonzero across iterations. The session
              // HEAD must advance on main-line turns only: a subagent shares
              // the session_id and its 5m-TTL prefix would flip the badge.
              let warmthRec = null;
              if (this.warmth && provider === 'anthropic' && bodyObj) {
                const us = usage.usageStart || {};
                warmthRec = this.warmth.record(bodyObj, {
                  cache_creation_input_tokens: us.cache_creation_input_tokens,
                  cache_read_input_tokens: us.cache_read_input_tokens,
                }, (!sideCall && !isSubagentRole(role)) ? sessionId : null);
              }
              this.emit('turn.completed', {
                agent, provider, reqId, sessionId, role, sideCall, text,
                usage: usageRecord, truncated, model, status, billing: bill,
                stop, sessionTotals, warmth: warmthRec,
                files: ftools ? ftools.files : [],
                reads: ftools ? ftools.reads : [],
              });
            }
          } catch (e) { fail(e); }
          this.emit('stream-end', { agent, reqId });
        });
      },
    };
  }

  _buildJsonTee(turnCtx, contentEncoding, isCount) {
    const { agent, provider, reqId, sessionId, role, sideCall, model, requestId, status } = turnCtx;
    const chunks = [];
    let size = 0;
    let dead = false;
    const fail = (e) => {
      if (dead) return;
      dead = true;
      this.emit('tee-failure', { agent, reqId, error: (e && e.message) || String(e) });
    };
    const decomp = new Decompressor(contentEncoding, (d) => {
      if (dead || size > TURN_TEXT_CAP) return;
      chunks.push(d);
      size += d.length;
    });
    let closed = false;
    return {
      feed: (chunk) => { if (!dead) decomp.feed(chunk); },
      close: () => {
        if (closed) return;
        closed = true;
        decomp.end(() => {
          if (dead || decomp.dead) return; // no receipt off a truncated view
          try {
            let parsed = null;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
            const sessionKey = sessionId || `agent:${agent}`;
            if (isCount) {
              const bill = billing('count_tokens', {
                modelResolved: model,
                countTokens: (parsed && typeof parsed === 'object') ? parsed : {},
              });
              this.billing.accumulate(bill, sessionKey, null);
            } else {
              const bill = billing('messages', { modelResolved: model });
              const stop = { stop_reason: null, stop_details: null,
                request_id: requestId, is_turn: false };
              this.billing.accumulate(bill, sessionKey, stop);
              this.stats.turnsCompleted += 1;
              this.emit('turn.completed', {
                agent, provider, reqId, sessionId, role, sideCall, text: '',
                usage: null, truncated: false, model, status, billing: bill,
                stop, sessionTotals: { ...this.billing.session(sessionKey) },
                warmth: null, files: [], reads: [],
              });
            }
          } catch (e) { fail(e); }
        });
      },
    };
  }
}

module.exports = { WireProxy, extractSessionId, detectSse };


if (require.main === module) {
  const proxy = new WireProxy({ port: Number(process.argv[2]) || 9777 });
  for (const ev of ['request', 'response', 'stream-start', 'stream-end', 'turn.completed', 'session', 'usage', 'proxy-error', 'tee-failure']) {
    proxy.on(ev, (payload) => console.log(`[${ev}]`, JSON.stringify(payload)));
  }
  proxy.listen().then((port) => {
    console.log(`clodeux wire on http://127.0.0.1:${port}`);
    console.log(`route shape: /agent/<name>/v1/messages (anthropic) · /agent/<name>/openai/... (explicit)`);
  });
}
