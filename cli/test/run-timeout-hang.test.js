'use strict';
// run-timeout-hang.test.js — T46a. Pins that `--timeout` is a HARD ceiling on
// the WHOLE send --wait / run verb, on every transport, even when the engine
// never emits a turnEnd AND a wire request wedges forever (the live 6-minute
// hang: a "Not logged in" reply lands, no turnEnd is emitted, and the
// post-timeout transcript refetch hangs on a dead tunnel — so the verb never
// returns and the tunnel child is never reaped).
//
// The stub deliberately WEDGES specific routes (holds the response open,
// never ends it) to model a dead/broken engine. `io.refetchGraceMs` is the
// grace seam so the whole thing stays sub-2s; --timeout's floor is 1s.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');

const TOKEN = 'sekret';

// A streaming stub whose routes are individually configurable to WEDGE (hold
// open forever) so we can model a hung tunnel. Tracks sockets so the server can
// be force-closed even with wedged requests still held open.
function stub(opts = {}) {
  const seen = [];
  const sockets = new Set();
  const held = [];            // responses we intentionally never end
  const state = { events: null };
  const server = http.createServer((req, res) => {
    if ((req.headers['authorization'] || '') !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null };
      seen.push(rec);
      const p = req.url.split('?')[0];
      if (req.method === 'GET' && p === '/api/sessions') {
        res.writeHead(200); return res.end(JSON.stringify({ ok: true, sessions: opts.sessions || [{ name: 'bob', type: 'claude' }] }));
      }
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(': connected\n\n');
        state.events = res;
        if (opts.onEventsOpen) opts.onEventsOpen(state, seen);
        return; // held open — turnEnd only if the test pushes it
      }
      if (p.startsWith('/api/transcript/')) {
        const verdict = opts.transcript ? opts.transcript(seen) : [];
        if (verdict === 'hang') { held.push(res); return; }   // wedge: never respond
        res.writeHead(200); return res.end(JSON.stringify({ ok: true, messages: verdict || [] }));
      }
      if (p === '/api/send') {
        if (opts.sendHangs) { held.push(res); return; }
        res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'no route' }));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const close = () => { for (const s of sockets) { try { s.destroy(); } catch {} } try { server.close(); } catch {} };
  return { server, seen, state, close };
}

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

async function cli(argv, port, extra = {}) {
  let stdout = '', stderr = '';
  const code = await run([...argv, '--url', `http://127.0.0.1:${port}`, '--token', TOKEN], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {},
    contextsFile: path.join(os.tmpdir(), 'nonexistent-clodexctl', 'contexts.json'),
    refetchGraceMs: 150,   // keep the post-timeout grace sub-second
    ...extra,
  });
  return { code, stdout, stderr };
}

// ── the hang repros ──────────────────────────────────────────────────────────

test('run: no turnEnd + a WEDGED post-timeout refetch → still exits by ~timeout+grace (not a 6-minute hang)', { timeout: 10_000 }, async () => {
  // events open, no turnEnd is ever pushed; snapshot answers, send answers, but
  // every refetch hangs forever. Pre-fix: the refetch had no abort, so the verb
  // never returned and the process never exited. Post-fix: the grace deadline
  // aborts the wedged fetch and we exit 1 with the honest message.
  let calls = 0;
  const { server, close } = stub({
    sessions: [{ name: 'ftest', type: 'claude' }],
    transcript: () => { calls++; return calls === 1 ? [] : 'hang'; },
  });
  const port = await listen(server);
  const t0 = Date.now();
  const { code, stderr } = await cli(['run', 'ftest', 'hi', '--timeout', '1'], port);
  const elapsed = Date.now() - t0;
  assert.strictEqual(code, 1);
  assert.match(stderr, /no end-of-turn within 1s/);
  assert.ok(elapsed < 5000, `returned by ~timeout+grace, not a hang (took ${elapsed}ms)`);
  close();
});

test('send --wait: a WEDGED snapshot GET (timer would never arm inside onOpen) → still exits by the ceiling', { timeout: 10_000 }, async () => {
  // The snapshot GET hangs forever, so onOpen never reaches past its first
  // await. Pre-fix hardTimer was armed AFTER that await, so the ceiling never
  // armed → infinite wait. Post-fix the ceiling is armed before the stream and
  // independent of onOpen, so it fires, aborts the hung GET, and we exit 1.
  const { server, close } = stub({
    sessions: [{ name: 'ftest', type: 'claude' }],
    transcript: () => 'hang',   // snapshot AND every refetch wedge
  });
  const port = await listen(server);
  const t0 = Date.now();
  const { code, stderr } = await cli(['send', 'ftest', 'hi', '--wait', '--timeout', '1'], port);
  const elapsed = Date.now() - t0;
  assert.strictEqual(code, 1);
  assert.match(stderr, /no end-of-turn within 1s/);
  assert.ok(elapsed < 5000, `the ceiling fired despite a hung snapshot (took ${elapsed}ms)`);
  close();
});

test('run: no turnEnd but the reply IS in the transcript at timeout → prints it, THEN the honest timeout error', async () => {
  // The live case: a "Not logged in" assistant line lands but no turnEnd fires.
  // Deliverable 2's bonus — the post-timeout refetch still prints whatever
  // landed before surfacing the timeout error (exit 1, no turnEnd is honest).
  let calls = 0;
  const { server, close } = stub({
    sessions: [{ name: 'ftest', type: 'claude' }],
    transcript: () => {
      calls++;
      if (calls === 1) return [];   // snapshot: empty
      return [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Not logged in · Please run /login' }];
    },
  });
  const port = await listen(server);
  const { code, stdout, stderr } = await cli(['run', 'ftest', 'hi', '--timeout', '1'], port);
  assert.strictEqual(code, 1);
  assert.match(stdout, /Not logged in/);          // the landed reply IS printed
  assert.doesNotMatch(stdout, /\[user\] hi/);     // our echoed user row is not
  assert.match(stderr, /no end-of-turn within 1s/); // still honest: no turn ended
  close();
});

// ── regression guard: the ceiling machinery must not delay the happy path ─────

test('run: a normal turnEnd still returns promptly (grace/abort must not stall success)', async () => {
  let calls = 0;
  const { server, close } = stub({
    sessions: [{ name: 'bob', type: 'claude' }],
    onEventsOpen: (state, seen) => {
      const iv = setInterval(() => {
        if (seen.some((s) => s.url === '/api/send')) { clearInterval(iv); state.events.write(`event: activity\ndata: ${JSON.stringify({ name: 'bob', state: 'idle', turnEnd: true })}\n\n`); }
      }, 20);
    },
    transcript: () => { calls++; return calls === 1 ? [] : [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }]; },
  });
  const port = await listen(server);
  const t0 = Date.now();
  const { code, stdout } = await cli(['run', 'bob', 'q', '--timeout', '30'], port);
  const elapsed = Date.now() - t0;
  assert.strictEqual(code, 0);
  assert.match(stdout, /\[assistant\] a/);
  assert.ok(elapsed < 4000, `returned at turnEnd, not after any grace window (took ${elapsed}ms)`);
  close();
});
