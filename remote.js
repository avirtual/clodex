
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

const NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const MAX_BODY = 64 * 1024;          // matches the IPC message cap
const SSE_HEARTBEAT_MS = 25000;
const ATTACH_MAX_BUFFERED = 4 * 1024 * 1024;
const RESIZE_DEBOUNCE_MS = 80;

class RemoteServer {
  constructor({ port, host, pagePath, getSessions, getTranscript, send, restartApp,
                hostLabel, version, srcDir, getWebInfo, getAttachInfo, sendInput, resizePty, onControlChange,
                query, createSession, killSession, restartSession, getCatalogs,
                getSessionArgs, setSessionArgs,
                getSkillCatalog, setSessionSkills,
                deliverDm, claimDms, listDmOrigins, receiveRoster,
                wtermOpen, wtermInput, wtermResize, wtermClose, onWtermStreams,
                token, insecure }) {
    this._port = port;
    this._host = host || '127.0.0.1';
    this._pagePath = pagePath;
    this._getSessions = getSessions;
    this._getTranscript = getTranscript;
    this._send = send;
    this._restartApp = restartApp || null;
    this._hostLabel = hostLabel || 'clodex';
    this._version = version || '';
    this._srcDir = srcDir || null;
    // The browser frontend's host, read per hello (t30). A getter, not a value:
    // web-host.js starts after this server is constructed, and is absent
    // entirely under Electron.
    this._getWebInfo = typeof getWebInfo === 'function' ? getWebInfo : null;
    this._getAttachInfo = getAttachInfo || null;
    this._sendInput = sendInput || null;
    this._resizePty = resizePty || null;
    this._onControlChange = onControlChange || null;
    this._query = query || null;
    this._createSession = createSession || null;
    this._killSession = killSession || null;
    this._restartSession = restartSession || null;
    this._getCatalogs = getCatalogs || null;
    this._getSessionArgs = getSessionArgs || null;
    this._setSessionArgs = setSessionArgs || null;
    this._getSkillCatalog = getSkillCatalog || null;
    this._setSessionSkills = setSessionSkills || null;
    this._deliverDm = deliverDm || null;
    this._claimDms = claimDms || null;
    this._listDmOrigins = listDmOrigins || null;
    this._receiveRoster = receiveRoster || null;
    // The peer terminal (t219). Four callbacks that are passed together or not
    // at all: remote-wiring supplies them only while some peer holds the grant,
    // and their ABSENCE is the capability gate — the endpoints 501 and `shell`
    // drops out of hello. A runtime flag check here would be weaker, because it
    // can be true while the operator believes it is false.
    this._wtermOpen = wtermOpen || null;
    this._wtermInput = wtermInput || null;
    this._wtermResize = wtermResize || null;
    this._wtermClose = wtermClose || null;
    this._wterm = new Map();         // seat -> Set of SSE responses (peer terminal feeds)
    // Fired whenever that Map's membership changes, with the seats currently
    // being watched. NOT part of the grant bundle above and deliberately not
    // gated with it: the indicator has to survive the moment the grant is
    // revoked, which is exactly when the last stream goes away and the operator
    // needs to see it go. Absence is an ordinary host with no UI to tell.
    this._onWtermStreams = onWtermStreams || null;
    this._server = null;
    this._clients = new Set();       // live SSE responses (events feed)
    this._attach = new Map();        // name -> Set of SSE responses (attach feeds)
    this._control = new Map();       // name -> { token, client } single holder
    this._activity = new Map();      // name -> 'thinking' | 'idle'
    this._heartbeat = null;
    this._resizePending = new Map(); // name -> { cols, rows, timer }
    this._resizeLast = new Map();    // name -> 'colsxrows' last flushed
    this._gate = makeTokenGate(token);
    this._insecure = !!insecure;
    this._loopback = isLoopbackHost(this._host);
  }

  // Apply (or withdraw) the peer-terminal grant on a RUNNING server. The
  // constructor's copy of these callbacks is only the state at startup; the
  // operator toggles the grant while the box is serving, and a capability with
  // no live off switch is not a capability.
  //
  // ORDER IS THE WHOLE POINT: open streams are closed BEFORE the callbacks are
  // dropped. Reversed, there is a window in which the handler is gone but a
  // live shell stream is still writing to a remote party — revoked on paper,
  // serving in fact. The close carries `revoked` so the consumer reads a
  // decision rather than a dropped tunnel and stops retrying.
  //
  // Withdrawal is keyed on the CALLBACK, never on the bundle: remote-wiring's
  // no-grant return is a truthy object of four nulls, so `!cbs` would read a
  // revocation as an ordinary reconcile and null the handlers with the streams
  // still open. Only the ternary at its call site stands between the two, and a
  // correctness property one cleanup away from false is not a property.
  setWtermCallbacks(cbs) {
    const next = (cbs && cbs.wtermOpen) ? cbs : null;
    const had = !!this._wtermOpen;
    if (had && !next) this.dropAllWterm('revoked');
    this._wtermOpen = (next && next.wtermOpen) || null;
    this._wtermInput = (next && next.wtermInput) || null;
    this._wtermResize = (next && next.wtermResize) || null;
    this._wtermClose = (next && next.wtermClose) || null;
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
          // Peer terminals heartbeat too. An idle shell is the NORMAL state of
          // this stream — an operator opens a terminal and reads it — so
          // without a ping a tunnel or proxy reaps the connection precisely
          // when nothing is wrong.
          for (const set of this._wterm.values()) {
            for (const res of set) {
              try { res.write(': ping\n\n'); } catch {}
            }
          }
          // Re-report on the same tick. The membership events are the fast
          // path, but they only reach the windows that existed when they
          // fired — a workspace window opened while a peer is already in a
          // shell would otherwise show nothing until that shell closed. An
          // indicator whose accuracy depends on when you opened your window is
          // not one an operator can rely on.
          //
          // Convergence runs BOTH ways, because `_notifyWtermStreams` rebuilds
          // the whole seat list from `_wterm` rather than sending a delta: a
          // mark the receiver holds for a seat no longer in the set is cleared
          // by the same message that sets the others (peers-ui's handler
          // deletes any `data-served-terminal` outside `live`). So a dropped
          // event self-heals within a heartbeat in either direction, and no
          // caller has to pair its add with a matching remove.
          this._notifyWtermStreams();
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
    // Reason-carrying, not a bare end: a stopping server is a decision too.
    this.dropAllWterm('offline');
    this._control.clear();
    for (const p of this._resizePending.values()) clearTimeout(p.timer);
    this._resizePending.clear();
    this._resizeLast.clear();
    try { this._server.close(); } catch {}
    this._server = null;
  }

  notifyActivity(name, state, turnEnd) {
    this._activity.set(name, state);
    this._broadcast('activity', { name, state, turnEnd: !!turnEnd });
  }

  notifySessions() {
    const live = new Set((this._getSessions() || []).map(s => s.name));
    for (const name of this._activity.keys()) {
      if (!live.has(name)) this._activity.delete(name);
    }
    for (const name of this._attach.keys()) {
      if (!live.has(name)) this._dropAttach(name);
    }
    // A peer-terminal stream outlives its seat otherwise, and the seat is what
    // every local surface hangs on: the mark is a sidebar row attribute, and a
    // killed or archived session has no row. The peer keeps typing into a live
    // login shell with nothing on this box able to say so.
    //
    // Worse on recovery. The drawer shell is NOT reaped by a kill (only by a
    // window close and by session:forget), so recreating the same name in the
    // same workspace hands a surviving stream input rights against the same
    // still-running shell — with no fresh `wtermOpen`, so the
    // `peer-terminal-open` chip never fires again for a party that is back
    // inside it.
    //
    // The SHELL is deliberately left running: it is the operator's own, and a
    // restart-through-kill has to keep whatever is in it. Only the peer's view
    // of it ends here. Keys are spread because `_closeWterm` deletes from the
    // Map this iterates.
    for (const seat of [...this._wterm.keys()]) {
      if (!live.has(seat)) this.dropWterm(seat, 'closed');
    }
    this._broadcast('sessions', {});
  }

  notifyDmMail(origin) {
    this._broadcast('dm-mail', { origin });
  }

  pushOutput(name, chunk) {
    const set = this._attach.get(name);
    if (!set || set.size === 0) return;
    const b64 = Buffer.isBuffer(chunk) ? chunk.toString('base64') : Buffer.from(chunk).toString('base64');
    const frame = `event: output\ndata: ${JSON.stringify({ b64 })}\n\n`;
    for (const res of set) {
      try {
        res.write(frame);
        if (res.writableLength > ATTACH_MAX_BUFFERED) res.destroy();
      } catch {}
    }
  }

  // Peer-terminal output. Same shape and the same 4MB rule as pushOutput, and
  // the rule is not optional here either: a half-open tunnel that keeps
  // buffering renders a stale terminal as a live one, which on a SHELL means an
  // operator reading output that no longer describes the box.
  pushWtermOutput(seat, chunk) {
    const set = this._wterm.get(seat);
    if (!set || set.size === 0) return;
    const b64 = Buffer.isBuffer(chunk) ? chunk.toString('base64') : Buffer.from(chunk).toString('base64');
    const frame = `event: output\ndata: ${JSON.stringify({ b64 })}\n\n`;
    for (const res of set) {
      try {
        res.write(frame);
        if (res.writableLength > ATTACH_MAX_BUFFERED) res.destroy();
      } catch {}
    }
  }

  pushWtermExit(seat, exitCode) {
    this._closeWterm(seat, { event: 'exit', data: { exitCode } });
  }

  // Ending a peer-terminal stream ALWAYS says why. An end with no reason is
  // indistinguishable from a dropped tunnel, so the consumer would sit in its
  // reconnect backoff retrying against a decision — which is exactly what
  // revocation is. `reason` is a code from peer-shell's vocabulary.
  dropWterm(seat, reason) {
    this._closeWterm(seat, { event: 'closed', data: { reason: reason || 'closed' } });
  }

  // Every open peer-terminal stream, closed with one reason. Used by revocation
  // and by stop(): a grant that goes away must not leave a live shell stream
  // behind it.
  dropAllWterm(reason) {
    for (const seat of [...this._wterm.keys()]) this.dropWterm(seat, reason);
  }

  _closeWterm(seat, { event, data }) {
    const set = this._wterm.get(seat);
    this._wterm.delete(seat);
    if (!set) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) { try { res.write(frame); res.end(); } catch {} }
    this._notifyWtermStreams();
  }

  // Which seats a remote party is WATCHING right now. Reported from the one
  // place that knows — the Map — rather than inferred from opens and closes at
  // the call sites, because the ways a stream ends are not all call sites: a
  // socket dropped by the tunnel and a res.destroy() from the 4MB backpressure
  // rule both arrive as `req.on('close')` and neither passes through an
  // explicit close. An indicator built from counted opens would leak one every
  // time either happens, and an indicator that over-reports a live shell is
  // worse than none — it teaches the operator to ignore it.
  //
  // Errors are swallowed: this is a UI signal, and a renderer fault must not
  // take down a request path on the wire.
  _notifyWtermStreams() {
    if (!this._onWtermStreams) return;
    const seats = [];
    for (const [seat, set] of this._wterm) if (set.size > 0) seats.push(seat);
    try { this._onWtermStreams(seats); } catch {}
  }

  // Is anyone watching this seat? The same question `_notifyWtermStreams`
  // answers for the UI, asked by the input routes so that what the operator is
  // shown and what a peer is allowed to do cannot drift apart: one Map, one
  // membership test, and `_notifyWtermStreams` filters on `size` too — a seat
  // this refuses must not be a seat the sidebar marks. No path leaves an empty
  // set in the Map today (the drop handler deletes the key as it empties), so
  // the size test is belt-and-braces; a path that ever did would otherwise
  // grant input to a seat with no watcher.
  _wtermAttached(seat) {
    const set = this._wterm.get(seat);
    return !!(set && set.size > 0);
  }

  pushTelemetry(name, tele) {
    const set = this._attach.get(name);
    if (!set || set.size === 0) return;
    const frame = `event: telemetry\ndata: ${JSON.stringify(tele)}\n\n`;
    for (const res of set) {
      try { res.write(frame); } catch {}
    }
  }

  // Carries a small trigger {kind, args}, never rendered content: the viewer maps
  // kind to its own render and pulls content back through the query RPC.
  pushUiEvent(name, kind, args) {
    if (!kind || typeof kind !== 'string') return;
    const set = this._attach.get(name);
    if (!set || set.size === 0) return;
    const frame = `event: ui\ndata: ${JSON.stringify({ kind, args: args || {} })}\n\n`;
    for (const res of set) { try { res.write(frame); } catch {} }
  }

  // Owner geometry is canonical. No feedback loop only because viewers push
  // geometry on an explicit fit, never on an applied resize.
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

  _webHost() {
    if (!this._getWebInfo) return null;
    let info;
    try { info = this._getWebInfo(); } catch { return null; }
    if (!info || !Number.isInteger(info.port) || info.port <= 0 || info.port > 65535) return null;
    return { port: info.port, tokenGated: info.tokenGated === true };
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
      if (this._wtermOpen) caps.push('shell'); // peer terminal — present only while a peer holds the grant
      return this._json(res, 200, {
        ok: true, app: 'clodex', host: this._hostLabel,
        version: this._version, caps,
        platform: process.platform,
        srcDir: this._srcDir,
        dmOrigins: this._listDmOrigins ? this._listDmOrigins() : [],
        // `tokenGated` says a token is REQUIRED, never what it is. The token itself is
        // deliberately NOT advertised: hello is open on the loopback-no-token deployment.
        webHost: this._webHost(),
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
      if (info.telemetry && (info.telemetry.proxy || info.telemetry.ctx)) {
        try { res.write(`event: telemetry\ndata: ${JSON.stringify(info.telemetry)}\n\n`); } catch {}
      }
      let set = this._attach.get(name);
      if (!set) { set = new Set(); this._attach.set(name, set); }
      set.add(res);
      this._clients.delete(res);   // attach feeds are per-session, not the global events feed
      req.on('close', () => {
        set.delete(res);
        if (set.size === 0) { this._attach.delete(name); this._setControl(name, null); }
      });
      return;
    }
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
    // ---- Peer terminal (t219) ----
    // A shell on THIS box, driven from a peer. Everything below exists only
    // while remote-wiring passed the callbacks, so a box whose operator never
    // granted it answers 501 and never advertised `shell` in the first place.
    //
    // The seat is the BARE session name: the consumer keys its peer sessions
    // `name@peerId` and splits before it builds the URL, so the `@` never
    // arrives here. NAME_RE is the same grammar the local seat resolver uses,
    // which is what makes a valid wire seat a valid local one.
    if (req.method === 'GET' && p.startsWith('/api/wterm/')) {
      if (!this._wtermOpen) return this._json(res, 501, { ok: false, error: 'terminal sharing is not enabled on this box' });
      const seat = decodeURIComponent(p.slice('/api/wterm/'.length));
      if (!NAME_RE.test(seat)) return this._json(res, 400, { ok: false, error: 'bad seat' });
      let info;
      // `attached` is read BEFORE this stream joins the set, and it is the half
      // of the announce decision that only the server knows: remote-wiring can
      // see that the PTY already existed, but not whether anyone was still
      // watching it. A reconnect after a genuine detach must still announce —
      // that is a new remote party — so "the shell was already running" alone
      // would silence a real event.
      const watched = this._wterm.get(seat);
      try { info = this._wtermOpen(seat, { attached: !!(watched && watched.size) }); }
      catch (e) { return this._json(res, 500, { ok: false, error: e.message }); }
      // A refusal that is a CONFIG BIT of this box answers 501, the same as an
      // absent callback above; only a genuinely missing seat is 404. The
      // consumer reads the status, not the body — it discards non-200 bodies —
      // so the status IS the refusal code, and "drawer services are off here"
      // arriving as 404 would tell the operator to go look for a session that
      // was never the problem.
      if (!info || !info.ok) {
        const config = !!(info && info.code === 'no-services');
        return this._json(res, config ? 501 : 404, info || { ok: false, error: 'no terminal for that seat' });
      }
      this._sseRaw(req, res);
      let set = this._wterm.get(seat);
      if (!set) { set = new Set(); this._wterm.set(seat, set); }
      set.add(res);
      this._notifyWtermStreams();
      req.on('close', () => {
        const cur = this._wterm.get(seat);
        if (!cur) return;
        cur.delete(res);
        if (cur.size === 0) this._wterm.delete(seat);
        this._notifyWtermStreams();
      });
      const hello = {
        b64: (info.scrollback || Buffer.alloc(0)).toString('base64'),
        cols: info.cols || 80, rows: info.rows || 24,
      };
      try { res.write(`event: replay\ndata: ${JSON.stringify(hello)}\n\n`); } catch {}
      return undefined;
    }
    if (req.method === 'POST' && p.startsWith('/api/wterm-input/')) {
      if (!this._wtermInput) return this._json(res, 501, { ok: false, error: 'terminal sharing is not enabled on this box' });
      const seat = decodeURIComponent(p.slice('/api/wterm-input/'.length));
      if (!NAME_RE.test(seat)) return this._json(res, 400, { ok: false, error: 'bad seat' });
      return this._readBody(req, res, (body) => {
        // Re-read the handler HERE, not above. `_readBody` calls back from
        // `req.on('end')`, which runs outside `_route`'s try/catch, and main.js
        // rethrows an uncaughtException — so calling a handler that revocation
        // nulled while the body was in flight crashes the whole app, and a
        // caller who dribbles bytes chooses how long that window stays open.
        // Capturing the callback before `_readBody` would close the crash and
        // reopen the revocation hole: the shell would keep taking keystrokes
        // after the grant was withdrawn. Both ends must be checked, at the
        // moment of use.
        if (!this._wtermInput) return this._json(res, 501, { ok: false, error: 'terminal sharing is not enabled on this box' });
        // An open stream is a PRECONDITION of remote input, not a decoration
        // beside it. `_wterm` is the same Map `_notifyWtermStreams` reports
        // from, so refusing here is what makes the sidebar's mark mean "a peer
        // can type into this seat" rather than "a peer is looking at it".
        // Without the check a caller that never opened `/api/wterm/:seat`
        // reaches the shell anyway: the Map is untouched so no report fires,
        // and the announce lives in the open path so it never runs. Re-read at
        // the moment of use for the same reason as the callback above — the
        // last stream can go away while the body is still arriving.
        if (!this._wtermAttached(seat)) return this._json(res, 409, { ok: false, error: 'no open terminal stream for that seat' });
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        // Keystrokes pass through as OPAQUE BYTES and are deliberately not vetted
        // here: this is a terminal, and a person typing `^C` means it. What IS
        // vetted, on both ends, is geometry and the seat.
        const out = this._wtermInput(seat, String(msg.data || ''));
        return this._json(res, out && out.ok ? 200 : 404, out || { ok: false });
      });
    }
    if (req.method === 'POST' && p.startsWith('/api/wterm-resize/')) {
      if (!this._wtermResize) return this._json(res, 501, { ok: false, error: 'terminal sharing is not enabled on this box' });
      const seat = decodeURIComponent(p.slice('/api/wterm-resize/'.length));
      if (!NAME_RE.test(seat)) return this._json(res, 400, { ok: false, error: 'bad seat' });
      return this._readBody(req, res, (body) => {
        // Same deferral, same re-read, same attachment precondition — see
        // wterm-input above. Geometry is not a keystroke, but a resize reaches
        // the operator's own shell and moves what is on their screen, so it is
        // remote input by every measure that matters here.
        if (!this._wtermResize) return this._json(res, 501, { ok: false, error: 'terminal sharing is not enabled on this box' });
        if (!this._wtermAttached(seat)) return this._json(res, 409, { ok: false, error: 'no open terminal stream for that seat' });
        let msg;
        try { msg = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: 'bad JSON' }); }
        const cols = parseInt(msg.cols, 10), rows = parseInt(msg.rows, 10);
        if (!(cols >= 20 && cols <= 500 && rows >= 5 && rows <= 300)) {
          return this._json(res, 400, { ok: false, error: 'bad dimensions' });
        }
        const out = this._wtermResize(seat, cols, rows);
        return this._json(res, out && out.ok ? 200 : 404, out || { ok: false });
      });
    }
    if (req.method === 'POST' && p.startsWith('/api/wterm-close/')) {
      if (!this._wtermClose) return this._json(res, 501, { ok: false, error: 'terminal sharing is not enabled on this box' });
      const seat = decodeURIComponent(p.slice('/api/wterm-close/'.length));
      if (!NAME_RE.test(seat)) return this._json(res, 400, { ok: false, error: 'bad seat' });
      // Detach, never kill: the shell belongs to the operator of THIS box and
      // their own tab is showing it. A remote party closing its view must not
      // take the local operator's terminal with it.
      this.dropWterm(seat, 'detached');
      let out;
      try { out = this._wtermClose(seat); } catch (e) { return this._json(res, 500, { ok: false, error: e.message }); }
      return this._json(res, 200, out || { ok: true });
    }
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
    // Bare {name,type,cwd} stays valid (compat); the whole parsed body is forwarded
    // unvalidated so the owner maps it and drops what never crosses.
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
    if (req.method === 'GET' && p === '/api/catalogs') {
      if (!this._getCatalogs) return this._json(res, 501, { ok: false, error: 'catalogs not available' });
      return Promise.resolve()
        .then(() => this._getCatalogs())
        .then((cat) => this._json(res, 200, { ok: true, catalogs: cat || {} }))
        .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
    }
    if (req.method === 'POST' && p.startsWith('/api/kill/')) {
      if (!this._killSession) return this._json(res, 501, { ok: false, error: 'kill not available' });
      const name = decodeURIComponent(p.slice('/api/kill/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return Promise.resolve()
        .then(() => this._killSession(name))
        .then((out) => this._json(res, out && out.ok ? 200 : 404, out || { ok: false, error: 'kill failed' }))
        .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
    }
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
    if (req.method === 'GET' && p.startsWith('/api/session-args/')) {
      if (!this._getSessionArgs) return this._json(res, 501, { ok: false, error: 'args not available' });
      const name = decodeURIComponent(p.slice('/api/session-args/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return Promise.resolve()
        .then(() => this._getSessionArgs(name))
        .then((out) => this._json(res, out && out.ok ? 200 : 404, out || { ok: false, error: 'not found' }))
        .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
    }
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
    // Resolved box-side: inject-skills materialize at spawn on the box, so the roster
    // and skill library must be the box's, not the viewer's.
    if (req.method === 'GET' && p.startsWith('/api/skill-catalog/')) {
      if (!this._getSkillCatalog) return this._json(res, 501, { ok: false, error: 'skills not available' });
      const name = decodeURIComponent(p.slice('/api/skill-catalog/'.length));
      if (!NAME_RE.test(name)) return this._json(res, 400, { ok: false, error: 'bad session name' });
      return Promise.resolve()
        .then(() => this._getSkillCatalog(name))
        .then((out) => this._json(res, out && out.ok ? 200 : 404, out || { ok: false, error: 'not found' }))
        .catch((e) => this._json(res, 500, { ok: false, error: e.message }));
    }
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
    // `via` is the calling hub's own label — HTTP does not self-identify the caller.
    // Full replacement of the spoke's via-table, not a delta.
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

  // SSE headers WITHOUT joining the global events feed. Split out so a
  // per-stream feed (the peer terminal) does not have to add itself to
  // `_clients` and immediately remove itself again, which is what the attach
  // path does and is easy to forget: a stream left in `_clients` receives every
  // global broadcast as if it were an events subscriber.
  _sseRaw(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
  }

  _sse(req, res) {
    this._sseRaw(req, res);
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
