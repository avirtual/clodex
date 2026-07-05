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

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const MAX_BODY = 64 * 1024;          // matches the IPC message cap
const SSE_HEARTBEAT_MS = 25000;

class RemoteServer {
  constructor({ port, pagePath, getSessions, getTranscript, send, restartApp }) {
    this._port = port;
    this._pagePath = pagePath;
    this._getSessions = getSessions;
    this._getTranscript = getTranscript;
    this._send = send;
    this._restartApp = restartApp || null;
    this._server = null;
    this._clients = new Set();       // live SSE responses
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
        this._heartbeat = setInterval(() => {
          for (const res of this._clients) {
            try { res.write(': ping\n\n'); } catch {}
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
    this._broadcast('sessions', {});
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
