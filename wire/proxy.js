'use strict';

// Clodeux wire core: transparent API proxy with an SSE observer tee.
// Seeded from clodex2 lib/proxy.js (tested + live-verified there), adapted
// for Phase W1 of CLODEUX-PLAN.md. Differences from the clodex2 seed:
//   - no IntentScanner: the wire does NOT scan intents. It emits
//     'turn.completed' with the full normalized assistant text; the
//     SessionManager's existing parseIntent consumes it (one intent
//     grammar in the app, not two).
//   - turn.completed carries { agent, sessionId, text, usage } so the
//     consumer never has to join events to identify a turn.
//
// Invariant — TEE, DON'T TRANSFORM: the client receives the exact raw
// upstream bytes (status, headers minus hop-by-hop, body). All parsing
// happens on an observer copy; parser failures degrade to "no turn seen",
// never to a broken session. The one deliberate exception is the codex
// ChatGPT-backend REQUEST rewrite (auth injection), carried over as-is.
//
// Ordering contract (matches wirescope's): client bytes first, always.
// 'turn.completed' and 'stream-end' fire strictly AFTER the final client
// byte has been written.
//
// Events:
//   'request'        { agent, provider, reqId, method, path }
//   'response'       { agent, reqId, status, sse }
//   'stream-start'   { agent, reqId }                  → activity: thinking
//   'turn.completed' { agent, provider, reqId, sessionId, role, sideCall,
//                      text, usage, truncated, model, billing, stop,
//                      sessionTotals, warmth }
//                    role: parent/unknown = main line; Plan/verification/
//                    general-purpose/subagent = Task subs (see wire/role.js).
//                    sideCall: title-generator / health-probe request.
//                    billing/stop/sessionTotals (W2): the receipt — priced
//                    tokens (wire/billing.js, usage_final contract), stop
//                    facts incl. is_turn (terminal main-line response), and
//                    a snapshot of the session's running totals. Python twin:
//                    proxylab/receipts.py; the tee close is the one
//                    turn-finalize convergence point in-process.
//                    NOTE: non-SSE responses (count_tokens, JSON error
//                    bodies) are not teed and so not billed yet — proxylab
//                    counts those as 0-token billed/count_tokens requests;
//                    request counts may differ until W2 step 4 wires them.
//                    warmth (W2 step 2): the prefix-ledger stamp record
//                    (wire/warmth.js) when opts.warmth is set and the
//                    response confirmed a cache event; null otherwise.
//   'stream-end'     { agent, reqId }                  → activity: idle
//   'session'        { agent, sessionId, previous }    → persistence/--resume
//                    fires on CHANGE only (first sight or /clear rotation),
//                    and only from main-line non-side-call turns.
//   'usage'          { agent, reqId, usage }           → cost/ctx telemetry
//   'proxy-error'    { agent, reqId, error }
//   'tee-failure'    { agent, reqId, error }
//                    the OBSERVER died for this stream; the client keeps
//                    receiving raw bytes untouched. Contract (reviewer
//                    condition, CLODEUX-PLAN.md): when the app makes wire
//                    events load-bearing (W3), a tee-failure must disable
//                    ALL wire-fed controls visibly — never a partial set.

const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { URL } = require('url');

const { parseAgentPath, inferProvider } = require('./route');
const { SSEFramer, anthropicTextDelta, openaiTextDelta, UsageCollector, OpenAIUsageCollector } = require('./sse');
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

// Cap on accumulated turn text. A turn past this size keeps streaming to
// the client untouched; the observer just stops appending and marks the
// event truncated (intents live at column 1 of ordinary-sized turns).
const TURN_TEXT_CAP = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// ChatGPT-backend mode — codex ChatGPT-subscription auth.
// ---------------------------------------------------------------------------

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

// Strip /v1 prefix and inject ChatGPT OAuth headers. Leaves everything
// untouched when the auth file is unreadable.
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

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

class WireProxy extends EventEmitter {
  // opts:
  //   host        default 127.0.0.1 (do not bind wider without a reason)
  //   port        default 0 (ephemeral; read back from listen())
  //   upstreams   { anthropic, openai } URL overrides
  //   requireTokens  when true, every registered agent needs a token and
  //                  requests must carry it as the first path segment after
  //                  the agent name: /agent/<name>/<token>/v1/...
  //   warmth      a wire/warmth WarmthStore; when set, every cache-confirmed
  //               anthropic response stamps the prefix ledger and
  //               turn.completed carries the warmth record. null = off.
  constructor(opts = {}) {
    super();
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port ?? 0;
    this.upstreams = { ...DEFAULT_UPSTREAMS, ...(opts.upstreams || {}) };
    this.requireTokens = !!opts.requireTokens;
    this.warmth = opts.warmth || null;
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

  // Register an agent and mint its token. Returns the base URL to put in
  // the CLI's env (ANTHROPIC_BASE_URL / equivalent). The token is the
  // closed-loop guarantee: it only ever exists in the app's memory and the
  // spawned CLI's environment, so nothing else on the machine can speak
  // for this agent.
  //
  // Spawn-time identity binding (closes the pre-first-request window the
  // external proxy had): registration happens BEFORE the PTY spawns, and a
  // resume can pre-bind the known sessionId so the proxy never has an
  // unbound agent. The binding then tracks the CLI's declared identity
  // ('session' fires only on change — first sight or /clear rotation).
  // opts.upstreams: per-agent { provider: baseUrl } overrides — the
  // chaining mechanism: a session already routed through an external
  // wirescope keeps that path (upstream = the wirescope agent base) while
  // the in-process wire observes in front. Same bytes end-to-end.
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

    // Session identity + role classification ride in the request body.
    // Observer-side: a parse failure degrades to null role, never a broken
    // request. Anthropic wire only — codex carries neither the billing
    // header nor metadata-embedded identity (hook path covers codex in W1).
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
            // Durable main line: stamp the content fingerprint (the
            // stale-agent-id backstop) and own the agent↔session binding.
            this._roles.noteMainFingerprint(sessionId, obj);
            if (sessionId) this._bindSession(agent, sessionId);
          }
        }
      } catch { /* not JSON — nothing to observe */ }
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

    const lib = upstreamUrl.protocol === 'https:' ? https : http;
    const upReq = lib.request(upstreamUrl, { method: req.method, headers: fwdHeaders }, (upRes) => {
      const respHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) respHeaders[k] = v;
      }
      const sse = detectSse(upRes.headers['content-type'], chatgptMode, req.method, ctx.upstreamPath);
      this.emit('response', { agent, reqId, status: upRes.statusCode, sse });

      // Second guard level (the first is inside _buildTee): even a tee
      // whose construction or entry points are broken cannot touch the
      // client path. On the first throw the tee is dropped for this
      // stream and 'tee-failure' fires; stream-end still pairs with
      // stream-start so activity state can't wedge.
      let tee = null;
      let streamEnded = false;
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
              requestId: upRes.headers['request-id'] || null },
            upRes.headers['content-encoding']);
        } catch (e) { teeFail(e); }
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
      // Client gave up mid-stream — stop pulling from upstream, flush tee.
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

  // Observer pipeline: raw bytes → decompress → SSE frames → text deltas →
  // turn accumulator (+ usage collector for anthropic). Emission order on
  // stream close: 'usage' → 'turn.completed' → 'stream-end', all strictly
  // after the client's final byte. Consumers wanting main-line turns only
  // (intent scanning) filter role parent/unknown + sideCall false.
  _buildTee(turnCtx, contentEncoding) {
    const { agent, provider, reqId, sessionId, role, sideCall, model, bodyObj, requestId } = turnCtx;
    const usage = provider === 'anthropic' ? new UsageCollector() : new OpenAIUsageCollector();
    const extract = provider === 'anthropic' ? anthropicTextDelta : openaiTextDelta;
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
            // Receipt convergence (receipts.py's job, in-process): parse →
            // bill → accumulate → one event. Anything downstream of "a turn
            // happened" hangs off turn.completed, not a second closure.
            let usageRecord = null;
            let bill = null;
            let stop = null;
            if (!dead) {
              if (provider === 'anthropic') {
                usageRecord = usage.record;
                if (usageRecord || text) {
                  bill = billing('messages', {
                    modelResolved: usage.resolvedModel || model,
                    usageFinal: usage.usageFinal,
                    usageStart: usage.usageStart,
                  });
                  stop = {
                    stop_reason: usage.stopReason,
                    stop_details: usage.stopDetails,
                    request_id: requestId,
                    // one terminal response = one completed user turn
                    // (refusal/max_tokens still END a turn; tool_use is a
                    // mid-turn hop). Side-calls + subagents don't count.
                    is_turn: !sideCall && (role === 'parent' || role === 'unknown')
                      && usage.stopReason != null && usage.stopReason !== 'tool_use',
                  };
                }
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
            if (!dead && (text || usageRecord)) {
              this.stats.turnsCompleted += 1;
              let sessionTotals = null;
              if (bill) {
                const sessionKey = sessionId || `agent:${agent}`;
                this.billing.accumulate(bill, sessionKey, stop);
                sessionTotals = { ...this.billing.session(sessionKey) };
              }
              // Prefix-warmth stamp (response-confirmed; wire/warmth.js).
              // Parity detail: the stamping decision reads the cache fields
              // from message_start ONLY (proxylab's flat usage parse) — the
              // merged record could flip a 0→nonzero across iterations.
              // All anthropic turns stamp, side-calls and subagents too
              // (content-addressed; matches receipts.py, which never role-
              // gates the ledger).
              let warmthRec = null;
              if (this.warmth && provider === 'anthropic' && bodyObj) {
                const us = usage.usageStart || {};
                warmthRec = this.warmth.record(bodyObj, {
                  cache_creation_input_tokens: us.cache_creation_input_tokens,
                  cache_read_input_tokens: us.cache_read_input_tokens,
                }, sessionId);
              }
              this.emit('turn.completed', {
                agent, provider, reqId, sessionId, role, sideCall, text,
                usage: usageRecord, truncated, model, billing: bill, stop,
                sessionTotals, warmth: warmthRec,
              });
            }
          } catch (e) { fail(e); }
          this.emit('stream-end', { agent, reqId });
        });
      },
    };
  }
}

module.exports = { WireProxy, extractSessionId, detectSse };

// ---------------------------------------------------------------------------
// Standalone runner — smoke testing without the app shell:
//   node wire/proxy.js [port]
// Prints every event; point a CLI at http://127.0.0.1:<port>/agent/<name>.
// ---------------------------------------------------------------------------

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
