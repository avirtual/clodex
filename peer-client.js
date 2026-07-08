// Peer client — the consuming side of the Clodex peering protocol. Connects
// to another Clodex's remote server (remote.js) over a loopback URL (the
// remote end is reached via an SSH tunnel / tailnet, same stance as the
// phone UI) and exposes its sessions for attach/control.
//
// All protocol, reconnect, and buffering logic lives HERE in the main
// process — the renderer stays a thin adapter (subscribe/output/input/
// resize/status) by design. Peers being unreachable is the NORMAL state
// (laptops sleep): offline is a calm status, never an error path.
//
// Fan-out to the UI goes through a single injected `emit(channel, ...args)`
// callback so this module stays Electron-agnostic (and testable).

'use strict';

const http = require('http');
const { URL } = require('url');

const HELLO_INTERVAL_MS = 15000;      // offline poll cadence
const RECONNECT_MIN_MS = 1000;        // attach/events stream backoff
const RECONNECT_MAX_MS = 20000;
const REQUEST_TIMEOUT_MS = 5000;
// Popover queries can hit disk-heavy owner-side scans (wirescope /_report
// reads the whole session capture) — give them their own, longer budget.
const QUERY_TIMEOUT_MS = 20000;

class PeerConnection {
  constructor({ id, label, url, emit }) {
    this.id = id;
    this.label = label;
    this.url = url.replace(/\/+$/, '');
    this._emit = emit;
    this._agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
    this.online = false;
    this.hello = null;                // { host, version, caps }
    this.sessions = [];               // last fetched session list
    this._helloTimer = null;
    this._eventsReq = null;
    this._eventsBackoff = RECONNECT_MIN_MS;
    this._attachments = new Map();    // name -> { req, token, wanted, backoff, timer }
    this._stopped = false;
  }

  start() {
    this._stopped = false;
    this._helloLoop();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._helloTimer);
    if (this._eventsReq) { try { this._eventsReq.destroy(); } catch {} this._eventsReq = null; }
    for (const name of [...this._attachments.keys()]) this.detach(name);
    this._agent.destroy();
    this._setOnline(false);
  }

  status() {
    return {
      id: this.id, label: this.label, url: this.url,
      online: this.online,
      host: this.hello ? this.hello.host : null,
      version: this.hello ? this.hello.version : null,
      caps: this.hello ? this.hello.caps : [],
      sessions: this.sessions,
    };
  }

  // ---- liveness ----

  _helloLoop() {
    if (this._stopped) return;
    this._request('GET', '/api/peer/hello', null, (err, body) => {
      if (this._stopped) return;
      if (!err && body && body.ok && body.app === 'clodex') {
        const wasOffline = !this.online;
        this.hello = { host: body.host, version: body.version, caps: body.caps || [] };
        this._setOnline(true);
        if (wasOffline) {
          this._refreshSessions();
          this._openEvents();
          // Attachments the UI still wants get re-established on wake.
          for (const [name, att] of this._attachments) {
            if (att.wanted && !att.req) this._openAttach(name, att);
          }
        }
      } else {
        this._setOnline(false);
      }
      this._helloTimer = setTimeout(() => this._helloLoop(), HELLO_INTERVAL_MS);
    });
  }

  _setOnline(v) {
    if (this.online === v) return;
    this.online = v;
    if (!v) {
      this.sessions = [];
      if (this._eventsReq) { try { this._eventsReq.destroy(); } catch {} this._eventsReq = null; }
    }
    this._emit('peer-state', this.id, this.status());
  }

  _refreshSessions() {
    this._request('GET', '/api/sessions', null, (err, body) => {
      if (err || !body || !body.ok) return;
      this.sessions = body.sessions || [];
      this._emit('peer-state', this.id, this.status());
    });
  }

  // Global events feed: sessions come/go, activity flips.
  _openEvents() {
    if (this._stopped || this._eventsReq) return;
    this._sse('/api/events', {
      onEvent: (event, data) => {
        if (event === 'sessions') this._refreshSessions();
        else if (event === 'activity' && data && data.name) {
          const s = this.sessions.find((x) => x.name === data.name);
          if (s) s.activity = data.state;
          this._emit('peer-activity', this.id, data.name, data.state);
        }
      },
      onOpen: (req) => { this._eventsReq = req; this._eventsBackoff = RECONNECT_MIN_MS; },
      onClose: () => {
        this._eventsReq = null;
        if (this._stopped || !this.online) return;
        const delay = this._eventsBackoff;
        this._eventsBackoff = Math.min(this._eventsBackoff * 2, RECONNECT_MAX_MS);
        setTimeout(() => this._openEvents(), delay);
      },
    });
  }

  // ---- attach / control ----

  attach(name) {
    let att = this._attachments.get(name);
    if (att && att.wanted) return { ok: true };
    if (!att) { att = { req: null, token: null, wanted: true, backoff: RECONNECT_MIN_MS, timer: null }; this._attachments.set(name, att); }
    att.wanted = true;
    if (this.online) this._openAttach(name, att);
    return { ok: true };
  }

  detach(name) {
    const att = this._attachments.get(name);
    if (!att) return { ok: true };
    att.wanted = false;
    clearTimeout(att.timer);
    if (att.token) this._request('POST', `/api/control/${encodeURIComponent(name)}`, { action: 'release', token: att.token }, () => {});
    att.token = null;
    if (att.req) { try { att.req.destroy(); } catch {} att.req = null; }
    this._attachments.delete(name);
    return { ok: true };
  }

  _openAttach(name, att) {
    // opening guards the window between request start and onOpen — the
    // hello-loop wake path and the backoff timer can both land here.
    if (att.req || att.opening || !att.wanted || this._stopped) return;
    att.opening = true;
    this._sse(`/api/attach/${encodeURIComponent(name)}`, {
      onEvent: (event, data) => {
        if (event === 'replay') {
          // Fresh replay = fresh terminal: the renderer resets before
          // applying (raw-byte history is not exact terminal state).
          this._emit('peer-replay', this.id, name, {
            data: Buffer.from(data.b64 || '', 'base64'),
            cols: data.cols, rows: data.rows, holder: data.holder || null,
          });
        } else if (event === 'output') {
          this._emit('peer-data', this.id, name, Buffer.from(data.b64 || '', 'base64'));
        } else if (event === 'telemetry') {
          // Owner's status-bar view (partial: {proxy} and/or {ctx}); the
          // renderer merges it into its normal per-session telemetry state.
          this._emit('peer-telemetry', this.id, name, data);
        } else if (event === 'control') {
          // Server-side control moved (or auto-released); if it wasn't us,
          // drop our token.
          if (!data.holder || data.holder !== this.clientLabel()) att.token = null;
          this._emit('peer-control', this.id, name, data.holder || null);
        } else if (event === 'exit') {
          att.wanted = false;
          this._emit('peer-exit', this.id, name, data.exitCode);
        }
      },
      onOpen: (req) => { att.opening = false; att.req = req; att.backoff = RECONNECT_MIN_MS; },
      onClose: () => {
        att.opening = false;
        att.req = null;
        att.token = null;          // control died with the stream
        if (!att.wanted || this._stopped) return;
        this._emit('peer-control', this.id, name, null);
        const delay = att.backoff;
        att.backoff = Math.min(att.backoff * 2, RECONNECT_MAX_MS);
        att.timer = setTimeout(() => { if (this.online) this._openAttach(name, att); }, delay);
      },
    });
  }

  clientLabel() { return `peer:${this.label}`; }

  control(name, on, cb) {
    const att = this._attachments.get(name);
    if (!att) return cb({ ok: false, error: 'not attached' });
    if (on) {
      this._request('POST', `/api/control/${encodeURIComponent(name)}`, { action: 'acquire', client: this.clientLabel() }, (err, body) => {
        if (err || !body || !body.ok) return cb({ ok: false, error: err ? err.message : (body && body.error) || 'acquire failed' });
        att.token = body.token;
        cb({ ok: true });
      });
    } else {
      const token = att.token;
      att.token = null;
      if (!token) return cb({ ok: true });
      this._request('POST', `/api/control/${encodeURIComponent(name)}`, { action: 'release', token }, () => cb({ ok: true }));
    }
  }

  input(name, data, cb) {
    const att = this._attachments.get(name);
    if (!att || !att.token) return cb({ ok: false, error: 'not in control' });
    this._request('POST', `/api/input/${encodeURIComponent(name)}`, { token: att.token, data }, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false });
    });
  }

  // Pull-on-demand popover data (ctx/cost/bust/files/file peek) — the owner
  // answers from the same code path its own popups use. Deliberately not
  // tied to an attachment: reads ride the host-level trust boundary, same
  // as the transcript.
  query(name, kind, args, cb) {
    this._request('POST', `/api/query/${encodeURIComponent(name)}`, { kind, args: args || {} }, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false, error: 'query failed' });
    }, QUERY_TIMEOUT_MS);
  }

  resize(name, cols, rows, cb) {
    const att = this._attachments.get(name);
    if (!att || !att.token) return cb({ ok: false, error: 'not in control' });
    this._request('POST', `/api/resize/${encodeURIComponent(name)}`, { token: att.token, cols, rows }, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false });
    });
  }

  // ---- plumbing ----

  _request(method, path, payload, cb, timeout = REQUEST_TIMEOUT_MS) {
    let u;
    try { u = new URL(this.url + path); } catch (e) { return cb(e); }
    const body = payload ? JSON.stringify(payload) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port || 80,
      path: u.pathname + u.search, method,
      agent: this._agent, timeout,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; if (buf.length > 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        try { cb(null, JSON.parse(buf)); }
        catch { cb(new Error('bad response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => cb(e));
    if (body) req.write(body);
    req.end();
  }

  _sse(path, { onEvent, onOpen, onClose }) {
    let u;
    try { u = new URL(this.url + path); } catch { return onClose(); }
    const req = http.request({
      hostname: u.hostname, port: u.port || 80,
      path: u.pathname + u.search, method: 'GET',
      agent: this._agent,
      headers: { Accept: 'text/event-stream' },
    }, (res) => {
      if (res.statusCode !== 200) { req.destroy(); return; }
      onOpen(req);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        // SSE frames are \n\n-separated; heartbeats are comment lines.
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (buf.length > 8 * 1024 * 1024) { req.destroy(); return; }
          let event = 'message', data = null;
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7).trim();
            else if (line.startsWith('data: ')) {
              try { data = JSON.parse(line.slice(6)); } catch { data = null; }
            }
          }
          if (data !== null) { try { onEvent(event, data); } catch {} }
        }
      });
      res.on('end', () => onClose());
      res.on('error', () => onClose());
    });
    req.on('error', () => onClose());
    req.end();
  }
}

// Owns one PeerConnection per configured peer; reconciled from settings.
class PeerManager {
  constructor({ emit }) {
    this._emit = emit;
    this._peers = new Map();          // id -> PeerConnection
  }

  // peers: [{ id, label, url }] from ui-settings. Reconcile: keep matching,
  // drop removed, start added. URL/label change = restart that peer.
  sync(peers) {
    const wanted = new Map();
    for (const p of Array.isArray(peers) ? peers : []) {
      if (!p || !p.id || !p.url) continue;
      wanted.set(String(p.id), { id: String(p.id), label: String(p.label || p.id), url: String(p.url) });
    }
    for (const [id, conn] of this._peers) {
      const w = wanted.get(id);
      if (!w || w.url !== conn.url || w.label !== conn.label) {
        conn.stop();
        this._peers.delete(id);
        // Announce the drop even on a URL/label edit — attachments died
        // with the old connection, so the UI must shed its tabs; the new
        // connection re-announces via peer-state.
        this._emit('peer-removed', id);
      }
    }
    for (const [id, w] of wanted) {
      if (!this._peers.has(id)) {
        const conn = new PeerConnection({ ...w, emit: this._emit });
        this._peers.set(id, conn);
        conn.start();
      }
    }
  }

  stopAll() {
    for (const conn of this._peers.values()) conn.stop();
    this._peers.clear();
  }

  statuses() { return [...this._peers.values()].map((c) => c.status()); }

  get(id) { return this._peers.get(String(id)) || null; }
}

module.exports = { PeerManager, PeerConnection };
