// Remote access server — a phone-friendly web front door to running agent
// sessions. Plain Node http + SSE, zero dependencies, bound to 127.0.0.1
// ONLY: reaching it from another device is deliberately outsourced to a
// tailnet (`tailscale serve`) or an SSH tunnel, so v1 ships no auth surface.
//
// Deliberately decoupled from main.js internals: everything Clodex-specific
// arrives as injected callbacks (getSessions / getTranscript / send), and the
// only inbound coupling is notifyActivity/notifySessions called from the
// session manager. The transcript on disk is the single source of truth —
// SSE only signals "something changed", clients refetch. That keeps this
// module indifferent to the wire-intents vs JsonlWatcher observation split.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const crypto = require('crypto');
const { relayVersionOk, isQualifiedSender } = require('./relay-protocol');
const { makeTokenGate } = require('./auth-token');

// A bind host counts as loopback when nothing off-box can reach it — the case
// where "trust is the tunnel" still holds and no token is required. 0.0.0.0 / ::
// (the container's CLODEX_REMOTE_HOST) and any specific LAN address are NOT
// loopback, so they trip the fail-closed rule when no token is configured.
function isLoopbackHost(h) {
  const host = String(h || '').toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.');
}

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const MAX_BODY = 64 * 1024;          // matches the IPC message cap
const SSE_HEARTBEAT_MS = 25000;
// An attach stream whose socket can't drain this much is a dead/half-open
// tunnel; kill it and let the client reconnect + replay.
const ATTACH_MAX_BUFFERED = 4 * 1024 * 1024;
// Trailing-debounce window for mirroring owner resizes to viewers: long enough
// to coalesce a window-drag burst into one frame, short enough to feel live.
const RESIZE_DEBOUNCE_MS = 80;

class RemoteServer {
  constructor({ port, host, pagePath, getSessions, getTranscript, send, restartApp,
                hostLabel, version, srcDir, getAttachInfo, sendInput, resizePty, onControlChange,
                query, createSession, killSession, restartSession, getCatalogs,
                getSessionArgs, setSessionArgs,
                getSkillCatalog, setSessionSkills,
                deliverDm, claimDms, listDmOrigins, receiveRoster,
                token, insecure }) {
    this._port = port;
    // Bind host: loopback by default. The web-frontend container passes '0.0.0.0'
    // (via CLODEX_REMOTE_HOST, threaded in remote-wiring) so the peer wire can be
    // published on a loopback-mapped host port for desktop→container peering.
    // Desktop passes nothing, so the bind stays 127.0.0.1 — unchanged.
    this._host = host || '127.0.0.1';
    this._pagePath = pagePath;
    this._getSessions = getSessions;
    this._getTranscript = getTranscript;
    this._send = send;
    this._restartApp = restartApp || null;
    // Peer-attach surface (all optional: absent callbacks 501 their endpoints)
    this._hostLabel = hostLabel || 'clodex';
    this._version = version || '';
    // Self-reported install dir (home-relative, e.g. ~/projects/clodex) so a
    // consumer's Update targets the box's ACTUAL checkout instead of guessing.
    // null for a packaged .app (not a git-pullable source dir) and for old
    // owners — the hello simply omits it and viewers fall back to today's guess.
    this._srcDir = srcDir || null;
    this._getAttachInfo = getAttachInfo || null;
    this._sendInput = sendInput || null;
    this._resizePty = resizePty || null;
    this._onControlChange = onControlChange || null;
    // Generic pull-on-demand data source for the viewer's popovers (ctx/cost/
    // bust/files/file peek). One endpoint, kind-dispatched — popups are
    // open-time snapshots, so they need a query RPC, not a stream.
    this._query = query || null;
    // Remote session lifecycle (create/kill/restart on the peer). Optional like
    // the rest; absent → the endpoints 501 and the 'create' capability isn't
    // advertised, so viewers hide the "New Session on <peer>" affordance. The
    // three ship together under the one 'create' cap (see /api/peer/hello).
    this._createSession = createSession || null;
    this._killSession = killSession || null;
    this._restartSession = restartSession || null;
    // Session-less catalog read backing the New Session dialog's box-truth
    // checklists (M5). Rides the 'create' cap; its presence + a full-param
    // createSession is what the create2 hello cap advertises.
    this._getCatalogs = getCatalogs || null;
    // Remote session config editing (the Edit Session dialog over the wire).
    // getSessionArgs reads the box's editable args + the catalogs the dialog's
    // checklists need; setSessionArgs applies them (kill+respawn on restart).
    // Both gate the 'args' cap. Phase 2 (per-session skills editing) will add its
    // own endpoint pair under this SAME cap — 'args' means "remote session config
    // editing", and both pairs ship together in one release, so no second cap.
    this._getSessionArgs = getSessionArgs || null;
    this._setSessionArgs = setSessionArgs || null;
    // Phase 2 of remote session config editing: per-session skills. getSkillCatalog
    // reads the box's skill catalog (roster parsed box-side, box's skill library);
    // setSessionSkills persists the disabled/inject sets (restart is a separate
    // /api/session-restart call the popover already makes). Both ride the SAME
    // 'args' cap as the session-args pair — see /api/peer/hello — and each endpoint
    // 501s independently on its own absent callback.
    this._getSkillCatalog = getSkillCatalog || null;
    this._setSessionSkills = setSessionSkills || null;
    // DM federation (Clodex-to-Clodex agent messaging). deliverDm gates the 'dm'
    // cap and the inbound POST; claimDms drains a consumer's outbox; listDmOrigins
    // advertises which origins have mail waiting (so a consumer only claims when
    // there's something to fetch). All optional — absent → 501 / no 'dm' cap /
    // empty dmOrigins, and old owners simply omit the field.
    this._deliverDm = deliverDm || null;
    this._claimDms = claimDms || null;
    this._listDmOrigins = listDmOrigins || null;
    // Hub-relay federation (spoke side). receiveRoster caches the relayable
    // who-list the hub pushes to THIS box via POST /api/peer/roster (the hub is a
    // consumer of us; it computes the split-horizon'd, access-gated roster and
    // pushes it right after each hello poll). Presence gates the 'relay' cap so a
    // hub only ever pushes to a spoke that can act on it — an old spoke without the
    // callback 501s and the hub skips it. Absent → no 'relay' cap, no endpoint.
    this._receiveRoster = receiveRoster || null;
    this._server = null;
    this._clients = new Set();       // live SSE responses (events feed)
    this._attach = new Map();        // name -> Set of SSE responses (attach feeds)
    this._control = new Map();       // name -> { token, client } single holder
    this._activity = new Map();      // name -> 'thinking' | 'idle'
    this._heartbeat = null;
    // Owner-geometry propagation to read-only viewers. Owner fit() can fire in
    // bursts (window drags), so resizes are coalesced per session: the latest
    // dims win, flushed on a short trailing debounce, and identical dims are
    // dropped (last-sent dedup). _resizePending holds { cols, rows, timer }.
    this._resizePending = new Map(); // name -> { cols, rows, timer }
    this._resizeLast = new Map();    // name -> 'colsxrows' last flushed
    // ── Operator auth (docs/remote-auth-plan.md §2–3). The shared auth-token.js
    // gate; CLODEX_REMOTE_TOKEN threaded from remote-wiring. No token + loopback
    // bind = today's localhost-trust (SSH-tunnel peers untouched). No token +
    // non-loopback bind = the breach condition → fail-closed 503 unless the
    // explicit CLODEX_REMOTE_INSECURE=1 escape hatch (this._insecure) is set.
    this._gate = makeTokenGate(token);
    this._insecure = !!insecure;
    this._loopback = isLoopbackHost(this._host);
  }

  get running() { return !!this._server; }
  get port() { return this._port; }

  start() {
    if (this._server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try { this._route(req, res); }
        catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
      });
      server.on('error', (err) => {
        if (this._server !== server) reject(err);
      });
      server.listen(this._port, this._host, () => {
        this._server = server;
        // Reflect the actual bound port (meaningful when constructed with 0,
        // as tests do; a fixed port reads back unchanged).
        this._port = server.address().port;
        this._heartbeat = setInterval(() => {
          for (const res of this._clients) {
            try { res.write(': ping\n\n'); } catch {}
          }
          for (const set of this._attach.values()) {
            for (const res of set) {
              try { res.write(': ping\n\n'); } catch {}
            }
          }
        }, SSE_HEARTBEAT_MS);
        resolve();
      });
    });
  }

  stop() {
    if (!this._server) return;
    clearInterval(this._heartbeat);
    this._heartbeat = null;
    for (const res of this._clients) { try { res.end(); } catch {} }
    this._clients.clear();
    for (const set of this._attach.values()) {
      for (const res of set) { try { res.end(); } catch {} }
    }
    this._attach.clear();
    this._control.clear();
    for (const p of this._resizePending.values()) clearTimeout(p.timer);
    this._resizePending.clear();
    this._resizeLast.clear();
    try { this._server.close(); } catch {}
    this._server = null;
  }

  // Called from the session manager's activity fan-out (both observation
  // paths funnel through it). turnEnd marks a real end-of-turn idle — the
  // client uses it to refetch the transcript exactly once per turn.
  notifyActivity(name, state, turnEnd) {
    this._activity.set(name, state);
    this._broadcast('activity', { name, state, turnEnd: !!turnEnd });
  }

  // Session created or removed — clients refetch the list.
  notifySessions() {
    const live = new Set((this._getSessions() || []).map(s => s.name));
    for (const name of this._activity.keys()) {
      if (!live.has(name)) this._activity.delete(name);
    }
    for (const name of this._attach.keys()) {
      if (!live.has(name)) this._dropAttach(name);
    }
    this._broadcast('sessions', {});
  }

  // DM doorbell: a reply was just queued in the outbox for `origin`. Tells that
  // consumer to claim now instead of waiting out the hello interval. The outbox
  // stays the durable channel; this is only the low-latency nudge.
  notifyDmMail(origin) {
    this._broadcast('dm-mail', { origin });
  }

  // Live PTY bytes for a session — fan out to its attach streams. Called
  // from the session manager's onData, so it must stay cheap when nobody
  // is attached (the common case).
  pushOutput(name, chunk) {
    const set = this._attach.get(name);
    if (!set || set.size === 0) return;
    const b64 = Buffer.isBuffer(chunk) ? chunk.toString('base64') : Buffer.from(chunk).toString('base64');
    const frame = `event: output\ndata: ${JSON.stringify({ b64 })}\n\n`;
    for (const res of set) {
      try {
        res.write(frame);
        // A stream that can't drain is a half-open tunnel rendering
        // stale-as-live; kill it, the client reconnects and replays.
        if (res.writableLength > ATTACH_MAX_BUFFERED) res.destroy();
      } catch {}
    }
  }

  // Status-bar telemetry for a session — the viewer renders the owner's
  // strip (model/ctx/warmth/cost/busts) as-is. Same fan-out discipline as
  // pushOutput: cheap no-op when nobody is attached. `tele` is a partial
  // ({proxy} and/or {ctx}); the client merges.
  pushTelemetry(name, tele) {
    const set = this._attach.get(name);
    if (!set || set.size === 0) return;
    const frame = `event: telemetry\ndata: ${JSON.stringify(tele)}\n\n`;
    for (const res of set) {
      try { res.write(frame); } catch {}
    }
  }

  // Owner-initiated UI event — mirror a session-scoped component the owner just
  // surfaced (in response to an agent intent) to that session's attached
  // viewers, so a remote agent's `[agent:file view]` popup appears on the
  // viewer's screen too. Carries a SMALL trigger {kind, args}, never rendered
  // content: the viewer maps kind→its own local render and pulls content back
  // through the query RPC (filePeek/fileDiff), keeping content on the owner's
  // vetted code path and the no-reach-back principle intact. Session-scoped by
  // construction (only THIS name's attach set hears it). Same cheap-no-op
  // discipline as pushOutput. `[agent:file open]` (external launch) is never
  // routed here — view-only surfaces mirror.
  pushUiEvent(name, kind, args) {
    if (!kind || typeof kind !== 'string') return;
    const set = this._attach.get(name);
    if (!set || set.size === 0) return;
    const frame = `event: ui\ndata: ${JSON.stringify({ kind, args: args || {} })}\n\n`;
    for (const res of set) { try { res.write(frame); } catch {} }
  }

  // Owner PTY resized — mirror the new letterbox to read-only viewers so their
  // terminal follows the owner's geometry instead of rendering new output into
  // a stale box (staircase-wrapped garble). Owner geometry is canonical; a
  // controlling viewer's own resize round-trips through here too and echoes
  // back the same dims, which is an idempotent term.resize on that viewer (no
  // feedback loop — viewers only push geometry on explicit fit, not on an
  // applied resize). Coalesced per session (trailing debounce + dedup) so a
  // drag-burst of fit()s doesn't flood the stream. Cheap no-op with no
  // attachers, like pushOutput.
  notifyResize(name, cols, rows) {
    if (!(cols > 0 && rows > 0)) return;
    const set = this._attach.get(name);
    if (!set || set.size === 0) return;
    const pending = this._resizePending.get(name);
    if (pending) {
      pending.cols = cols; pending.rows = rows;
      return;                          // timer already scheduled; latest wins
    }
    const entry = { cols, rows, timer: null };
    entry.timer = setTimeout(() => this._flushResize(name), RESIZE_DEBOUNCE_MS);
    this._resizePending.set(name, entry);
  }

  _flushResize(name) {
    const entry = this._resizePending.get(name);
    this._resizePending.delete(name);
    if (!entry) return;
    const set = this._attach.get(name);
    if (!set || set.size === 0) { this._resizeLast.delete(name); return; }
    const key = `${entry.cols}x${entry.rows}`;
    if (this._resizeLast.get(name) === key) return;   // dedup: no real change
    this._resizeLast.set(name, key);
    const frame = `event: resize\ndata: ${JSON.stringify({ cols: entry.cols, rows: entry.rows })}\n\n`;
    for (const res of set) { try { res.write(frame); } catch {} }
  }

  // PTY exited — tell attachers, then tear the streams down.
  notifyExit(name, exitCode) {
    const set = this._attach.get(name);
    if (set) {
      const frame = `event: exit\ndata: ${JSON.stringify({ exitCode })}\n\n`;
      for (const res of set) { try { res.write(frame); res.end(); } catch {} }
    }
    this._dropAttach(name);
  }

  _dropAttach(name) {
    const set = this._attach.get(name);
    if (set) { for (const res of set) { try { res.end(); } catch {} } }
    this._attach.delete(name);
    const pending = this._resizePending.get(name);
    if (pending) { clearTimeout(pending.timer); this._resizePending.delete(name); }
    this._resizeLast.delete(name);
    this._setControl(name, null);
  }

  // Single-holder control state. holder = { token, client } or null.
  // Last-wins on acquire (both laptops are the same operator); everyone
  // attached hears about the change.
  _setControl(name, holder) {
    const prev = this._control.get(name) || null;
    if (!prev && !holder) return;
    if (holder) this._control.set(name, holder); else this._control.delete(name);
    const client = holder ? holder.client : null;
    const set = this._attach.get(name);
    if (set) {
      const frame = `event: control\ndata: ${JSON.stringify({ holder: client })}\n\n`;
      for (const res of set) { try { res.write(frame); } catch {} }
    }
    if (this._onControlChange) {
      try { this._onControlChange(name, client); } catch {}
    }
  }

  _controlToken(name) {
    const cur = this._control.get(name);
    return cur ? cur.token : null;
  }

  activityFor(name) { return this._activity.get(name) || 'idle'; }

  _broadcast(event, data) {
    if (!this._server || this._clients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this._clients) {
      try { res.write(frame); } catch {}
    }
  }

  // Operator-auth gate — runs before ANY routing (viewer page, every /api/*, and
  // the SSE stream: transcripts are sensitive, read-only is not harmless).
  // Returns true to proceed; on refusal it has already written the response.
  _authGate(req, res) {
    // Fail-closed: a non-loopback bind with no configured token is the exact
    // breach condition (container 0.0.0.0 + no secret). Refuse with a hard,
    // observable 503 naming the env var, rather than silently localhost-trusting.
    if (!this._gate.configured && !this._loopback && !this._insecure) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Refusing to serve: bound to a non-loopback address with no CLODEX_REMOTE_TOKEN set. Set CLODEX_REMOTE_TOKEN, or CLODEX_REMOTE_INSECURE=1 to override.');
      return false;
    }
    // Token check. No token configured (loopback, or the insecure override) →
    // gate.check passes everything, exactly as before this change.
    if (!this._gate.check(this._gate.fromReq(req))) {
      res.writeHead(401, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'Bearer',
      });
      res.end('unauthorized');
      return false;
    }
    // Bookmark path: a valid ?token= seeds an HttpOnly cookie so the viewer's
    // later XHR + EventSource authenticate without page JS ever touching the
    // token (EventSource can't set headers — the cookie is the mechanism).
    if (this._gate.configured) this._maybeSetTokenCookie(req, res);
    return true;
  }

  // Set the token cookie ONLY when the (already-validated) token arrived via the
  // ?token= query param — the first bookmark hit. Bearer callers (peer-client)
  // and cookie-carrying requests don't need it re-issued. Secure flag when the
  // edge terminated TLS (x-forwarded-proto: https).
  _maybeSetTokenCookie(req, res) {
    let q = null;
    try { q = new URL(req.url, 'http://localhost').searchParams.get('token'); } catch { /* keep null */ }
    if (!q) return;
    const proto = String((req.headers && req.headers['x-forwarded-proto']) || '');
    const secure = /https/i.test(proto) ? '; Secure' : '';
    res.setHeader('Set-Cookie', `clodex_remote_token=${encodeURIComponent(q)}; HttpOnly; SameSite=Strict; Path=/${secure}`);
  }

  _route(req, res) {
    if (!this._authGate(req, res)) return;
    const url = new URL(req.url, 'http://localhost');
    let p = url.pathname;

    // Optional mount prefix for path-based ingress routing (example.com/c →
    // this server). The page uses relative URLs, so it works at / and under
    // /c/ alike; the redirect makes bare /c resolve those correctly.
    if (p === '/c') {
      res.writeHead(301, { Location: '/c/' });
      return res.end();
    }
    if (p.startsWith('/c/')) p = p.slice(2);

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return this._page(res);
    }
    if (req.method === 'GET' && p === '/api/sessions') {
      const sessions = (this._getSessions() || []).map(s => ({
        ...s, activity: this.activityFor(s.name),
      }));
      return this._json(res, 200, { ok: true, sessions });
    }
    if (req.method === 'GET' && p.startsWith('/api/transcript/')) {
      const name = decodeURIComponent(p.slice('/api/transcript/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 100, 500);
      const out = this._getTranscript(name, limit);
      return this._json(res, out.ok ? 200 : 404, out);
    }
    if (req.method === 'GET' && p === '/api/events') {
      return this._sse(req, res);
    }
    // ---- Peer protocol (headless-first: usable with no window open) ----
    // Identity comes from response content, never from the port — SSH
    // tunnels make every peer look like localhost.
    if (req.method === 'GET' && p === '/api/peer/hello') {
      const caps = ['transcript', 'send'];
      if (this._getAttachInfo) caps.push('attach');
      if (this._sendInput) caps.push('control');
      if (this._query) caps.push('query');
      if (this._createSession) {
        caps.push('create'); // covers create + kill + restart (ship together)
        // create2 = this box accepts the FULL-param create body + serves
        // /api/catalogs (M5). A separate string so old clients ignore it and keep
        // the bare {name,type,cwd} behavior; on this version 'create' ⇒ 'create2'.
        caps.push('create2');
      }
      if (this._getSessionArgs) caps.push('args');   // remote session config editing — args + skills pairs, ship together under one cap
      if (this._deliverDm) caps.push('dm'); // inbound DM + outbox claim (federation)
      if (this._receiveRoster) caps.push('relay'); // accepts a hub-pushed relay roster (hub-relay federation)
      return this._json(res, 200, {
        ok: true, app: 'clodex', host: this._hostLabel,
        version: this._version, caps,
        // Deploy/identity surfacing: which OS the box runs (the deploy wizard
        // and header tooltip show it; harmless to older viewers that ignore it).
        platform: process.platform,
        // Install dir on the box (home-relative or null) — lets a consumer's
        // Update pull the RIGHT checkout. null/absent → viewer keeps its guess.
        srcDir: this._srcDir,
        // Origins (consumer labels) with DM mail waiting — a consumer whose label
        // appears here claims its outbox this tick. Empty/absent → nothing to
        // fetch, so old consumers (which ignore the field) simply never claim.
        dmOrigins: this._listDmOrigins ? this._listDmOrigins() : [],
      });
    }
    // Read side: raw PTY stream with best-effort scrollback replay. The
    // replay reconstructs recent output, NOT exact terminal state — clients
    // must reset their terminal before applying it, and re-replay on
    // reconnect rather than resuming.
    if (req.method === 'GET' && p.startsWith('/api/attach/')) {
      if (!this._getAttachInfo) return this._json(res, 501, { ok: false, error: 'attach not available' });
      const name = decodeURIComponent(p.slice('/api/attach/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      const info = this._getAttachInfo(name);
      if (!info || !info.ok) return this._json(res, 404, { ok: false, error: 'no such session' });
      this._sse(req, res);
      const cur = this._control.get(name);
      const hello = {
        b64: (info.scrollback || Buffer.alloc(0)).toString('base64'),
        cols: info.cols || 80, rows: info.rows || 24,
        holder: cur ? cur.client : null,
      };
      try { res.write(`event: replay\ndata: ${JSON.stringify(hello)}\n\n`); } catch {}
      // Seed the status bar right behind the replay — the live telemetry
      // stream only ticks every poll, and an empty bar for 5s reads broken.
      if (info.telemetry && (info.telemetry.proxy || info.telemetry.ctx)) {
        try { res.write(`event: telemetry\ndata: ${JSON.stringify(info.telemetry)}\n\n`); } catch {}
      }
      let set = this._attach.get(name);
      if (!set) { set = new Set(); this._attach.set(name, set); }
      set.add(res);
      this._clients.delete(res);   // attach feeds are per-session, not the global events feed
      req.on('close', () => {
        set.delete(res);
        // Control is only meaningful while its holder can see the session:
        // last attacher gone -> auto-release.
        if (set.size === 0) { this._attach.delete(name); this._setControl(name, null); }
      });
      return;
    }
    // Control side: shell-equivalent endpoints. Input/resize are gated on a
    // per-acquire capability token so a read-only viewer (or a confused
    // client on the tunnel host) can't type by accident.
    if (req.method === 'POST' && p.startsWith('/api/control/')) {
      if (!this._sendInput) return this._json(res, 501, { ok: false, error: 'control not available' });
      const name = decodeURIComponent(p.slice('/api/control/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return this._readBody(req, res, (body) => {
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        const info = this._getAttachInfo ? this._getAttachInfo(name) : null;
        if (!info || !info.ok) return this._json(res, 404, { ok: false, error: 'no such session' });
        if (msg.action === 'acquire') {
          const client = String(msg.client || 'peer').slice(0, 64);
          const token = crypto.randomBytes(16).toString('hex');
          this._setControl(name, { token, client });
          return this._json(res, 200, { ok: true, token });
        }
        if (msg.action === 'release') {
          if (String(msg.token || '') !== this._controlToken(name)) {
            return this._json(res, 403, { ok: false, error: 'not the control holder' });
          }
          this._setControl(name, null);
          return this._json(res, 200, { ok: true });
        }
        return this._json(res, 400, { ok: false, error: 'bad action' });
      });
    }
    if (req.method === 'POST' && p.startsWith('/api/input/')) {
      if (!this._sendInput) return this._json(res, 501, { ok: false, error: 'input not available' });
      const name = decodeURIComponent(p.slice('/api/input/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return this._readBody(req, res, (body) => {
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        if (String(msg.token || '') !== this._controlToken(name)) {
          return this._json(res, 403, { ok: false, error: 'not the control holder' });
        }
        const out = this._sendInput(name, String(msg.data || ''));
        return this._json(res, out && out.ok ? 200 : 404, out || { ok: false });
      });
    }
    if (req.method === 'POST' && p.startsWith('/api/resize/')) {
      if (!this._resizePty) return this._json(res, 501, { ok: false, error: 'resize not available' });
      const name = decodeURIComponent(p.slice('/api/resize/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return this._readBody(req, res, (body) => {
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        // Owner geometry is canonical: resize is a control-mode privilege,
        // never a side effect of viewing.
        if (String(msg.token || '') !== this._controlToken(name)) {
          return this._json(res, 403, { ok: false, error: 'not the control holder' });
        }
        const cols = parseInt(msg.cols, 10), rows = parseInt(msg.rows, 10);
        if (!(cols >= 20 && cols <= 500 && rows >= 5 && rows <= 300)) {
          return this._json(res, 400, { ok: false, error: 'bad dimensions' });
        }
        const out = this._resizePty(name, cols, rows);
        return this._json(res, out && out.ok ? 200 : 404, out || { ok: false });
      });
    }
    // Popover data pull: read-only snapshots (context breakdown, cost report,
    // bust forensics, touched files, file peek/diff). Un-gated like the
    // transcript read — the tunnel is the auth boundary, and control-holders
    // can read anything through the session anyway. The kind whitelist lives
    // in the injected callback.
    if (req.method === 'POST' && p.startsWith('/api/query/')) {
      if (!this._query) return this._json(res, 501, { ok: false, error: 'query not available' });
      const name = decodeURIComponent(p.slice('/api/query/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return this._readBody(req, res, (body) => {
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        Promise.resolve()
          .then(() => this._query(name, String(msg.kind || ''), msg.args || {}))
          .then((out) => this._json(res, out && out.ok ? 200 : 404, out || { ok: false, error: 'query failed' }))
          .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
      });
    }
    if (req.method === 'POST' && p === '/api/send') {
      return this._readBody(req, res, (body) => {
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        const name = String(msg.name || '');
        const text = String(msg.text || '').trim();
        if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
        if (!text) return this._json(res, 400, { ok: false, error: 'empty message' });
        const out = this._send(name, text);
        return this._json(res, out.ok ? 200 : 404, out);
      });
    }
    // Full app relaunch (sessions resume per the normal quit/restore
    // lifecycle). The response is written BEFORE the restart fires — the
    // server dies with the app, so a late reply would never arrive. POST
    // only; the page fronts it with a confirm.
    if (req.method === 'POST' && p === '/api/restart') {
      if (!this._restartApp) return this._json(res, 501, { ok: false, error: 'restart not available' });
      this._json(res, 200, { ok: true });
      this._restartApp();
      return;
    }
    // Remote session create — the full-param body (M5): {name, type, cwd} plus the
    // optional setArgs patch keys + create-only resumeId/fork/stripLevel/intents.
    // Bare {name,type,cwd} stays valid (compat); the whole parsed body is forwarded
    // so the owner (remote-wiring) maps it onto create() and drops what never
    // crosses (exec grants). The ack carries the whole outcome (viewer sees no
    // dialogs on this box), with distinguishable errors: bad name/type, name taken,
    // bad cwd, spawn failure, plus non-fatal warnings[]. Trust is the tunnel, same
    // as every peer RPC — no token.
    if (req.method === 'POST' && p === '/api/sessions') {
      if (!this._createSession) return this._json(res, 501, { ok: false, error: 'create not available' });
      return this._readBody(req, res, (body) => {
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        Promise.resolve()
          .then(() => this._createSession(msg))
          .then((out) => this._json(res, out && out.ok ? 200 : 400, out || { ok: false, error: 'create failed' }))
          .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
      });
    }
    // Session-less catalogs for the New Session dialog when it targets THIS box
    // (M5): the checklists must render the box's skills/agents/prompts/tools, not
    // the viewer's own libraries. A SUPERSET of /api/session-args' catalogs block
    // (adds skills; agents unscoped — no session to scope by pre-create). Rides the
    // 'create' capability; the create2 hello cap tells the viewer it's available.
    if (req.method === 'GET' && p === '/api/catalogs') {
      if (!this._getCatalogs) return this._json(res, 501, { ok: false, error: 'catalogs not available' });
      return Promise.resolve()
        .then(() => this._getCatalogs())
        .then((cat) => this._json(res, 200, { ok: true, catalogs: cat || {} }))
        .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
    }
    // Remote session kill — user-initiated semantics on the owner (removes from
    // persistence, no resume). Path-scoped like input/control/resize.
    if (req.method === 'POST' && p.startsWith('/api/kill/')) {
      if (!this._killSession) return this._json(res, 501, { ok: false, error: 'kill not available' });
      const name = decodeURIComponent(p.slice('/api/kill/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return Promise.resolve()
        .then(() => this._killSession(name))
        .then((out) => this._json(res, out && out.ok ? 200 : 404, out || { ok: false, error: 'kill failed' }))
        .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
    }
    // Remote session restart — kill + respawn from the persisted entry. Body
    // {fresh} picks plain restart (--resume, keeps history) vs fresh reload
    // (new conversation, re-reads skills). Path-scoped like kill; gated on the
    // same 'create' capability (create/kill/restart ship together). The ack is
    // distinguishable: not-found in persistence (404) vs a respawn failure whose
    // message says the entry was kept (still 404, distinct text).
    if (req.method === 'POST' && p.startsWith('/api/restart-session/')) {
      if (!this._restartSession) return this._json(res, 501, { ok: false, error: 'restart not available' });
      const name = decodeURIComponent(p.slice('/api/restart-session/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return this._readBody(req, res, (body) => {
        let msg = {};
        if (body) { try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); } }
        Promise.resolve()
          .then(() => this._restartSession(name, { fresh: !!msg.fresh }))
          .then((out) => this._json(res, out && out.ok ? 200 : 404, out || { ok: false, error: 'restart failed' }))
          .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
      });
    }
    // Remote session args read — the Edit Session dialog's source of truth for a
    // peer session. Returns the box's editable args PLUS the catalogs the dialog's
    // checklists render from (agents/prompts/claudeTools + proxyUrl), so the viewer
    // never leaks its OWN libraries into a remote edit. Gated on 'args'; path-scoped
    // like the other per-session RPCs. ok:false (unknown name) → 404.
    if (req.method === 'GET' && p.startsWith('/api/session-args/')) {
      if (!this._getSessionArgs) return this._json(res, 501, { ok: false, error: 'args not available' });
      const name = decodeURIComponent(p.slice('/api/session-args/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return Promise.resolve()
        .then(() => this._getSessionArgs(name))
        .then((out) => this._json(res, out && out.ok ? 200 : 404, out || { ok: false, error: 'not found' }))
        .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
    }
    // Remote session args apply — {extraArgs, restart, proxy, systemPrompt, agents,
    // denyBuiltins, disabledTools, disabledSkills, injectSkills, systemPromptFile,
    // appendPromptFiles}. Owner shares session:setArgs's core (undefined-untouched,
    // stripLevel/label re-assert, catch-upsert); restart:true kills+respawns and the
    // attached viewer reattaches off the SSE exit. Same 'args' cap as the GET.
    if (req.method === 'POST' && p.startsWith('/api/session-args/')) {
      if (!this._setSessionArgs) return this._json(res, 501, { ok: false, error: 'args not available' });
      const name = decodeURIComponent(p.slice('/api/session-args/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return this._readBody(req, res, (body) => {
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        Promise.resolve()
          .then(() => this._setSessionArgs(name, msg))
          .then((out) => this._json(res, out && out.ok ? 200 : 404, out || { ok: false, error: 'setArgs failed' }))
          .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
      });
    }
    // Remote skill catalog — the Skills popover's data over the wire. Owner returns
    // EXACTLY what session:skillCatalog returns (names union, disabledSkills,
    // effective lower-layer state, skillsLocked, canReenable, skillLib, injectSkills),
    // all resolved BOX-side: the transcript roster and the skill library are the
    // box's, which is correct because inject-skills materialize at spawn on the box.
    // Rides the 'args' cap; path-scoped; ok:false (unknown name) → 404.
    if (req.method === 'GET' && p.startsWith('/api/skill-catalog/')) {
      if (!this._getSkillCatalog) return this._json(res, 501, { ok: false, error: 'skills not available' });
      const name = decodeURIComponent(p.slice('/api/skill-catalog/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return Promise.resolve()
        .then(() => this._getSkillCatalog(name))
        .then((out) => this._json(res, out && out.ok ? 200 : 404, out || { ok: false, error: 'not found' }))
        .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
    }
    // Remote skill gating apply — {disabledSkills, injectSkills}. Owner shares
    // session:setSkills's core (persist-only; injectSkills optional; restart is a
    // separate /api/session-restart the popover makes when the user asks). Same
    // 'args' cap as the GET.
    if (req.method === 'POST' && p.startsWith('/api/session-skills/')) {
      if (!this._setSessionSkills) return this._json(res, 501, { ok: false, error: 'skills not available' });
      const name = decodeURIComponent(p.slice('/api/session-skills/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return this._readBody(req, res, (body) => {
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        Promise.resolve()
          .then(() => this._setSessionSkills(name, msg.disabledSkills, msg.injectSkills))
          .then((out) => this._json(res, out && out.ok ? 200 : 404, out || { ok: false, error: 'setSkills failed' }))
          .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
      });
    }
    // Inbound DM — {to, from, origin, body, urgent}. The consumer POSTs here to
    // reach an agent on THIS box. The owner's deliverDm runs the same cost-gate/
    // park path a local dm takes and returns the verdict, which rides the
    // synchronous response back to the sender (delivered / parked / bounced) —
    // no async ack channel needed. Trust is the tunnel, same as every peer RPC.
    if (req.method === 'POST' && p === '/api/dm') {
      if (!this._deliverDm) return this._json(res, 501, { ok: false, error: 'dm not available' });
      return this._readBody(req, res, (body) => {
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        const to = String(msg.to || '');
        const from = String(msg.from || '');
        const origin = String(msg.origin || '');
        const text = typeof msg.body === 'string' ? msg.body : '';
        if (!NAME_RE.test(to)) return this._json(res, 400, { ok: false, error: 'bad target name' });
        // `from` may be bare (a direct DM) or fully-qualified `name@origin` (the
        // terminal leg of a relayed DM — `from` is sacred, carried through unchanged
        // from the originating spoke). deliverDm keys the senderTag off the '@'.
        if (!isQualifiedSender(from)) return this._json(res, 400, { ok: false, error: 'bad sender name' });
        if (!NAME_RE.test(origin)) return this._json(res, 400, { ok: false, error: 'bad origin' });
        if (!text) return this._json(res, 400, { ok: false, error: 'empty message' });
        if (text.length > MAX_BODY) return this._json(res, 413, { ok: false, error: 'message too large' });
        Promise.resolve()
          .then(() => this._deliverDm({ to, from, origin, body: text, urgent: msg.urgent === true }))
          .then((out) => this._json(res, out && out.ok ? 200 : 404, out || { ok: false, error: 'delivery failed' }))
          .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
      });
    }
    // Outbox claim — {origin}. A consumer drains the mail this box has queued for
    // it (box→consumer DMs, since the box can't dial back over the one-way
    // tunnel). Atomic whole-dir claim on the owner side; response carries the
    // whole snapshot.
    if (req.method === 'POST' && p === '/api/dm/claim') {
      if (!this._claimDms) return this._json(res, 501, { ok: false, error: 'dm not available' });
      return this._readBody(req, res, (body) => {
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        const origin = String(msg.origin || '');
        if (!NAME_RE.test(origin)) return this._json(res, 400, { ok: false, error: 'bad origin' });
        Promise.resolve()
          .then(() => this._claimDms(origin))
          .then((messages) => this._json(res, 200, { ok: true, messages: Array.isArray(messages) ? messages : [] }))
          .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
      });
    }
    // Relay roster push — {rv, via, roster:[{name,origin,type}]}. The HUB (a
    // consumer of this box) computes the set of agents on its OTHER peers that
    // THIS spoke is permitted to reach (split-horizon + symmetric relayAllowed
    // gate, both applied hub-side) and pushes it here every hello tick. `via` is
    // the hub's own label — what this spoke keys its via-table and outbox under
    // (HTTP doesn't self-identify the caller; it's the same label the hub uses as
    // `origin` on /api/dm to us). Full-replacement, not a delta. receiveRoster
    // caches it as the spoke's via-table; a subsequent [agent:dm name@origin]
    // whose origin is unconfigured-but-in-roster routes out through `via`.
    if (req.method === 'POST' && p === '/api/peer/roster') {
      if (!this._receiveRoster) return this._json(res, 501, { ok: false, error: 'relay not available' });
      return this._readBody(req, res, (body) => {
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        if (!relayVersionOk(msg.rv)) return this._json(res, 400, { ok: false, error: 'unsupported relay version' });
        const via = String(msg.via || '');
        if (!NAME_RE.test(via)) return this._json(res, 400, { ok: false, error: 'bad via' });
        // Sanitize the roster wire value into trusted shape before it's cached:
        // both name and origin must be name-charset (they become dm targets/keys),
        // and the origin must not be `via` itself (a hub advertising its own label
        // as a reachable origin would make the spoke try to relay back to it).
        const rosterIn = Array.isArray(msg.roster) ? msg.roster : [];
        const roster = [];
        for (const e of rosterIn) {
          if (!e || typeof e !== 'object') continue;
          const name = String(e.name || '');
          const origin = String(e.origin || '');
          const type = e.type === 'codex' ? 'codex' : 'claude';
          if (!NAME_RE.test(name) || !NAME_RE.test(origin)) continue;
          if (origin === via) continue;
          roster.push({ name, origin, type });
        }
        Promise.resolve()
          .then(() => this._receiveRoster({ via, roster }))
          .then(() => this._json(res, 200, { ok: true }))
          .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
      });
    }
    this._json(res, 404, { ok: false, error: 'not found' });
  }

  _page(res) {
    // Read per-request (not cached): the file is small, and dev edits show
    // up on phone reload without an app restart.
    fs.readFile(this._pagePath, (err, buf) => {
      if (err) { this._json(res, 500, { ok: false, error: 'page missing' }); return; }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    });
  }

  _sse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    this._clients.add(res);
    req.on('close', () => this._clients.delete(res));
  }

  _readBody(req, res, cb) {
    let body = '';
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      body += chunk;
      if (body.length > MAX_BODY) {
        over = true;
        this._json(res, 413, { ok: false, error: 'message too large' });
        req.destroy();
      }
    });
    req.on('end', () => { if (!over) cb(body); });
  }

  _json(res, code, obj) {
    if (res.writableEnded) return;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
}

module.exports = { RemoteServer };
