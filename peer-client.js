
'use strict';

const http = require('http');
const { URL } = require('url');
const { RELAY_ENVELOPE_V } = require('./relay-protocol');
const { withoutExecGrants } = require('./session-args');
const { makeWatchdog, STALE_MS } = require('./cli/src/sse-guard');
const { makeSseDecoder, MAX_BUFFER_BYTES } = require('./cli/src/sse-frame');

const HELLO_INTERVAL_MS = 15000;      // offline poll cadence
const RECONNECT_MIN_MS = 1000;        // attach/events stream backoff
const RECONNECT_MAX_MS = 20000;
// Backoff resets only after a stream has LIVED this long past the staleness
// deadline — not on a 200. A producer that overflows or closes at byte zero
// still reaches 200, and resetting on open pinned it at the 1s floor forever.
// The bar must stay >= _staleMs: the watchdog pets on every chunk (including
// heartbeat comments), so outliving it entails having carried bytes. Do NOT
// tighten this to "decoded a well-formed event" — an idle-but-healthy peer
// emits only heartbeats and would be pushed into permanent backoff.
const STABLE_MARGIN_MS = 1000;
const REQUEST_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 20000;
const OVERFLOW_LOG_INTERVAL_MS = 60000;

// Comparable identity for the hello's webHost field, so identityChanged can
// treat "appeared", "vanished" and "moved to another port" alike. null and a
// live host must never compare equal, hence the explicit sentinel rather than
// optional-chaining into undefined.
function webHostKey(w) {
  return w ? `${w.port}:${w.tokenGated ? 1 : 0}` : '';
}

class PeerConnection {
  constructor({ id, label, url, token, emit, selfLabel, helloIntervalMs, computeRoster, staleMs, timers, sseMaxBufferBytes }) {
    this.id = id;
    this.label = label;
    this.url = url.replace(/\/+$/, '');
    // Operator auth token for a tokened remote wire (remote-auth-plan.md [internal design doc, not in this repo] §4).
    // Presented as `Authorization: Bearer <token>` on every request + SSE stream;
    // null = no header (loopback / untokened peer, unchanged). A token change is a
    // peer restart (PeerManager.sync), so it's fixed for a connection's lifetime.
    this._token = (typeof token === 'string' && token) ? token : null;
    this._emit = emit;
    this._computeRoster = computeRoster || null;
    this._helloIntervalMs = helloIntervalMs || HELLO_INTERVAL_MS;
    this._staleMs = Number.isInteger(staleMs) ? staleMs : STALE_MS;
    this._timers = timers || { setTimeout, clearTimeout };
    // Unframed-residue ceiling, same seam and same reason as staleMs above:
    // overridable ONLY so a test can trip it with kilobytes instead of moving a
    // megabyte per assertion. Production takes sse-frame's MAX_BUFFER_BYTES.
    this._sseMaxBufferBytes = Number.isInteger(sseMaxBufferBytes) ? sseMaxBufferBytes : MAX_BUFFER_BYTES;
    this._selfLabel = selfLabel || null;
// Two deliberately-separate socket pools; do not merge. SSE streams never end
// while live, so sharing one pool lets a few attaches pin every socket and
// starve request traffic (hello/control/input/resize/query) — control acquires
// then queue inside the agent and land minutes late. Streams get their own
// uncapped, un-pooled agent.
    this._reqAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
    this._sseAgent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
    this.online = false;
    this.hello = null;                // { host, version, caps, platform, srcDir }
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
    // Destroy both pools. The SSE agent's .destroy() also reaps any stream
    // whose request was still mid-open (req not yet captured for a per-req
    // destroy), keeping teardown airtight.
    this._reqAgent.destroy();
    this._sseAgent.destroy();
    this._setOnline(false);
  }

  status() {
    return {
      id: this.id, label: this.label, url: this.url,
      online: this.online,
      host: this.hello ? this.hello.host : null,
      version: this.hello ? this.hello.version : null,
      caps: this.hello ? this.hello.caps : [],
      platform: this.hello ? this.hello.platform : null,
      srcDir: this.hello ? this.hello.srcDir : null,
      webHost: this.hello ? this.hello.webHost : null,
      sessions: this.sessions,
    };
  }


  _helloLoop() {
    if (this._stopped) return;
    this._request('GET', '/api/peer/hello', null, (err, body) => {
      if (this._stopped) return;
      if (!err && body && body.ok && body.app === 'clodex') {
        const wasOffline = !this.online;
        const prev = this.hello;
        const wh = body.webHost;
        const webHost = (wh && Number.isInteger(wh.port) && wh.port > 0 && wh.port <= 65535)
          ? { port: wh.port, tokenGated: wh.tokenGated === true }
          : null;
        const next = { host: body.host, version: body.version, caps: body.caps || [], platform: body.platform || null, srcDir: body.srcDir || null, webHost };
// Edge-triggered identity check: an in-place Update restarts the box faster
// than the hello cadence can observe an offline dip, so _setOnline sees no
// transition and never emits — leaving a stale version in the renderer.
        const identityChanged = !prev ||
          prev.version !== next.version ||
          prev.platform !== next.platform ||
          prev.srcDir !== next.srcDir ||
          webHostKey(prev.webHost) !== webHostKey(next.webHost) ||
          (prev.caps || []).join(',') !== (next.caps || []).join(',');
        this.hello = next;
        this._setOnline(true);
        if (wasOffline) {
          this._refreshSessions();
          this._openEvents();
          for (const [name, att] of this._attachments) {
            if (att.wanted && !att.req) this._openAttach(name, att);
          }
        } else if (identityChanged) {
          // Stayed online but the identity moved — force the peer-state emission
          // _setOnline would have made on a transition. Guarded by the else so we
          // never double-emit when wasOffline already fired one.
          this._emit('peer-state', this.id, this.status());
        }
        if (this._selfLabel && Array.isArray(body.dmOrigins) && body.dmOrigins.includes(this._selfLabel)) {
          this._claimAndEmit();
        }
// Only push when the spoke advertised the 'relay' cap — else it 501s.
        if (this._computeRoster && Array.isArray(next.caps) && next.caps.includes('relay')) {
          let roster = null;
          try { roster = this._computeRoster(this.id); } catch { roster = null; }
          if (Array.isArray(roster)) this.pushRoster(roster);
        }
      } else {
        this._setOnline(false);
      }
      this._helloTimer = setTimeout(() => this._helloLoop(), this._helloIntervalMs);
    });
  }

// Both the hello-tick path and the SSE doorbell can fire for the same mail:
// the whole-dir rename-claim is atomic, so the loser emits nothing.
  _claimAndEmit() {
    this.claimDms((resp) => {
      if (resp && resp.ok && Array.isArray(resp.messages) && resp.messages.length) {
        this._emit('peer-dms', this.id, resp.messages);
      }
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

  _openEvents() {
    if (this._stopped || this._eventsReq) return;
    this._sse('/api/events', {
      onEvent: (event, data) => {
        if (event === 'sessions') this._refreshSessions();
        else if (event === 'activity' && data && data.name) {
          const s = this.sessions.find((x) => x.name === data.name);
          if (s) s.activity = data.state;
          this._emit('peer-activity', this.id, data.name, data.state);
        } else if (event === 'dm-mail' && data && data.origin === this._selfLabel) {
          this._claimAndEmit();
        }
      },
      onOpen: (req) => {
        this._eventsReq = req;
// Resync unconditionally: SSE has no replay, so any 'sessions' events emitted
// while disconnected are lost. A compose recreate severs this feed faster than
// the hello cadence sees an offline dip, so neither the wasOffline nor the
// identityChanged trigger fires. Backoff reset lives in onStable, not here.
        this._refreshSessions();
      },
      onStable: () => { this._eventsBackoff = RECONNECT_MIN_MS; },
      onClose: () => {
        this._eventsReq = null;
        if (this._stopped || !this.online) return;
        const delay = this._eventsBackoff;
        this._eventsBackoff = Math.min(this._eventsBackoff * 2, RECONNECT_MAX_MS);
        setTimeout(() => this._openEvents(), delay);
      },
    });
  }


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
        } else if (event === 'resize') {
          // Owner PTY resized: mirror its geometry onto our letterbox so new
          // output stops wrapping into a stale box. Resize-in-place (no reset/
          // re-replay) — same as a local terminal resize; old scrollback won't
          // reflow but that's acceptable and avoids a clear/flash per fit.
          this._emit('peer-resize', this.id, name, { cols: data.cols, rows: data.rows });
        } else if (event === 'ui') {
          if (data && typeof data.kind === 'string') {
            this._emit('peer-ui', this.id, name, { kind: data.kind, args: data.args || {} });
          }
        } else if (event === 'telemetry') {
          this._emit('peer-telemetry', this.id, name, data);
        } else if (event === 'control') {
          if (!data.holder || data.holder !== this.clientLabel()) att.token = null;
          this._emit('peer-control', this.id, name, data.holder || null);
        } else if (event === 'exit') {
          att.wanted = false;
          this._emit('peer-exit', this.id, name, data.exitCode);
        }
      },
      onOpen: (req) => { att.opening = false; att.req = req; },
      onStable: () => { att.backoff = RECONNECT_MIN_MS; },
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

  restart(cb) {
    this._request('POST', '/api/restart', {}, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false });
    });
  }

// withoutExecGrants is the client-side mirror of the server backstop — exec
// grants must never ride the wire in either direction.
  createSession(spec, cb) {
    this._request('POST', '/api/sessions', withoutExecGrants(spec || {}), (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false });
    });
  }

  getCatalogs(cb) {
    this._request('GET', '/api/catalogs', null, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false, error: 'no response' });
    });
  }

  killSession(name, cb) {
    this._request('POST', `/api/kill/${encodeURIComponent(name)}`, {}, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false });
    });
  }

  restartSession(name, opts, cb) {
    this._request('POST', `/api/restart-session/${encodeURIComponent(name)}`, { fresh: !!(opts && opts.fresh) }, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false });
    });
  }

  sessionArgs(name, cb) {
    this._request('GET', `/api/session-args/${encodeURIComponent(name)}`, null, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false, error: 'no response' });
    });
  }

  setSessionArgs(name, patch, cb) {
    this._request('POST', `/api/session-args/${encodeURIComponent(name)}`, patch || {}, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false, error: 'no response' });
    });
  }

  skillCatalog(name, cb) {
    this._request('GET', `/api/skill-catalog/${encodeURIComponent(name)}`, null, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false, error: 'no response' });
    });
  }

  setSessionSkills(name, disabledSkills, injectSkills, cb) {
    this._request('POST', `/api/session-skills/${encodeURIComponent(name)}`, { disabledSkills, injectSkills }, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false, error: 'no response' });
    });
  }

// `origin` is OUR label (how the box keys its reply outbox for us); passed
// once from selfLabel, never recomputed.
  dm({ to, from, body, urgent }, cb) {
    this._request('POST', '/api/dm', { to, from, origin: this._selfLabel, body, urgent: !!urgent }, (err, resp) => {
      cb(err ? { ok: false, error: err.message } : resp || { ok: false, error: 'no response' });
    });
  }

  claimDms(cb) {
    this._request('POST', '/api/dm/claim', { origin: this._selfLabel }, (err, resp) => {
      cb(err ? { ok: false, error: err.message } : resp || { ok: false });
    });
  }

  pushRoster(roster, cb) {
    this._request('POST', '/api/peer/roster',
      { rv: RELAY_ENVELOPE_V, via: this._selfLabel, roster: Array.isArray(roster) ? roster : [] },
      (err, resp) => { if (cb) cb(err ? { ok: false, error: err.message } : resp || { ok: false }); });
  }


  _authHeaders() {
    return this._token ? { Authorization: `Bearer ${this._token}` } : {};
  }

// Rate-limited to once per minute per connection: an overflow that repeats is
// exactly the case where the cause has NOT passed, and a per-cycle line at the
// 1s reconnect floor would bury the log it is meant to inform.
  _reportSseOverflow(path, bytes) {
    const now = Date.now();
    if (this._lastOverflowLog && now - this._lastOverflowLog < OVERFLOW_LOG_INTERVAL_MS) return;
    this._lastOverflowLog = now;
    const mb = (bytes / (1024 * 1024)).toFixed(2);
    const limitMb = (this._sseMaxBufferBytes / (1024 * 1024)).toFixed(2);
    this._emit('ipc-message', {
      type: 'system', from: `peer:${this.label}`, to: `peer:${this.label}`,
      body: `SSE: ${path} sent ${mb}MB with no frame terminator (limit ${limitMb}MB) — stream dropped, reconnecting. The peer is sending malformed event-stream data.`,
    });
  }

  _request(method, path, payload, cb, timeout = REQUEST_TIMEOUT_MS) {
    let u;
    try { u = new URL(this.url + path); } catch (e) { return cb(e); }
    const body = payload ? JSON.stringify(payload) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port || 80,
      path: u.pathname + u.search, method,
      agent: this._reqAgent, timeout,
      headers: {
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...this._authHeaders(),
      },
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

// onClose is the ONE reconnect door: every death — server end, transport
// error, or the staleness watchdog — goes through it exactly once.
// A half-open socket emits no 'end' and no 'error', so the watchdog re-arms on
// every chunk (including heartbeat comments) as the only available evidence.
// On fire we destroy AND walk the close door; the destroy usually raises
// 'error' which reaches the door too — hence the one-shot guard below.
  _sse(path, { onEvent, onOpen, onClose, onStable }) {
    let u;
    try { u = new URL(this.url + path); } catch { return onClose(); }
// Fires onClose at most once: a watchdog destroy also raises a socket error,
// and two onCloses would schedule two reconnects — two live streams for one
// attachment. Also stops the timer so teardown leaves nothing armed.
    let closed = false;
    let watchdog = null;
    let stableTimer = null;
    const close = () => {
      if (closed) return;
      closed = true;
      if (watchdog) { watchdog.stop(); watchdog = null; }
      // Cleared on the SAME door as the watchdog, and for the same reason: a
      // stability timer outliving its stream would either reset the backoff for a
      // connection that is already dead, or keep the event loop alive after
      // teardown.
      if (stableTimer != null) { this._timers.clearTimeout(stableTimer); stableTimer = null; }
      onClose();
    };
    const req = http.request({
      hostname: u.hostname, port: u.port || 80,
      path: u.pathname + u.search, method: 'GET',
      agent: this._sseAgent,
      headers: { Accept: 'text/event-stream', ...this._authHeaders() },
    }, (res) => {
      if (res.statusCode !== 200) { req.destroy(); return; }
      onOpen(req);
      // Armed only once the stream is genuinely live (200 in hand). A request
      // that never gets a response is a CONNECT-time problem, not a half-open
      // one, and it has no onClose path here today — widening that is a
      // different fix.
      watchdog = makeWatchdog(this._staleMs, () => {
        try { req.destroy(); } catch {}
        close();
      }, this._timers);
      watchdog.pet();
      // Armed at the same moment as the watchdog and on the same injected timer
      // seam, so the two deadlines can never be measured against different
      // clocks — the ordering between them is what makes "lasted" mean "carried
      // bytes" (see STABLE_MARGIN_MS).
      if (onStable) {
        stableTimer = this._timers.setTimeout(() => {
          stableTimer = null;
          if (!closed) onStable();
        }, this._staleMs + STABLE_MARGIN_MS);
      }
      res.setEncoding('utf8');
      const decoder = makeSseDecoder({
// `data: null` parses fine but these consumers all dereference the payload;
// the CLI's (which render text) do not share this.
        onEvent: (event, data) => { if (data === null) return; try { onEvent(event, data); } catch {} },
        dropUnparsableData: true,
        maxBufferBytes: this._sseMaxBufferBytes,
// Destroy and let the ONE close door handle it, so this reconnects on the
// normal backoff. Reconnect rather than give up: the likely causes are
// transient, and giving up strands the session list stale while the peer
// still reads as online. The growing backoff bounds the cost.
        onOverflow: (bytes) => {
          this._reportSseOverflow(path, bytes);
          try { req.destroy(); } catch {}
        },
      });
      res.on('data', (chunk) => {
        // Re-arm FIRST, before any framing: a chunk carrying only heartbeat
        // comments yields no event but is exactly the liveness signal we need.
        if (watchdog) watchdog.pet();
        decoder.push(chunk);
      });
      res.on('end', close);
      res.on('error', close);
    });
    req.on('error', close);
    req.end();
  }
}

class PeerManager {
  constructor({ emit, selfLabel, computeRoster }) {
    this._emit = emit;
    this._selfLabel = selfLabel || null; // our origin on the wire (DM federation)
    this._computeRoster = computeRoster || null;
    this._peers = new Map();          // id -> PeerConnection
  }

  // peers: [{ id, label, url, token }] from ui-settings. Reconcile: keep matching,
  // drop removed, start added. URL/label/TOKEN change = restart that peer (the
  // Bearer header is fixed at construction, so a re-auth needs a fresh connection).
  sync(peers) {
    const wanted = new Map();
    for (const p of Array.isArray(peers) ? peers : []) {
      if (!p || !p.id || !p.url) continue;
      wanted.set(String(p.id), {
        id: String(p.id), label: String(p.label || p.id), url: String(p.url),
        token: (typeof p.token === 'string' && p.token) ? p.token : null,
      });
    }
    for (const [id, conn] of this._peers) {
      const w = wanted.get(id);
      if (!w || w.url !== conn.url || w.label !== conn.label || (w.token || null) !== (conn._token || null)) {
        conn.stop();
        this._peers.delete(id);
        // Announce the drop even on a URL/label/token edit — attachments died
        // with the old connection, so the UI must shed its tabs; the new
        // connection re-announces via peer-state.
        this._emit('peer-removed', id);
      }
    }
    for (const [id, w] of wanted) {
      if (!this._peers.has(id)) {
        const conn = new PeerConnection({ ...w, emit: this._emit, selfLabel: this._selfLabel, computeRoster: this._computeRoster });
        this._peers.set(id, conn);
        conn.start();
// _setOnline emits on TRANSITIONS, so a peer whose hello never succeeds would
// otherwise never emit at all — saved in settings yet invisible in the sidebar.
        this._emit('peer-state', id, conn.status());
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
