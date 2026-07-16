'use strict';
// peer-client-refresh.test.js — session-list freshness across an SSE feed gap.
//
// Regression for a live bug: after a sandbox Rebuild (compose recreate) the host
// sidebar kept a stale, empty session list for the box. The recreate severs the
// /api/events SSE faster than the 15s hello cadence sees an offline dip, so
// neither the offline→online nor the identityChanged trigger refreshed sessions;
// SSE has no replay, so the box-boot 'sessions' events fell in the reconnect gap
// and the list stayed stale until the next organic change. The fix resyncs
// unconditionally in _openEvents' onOpen — an SSE (re)open IS recovery from a gap.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PeerConnection } = require('../peer-client');

// A server whose /api/sessions payload is mutable (so a test can simulate the box
// booting new sessions during the gap), that counts session GETs, and that hands
// out its open SSE responses so the test can sever the feed on demand.
function refreshServer() {
  const state = { sessions: [], sessionGets: 0, sseResponses: [] };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/api/peer/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Stable identity every tick: no offline dip, no identityChanged — so the
      // ONLY thing that can refresh the list across the gap is the SSE reopen.
      res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'h', caps: [], version: '1', sessions: [] }));
    } else if (p === '/api/sessions') {
      state.sessionGets++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: state.sessions }));
    } else if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      state.sseResponses.push(res); // held open; the test severs to force a reopen
    } else {
      res.writeHead(404).end();
    }
  });
  return { server, state };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function waitFor(pred, ms = 4000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v; try { v = pred(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('timeout'));
      setTimeout(tick, 15);
    };
    tick();
  });
}

test('an SSE reopen resyncs the session list (Rebuild/recreate gap regression)', async () => {
  const { server, state } = refreshServer();
  const port = await listen(server);
  const conn = new PeerConnection({
    id: 'box', label: 'box', url: `http://127.0.0.1:${port}`,
    emit: () => {}, helloIntervalMs: 10000, // slow hello: prove the SSE reopen (not a hello) resyncs
  });
  conn.start();
  try {
    // Come online and open the first events stream. The box has no sessions yet.
    await waitFor(() => conn.online && state.sseResponses.length === 1);
    await waitFor(() => state.sessionGets >= 1); // wasOffline + onOpen both refresh
    assert.deepStrictEqual(conn.sessions, []);
    const getsBeforeGap = state.sessionGets;

    // The box "reboots" with a fresh session and the SSE feed is severed — exactly
    // a compose recreate: the boot 'sessions' event is emitted into the gap and
    // lost (this server never re-sends it), so ONLY a reopen resync can recover it.
    state.sessions = [{ name: 'boot-session', type: 'claude', activity: 'idle' }];
    for (const res of state.sseResponses.splice(0)) { try { res.end(); } catch {} }

    // onClose → backoff → _openEvents → onOpen → _refreshSessions picks up the list.
    await waitFor(() => state.sseResponses.length >= 1); // the feed reopened
    await waitFor(() => conn.sessions.length === 1);
    assert.strictEqual(conn.sessions[0].name, 'boot-session');
    // The recovery went through a real GET /api/sessions on the reopen, not a hello.
    assert.ok(state.sessionGets > getsBeforeGap, 'the reopen issued a fresh /api/sessions GET');
  } finally {
    conn.stop();
    server.close();
  }
});
