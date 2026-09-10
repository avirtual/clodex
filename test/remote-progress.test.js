'use strict';
// remote-progress.test.js — the `progress` SSE nudge that keeps a long turn from
// looking frozen on the phone (t802). Real HTTP against a port-0 RemoteServer for
// the frame, plus source-shape assertions for the client half in
// renderer/remote.html, which has no test harness of its own.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { RemoteServer } = require('../remote');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

async function withServer(fn) {
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
  });
  await server.start();
  try { return await fn(server); } finally { server.stop(); }
}

// Opens the SSE stream, runs `emit` once the connection is live, and resolves with
// everything that arrived after the hello frame.
function collect(server, emit) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: server.port, path: '/api/events' }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        if (!buf.includes('\n\n')) return;
        if (!r._emitted) { r._emitted = true; emit(); return; }
        r.destroy();
        resolve(buf);
      });
    });
    r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    r.end();
  });
}

test('notifyProgress broadcasts an event: progress frame carrying only the seat name', async () => {
  await withServer(async (server) => {
    const frames = await collect(server, () => server.notifyProgress('seat-a'));
    assert.match(frames, /event: progress\ndata: \{"name":"seat-a"\}\n\n/,
      'the frame names the event and carries {name} — and nothing else');
    // Bodyless is the design, not an omission: the phone refetches the transcript,
    // so shipping turn text over SSE would put it on the wire for no reader.
    assert.doesNotMatch(frames, /event: progress\ndata: [^\n]*"text"/, 'no turn text rides the nudge');
  });
});

test('notifyProgress does not disturb the activity map the sidebar dot reads', async () => {
  await withServer(async (server) => {
    server.notifyActivity('seat-a', 'thinking', false);
    server.notifyProgress('seat-a');
    assert.strictEqual(server.activityFor('seat-a'), 'thinking',
      'a progress nudge is not an activity transition');
    server.notifyProgress('never-seen');
    assert.strictEqual(server.activityFor('never-seen'), 'idle',
      'and it does not invent an activity entry for an unknown seat');
  });
});

// ── the client half (renderer/remote.html) ──────────────────────────────────
// Source-shape only: the page has no DOM harness in this repo, so these pin that
// the listener and the class exist and are wired to the right names. They do NOT
// exercise the fetch or the render — a change that keeps these strings while
// breaking the behaviour would pass.

const CLIENT = fs.readFileSync(PAGE, 'utf8');

test('the phone client listens for progress and coalesces the refetch', () => {
  const listener = CLIENT.match(/es\.addEventListener\('progress',[\s\S]{0,600}?\n {4}\}\);/);
  assert.ok(listener, 'a progress SSE listener sits beside the activity one');
  assert.match(listener[0], /open !== d\.name\) return/, 'it acts only on the session the phone has open');
  assert.match(listener[0], /burstFetch\(\)/, 'and refetches the transcript, which is the source of truth');
  assert.match(listener[0], /1500/, 'coalesced — the jsonl path fires activity per flush too');

  const turnEnd = CLIENT.match(/if \(d\.turnEnd \|\| d\.state === 'thinking'\) burstFetch\(\);/);
  assert.ok(turnEnd, 'ENTER: the turnEnd burst is still an unconditional burstFetch — the final '
    + 'reply must always land, so the coalescing must not have been moved into burstFetch itself');
});

test('an interim assistant bubble is rendered with the interim class, and styled dimmer', () => {
  assert.match(CLIENT, /function appendBubble\(role, text, interim\)/,
    'appendBubble takes the flag');
  assert.match(CLIENT, /interim \? ' interim' : ''/, 'and puts it on the class list');
  assert.match(CLIENT, /appendBubble\(m\.role, m\.text, m\.interim\)/,
    'renderChat passes the flag jsonlToMessages sets');
  assert.match(CLIENT, /\.msg\.assistant\.interim \{[^}]*var\(--dim\)/,
    'and the CSS dims it');
});
