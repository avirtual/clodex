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
  // otherwise. `verb` names the operation for the error message.
  async _call(method, pathAndQuery, verb, jsonBody) {
    const init = { method, headers: this._headers(jsonBody != null ? { 'Content-Type': 'application/json' } : null) };
    if (jsonBody != null) init.body = JSON.stringify(jsonBody);
    const res = await this._fetch(pathAndQuery, init);
    const body = await this._body(res);
    if (res.ok) return body;
    // Non-2xx → coded error. Prefer the server's own error string, else the
    // raw text, else the status.
    const detail = (body && (body.error || body._text)) || `HTTP ${res.status}`;
    throw new CliError(exitForStatus(res.status), scrub(`${verb} failed: ${detail}`, this._token));
  }

  get(pathAndQuery, verb) { return this._call('GET', pathAndQuery, verb || 'request'); }
  post(pathAndQuery, verb, jsonBody) { return this._call('POST', pathAndQuery, verb || 'request', jsonBody == null ? {} : jsonBody); }

  // Open a text/event-stream over the wire and parse SSE frames by hand (zero
  // deps: node:http/https, blank-line block framing, `event:`/`data:` lines,
  // `:`-lead comments ignored). The Bearer token rides the header, same as
  // every other call — it never leaves this module.
  //
  //   onOpen()              — the response reached 200 (stream is live/subscribed)
  //   onEvent(name, data)   — one parsed frame; `data` is the JSON-parsed payload
  //                           (or the raw string if it didn't parse)
  //   onChunk(chunk)        — every raw response chunk, BEFORE parsing. Fires for
  //                           heartbeat/comment traffic too (which yields no
  //                           parsed frame), so a staleness watchdog can treat any
  //                           byte — data or `: ping` — as liveness.
  //   onError(err)          — a coded CliError (non-2xx status, or transport death)
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
      let buf = '';
      res.on('data', (chunk) => {
        if (onChunk) onChunk(chunk);
        buf += chunk;
        // SSE separates events with a blank line. Tolerate CRLF and LF.
        let idx;
        while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + buf.slice(idx).match(/^\r?\n\r?\n/)[0].length);
          const frame = parseSseBlock(block);
          if (frame && onEvent) {
            let data = frame.data;
            try { data = JSON.parse(frame.data); } catch {}
            onEvent(frame.event || 'message', data);
          }
        }
      });
      res.on('end', () => fail(new CliError(EXIT.CONNECT, scrub('event stream closed by the engine', this._token))));
      res.on('error', (e) => fail(new CliError(EXIT.CONNECT, scrub(`event stream error: ${e.message}`, this._token))));
    });
    req.on('error', (e) => fail(new CliError(EXIT.CONNECT, scrub(`cannot reach the engine: ${e.message}`, this._token))));
    req.end();
    return { close() { if (closed) return; closed = true; try { req.destroy(); } catch {} } };
  }
}

// Parse one SSE block (the text between blank lines) into { event, data }.
// Multiple `data:` lines concatenate with '\n' (SSE spec); `:`-lead lines are
// comments. Returns null for a comment-only / dataless block.
function parseSseBlock(block) {
  let event = null;
  const dataLines = [];
  for (const raw of block.split(/\r?\n/)) {
    if (!raw || raw[0] === ':') continue;
    const colon = raw.indexOf(':');
    const field = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? '' : raw.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

module.exports = { WireClient, scrub, parseSseBlock };
