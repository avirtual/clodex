'use strict';
// exec-verb.test.js — the type-aware `exec` verb and its --pty mode. A streaming stub
// node:http plays remote.js's routes: GET /api/sessions (the authoritative type lookup
// exec keys off), the attach/control/input PTY dance (bash), and the
// events/transcript/dm trio (agent). `sessions` names a session bash or claude.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');
const { RESOURCES_DOC } = require('./fixtures/resources-doc');
const { serverTranscriptPage } = require('./fixtures/transcript-page');

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
      if (req.method === 'GET' && p === '/api/resources') {
        res.writeHead(200); return res.end(JSON.stringify(RESOURCES_DOC));
      }
      if (req.method === 'GET' && p === '/api/sessions') {
        res.writeHead(200); return res.end(JSON.stringify({ ok: true, sessions }));
      }
      if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/attach(\?|$)/.test(p)) {
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
      if (req.method === 'GET' && opts.seats && /^\/api\/sessions\/[^/]+$/.test(p)) {
        const seat = opts.seats[decodeURIComponent(p.split('/')[3])];
        if (seat) { res.writeHead(200); return res.end(JSON.stringify({ ok: true, session: seat })); }
        res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: 'Session not found' }));
      }
      if (/^\/api\/sessions\/[^/]+\/control(\?|$)/.test(p)) {
        if (rec.body && rec.body.action === 'acquire') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, token: 'ctl-1' })); }
        res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
      }
      if (/^\/api\/sessions\/[^/]+\/input(\?|$)/.test(p)) {
        if (opts.onInput) opts.onInput(state, rec, seen);
        res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
      }
      if (/^\/api\/sessions\/[^/]+\/transcript$/.test(p)) {
        res.writeHead(200); return res.end(JSON.stringify(serverTranscriptPage((opts.transcript && opts.transcript(seen)) || [], req.url)));
      }
      if (/^\/api\/sessions\/[^/]+\/dm$/.test(p)) { res.writeHead(200); return res.end(JSON.stringify(opts.dmReply ? opts.dmReply() : { ok: true })); }
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
      if (seen.some((s) => /^\/api\/sessions\/[^/]+\/dm$/.test(s.url))) { clearInterval(iv); state.events.write(`event: activity\ndata: ${JSON.stringify({ name, state: 'idle', turnEnd: true })}\n\n`); }
    }, 20);
  };
}

// ── exec → agent (dm-and-wait path) ──────────────────────────────────────────

test('exec on a claude agent routes to dm-and-wait: /api/sessions/:name/dm hit, NOT sessions/input', async () => {
  let calls = 0;
  const { server, seen } = stub({
    sessions: [{ name: 'worker2', type: 'claude' }],
    onEventsOpen: endTurnWhenSent('worker2'),
    transcript: () => { calls++; return calls === 1 ? [] : [{ role: 'user', text: '2*3' }, { role: 'assistant', text: '6' }]; },
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['exec', 'worker2', '2*3', '--timeout', '10'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /\[assistant\] 6/);
  assert.doesNotMatch(stdout, /\[user\] 2\*3/);
  const urls = seen.map((s) => `${s.method} ${s.url.split('?')[0]}`);
  assert.ok(urls.includes('GET /api/sessions'), 'looked up the type');
  assert.ok(urls.some((u) => /^POST \/api\/sessions\/[^/]+\/dm$/.test(u)), 'used the dm path');
  assert.ok(urls.includes('GET /api/events'), 'awaited turn end');
  assert.ok(!urls.some((u) => /^POST \/api\/sessions\/[^/]+\/input$/.test(u)), 'never typed into the TUI');
  server.close();
});

test('exec on a codex agent also routes to dm-and-wait', async () => {
  let calls = 0;
  const { server, seen } = stub({
    sessions: [{ name: 'cx', type: 'codex' }],
    onEventsOpen: endTurnWhenSent('cx'),
    transcript: () => { calls++; return calls === 1 ? [] : [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }]; },
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['exec', 'cx', 'hi', '--timeout', '10'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /\[assistant\] yo/);
  assert.ok(!seen.some((s) => /^\/api\/sessions\/[^/]+\/input(\?|$)/.test(s.url)));
  server.close();
});

test('exec --json on an agent carries mode:"agent"', async () => {
  let calls = 0;
  const { server } = stub({
    sessions: [{ name: 'bob', type: 'claude' }],
    onEventsOpen: endTurnWhenSent('bob'),
    transcript: () => { calls++; return calls === 1 ? [] : [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }]; },
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['exec', 'bob', 'q', '-o', 'json', '--timeout', '10'], port);
  assert.strictEqual(code, 0);
  const j = JSON.parse(stdout);
  assert.strictEqual(j.mode, 'agent');
  assert.strictEqual(j.ok, true);
  assert.deepStrictEqual(j.entries, [{ role: 'assistant', text: 'a', seq: 1 }]);
  server.close();
});

// ── exec → bash (PTY path) ───────────────────────────────────────────────────

test('exec on a bash session routes to the PTY: attach + input hit, NOT the dm path', async () => {
  const { server, seen } = stub({
    sessions: [{ name: 'shell', type: 'bash' }],
    onInput: (state) => pushOutput(state.attach, '/work\r\n'),
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['exec', 'shell', 'pwd', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /\/work/);
  const urls = seen.map((s) => `${s.method} ${s.url.split('?')[0]}`);
  assert.ok(urls.includes('GET /api/sessions'), 'looked up the type');
  assert.ok(urls.includes('GET /api/sessions/shell/attach'), 'used the PTY attach path');
  assert.ok(urls.some((u) => u === 'POST /api/sessions/shell/input'), 'typed the command');
  assert.ok(!urls.some((u) => /^POST \/api\/sessions\/[^/]+\/dm$/.test(u)), 'never used the DM path');
  const inputRec = seen.find((s) => s.url === '/api/sessions/shell/input');
  assert.strictEqual(inputRec.body.data, 'pwd\r');
  server.close();
});

test('exec --json on a bash session carries mode:"pty"', async () => {
  const { server } = stub({
    sessions: [{ name: 'shell', type: 'bash' }],
    onInput: (state) => pushOutput(state.attach, 'hi\r\n'),
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['exec', 'shell', 'echo hi', '-o', 'json', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 0);
  const j = JSON.parse(stdout);
  assert.strictEqual(j.mode, 'pty');
  assert.strictEqual(j.name, 'shell');
  assert.match(j.output, /hi/);
  server.close();
});

// ── exec → unknown ───────────────────────────────────────────────────────────

test('exec on an unknown session → exit 5, lists the running names', async () => {
  const { server } = stub({ sessions: [{ name: 'shell', type: 'bash' }, { name: 'bob', type: 'claude' }] });
  const port = await listen(server);
  const { code, stderr } = await cli(['exec', 'ghost', 'hi'], port);
  assert.strictEqual(code, 5);
  assert.match(stderr, /no such session: ghost/);
  assert.match(stderr, /running: shell, bob/);
  server.close();
});

test('exec on a sleeping assistant resolves it by name and waits on the post-wake after= cursor', async () => {
  const dmSent = (seen) => seen.some((r) => r.method === 'POST' && r.url === '/api/sessions/asst/dm');
  const { server, seen } = stub({
    sessions: [{ name: 'bob', type: 'claude' }],
    seats: { asst: { name: 'asst', type: 'claude', class: 'assistant', state: 'asleep', activity: 'asleep' } },
    onEventsOpen: endTurnWhenSent('asst'),
    transcript: (seen) => (dmSent(seen)
      ? [{ role: 'user', text: 'hi', ts: new Date().toISOString() }, { role: 'assistant', text: 'awake now', ts: new Date().toISOString() }]
      : [{ role: 'user', text: 'old', ts: '2020-01-01T00:00:00.000Z' }, { role: 'assistant', text: 'old reply', ts: '2020-01-01T00:00:00.000Z' }]),
  });
  const port = await listen(server);
  const { code, stdout, stderr } = await cli(['exec', 'asst', 'hi', '--timeout', '10'], port);
  assert.strictEqual(code, 0, stderr);
  assert.match(stdout, /\[assistant\] awake now/);
  assert.doesNotMatch(stdout, /old reply/);
  const dmAt = seen.findIndex((r) => r.method === 'POST' && r.url === '/api/sessions/asst/dm');
  assert.ok(dmAt > 0, 'reached the dm');
  const reads = seen.filter((r) => r.url.startsWith('/api/sessions/asst/transcript'));
  assert.ok(reads.length > 0, 'read the transcript');
  for (const r of reads) {
    assert.ok(seen.indexOf(r) > dmAt, `transcript read after the wake dm: ${r.url}`);
    assert.match(r.url, /[?&]after=/);
    assert.doesNotMatch(r.url, /[?&]since=/);
  }
  server.close();
});

test('exec on a sleeper floors the after= cursor at the dm reply ts, so a server clock 30 s behind still yields the reply', async () => {
  const serverNow = () => new Date(Date.now() - 30000).toISOString();
  const dmSent = (seen) => seen.some((r) => r.method === 'POST' && r.url === '/api/sessions/asst/dm');
  const { server, seen } = stub({
    sessions: [{ name: 'bob', type: 'claude' }],
    seats: { asst: { name: 'asst', type: 'claude', class: 'assistant', state: 'asleep', activity: 'asleep' } },
    onEventsOpen: endTurnWhenSent('asst'),
    dmReply: () => ({ ok: true, ts: serverNow() }),
    transcript: (seen) => (dmSent(seen)
      ? [{ role: 'user', text: 'hi', ts: serverNow() }, { role: 'assistant', text: 'skewed reply', ts: serverNow() }]
      : [{ role: 'assistant', text: 'old reply', ts: '2020-01-01T00:00:00.000Z' }]),
  });
  try {
    const port = await listen(server);
    const { code, stdout, stderr } = await cli(['exec', 'asst', 'hi', '--timeout', '10'], port, { refetchGraceMs: 300 });
    assert.strictEqual(code, 0, stderr);
    assert.match(stdout, /\[assistant\] skewed reply/);
    assert.doesNotMatch(stdout, /old reply/);
    assert.ok(seen.some((r) => r.url.startsWith('/api/sessions/asst/transcript') && /[?&]after=/.test(r.url)), 'read with the after= cursor');
  } finally { server.close(); }
});

test('exec on a sleeper whose turn ends with no reply in the transcript exits non-zero, not a silent empty success', async () => {
  const { server } = stub({
    sessions: [{ name: 'bob', type: 'claude' }],
    seats: { asst: { name: 'asst', type: 'claude', class: 'assistant', state: 'asleep', activity: 'asleep' } },
    onEventsOpen: endTurnWhenSent('asst'),
    transcript: () => [{ role: 'assistant', text: 'old reply', ts: '2020-01-01T00:00:00.000Z' }],
  });
  try {
    const port = await listen(server);
    const { code, stdout, stderr } = await cli(['exec', 'asst', 'hi', '--timeout', '10'], port, { refetchGraceMs: 300 });
    assert.notStrictEqual(code, 0);
    assert.strictEqual(stdout, '');
    assert.match(stderr, /asst ended its turn but no reply after the wake reached the transcript/);
  } finally { server.close(); }
});

test('exec with no text → usage error', async () => {
  const { server } = stub({ sessions: [{ name: 'bob', type: 'claude' }] });
  const port = await listen(server);
  const { code, stderr } = await cli(['exec', 'bob'], port);
  assert.strictEqual(code, 2);
  assert.match(stderr, /exec needs text/);
  server.close();
});

// ── --pty: the explicit TUI-typing mode ──────────────────────────────────────

test('exec --pty on an agent types into the TUI instead of routing by type', async () => {
  const { server, seen } = stub({
    sessions: [{ name: 'worker2', type: 'claude' }],
    onInput: (state) => pushOutput(state.attach, 'y\r\n'),
  });
  const port = await listen(server);
  const { code } = await cli(['exec', 'worker2', 'y', '--pty', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 0);
  assert.ok(seen.some((s) => s.url === '/api/sessions/worker2/attach'), 'attached with --pty');
  assert.ok(seen.some((s) => s.url === '/api/sessions/worker2/input'), 'typed with --pty');
  assert.ok(!seen.some((s) => /^\/api\/sessions\/[^/]+\/dm$/.test(s.url)), 'never used the DM path');
  server.close();
});

test('exec --pty does not look the type up at all', async () => {
  const { server, seen } = stub({
    sessions: [],   // the lookup, if it ran, would be a NOTFOUND exit 5
    onInput: (state) => pushOutput(state.attach, 'ok\r\n'),
  });
  const port = await listen(server);
  const { code } = await cli(['exec', 'ghostly', 'y', '--pty', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 0, 'no type lookup, so an absent row cannot fail it');
  assert.ok(!seen.some((s) => s.url === '/api/sessions'), 'the type lookup never ran');
  server.close();
});

test('exec on a bash session takes the PTY path with no --pty needed', async () => {
  const { server, seen } = stub({
    sessions: [{ name: 'shell', type: 'bash' }],
    onInput: (state) => pushOutput(state.attach, 'ok\r\n'),
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['exec', 'shell', 'true', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /ok/);
  assert.ok(seen.some((s) => s.url === '/api/sessions/shell/attach'));
  server.close();
});

// ── dm: fire-and-forget only ─────────────────────────────────────────────────

test('dm --wait is a usage error naming exec, and sends nothing', async () => {
  const { server, seen } = stub({ sessions: [{ name: 'bob', type: 'claude' }] });
  const port = await listen(server);
  const { code, stderr } = await cli(['dm', 'bob', 'hi', '--wait'], port);
  assert.strictEqual(code, 2);
  assert.match(stderr, /dm has no --wait/);
  assert.match(stderr, /clodexctl exec/);
  assert.deepStrictEqual(seen, [], 'refused before any request');
  server.close();
});

test('dm without --wait posts to /dm and returns fire-and-forget', async () => {
  const { server, seen } = stub({ sessions: [{ name: 'bob', type: 'claude' }] });
  const port = await listen(server);
  const { code, stdout } = await cli(['dm', 'bob', 'hi'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /fire-and-forget/);
  assert.ok(seen.some((s) => s.url === '/api/sessions/bob/dm'), 'posted the DM');
  assert.ok(!seen.some((s) => s.url === '/api/events'), 'no events feed opened');
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
  assert.ok(seen.some((s) => s.url === '/api/sessions/worker2/input'), 'typed raw');
  server.close();
});
