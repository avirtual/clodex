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

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const MAX_BODY = 64 * 1024;          // matches the IPC message cap
const SSE_HEARTBEAT_MS = 25000;
// An attach stream whose socket can't drain this much is a dead/half-open
// tunnel; kill it and let the client reconnect + replay.
const ATTACH_MAX_BUFFERED = 4 * 1024 * 1024;

class RemoteServer {
  constructor({ port, pagePath, getSessions, getTranscript, send, restartApp,
                hostLabel, version, getAttachInfo, sendInput, resizePty, onControlChange,
                query }) {
    this._port = port;
    this._pagePath = pagePath;
    this._getSessions = getSessions;
    this._getTranscript = getTranscript;
    this._send = send;
    this._restartApp = restartApp || null;
    // Peer-attach surface (all optional: absent callbacks 501 their endpoints)
    this._hostLabel = hostLabel || 'clodex';
    this._version = version || '';
    this._getAttachInfo = getAttachInfo || null;
    this._sendInput = sendInput || null;
    this._resizePty = resizePty || null;
    this._onControlChange = onControlChange || null;
    // Generic pull-on-demand data source for the viewer's popovers (ctx/cost/
    // bust/files/file peek). One endpoint, kind-dispatched — popups are
    // open-time snapshots, so they need a query RPC, not a stream.
    this._query = query || null;
    this._server = null;
    this._clients = new Set();       // live SSE responses (events feed)
    this._attach = new Map();        // name -> Set of SSE responses (attach feeds)
    this._control = new Map();       // name -> { token, client } single holder
    this._activity = new Map();      // name -> 'thinking' | 'idle'
    this._heartbeat = null;
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
      server.listen(this._port, '127.0.0.1', () => {
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

  _route(req, res) {
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
      return this._json(res, 200, {
        ok: true, app: 'clodex', host: this._hostLabel,
        version: this._version, caps,
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
