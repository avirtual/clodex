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
const { RELAY_ENVELOPE_V } = require('./relay-protocol');
const { withoutExecGrants } = require('./session-args');
// The staleness watchdog, imported from the CLI's SSE guard rather than
// reimplemented. That module's header names THIS file as the reason it exists
// ("the half-open-socket bug that bit the GUI's peer-client.js") — the tested
// answer was written on the other side and never came back. makeWatchdog is a
// pure timer leaf with an injectable seam, and STALE_MS carries the timing
// rationale (60s, >2x remote.js's 25s SSE_HEARTBEAT_MS), so importing it keeps
// ONE home for "how long is too long". Same leaf direction peer-tunnel.js:35 and
// web-tunnel.js:73 already take into cli/src/transport; cli/ never requires an
// app file, and cli/ ships in the DMG (build.files).
const { makeWatchdog, STALE_MS } = require('./cli/src/sse-guard');
// The SSE frame decoder, likewise imported rather than reimplemented (t47).
// This file and cli/src/client.js each hand-rolled the same `\n\n` framing,
// the same `: ping` skip and the same event:/data: read — and had SILENTLY
// DRIFTED (CRLF tolerance, space-less fields, multi-line data: all handled on
// the CLI side only). One decoder now. The unframed-residue bound is the
// decoder's own default since t48 — both heads take it, so it is not set here.
// Same leaf direction as sse-guard above.
const { makeSseDecoder, MAX_BUFFER_BYTES } = require('./cli/src/sse-frame');

const HELLO_INTERVAL_MS = 15000;      // offline poll cadence
const RECONNECT_MIN_MS = 1000;        // attach/events stream backoff
const RECONNECT_MAX_MS = 20000;
// How long an SSE stream must LIVE before its open counts as a good one and the
// reconnect backoff resets (t50). Not a tuning knob — a derived quantity, and
// the derivation is the whole argument:
//
//   A 200 costs the producer nothing to emit, so "we connected" is not evidence
//   the stream works. An overflowing producer reaches 200 first and dies inside
//   one pass; a producer that closes at byte zero reaches 200 too. Resetting on
//   open put both of those in a 1s-floor loop forever, moving up to a megabyte
//   per pass in the overflow case — bandwidth-bound, so it never announced
//   itself. What distinguishes those from a working stream is not WHAT arrived
//   but that the open LASTED.
//
//   The bar is the watchdog's deadline, not a number picked for feel. The
//   watchdog destroys any stream that goes _staleMs without a chunk, and
//   res.on('data') pets it on EVERY chunk — including remote.js's `: ping`
//   comments, which carry no event. So a stream that outlives _staleMs has
//   necessarily carried bytes: the watchdog would have killed it otherwise.
//   "Lasted" therefore entails "carried traffic" without a second check, and
//   any bar BELOW _staleMs would certify a half-open socket carrying nothing.
//
//   Deliberately NOT "decoded a well-formed event": an idle-but-healthy peer
//   emits only heartbeat comments for as long as nothing happens, and that test
//   would put a perfectly good quiet connection into permanent backoff.
//
// The margin exists only to break the tie with the watchdog on the same tick, so
// a watchdog kill always resolves as not-stable rather than racing the reset.
const STABLE_MARGIN_MS = 1000;
const REQUEST_TIMEOUT_MS = 5000;
// Popover queries can hit disk-heavy owner-side scans (wirescope /_report
// reads the whole session capture) — give them their own, longer budget.
const QUERY_TIMEOUT_MS = 20000;
// Floor between two SSE-overflow log lines on one connection (t48). See
// _reportSseOverflow: the repeating case is the one worth logging once, not
// once per reconnect cycle.
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
    // Hub-relay federation (we are the HUB for this connection). Injected callback
    // computeRoster(id) → the split-horizon'd, access-gated roster of agents on our
    // OTHER peers this spoke may reach (settings-aware, so it lives in peer-wiring,
    // not here). Called once per successful hello tick, but only when the spoke
    // advertised the 'relay' cap — so we never push to a box that can't act on it.
    this._computeRoster = computeRoster || null;
    // Poll cadence; overridable so tests can drive multiple hellos in-window
    // (production always uses the 15s default).
    this._helloIntervalMs = helloIntervalMs || HELLO_INTERVAL_MS;
    // SSE staleness bound and the timer seam the watchdog runs on. Both
    // overridable ONLY so tests can drive the deadline without real sleeps;
    // production takes STALE_MS and the global timers.
    this._staleMs = Number.isInteger(staleMs) ? staleMs : STALE_MS;
    this._timers = timers || { setTimeout, clearTimeout };
    // Unframed-residue ceiling, same seam and same reason as staleMs above:
    // overridable ONLY so a test can trip it with kilobytes instead of moving a
    // megabyte per assertion. Production takes sse-frame's MAX_BUFFER_BYTES.
    this._sseMaxBufferBytes = Number.isInteger(sseMaxBufferBytes) ? sseMaxBufferBytes : MAX_BUFFER_BYTES;
    // Our own label as the box will see it (the origin on outbound DMs and the
    // key we claim our inbox under). Computed once by the caller — never per
    // request — so it can't drift mid-session.
    this._selfLabel = selfLabel || null;
    // Two deliberately-separate socket pools. SSE streams (events + every
    // attach) never end while live, so pooling them alongside short requests
    // lets a few attached sessions pin every socket and starve the request
    // traffic that shares this origin (hello/control/input/resize/query). That
    // was the live-control bug: with one 4-socket pool, 4 attaches held all
    // sockets and control/input queued INSIDE the agent — keystrokes dropped,
    // and a momentary SSE reconnect freed a socket that let a stale queued
    // acquire through minutes late. So: short requests keep a small keep-alive
    // pool; streams get their own uncapped, un-pooled agent (a socket each,
    // closed on stream end) and never compete with requests.
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
      // {port, tokenGated} or null — the box's browser frontend (t30). Rides
      // status() so the renderer reads it from LIVE peer state on every
      // peer-state emit, never from a value cached when a popover opened.
      webHost: this.hello ? this.hello.webHost : null,
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
        const prev = this.hello;
        // webHost: {port, tokenGated} or null — the box's browser frontend, so
        // a consumer can tunnel to it rather than guessing wire-port+1 (t30).
        // Normalized here so one malformed field can't reach the renderer.
        const wh = body.webHost;
        const webHost = (wh && Number.isInteger(wh.port) && wh.port > 0 && wh.port <= 65535)
          ? { port: wh.port, tokenGated: wh.tokenGated === true }
          : null;
        const next = { host: body.host, version: body.version, caps: body.caps || [], platform: body.platform || null, srcDir: body.srcDir || null, webHost };
        // Did the box's reported identity move since the last hello? (caps
        // compared as a joined string.) An in-place Update restarts the box
        // faster than the 15s hello cadence can observe an offline dip, so
        // _setOnline never sees a transition and never emits — without this the
        // renderer's peerStatuses (and the ⓘ popover reading it) keep the stale
        // version forever.
        const identityChanged = !prev ||
          prev.version !== next.version ||
          prev.platform !== next.platform ||
          prev.srcDir !== next.srcDir ||
          // A web host appearing, vanishing or MOVING is an identity change: a
          // consumer forwarding to the old port would tunnel to nothing (or,
          // worse, to whatever took the port). Same-tick, not the 15s cadence.
          webHostKey(prev.webHost) !== webHostKey(next.webHost) ||
          (prev.caps || []).join(',') !== (next.caps || []).join(',');
        this.hello = next;
        this._setOnline(true);
        if (wasOffline) {
          this._refreshSessions();
          this._openEvents();
          // Attachments the UI still wants get re-established on wake.
          for (const [name, att] of this._attachments) {
            if (att.wanted && !att.req) this._openAttach(name, att);
          }
        } else if (identityChanged) {
          // Stayed online but the identity moved — force the peer-state emission
          // _setOnline would have made on a transition. Guarded by the else so we
          // never double-emit when wasOffline already fired one.
          this._emit('peer-state', this.id, this.status());
        }
        // DM federation: if the box says it has mail queued for us (our label in
        // dmOrigins), claim it now. Every tick, not just on wake — box→consumer
        // replies accrue between hellos, and the hello cadence IS the delivery
        // latency. Emits 'peer-dms' up to main for local delivery.
        if (this._selfLabel && Array.isArray(body.dmOrigins) && body.dmOrigins.includes(this._selfLabel)) {
          this._claimAndEmit();
        }
        // Hub-relay: push this spoke its relay roster, but only if it advertised the
        // 'relay' cap (else it 501s and can't cache it). Every hello tick is the
        // blessed cadence — the full-replacement push keeps the spoke's roster fresh
        // (its TTL-by-liveness expiry keys off this refresh), and a relayAllowed
        // toggle converges within one tick as computeRoster recomputes the gate.
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

  // Claim our outbox off the box and emit whatever came back. Shared by the
  // hello-tick path (box advertised our label in dmOrigins) and the dm-mail
  // doorbell (box pushed an SSE nudge). Both can fire for the same mail: the
  // whole-dir rename-claim is atomic, so the loser reads an empty snapshot and
  // emits nothing — no double-delivery.
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
        } else if (event === 'dm-mail' && data && data.origin === this._selfLabel) {
          // Doorbell: the box queued a reply for us. Claim immediately rather
          // than waiting the hello interval; racing hello-claims are safe (see
          // _claimAndEmit).
          this._claimAndEmit();
        }
      },
      onOpen: (req) => {
        this._eventsReq = req;
        // The backoff reset is NOT here — see onStable below and
        // STABLE_MARGIN_MS. Reaching this line means only that a 200 arrived.
        // An SSE (re)open is by definition recovery from a feed gap, and SSE has
        // no replay — any 'sessions' events the box emitted while we were
        // disconnected are lost. A compose recreate (Rebuild / in-place Update)
        // severs this feed faster than the 15s hello cadence sees an offline dip,
        // so neither the wasOffline nor identityChanged trigger fires; without a
        // resync here the host sidebar keeps a stale (often empty) session list
        // until the next organic change. Resync unconditionally — harmless
        // duplicate GET on the wasOffline path (it refreshed just before this).
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
        } else if (event === 'resize') {
          // Owner PTY resized: mirror its geometry onto our letterbox so new
          // output stops wrapping into a stale box. Resize-in-place (no reset/
          // re-replay) — same as a local terminal resize; old scrollback won't
          // reflow but that's acceptable and avoids a clear/flash per fit.
          this._emit('peer-resize', this.id, name, { cols: data.cols, rows: data.rows });
        } else if (event === 'ui') {
          // Owner surfaced a session-scoped component (e.g. a remote agent's
          // [agent:file view]): forward the small {kind, args} trigger so the
          // viewer renders its own copy. Content is NOT here — the viewer pulls
          // it via the query RPC. An unknown/malformed kind from a newer or
          // stale owner is passed through verbatim; the renderer's dispatch
          // ignores kinds it doesn't know.
          if (data && typeof data.kind === 'string') {
            this._emit('peer-ui', this.id, name, { kind: data.kind, args: data.args || {} });
          }
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
      // Same split as the events stream, and this side is the worse of the two:
      // there is one attach stream per attached session, so a malformed box put N
      // simultaneous cycles on the 1s floor, not one.
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

  // Host-level full relaunch of the peer's Clodex. Not tied to any attachment
  // or control token — restart rides the host trust boundary (tunnel = auth),
  // same as query/transcript. The owner acks BEFORE it quits, so a successful
  // reply means "restart accepted, going down now"; the peer then drops offline
  // and the normal reconnect/auto-reattach machinery brings it back.
  restart(cb) {
    this._request('POST', '/api/restart', {}, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false });
    });
  }

  // Host-level session lifecycle on the peer. Like restart/query, not tied to
  // an attachment or token — trust is the tunnel. The owner routes to its live
  // create()/kill() paths; the ack is the whole outcome (distinguishable errors).
  // The whole spec is forwarded as the POST body (M5 full-param create: name/
  // type/cwd plus the optional setArgs patch keys + create-only fields); a bare
  // {name,type,cwd} stays valid. withoutExecGrants is the CLIENT-side mirror of
  // the server backstop — exec grants must never ride the wire in either
  // direction, even if a future caller hands us a spec carrying them.
  createSession(spec, cb) {
    this._request('POST', '/api/sessions', withoutExecGrants(spec || {}), (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false });
    });
  }

  // Session-less catalogs for a pre-create New Session dialog targeting this box
  // (M5). GET /api/catalogs (rides the box's 'create'/'create2' cap); the owner
  // wraps as { ok:true, catalogs } — returned intact so the renderer reads
  // `.catalogs`. An old (non-create2) box 501s → { ok:false } here.
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

  // Restart a peer session in place. opts.fresh picks a new-conversation reload
  // (re-reads skills) over a plain --resume restart. The owner respawns the same
  // name, so an attached viewer's auto-reattach brings the pane back live.
  restartSession(name, opts, cb) {
    this._request('POST', `/api/restart-session/${encodeURIComponent(name)}`, { fresh: !!(opts && opts.fresh) }, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false });
    });
  }

  // Edit Session over the wire. Like restart/query, host-level (not tied to an
  // attachment or token — trust is the tunnel). sessionArgs reads the box's
  // editable args + catalogs for the dialog; setSessionArgs applies the patch
  // (the box kills+respawns on restart:true and the attached viewer reattaches
  // off the SSE exit). Plain request-pool traffic, not SSE.
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

  // Skills over the wire (Phase 2, same 'args' cap). skillCatalog reads the box's
  // skill catalog for the Skills popover; setSessionSkills persists the disabled/
  // inject sets (persist-only — the popover makes a separate restart-session call
  // to apply now). Host-level like sessionArgs; plain request-pool traffic.
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

  // ---- DM federation ----
  // Send a DM to an agent on this peer. `origin` is OUR label (how the box keys
  // its reply outbox for us); passed once from selfLabel, never recomputed. The
  // owner's verdict (delivered / parked / bounced) rides the response — that IS
  // the sender's notice, no async ack needed.
  dm({ to, from, body, urgent }, cb) {
    this._request('POST', '/api/dm', { to, from, origin: this._selfLabel, body, urgent: !!urgent }, (err, resp) => {
      cb(err ? { ok: false, error: err.message } : resp || { ok: false, error: 'no response' });
    });
  }

  // Claim any DMs the box has queued for us (box→consumer replies). Keyed by our
  // label. Fired from the hello tick when dmOrigins advertises us.
  claimDms(cb) {
    this._request('POST', '/api/dm/claim', { origin: this._selfLabel }, (err, resp) => {
      cb(err ? { ok: false, error: err.message } : resp || { ok: false });
    });
  }

  // Push the relay roster to this spoke (hub-relay federation). WE are the hub for
  // this connection; the caller computes the split-horizon'd, access-gated roster
  // of agents on our OTHER peers that this spoke may reach, and we deliver it. Only
  // fired when the spoke advertised the 'relay' cap (peer-wiring gates on the
  // parsed hello caps), so this never 501-spams an old box. `via` is our own label
  // (this._selfLabel) — what the spoke keys its via-table/outbox under. Fire-and-
  // forget: a failed push just retries on the next tick with a fresh roster.
  pushRoster(roster, cb) {
    this._request('POST', '/api/peer/roster',
      { rv: RELAY_ENVELOPE_V, via: this._selfLabel, roster: Array.isArray(roster) ? roster : [] },
      (err, resp) => { if (cb) cb(err ? { ok: false, error: err.message } : resp || { ok: false }); });
  }

  // ---- plumbing ----

  // Bearer header for a tokened peer, merged into a request's headers. Empty for
  // an untokened peer so the wire is byte-for-byte unchanged there.
  _authHeaders() {
    return this._token ? { Authorization: `Bearer ${this._token}` } : {};
  }

  // Say, out loud, that a stream was killed for unframed residue (t48).
  //
  // A bound that fires silently is a bound nobody can diagnose — t45's lesson,
  // and it applies harder here: the symptom of a silent overflow is a peer that
  // flaps for no visible reason, which is indistinguishable from a flaky
  // network and would be debugged as one. The IPC log is where this side's
  // other unexplained-behaviour lines already go, and it names the peer, the
  // stream path, and the number, so the line is enough to act on by itself.
  //
  // Rate-limited to once per minute per connection. An overflow that repeats is
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

  // Open an SSE stream. onClose is the ONE reconnect door: every death — server
  // end, transport error, or the staleness watchdog — goes through it exactly
  // once, so a watchdog-driven reconnect lands in the same place a socket-error
  // one does rather than in a second path with its own backoff.
  //
  // THE WATCHDOG (the half-open-socket fix). A socket that stops delivering
  // bytes emits no 'end' and no 'error': it reads as live forever, and both
  // consumers here keep believing a dead feed. So we arm a staleness timer on
  // connect and re-arm it on EVERY chunk — including remote.js's 25s `: ping`
  // comment frames, which is the whole point: a heartbeat that stops arriving is
  // the only evidence a half-open socket ever produces.
  //
  // On fire we destroy the socket AND walk the close door. In practice the
  // destroy raises 'error' and that alone reaches the door — measured: removing
  // the explicit close() keeps every test here green. It stays as the guarantee
  // for the case where it does not (a request already past its own teardown
  // emits nothing), and the redundancy is exactly why the one-shot guard below
  // is mandatory rather than tidiness.
  // onStable (t50) fires once, STABLE_MARGIN_MS past the staleness deadline, if
  // the stream is still alive — the signal a consumer resets its backoff on.
  // Optional: a consumer that passes none simply never resets.
  _sse(path, { onEvent, onOpen, onClose, onStable }) {
    let u;
    try { u = new URL(this.url + path); } catch { return onClose(); }
    // Fires onClose at most once. Needed the moment a second death path exists:
    // a watchdog destroy also raises a socket error, and two onCloses on one
    // stream would schedule two reconnects — i.e. two live streams for one
    // attachment. Also stops the timer, so a closed stream leaves nothing armed
    // (a stray timer would keep the event loop alive after teardown).
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
      // Framing is sse-frame.js's. dropUnparsableData is this side's preserved
      // divergence from the CLI's copy (a `data:` line that will not JSON-parse
      // drops the frame rather than arriving raw); the residue bound is the
      // decoder's default, shared. A consumer throw is swallowed here, at the
      // call site where it always was — which consumer throws you tolerate is
      // the head's business, not the decoder's.
      const decoder = makeSseDecoder({
        // `data: null` parses fine but this side's consumers all dereference
        // the payload (data.b64, data.name, data.exitCode), and the old guard
        // was `if (data !== null)` — a null was dropped, not delivered. Kept
        // here rather than made a decoder option: it is a property of THESE
        // consumers, and the CLI's (which render text) do not share it.
        onEvent: (event, data) => { if (data === null) return; try { onEvent(event, data); } catch {} },
        dropUnparsableData: true,
        maxBufferBytes: this._sseMaxBufferBytes,
        // The producer sent more unframed bytes than any legitimate frame could
        // be. Destroy the socket and let the ONE close door handle it — the same
        // door a socket error uses, so this reconnects on the normal calm
        // backoff rather than in a second path of its own.
        //
        // WHY RECONNECT RATHER THAN GIVE UP. The likely causes are transient
        // (a hop mangling a stretch of the stream, a truncated write), and
        // giving up would strand this peer's session list stale forever while
        // the peer still reads as online — a worse failure, and a silent one.
        // Reconnecting is self-healing if the cause passes.
        //
        // WHAT THAT COSTS, and why it is now bounded. If the cause does NOT
        // pass, this cycles — but it cycles on a GROWING backoff since t50.
        // It used to sit at the 1s floor forever, because onOpen reset the
        // backoff on every successful connect and an overflowing stream does
        // reach 200 first; each pass moved a megabyte, and being bandwidth-bound
        // rather than a CPU spin it never announced itself. The reset now needs
        // the stream to have LASTED (STABLE_MARGIN_MS), which an overflowing one
        // never does, so this walks up to RECONNECT_MAX_MS like any other
        // failure and self-heals at the same cadence if the cause passes.
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

// Owns one PeerConnection per configured peer; reconciled from settings.
class PeerManager {
  constructor({ emit, selfLabel, computeRoster }) {
    this._emit = emit;
    this._selfLabel = selfLabel || null; // our origin on the wire (DM federation)
    // Hub-relay: settings-aware roster computation, handed to each connection so it
    // can push per hello tick (see PeerConnection). Injected here so peer-client
    // stays electron-free — the settings/statuses read lives in peer-wiring.
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
        // Announce the newborn immediately. _setOnline emits on TRANSITIONS,
        // so a peer whose hello never succeeds (wrong port, box down) would
        // otherwise never emit at all — saved in settings yet invisible in the
        // sidebar, which reads only peer-state events. One offline status now;
        // a successful hello follows with the online one moments later.
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
