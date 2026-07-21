'use strict';
// run-verb.test.js — the type-aware `run` verb and the exec-on-agent guardrail.
// A streaming stub node:http server plays remote.js's routes: GET /api/sessions
// (the authoritative type lookup run/exec key off), the attach/control/input
// PTY dance (bash path), and the events/transcript/send trio (agent path).
// `sessions` is configurable per test so we can name a session bash or claude.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');

const TOKEN = 'sekret';
const b64 = (s) => Buffer.from(s).toString('base64');

// A streaming stub. opts.sessions = the /api/sessions list. opts.onInput /
// opts.onEventsOpen push frames in reaction. Records every request in `seen`.
function stub(opts = {}) {
  const seen = [];
  const state = { attach: null, events: null };
  const sessions = opts.sessions || [];
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
        res.writeHead(200); return res.end(JSON.stringify({ ok: true, sessions }));
      }
      if (req.method === 'GET' && p.startsWith('/api/attach/')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(': connected\n\n');
        state.attach = res;
        return;
      }
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(': connected\n\n');
        state.events = res;
        if (opts.onEventsOpen) opts.onEventsOpen(state, seen);
        return;
      }
      if (p.startsWith('/api/control/')) {
        if (rec.body && rec.body.action === 'acquire') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, token: 'ctl-1' })); }
        res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
      }
      if (p.startsWith('/api/input/')) {
        if (opts.onInput) opts.onInput(state, rec, seen);
        res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
      }
      if (p.startsWith('/api/transcript/')) {
        res.writeHead(200); return res.end(JSON.stringify({ ok: true, messages: (opts.transcript && opts.transcript(seen)) || [] }));
      }
      if (p === '/api/send') { res.writeHead(200); return res.end(JSON.stringify({ ok: true })); }
      res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'no route' }));
    });
  });
  return { server, seen, state };
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
    ...extra,
  });
  return { code, stdout, stderr };
}

function pushOutput(res, s) { res.write(`event: output\ndata: ${JSON.stringify({ b64: b64(s) })}\n\n`); }
function endTurnWhenSent(name) {
  return (state, seen) => {
    const iv = setInterval(() => {
      if (seen.some((s) => s.url === '/api/send')) { clearInterval(iv); state.events.write(`event: activity\ndata: ${JSON.stringify({ name, state: 'idle', turnEnd: true })}\n\n`); }
    }, 20);
  };
}

// ── run → agent (send-wait path) ─────────────────────────────────────────────

test('run on a claude agent routes to send-wait: /api/send hit, NOT /api/input', async () => {
  let calls = 0;
  const { server, seen } = stub({
    sessions: [{ name: 'worker2', type: 'claude' }],
    onEventsOpen: endTurnWhenSent('worker2'),
    transcript: () => { calls++; return calls === 1 ? [] : [{ role: 'user', text: '2*3' }, { role: 'assistant', text: '6' }]; },
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['run', 'worker2', '2*3', '--timeout', '10'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /\[assistant\] 6/);
  assert.doesNotMatch(stdout, /\[user\] 2\*3/);
  const urls = seen.map((s) => `${s.method} ${s.url.split('?')[0]}`);
  assert.ok(urls.includes('GET /api/sessions'), 'looked up the type');
  assert.ok(urls.includes('POST /api/send'), 'used the send path');
  assert.ok(urls.includes('GET /api/events'), 'awaited turn end');
  assert.ok(!urls.some((u) => u.startsWith('POST /api/input/')), 'never typed into the TUI');
  server.close();
});

test('run on a codex agent also routes to send-wait', async () => {
  let calls = 0;
  const { server, seen } = stub({
    sessions: [{ name: 'cx', type: 'codex' }],
    onEventsOpen: endTurnWhenSent('cx'),
    transcript: () => { calls++; return calls === 1 ? [] : [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }]; },
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['run', 'cx', 'hi', '--timeout', '10'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /\[assistant\] yo/);
  assert.ok(!seen.some((s) => s.url.startsWith('/api/input/')));
  server.close();
});

test('run --json on an agent carries mode:"agent"', async () => {
  let calls = 0;
  const { server } = stub({
    sessions: [{ name: 'bob', type: 'claude' }],
    onEventsOpen: endTurnWhenSent('bob'),
    transcript: () => { calls++; return calls === 1 ? [] : [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }]; },
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['run', 'bob', 'q', '--json', '--timeout', '10'], port);
  assert.strictEqual(code, 0);
  const j = JSON.parse(stdout);
  assert.strictEqual(j.mode, 'agent');
  assert.strictEqual(j.ok, true);
  assert.deepStrictEqual(j.entries, [{ role: 'assistant', text: 'a' }]);
  server.close();
});

// ── run → bash (exec path) ───────────────────────────────────────────────────

test('run on a bash session routes to exec: attach + input hit, NOT /api/send', async () => {
  const { server, seen } = stub({
    sessions: [{ name: 'shell', type: 'bash' }],
    onInput: (state) => pushOutput(state.attach, '/work\r\n'),
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['run', 'shell', 'pwd', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /\/work/);
  const urls = seen.map((s) => `${s.method} ${s.url.split('?')[0]}`);
  assert.ok(urls.includes('GET /api/sessions'), 'looked up the type');
  assert.ok(urls.includes('GET /api/attach/shell'), 'used the PTY attach path');
  assert.ok(urls.some((u) => u === 'POST /api/input/shell'), 'typed the command');
  assert.ok(!urls.includes('POST /api/send'), 'never used the DM path');
  const inputRec = seen.find((s) => s.url === '/api/input/shell');
  assert.strictEqual(inputRec.body.data, 'pwd\r');
  server.close();
});

test('run --json on a bash session carries mode:"pty"', async () => {
  const { server } = stub({
    sessions: [{ name: 'shell', type: 'bash' }],
    onInput: (state) => pushOutput(state.attach, 'hi\r\n'),
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['run', 'shell', 'echo hi', '--json', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 0);
  const j = JSON.parse(stdout);
  assert.strictEqual(j.mode, 'pty');
  assert.strictEqual(j.name, 'shell');
  assert.match(j.output, /hi/);
  server.close();
});

// ── run → unknown ────────────────────────────────────────────────────────────

test('run on an unknown session → exit 5, lists the running names', async () => {
  const { server } = stub({ sessions: [{ name: 'shell', type: 'bash' }, { name: 'bob', type: 'claude' }] });
  const port = await listen(server);
  const { code, stderr } = await cli(['run', 'ghost', 'hi'], port);
  assert.strictEqual(code, 5);
  assert.match(stderr, /no such session: ghost/);
  assert.match(stderr, /running: shell, bob/);
  server.close();
});

test('run with no text → usage error', async () => {
  const { server } = stub({ sessions: [{ name: 'bob', type: 'claude' }] });
  const port = await listen(server);
  const { code, stderr } = await cli(['run', 'bob'], port);
  assert.strictEqual(code, 2);
  assert.match(stderr, /run needs text/);
  server.close();
});

// ── exec-on-agent guardrail ──────────────────────────────────────────────────

test('exec on an agent refuses without --pty: warns on stderr, exit 2, no typing', async () => {
  const { server, seen } = stub({ sessions: [{ name: 'worker2', type: 'claude' }] });
  const port = await listen(server);
  const { code, stderr } = await cli(['exec', 'worker2', '2*3', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 2);
  assert.match(stderr, /worker2 is a claude agent/);
  assert.match(stderr, /Pass --pty/);
  // it looked up the type but never attached/typed
  assert.ok(seen.some((s) => s.url === '/api/sessions'));
  assert.ok(!seen.some((s) => s.url.startsWith('/api/attach/')), 'did not attach');
  assert.ok(!seen.some((s) => s.url.startsWith('/api/input/')), 'did not type');
  server.close();
});

test('exec --pty on an agent proceeds (chosen TUI typing)', async () => {
  const { server, seen } = stub({
    sessions: [{ name: 'worker2', type: 'claude' }],
    onInput: (state) => pushOutput(state.attach, 'y\r\n'),
  });
  const port = await listen(server);
  const { code } = await cli(['exec', 'worker2', 'y', '--pty', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 0);
  assert.ok(seen.some((s) => s.url === '/api/attach/worker2'), 'attached with --pty');
  assert.ok(seen.some((s) => s.url === '/api/input/worker2'), 'typed with --pty');
  server.close();
});

test('exec on a bash session is unaffected by the guardrail (no --pty needed)', async () => {
  const { server, seen } = stub({
    sessions: [{ name: 'shell', type: 'bash' }],
    onInput: (state) => pushOutput(state.attach, 'ok\r\n'),
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['exec', 'shell', 'true', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /ok/);
  assert.ok(seen.some((s) => s.url === '/api/attach/shell'));
  server.close();
});

test('exec --json on an agent without --pty still refuses (exit 2, warning on stderr)', async () => {
  const { server } = stub({ sessions: [{ name: 'a', type: 'codex' }] });
  const port = await listen(server);
  const { code, stdout, stderr } = await cli(['exec', 'a', 'x', '--json', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 2);
  assert.match(stderr, /is a codex agent/);
  assert.strictEqual(stdout, '');   // nothing printed to stdout
  server.close();
});

// ── input is deliberately UNCHANGED (no guardrail) ───────────────────────────

test('input on an agent is unchanged — no type lookup, no guardrail, just types', async () => {
  const { server, seen } = stub({ sessions: [{ name: 'worker2', type: 'claude' }] });
  const port = await listen(server);
  const { code, stdout } = await cli(['input', 'worker2', 'hello'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /input sent to worker2/);
  // input does NOT consult /api/sessions — it's the raw plumbing channel
  assert.ok(!seen.some((s) => s.url === '/api/sessions'), 'input never looks up the type');
  assert.ok(seen.some((s) => s.url === '/api/input/worker2'), 'typed raw');
  server.close();
});
