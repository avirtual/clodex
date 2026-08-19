
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { RELAY_ENVELOPE_V } = require('./relay-protocol');
const { withoutExecGrants } = require('./session-args');
const { makeWatchdog, STALE_MS } = require('./cli/src/sse-guard');
const { makeSseDecoder, MAX_BUFFER_BYTES } = require('./cli/src/sse-frame');
const { peerHasShellCap, peerShellRefusal, vetWireResize } = require('./peer-shell');

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
// A peer-terminal stream that never reaches 200 was REFUSED, and the status is
// the only part of the refusal that survives: the SSE path discards non-200
// bodies. So the status carries the code, which is why remote.js answers 501 for
// both of its config-bit refusals (no callback, drawer services off) and reserves
// 404 for a seat that genuinely is not there.
// Every row has a real producer on the serving side — a status this table
// names that nothing answers reads as a documented case and stops anyone
// looking for the hole where it should be. Anything NOT listed (the
// fail-closed 503, or a 403 from something between us and the box) falls to
// 'failed', which is what 401 says too: the row is here because the auth gate
// genuinely answers it, not because the mapping differs.
const WTERM_STATUS_CODE = {
  501: 'off',        // this box does not serve terminals — grant off, or no drawer services
  404: 'no-seat',    // the box serves them; this seat has none
  400: 'bad-seat',   // our seat failed the far side's grammar (a bug on this end)
  401: 'failed',     // _authGate
};
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

// Same sentinel rule for the box's wirescope (t443): a port that appeared,
// vanished or moved must all read as an identity change, so the affordance
// downstream is never rendered from a stale port.
function wirescopeKey(w) {
  return w ? String(w.port) : '';
}

// A wterm owner is a WINDOW, addressed by its workspace id. Normalized to a
// string because the Set is compared against ids arriving from two unrelated
// callers — an IPC sender's workspace and main.js's window hooks — and a Set
// keyed by mixed types would silently hold two entries for one window, leaving
// a want nothing drops.
//
// There is deliberately no sentinel for an absent owner: an unresolvable sender
// is REFUSED at the open (ipc-handlers), because a want filed under a key no
// dropper ever passes is exactly the undroppable want this ownership exists to
// prevent.
function ownerKey(owner) {
  return String(owner);
}

// The scheme half of a dial, in ONE place, exported so it can be tested without
// a socket. Every request this module makes — control requests and the SSE
// streams alike — carries `Authorization: Bearer <token>`, so the module used to
// hand the operator's token to a cleartext socket whenever the peer was
// configured with an https:// URL: `http.request` unconditionally, and
// `port: u.port || 80` for good measure, so even a scheme-only https URL went to
// the cleartext port (F001).
//
// The acceptance half was never in doubt — peer-import.js:59 admits https://
// explicitly, peer-deploy.js:214 classifies it as a url, and
// test/peer-deploy.test.js:277 pins that. The CLI's own client against the same
// wire got it right (cli/src/client.js:105). Two first-party clients, one wire,
// and only one of them kept TLS — because acceptance and dialling were tested in
// different files and the SEAM between them was owned by nothing. It is owned by
// test/peer-url-seam.test.js now.
//
// Ports: 443 for https, 80 for http, matching what a browser would do with the
// same URL. Returns the request options both dial sites need, so neither can
// drift from the other again.
function dialOptions(baseUrl, path = '') {
  const u = new URL(baseUrl + path);
  const secure = u.protocol === 'https:';
  return {
    secure,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : (secure ? 443 : 80),
    path: u.pathname + u.search,
  };
}

// Whether a peer's base URL is TLS, for picking the socket-pool class up front.
// Defensive rather than assertive: a base URL that will not parse is not a
// reason to throw in a constructor — every dial through it will fail on its own
// try/catch, and treating it as plaintext changes nothing about that.
function isSecureBase(raw) {
  try { return new URL(raw).protocol === 'https:'; } catch { return false; }
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
// Scheme-matched pools. Node's ClientRequest refuses an agent whose `protocol`
// differs from the request module's, so this is not cosmetic: swapping
// http.request for https.request without swapping the agent throws
// ERR_INVALID_PROTOCOL and the peer never connects at all. Fixed for the
// connection's lifetime for the same reason the token is — a URL change is a
// peer restart (PeerManager.sync), never a mutation of a live connection.
    this._secure = isSecureBase(this.url);
    const Agent = this._secure ? https.Agent : http.Agent;
    this._reqAgent = new Agent({ keepAlive: true, maxSockets: 8 });
    this._sseAgent = new Agent({ keepAlive: false, maxSockets: Infinity });
    this.online = false;
    this.hello = null;                // { host, version, caps, platform, srcDir }
    this.sessions = [];               // last fetched session list
    this._helloTimer = null;
    this._eventsReq = null;
    this._eventsBackoff = RECONNECT_MIN_MS;
    this._attachments = new Map();    // name -> { req, token, wanted, backoff, timer }
    // seat -> { req, wanted, backoff, timer, opening, owners } for peer TERMINAL
    // feeds.
    // Deliberately separate from _attachments: an attachment is a view of a
    // remote AGENT and carries the control token; a wterm is a shell on the same
    // box with no token at all, and merging the two maps would let a control
    // release tear down a terminal that never held control.
    //
    // `owners` is the set of WINDOWS that asked for this seat, and it is what
    // makes the want survivable. The renderer's release edge runs off its own
    // `held`, which dies with the renderer: a reload leaves `wanted` true here
    // with nobody left who could ever close it — a stream and a shell stranded
    // on someone else's machine. A window that navigates away drops its own
    // entry (dropWtermsForWindow), and the stream goes only when the set
    // empties, so one window's close cannot tear down another window's view.
    this._wterms = new Map();
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
    // Local teardown only — no wterm-close POST. The serving side drops its
    // stream entry on the socket close that _sseAgent.destroy() below causes,
    // so the round-trip would buy nothing and its reply would arrive at a
    // connection that is already gone.
    for (const seat of [...this._wterms.keys()]) this._teardownWterm(seat);
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
      wirescope: this.hello ? this.hello.wirescope : null,
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
        // Validated exactly like webHost, and null on anything short of a
        // usable integer port — including a peer too old to send the field at
        // all. That degrades to "no wirescope forward"; it must never degrade
        // to a guessed 7800, which would forward at whatever happens to listen
        // on the box's 7800 (or, unforwarded, at the VIEWER'S own).
        const wr = body.wirescope;
        const wirescope = (wr && Number.isInteger(wr.port) && wr.port > 0 && wr.port <= 65535)
          ? { port: wr.port }
          : null;
        const next = { host: body.host, version: body.version, caps: body.caps || [], platform: body.platform || null, srcDir: body.srcDir || null, webHost, wirescope };
// Edge-triggered identity check: an in-place Update restarts the box faster
// than the hello cadence can observe an offline dip, so _setOnline sees no
// transition and never emits — leaving a stale version in the renderer.
        const identityChanged = !prev ||
          prev.version !== next.version ||
          prev.platform !== next.platform ||
          prev.srcDir !== next.srcDir ||
          webHostKey(prev.webHost) !== webHostKey(next.webHost) ||
          wirescopeKey(prev.wirescope) !== wirescopeKey(next.wirescope) ||
          (prev.caps || []).join(',') !== (next.caps || []).join(',');
        // A grant withdrawn on the far side already closes the streams with a
        // reason; noticing the cap vanish from hello covers the case where the
        // box restarted WITHOUT the grant, so no close frame was ever sent and
        // our backoff would otherwise keep reopening against a 501.
        const lostShell = prev && peerHasShellCap(prev.caps) && !peerHasShellCap(next.caps);
        this.hello = next;
        if (lostShell) this._dropAllWterm('revoked');
        this._setOnline(true);
        if (wasOffline) {
          this._refreshSessions();
          this._openEvents();
          for (const [name, att] of this._attachments) {
            if (att.wanted && !att.req) this._openAttach(name, att);
          }
          for (const [seat, w] of this._wterms) {
            if (w.wanted && !w.req) this._openWterm(seat, w);
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

// --- peer terminal -------------------------------------------------------
// A shell on the SERVING box, streamed here. `seat` is the BARE session name:
// the renderer keys peer sessions `name@peerId` and splits with
// peer-shell's wireSeatFor before it gets here, so the `@` never reaches a URL.

// Is the far side offering terminals at all? Checked before every wterm call
// rather than once at open, because a grant can be withdrawn mid-session and
// the hello loop is where we learn it.
  _shellRefusal() {
    if (!this.online) return peerShellRefusal('offline', this.label);
    if (!peerHasShellCap(this.hello && this.hello.caps)) {
      return peerShellRefusal('off', this.label);
    }
    return null;
  }

  wtermOpen(seat, owner, cb) {
    const refusal = this._shellRefusal();
    if (refusal) return cb({ ok: false, error: refusal });
    let w = this._wterms.get(seat);
    // The owner is recorded on the DEDUPE path too, not just the fresh one.
    // A second window showing a seat the first already opened gets the early
    // return, and if that did not count it the first window's close would take
    // the second's stream down with it.
    if (w && w.wanted) { w.owners.add(ownerKey(owner)); return cb({ ok: true }); }
    if (!w) { w = { req: null, opening: false, wanted: true, backoff: RECONNECT_MIN_MS, timer: null, owners: new Set() }; this._wterms.set(seat, w); }
    w.owners.add(ownerKey(owner));
    w.wanted = true;
    this._openWterm(seat, w);
    return cb({ ok: true });
  }

  // Every want this window holds, released. Cannot fire against a seat merely
  // slow to re-attach: the drop happens at navigation START, strictly after the
  // old document's last IPC and strictly before the new document exists, so it
  // can only ever remove a want belonging to a renderer that no longer exists.
  // A fresh renderer's later open is ordered after this, finds no entry, and
  // opens for real — which is also what gets it a `replay` frame, since the
  // serving side writes one only at stream-open.
  //
  // Local teardown only — no wterm-close POST, the same ruling as `stop()` and
  // for a sharper reason. The serving side sheds its stream on the socket close
  // that `_teardownWterm` causes, so the POST buys nothing; but its close route
  // drops EVERY watcher of the seat, so one still in flight when the fresh
  // renderer re-opens would kill the stream it just got. Dropping the POST is
  // what makes the re-show race-free rather than merely usually-fast-enough.
  //
  // The visible cost, since it is invisible to the box's operator: no POST
  // means no `wtermClose` callback there, so a reload or a window close
  // produces no "a peer closed its view" chip in their ops log, where an
  // ordinary hide does. The stream and its mark still go — only the sentence is
  // missing.
  dropWtermsForWindow(owner) {
    const key = ownerKey(owner);
    for (const [seat, w] of [...this._wterms]) {
      if (!w.owners.delete(key)) continue;
      if (w.owners.size > 0) continue;
      this._teardownWterm(seat);
    }
  }

  _openWterm(seat, w) {
    if (w.req || w.opening || !w.wanted || this._stopped) return;
    w.opening = true;
    this._sse(`/api/wterm/${encodeURIComponent(seat)}`, {
      onEvent: (event, data) => {
        if (event === 'replay') {
          this._emit('peer-wterm-replay', this.id, seat, {
            data: Buffer.from(data.b64 || '', 'base64'),
            cols: data.cols, rows: data.rows,
          });
        } else if (event === 'output') {
          this._emit('peer-wterm-data', this.id, seat, Buffer.from(data.b64 || '', 'base64'));
        } else if (event === 'exit') {
          // The shell itself ended on the far side. Stop wanting the stream, or
          // the close door below reconnects into a seat with no shell.
          w.wanted = false;
          this._emit('peer-wterm-exit', this.id, seat, data.exitCode);
        } else if (event === 'closed') {
          // A DECISION, not a blip — the serving side always says why. Retrying
          // against a revocation is what this frame exists to prevent, so the
          // want is cleared before the close door runs.
          w.wanted = false;
          this._emit('peer-wterm-closed', this.id, seat,
            peerShellRefusal(String((data && data.reason) || 'closed'), this.label));
        }
      },
      // A drop can land in the interval between the GET going out and its 200
      // arriving. `_teardownWterm` can only destroy `w.req`, and `w.req` does
      // not exist yet — so it deletes the map entry and destroys NOTHING, while
      // the far side has already spawned the shell, added the response to its
      // `_wterm` and written `replay`. That is this ticket's own orphan, one
      // interval over, and it is the permanent variant at the window-close edge
      // where no later navigation can ever fire a second drop. Re-showing the
      // seat then opens a SECOND concurrent stream and every byte prints twice.
      //
      // So the socket is reaped HERE, where it first exists, against the same
      // three conditions teardown uses. The map-identity check is what makes it
      // safe: a fresh entry under this seat means this closure belongs to a
      // stream nobody wants, and assigning `req` onto a stale `w` would hand
      // the live entry's key to a dead one. `stop()` covers the same interval
      // with `_sseAgent.destroy()`; the two per-window droppers have no pool to
      // destroy, so they need this.
      onOpen: (req) => {
        if (!w.wanted || this._stopped || this._wterms.get(seat) !== w) {
          try { req.destroy(); } catch {}
          return;
        }
        w.opening = false;
        w.req = req;
      },
      onStable: () => { w.backoff = RECONNECT_MIN_MS; },
      // The serving side said no. Clear `wanted` BEFORE the close door runs, the
      // same as a `closed` frame and for the same reason: a refusal is a
      // decision, and reconnecting against it every ≤20s forever is both useless
      // and a knock on someone else's machine. The STATUS is the code — the body
      // is discarded by _request's SSE path — so it is mapped here.
      onRefused: (status) => {
        w.wanted = false;
        this._emit('peer-wterm-closed', this.id, seat,
          peerShellRefusal(WTERM_STATUS_CODE[status] || 'failed', this.label));
      },
      onClose: () => {
        w.opening = false;
        w.req = null;
        // Delete only if the map still holds THIS entry. A socket closes
        // asynchronously, so a seat torn down and immediately re-opened — a
        // reload, which drops the window's want and then re-shows the seat —
        // has a fresh entry under the same key by the time the old stream's
        // close lands. Deleting by key alone would drop the live entry and
        // leave a stream nothing tracks: a pane with a feed the map says is
        // not there, and no closer for it.
        if (!w.wanted || this._stopped) {
          if (this._wterms.get(seat) === w) this._wterms.delete(seat);
          return;
        }
        const delay = w.backoff;
        w.backoff = Math.min(w.backoff * 2, RECONNECT_MAX_MS);
        w.timer = setTimeout(() => { if (this.online) this._openWterm(seat, w); }, delay);
      },
    });
  }

// Keystrokes ride as OPAQUE BYTES — not vetted here and not vetted on the
// serving side either, deliberately: this is a terminal and a person typing
// `^C` means it. What IS vetted on both ends is geometry (wtermResize) and,
// where a caller composes a line rather than typing it, the command text.
  wtermInput(seat, data, cb) {
    const refusal = this._shellRefusal();
    if (refusal) return cb({ ok: false, error: refusal });
    this._request('POST', `/api/wterm-input/${encodeURIComponent(seat)}`, { data }, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false });
    });
  }

// Vetted HERE and again on the serving side. Not belt-and-braces: the consumer
// check is a fast local refusal that costs no round-trip, the serving check is
// the real one because the wire is not trusted — a peer is not obliged to run
// this code. Removing either is a bug; removing the serving one is a hole.
  wtermResize(seat, cols, rows, cb) {
    const refusal = this._shellRefusal();
    if (refusal) return cb({ ok: false, error: refusal });
    const vet = vetWireResize(cols, rows);
    if (!vet.ok) return cb(vet);
    this._request('POST', `/api/wterm-resize/${encodeURIComponent(seat)}`, { cols: vet.cols, rows: vet.rows }, (err, body) => {
      cb(err ? { ok: false, error: err.message } : body || { ok: false });
    });
  }

// Closes OUR VIEW, and it is term-tab's release edge that calls it — on hide
// and on a seat switch. The serving side detaches and never kills: it is one
// shell with two viewers, and the operator of that box has it in their own tab.
// Turning this into a kill would let a remote party take a local terminal away;
// drawer-pty's write() carries the rest of that reasoning.
  wtermClose(seat, owner, cb) {
    const w = this._wterms.get(seat);
    // Refcounted by window. The serving side's close route drops EVERY watcher
    // of the seat, so closing while a second window is still showing it would
    // kill that window's pane — the same hazard term-tab's `held` bookkeeping
    // guards on the renderer side, one layer down.
    //
    // A close whose owner does not resolve never gets here: the seam refuses
    // it, symmetrically with the open, so this method always has a name to
    // decrement. Both of the shapes that DO handle it here are wrong, which is
    // why the rule lives at the seam instead. Swallowing turns the sole path
    // that exists to close things into a no-op. Shedding on it takes a live
    // window's pane down whenever the dying window was not the only owner —
    // W1 and W2 on a seat, W2 hides then dies with a second close in flight.
    // The dead window's wants are shed by main's `closed` hook, which drops by
    // workspace id and so knows exactly who left.
    if (w) {
      w.owners.delete(ownerKey(owner));
      if (w.owners.size > 0) return cb({ ok: true });
    }
    this._teardownWterm(seat);
    if (!w) return cb({ ok: true });
    if (!this.online) return cb({ ok: true });
    this._request('POST', `/api/wterm-close/${encodeURIComponent(seat)}`, {}, () => cb({ ok: true }));
    return undefined;
  }

  _teardownWterm(seat) {
    const w = this._wterms.get(seat);
    if (!w) return;
    w.wanted = false;
    clearTimeout(w.timer);
    if (w.req) { try { w.req.destroy(); } catch {} w.req = null; }
    this._wterms.delete(seat);
  }

  _dropAllWterm(reason) {
    for (const seat of [...this._wterms.keys()]) {
      this._teardownWterm(seat);
      this._emit('peer-wterm-closed', this.id, seat, peerShellRefusal(reason, this.label));
    }
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
    let d;
    try { d = dialOptions(this.url, path); } catch (e) { return cb(e); }
    const body = payload ? JSON.stringify(payload) : null;
    const req = (d.secure ? https : http).request({
      hostname: d.hostname, port: d.port,
      path: d.path, method,
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
  // `onRefused(status)` is optional and only the peer TERMINAL passes it. Without
  // it a non-200 is indistinguishable from a dropped tunnel, so the caller
  // reconnects on backoff forever against a box that answered "no" — which is
  // the opposite of what a refusal means. Attach deliberately does not pass it:
  // a session that 404s now may exist on the next hello, so retrying is right
  // there.
  _sse(path, { onEvent, onOpen, onClose, onStable, onRefused }) {
    let d;
    try { d = dialOptions(this.url, path); } catch { return onClose(); }
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
    const req = (d.secure ? https : http).request({
      hostname: d.hostname, port: d.port,
      path: d.path, method: 'GET',
      agent: this._sseAgent,
      headers: { Accept: 'text/event-stream', ...this._authHeaders() },
    }, (res) => {
      if (res.statusCode !== 200) {
        // Reported before the destroy so the refusal is recorded before the
        // close door can run — the door reconnects, which is the one thing a
        // refusal must not cause. Today either order works, because destroy
        // raises its error asynchronously and onRefused would still land first;
        // this ordering is what keeps that timing from being load-bearing.
        if (onRefused) { try { onRefused(res.statusCode); } catch {} }
        req.destroy();
        return;
      }
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

  // A window went away or reloaded: every peer it was watching a shell on must
  // lose that want. Across ALL connections — the window could have had seats
  // open on several boxes, and a per-connection call would leave the rest.
  dropWtermsForWindow(owner) {
    for (const conn of this._peers.values()) conn.dropWtermsForWindow(owner);
  }

  statuses() { return [...this._peers.values()].map((c) => c.status()); }

  get(id) { return this._peers.get(String(id)) || null; }
}

module.exports = { PeerManager, PeerConnection, dialOptions };
