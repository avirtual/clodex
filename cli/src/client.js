// client.js — the in-process HTTP client for the remote.js wire.
//
// The token travels ONLY as an Authorization: Bearer header, built here from
// the resolved context. It is never placed in a URL, never logged, and this
// module never returns it. Uses global fetch (Node >=20) — zero deps.
//
// Every call maps a non-2xx onto a CliError with the contract exit code
// (errors.js:exitForStatus), so verbs can let failures propagate and the
// process exits with the right code. Connect failures (bad host, dead tunnel)
// surface as EXIT.CONNECT.
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { CliError, EXIT, exitForStatus } = require('./errors');
// SSE framing lives in ONE place (t47) — this side and the GUI's peer-client
// both feed it. parseSseBlock is re-exported below because it was part of this
// module's surface before the move and its tests import it from here.
const { parseSseBlock, makeSseDecoder, MAX_BUFFER_BYTES } = require('./sse-frame');

// Redact anything that looks like our bearer token from a string before it can
// reach stderr. Belt-and-suspenders: we never intentionally build such a
// string, but a wrapped fetch error could echo request init in theory.
function scrub(str, token) {
  if (!token || !str) return str;
  return String(str).split(token).join('***');
}

class WireClient {
  constructor(baseUrl, token) {
    this._base = baseUrl.replace(/\/+$/, '');
    this._token = token || null;
  }

  _headers(extra) {
    const h = { Accept: 'application/json', ...(extra || {}) };
    if (this._token) h.Authorization = `Bearer ${this._token}`;
    return h;
  }

  async _fetch(pathAndQuery, init) {
    const url = this._base + pathAndQuery;
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      // A caller-signalled abort is not a network failure — rethrow untouched
      // so the caller can tell its own ceiling from a dead engine.
      if (e && e.name === 'AbortError') throw e;
      // Network-level failure: DNS, ECONNREFUSED, TLS, aborted tunnel.
      throw new CliError(EXIT.CONNECT, scrub(`cannot reach the engine: ${e.message}`, this._token));
    }
    return res;
  }

  // Parse a JSON body; tolerate an empty/non-JSON body (some errors are text).
  async _body(res) {
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { return { _text: text }; }
  }

  // Run a request and return the parsed JSON on 2xx; throw a coded CliError
  // otherwise. `verb` names the operation for the error message. `opts.signal`
  // (optional) is an AbortSignal — the caller can cut a hung request so its
  // socket is released and the process can exit (send --wait's hard ceiling).
  async _call(method, pathAndQuery, verb, jsonBody, opts) {
    const init = { method, headers: this._headers(jsonBody != null ? { 'Content-Type': 'application/json' } : null) };
    if (jsonBody != null) init.body = JSON.stringify(jsonBody);
    if (opts && opts.signal) init.signal = opts.signal;
    const res = await this._fetch(pathAndQuery, init);
    const body = await this._body(res);
    if (res.ok) return body;
    // Non-2xx → coded error. Prefer the server's own error string, else the
    // raw text, else the status.
    const detail = (body && (body.error || body._text)) || `HTTP ${res.status}`;
    throw new CliError(exitForStatus(res.status), scrub(`${verb} failed: ${detail}`, this._token));
  }

  get(pathAndQuery, verb, opts) { return this._call('GET', pathAndQuery, verb || 'request', undefined, opts); }
  post(pathAndQuery, verb, jsonBody, opts) { return this._call('POST', pathAndQuery, verb || 'request', jsonBody == null ? {} : jsonBody, opts); }

  // Open a text/event-stream over the wire. The FRAMING is sse-frame.js's (one
  // decoder, shared with the GUI's peer-client since t47); what stays here is
  // the transport: the request, the Bearer header, the status handling and the
  // CliError typing. The token rides the header, same as every other call — it
  // never leaves this module.
  //
  //   onOpen()              — the response reached 200 (stream is live/subscribed)
  //   onEvent(name, data)   — one parsed frame; `data` is the JSON-parsed payload
  //                           (or the raw string if it didn't parse)
  //   onChunk(chunk)        — every raw response chunk, BEFORE parsing. Fires for
  //                           heartbeat/comment traffic too (which yields no
  //                           parsed frame), so a staleness watchdog can treat any
  //                           byte — data or `: ping` — as liveness.
  //   onError(err)          — a coded CliError (non-2xx status, transport death,
  //                           or an unframed-residue overflow — that one is
  //                           EXIT.SERVER, which openGuarded treats as terminal)
  //
  // Returns a handle { close() } that destroys the request. Idempotent close.
  openEventStream(pathAndQuery, verb, { onOpen, onEvent, onChunk, onError } = {}) {
    const u = new URL(this._base + pathAndQuery);
    const mod = u.protocol === 'https:' ? https : http;
    let closed = false;
    const fail = (err) => { if (!closed && onError) onError(err); };
    const req = mod.request(u, {
      method: 'GET',
      headers: this._headers({ Accept: 'text/event-stream' }),
    }, (res) => {
      if (res.statusCode !== 200) {
        // Drain the small error body so we can relay the server's message.
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let detail = `HTTP ${res.statusCode}`;
          try { const j = JSON.parse(text); if (j && j.error) detail = j.error; } catch { if (text) detail = text; }
          fail(new CliError(exitForStatus(res.statusCode), scrub(`${verb} failed: ${detail}`, this._token)));
        });
        return;
      }
      if (onOpen) onOpen();
      res.setEncoding('utf8');
      // Unparseable `data:` arrives raw — this side's preserved divergence from
      // the GUI's copy (sse-frame.js D4). The residue bound is the decoder's
      // shared default; before t48 this side had NO bound and `logs -f` could
      // grow its buffer until the process died.
      const decoder = makeSseDecoder({
        onEvent: (name, data) => { if (onEvent) onEvent(name, data); },
        // TERMINAL HERE, unlike the GUI, and the difference is deliberate.
        //
        // EXIT.SERVER rather than EXIT.CONNECT is what makes it terminal:
        // openGuarded retries anything CONNECT-coded and, on exhaustion,
        // REPLACES the error with a generic "3 reconnect attempts failed"
        // (sse-guard.js:105). So retrying would move three more megabytes and
        // then throw away the only sentence that says what actually happened.
        // A non-CONNECT code goes straight to onGiveUp carrying this message
        // (sse-guard.js:102), which is the whole point on a side a human is
        // sitting in front of: they get the diagnosis, not a symptom.
        //
        // It is also the honest code. A peer emitting a megabyte with no frame
        // terminator is a server-side failure (EXIT.SERVER's own definition),
        // not an unreachable wire — and unlike the GUI, giving up here strands
        // nothing: the human sees the error and decides.
        onOverflow: (bytes) => {
          const mb = (bytes / (1024 * 1024)).toFixed(1);
          fail(new CliError(EXIT.SERVER, scrub(
            `${verb} failed: the engine sent ${mb}MB of event-stream data with no frame terminator`
            + ` (limit ${MAX_BUFFER_BYTES / (1024 * 1024)}MB) — the stream is malformed`, this._token)));
          try { req.destroy(); } catch {}
        },
      });
      res.on('data', (chunk) => {
        if (onChunk) onChunk(chunk);
        decoder.push(chunk);
      });
      res.on('end', () => fail(new CliError(EXIT.CONNECT, scrub('event stream closed by the engine', this._token))));
      res.on('error', (e) => fail(new CliError(EXIT.CONNECT, scrub(`event stream error: ${e.message}`, this._token))));
    });
    req.on('error', (e) => fail(new CliError(EXIT.CONNECT, scrub(`cannot reach the engine: ${e.message}`, this._token))));
    req.end();
    return { close() { if (closed) return; closed = true; try { req.destroy(); } catch {} } };
  }
}

// parseSseBlock moved to sse-frame.js (t47) and is re-exported unchanged: it
// was part of this module's public surface, and cli/test/client.test.js pins it
// from here. Re-export rather than repoint so no existing test needs editing.
module.exports = { WireClient, scrub, parseSseBlock };
