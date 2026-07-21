'use strict';
// logs-follow.test.js — `logs NAME -f` end-to-end through main.run against a
// stub that plays /api/transcript (tail + refetch) and /api/events (activity
// frames that trigger a delta refetch). Asserts: tail first, then only the new
// entries on each activity; no duplicate lines across a forced reconnect; NDJSON
// under --json; Ctrl-C (a fake signal) exits 0.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');

const TOKEN = 'sekret';

// The transcript grows over the test; `script` is an array of message-arrays,
// one per successive GET /api/transcript. onEventsOpen gets the live events res.
function followStub(opts = {}) {
  const seen = [];
  const state = { events: null };
  let tIdx = 0;
  const server = http.createServer((req, res) => {
    if ((req.headers['authorization'] || '') !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('{}'); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null };
      seen.push(rec);
      const p = req.url.split('?')[0];
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': connected\n\n');
        state.events = res;
        if (opts.onEventsOpen) opts.onEventsOpen(state, seen);
        return;
      }
      if (req.method === 'GET' && p.startsWith('/api/transcript/')) {
        // Each call returns the next scripted snapshot (last one sticks).
        const msgs = opts.transcript ? opts.transcript(tIdx++, seen) : [];
        res.writeHead(200); return res.end(JSON.stringify({ ok: true, messages: msgs }));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return { server, seen, state };
}

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function activity(res, name) { res.write(`event: activity\ndata: ${JSON.stringify({ name, state: 'idle', turnEnd: true })}\n\n`); }

// A signal seam so a test can deliver Ctrl-C deterministically.
function fakeSignalTty() {
  const sigL = new Set();
  return { tty: { onSignal: (fn) => { sigL.add(fn); return () => sigL.delete(fn); } }, signal: () => [...sigL].forEach((fn) => fn()) };
}

async function cli(argv, port, extra = {}) {
  let stdout = '', stderr = '';
  const code = await run([...argv, '--url', `http://127.0.0.1:${port}`, '--token', TOKEN], {
    stdout: (s) => (stdout += s), stderr: (s) => (stderr += s),
    env: {}, contextsFile: path.join(os.tmpdir(), 'nonexistent-clodexctl', 'contexts.json'),
    ...extra,
  });
  return { code, stdout, stderr };
}

test('logs -f: prints the tail, then only the delta on an activity frame', async () => {
  const sig = fakeSignalTty();
  const { server } = followStub({
    onEventsOpen: (state, seen) => {
      // resnapshot GET happens on open; then fire an activity → refetch prints delta.
      setTimeout(() => activity(state.events, 'bob'), 40);
      setTimeout(() => sig.signal(), 120);  // Ctrl-C to end the follow
    },
    transcript: (i) => {
      // 0: tail (logs), 1: onOpen resnapshot, 2+: refetch after activity
      if (i <= 1) return [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }];
      return [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }, { role: 'user', text: 'q2' }, { role: 'assistant', text: 'a2' }];
    },
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['logs', 'bob', '-f'], port, { tty: sig.tty });
  assert.strictEqual(code, 0);
  // Tail present exactly once; delta appended; no dup of the tail entries.
  assert.match(stdout, /\[assistant\] a1/);
  assert.match(stdout, /\[assistant\] a2/);
  assert.strictEqual((stdout.match(/a1/g) || []).length, 1, 'tail entry not duplicated');
  assert.ok(stdout.indexOf('a1') < stdout.indexOf('a2'), 'delta after tail');
  server.close();
});

test('logs -f --json: NDJSON, one object per entry (tail + delta), never a growing array', async () => {
  const sig = fakeSignalTty();
  const { server } = followStub({
    onEventsOpen: (state) => { setTimeout(() => activity(state.events, 'bob'), 40); setTimeout(() => sig.signal(), 120); },
    transcript: (i) => (i <= 1 ? [{ role: 'user', text: 'q1' }] : [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a2' }]),
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['logs', 'bob', '-f', '--json'], port, { tty: sig.tty });
  assert.strictEqual(code, 0);
  const lines = stdout.trim().split('\n').filter(Boolean);
  // Each line parses as its own object (NDJSON), not a single array.
  const objs = lines.map((l) => JSON.parse(l));
  assert.ok(objs.every((o) => o && typeof o === 'object' && !Array.isArray(o)));
  assert.deepStrictEqual(objs[0], { role: 'user', text: 'q1' });
  assert.ok(objs.some((o) => o.role === 'assistant' && o.text === 'a2'));
  server.close();
});

test('logs -f: no duplicate lines across a forced reconnect (re-snapshot silent)', async () => {
  const sig = fakeSignalTty();
  let firstEvents = true;
  const { server } = followStub({
    onEventsOpen: (state) => {
      if (firstEvents) { firstEvents = false; setTimeout(() => { try { state.events.end(); } catch {} }, 40); } // drop → reconnect
      else { setTimeout(() => activity(state.events, 'bob'), 20); setTimeout(() => sig.signal(), 120); }
    },
    transcript: (i) => {
      // Snapshot stays 2 entries across the reconnect; a new one appears only
      // after the post-reconnect activity. A reconnect that re-printed the tail
      // would duplicate a1.
      if (i <= 2) return [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }];
      return [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }, { role: 'assistant', text: 'a2' }];
    },
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['logs', 'bob', '-f'], port, { tty: sig.tty });
  assert.strictEqual(code, 0);
  assert.strictEqual((stdout.match(/a1/g) || []).length, 1, 'no dup across reconnect');
  assert.match(stdout, /a2/);
  server.close();
});

test('logs -f: Ctrl-C exits 0 (pager, not a failure)', async () => {
  const sig = fakeSignalTty();
  const { server } = followStub({
    onEventsOpen: () => { setTimeout(() => sig.signal(), 40); },
    transcript: () => [{ role: 'user', text: 'q1' }],
  });
  const port = await listen(server);
  const { code } = await cli(['logs', 'bob', '-f'], port, { tty: sig.tty });
  assert.strictEqual(code, 0);
  server.close();
});

test('logs without -f: unchanged one-shot (no events feed opened)', async () => {
  const { server, seen } = followStub({ transcript: () => [{ role: 'assistant', text: 'hi' }] });
  const port = await listen(server);
  const { code, stdout } = await cli(['logs', 'bob'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /\[assistant\] hi/);
  assert.ok(!seen.some((s) => s.url === '/api/events'), 'no follow stream for a plain logs');
  server.close();
});
