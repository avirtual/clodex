'use strict';
// exec-wait.test.js — the SSE-driven verbs (exec, send --wait) end-to-end
// through main.run against a stub node:http server that plays remote.js's
// streaming routes: GET /api/attach/:name (replay + output frames), the
// control/input dance, GET /api/events (activity frames), and the
// transcript/send pair send --wait needs. Every request carries a Bearer
// token; the stub enforces it exactly like remote.js's gate.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');

const TOKEN = 'sekret';
const b64 = (s) => Buffer.from(s).toString('base64');

// A streaming stub. `opts` supplies per-route behaviour; the harness records
// every request and exposes the live attach/events responses so a test can push
// frames in reaction to an input POST.
function sseStub(opts = {}) {
  const seen = [];
  const state = { attach: null, events: null };
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
      // Type lookup for exec's agent guardrail (T36f). These fixtures all exec
      // against BASH sessions, so the guardrail must see type bash and proceed;
      // opts.sessions overrides for a specific case.
      if (req.method === 'GET' && p === '/api/sessions') {
        res.writeHead(200); return res.end(JSON.stringify({ ok: true, sessions: opts.sessions || [{ name: 'bash', type: 'bash' }] }));
      }
      // SSE routes
      if (req.method === 'GET' && p.startsWith('/api/attach/')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(': connected\n\n');
        res.write(`event: replay\ndata: ${JSON.stringify({ b64: b64('OLD SCROLLBACK\n'), cols: 80, rows: 24, holder: null })}\n\n`);
        state.attach = res;
        return; // held open
      }
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(': connected\n\n');
        state.events = res;
        if (opts.onEventsOpen) opts.onEventsOpen(state, seen);
        return; // held open
      }
      // JSON routes — delegate to opts.handle, else a sensible default.
      if (opts.handle && opts.handle(req, res, rec, state, seen)) return;
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

// ── exec ───────────────────────────────────────────────────────────────────

test('exec: replay discarded, control before input, output printed ANSI-stripped, control released', async () => {
  const { server, seen } = sseStub({
    onInput: (state, rec) => {
      // The command lands → the PTY echoes it, prints output, redraws prompt.
      const ESC = '\x1b';
      pushOutput(state.attach, `${ESC}[32m/work${ESC}[0m\r\n`);
    },
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['exec', 'bash', 'pwd', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 0);
  // ANSI stripped; scrollback replay NOT present
  assert.match(stdout, /\/work/);
  assert.doesNotMatch(stdout, /OLD SCROLLBACK/);
  assert.doesNotMatch(stdout, /\x1b\[/);
  const order = seen.map((s) => `${s.method} ${s.url}`);
  // type lookup (guardrail) first, then attach opens, control acquired before
  // input, released after
  assert.strictEqual(order[0], 'GET /api/sessions');
  const attachIdx = seen.findIndex((s) => s.url.startsWith('/api/attach/'));
  assert.ok(attachIdx >= 0 && order[attachIdx] === 'GET /api/attach/bash');
  const acquireIdx = seen.findIndex((s) => s.url.startsWith('/api/control/') && s.body && s.body.action === 'acquire');
  const inputIdx = seen.findIndex((s) => s.url.startsWith('/api/input/'));
  const releaseIdx = seen.findIndex((s) => s.url.startsWith('/api/control/') && s.body && s.body.action === 'release');
  assert.ok(acquireIdx >= 0 && inputIdx >= 0 && releaseIdx >= 0);
  assert.ok(acquireIdx < inputIdx, 'control acquired before input');
  assert.ok(inputIdx < releaseIdx, 'control released after input');
  // input carried the command + Enter with the acquired token
  assert.strictEqual(seen[inputIdx].body.data, 'pwd\r');
  assert.strictEqual(seen[inputIdx].body.token, 'ctl-1');
  server.close();
});

test('exec --raw: keeps the ANSI bytes verbatim', async () => {
  const ESC = '\x1b';
  const { server } = sseStub({ onInput: (state) => pushOutput(state.attach, `${ESC}[1mBOLD${ESC}[0m\r\n`) });
  const port = await listen(server);
  const { code, stdout } = await cli(['exec', 'bash', 'x', '--raw', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /\x1b\[1mBOLD/);
  server.close();
});

test('exec --json: {ok,name,output,truncated} shape', async () => {
  const { server } = sseStub({ onInput: (state) => pushOutput(state.attach, 'hi\r\n') });
  const port = await listen(server);
  const { code, stdout } = await cli(['exec', 'bash', 'echo hi', '--json', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 0);
  const j = JSON.parse(stdout);
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.name, 'bash');
  assert.strictEqual(j.truncated, false);
  assert.match(j.output, /hi/);
  server.close();
});

test('exec quiet-gate: returns at the gate after silence, not at timeout', async () => {
  const { server } = sseStub({
    onInput: (state) => {
      pushOutput(state.attach, 'part1 ');
      setTimeout(() => pushOutput(state.attach, 'part2\r\n'), 40); // within the gate window → resets it
    },
  });
  const port = await listen(server);
  const t0 = Date.now();
  const { code, stdout } = await cli(['exec', 'bash', 'x', '--quiet-ms', '120', '--timeout', '30'], port);
  const elapsed = Date.now() - t0;
  assert.strictEqual(code, 0);
  assert.match(stdout, /part1 part2/);
  assert.ok(elapsed < 5000, `returned at the quiet gate, not the 30s timeout (took ${elapsed}ms)`);
  server.close();
});

test('exec timeout: never-quiet stream → partial output + exit 1', async () => {
  let iv;
  const { server } = sseStub({
    onInput: (state) => { iv = setInterval(() => { try { pushOutput(state.attach, 'tick '); } catch {} }, 60); },
  });
  const port = await listen(server);
  const { code, stdout, stderr } = await cli(['exec', 'bash', 'yes', '--timeout', '1', '--quiet-ms', '5000'], port);
  clearInterval(iv);
  assert.strictEqual(code, 1);
  assert.match(stdout, /tick/);                 // partial output printed
  assert.match(stderr, /no quiet within 1s/);
  server.close();
});

test('exec: input 403 mid-flight → control release attempted, no hang, coded error', async () => {
  const { server, seen } = sseStub({
    handle: (req, res, rec, state) => {
      if (req.url.startsWith('/api/input/')) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not the control holder' })); return true; }
      return false;
    },
  });
  const port = await listen(server);
  const { code, stderr } = await cli(['exec', 'bash', 'x', '--quiet-ms', '80'], port);
  assert.strictEqual(code, 4); // 403 → AUTH
  assert.match(stderr, /not the control holder/);
  // release still attempted after the failure
  assert.ok(seen.some((s) => s.url.startsWith('/api/control/') && s.body && s.body.action === 'release'));
  server.close();
});

// ── send --wait ──────────────────────────────────────────────────────────────

test('send --wait: busy→turnEnd → new entries printed, snapshot respected', async () => {
  let calls = 0;
  const { server, seen } = sseStub({
    onEventsOpen: (state) => {
      // After the send lands, fire a turn-end activity for our session.
      const iv = setInterval(() => {
        if (seen.some((s) => s.url === '/api/send')) {
          clearInterval(iv);
          state.events.write(`event: activity\ndata: ${JSON.stringify({ name: 'other', state: 'idle', turnEnd: true })}\n\n`); // ignored
          state.events.write(`event: activity\ndata: ${JSON.stringify({ name: 'bob', state: 'idle', turnEnd: true })}\n\n`);
        }
      }, 20);
    },
    transcript: () => {
      // First fetch (snapshot) = 2 old entries; refetch = old + our echo + reply
      calls++;
      if (calls === 1) return [{ role: 'user', text: 'old1' }, { role: 'assistant', text: 'old2' }];
      return [
        { role: 'user', text: 'old1' }, { role: 'assistant', text: 'old2' },
        { role: 'user', text: 'do the thing' }, { role: 'assistant', text: 'done it' },
      ];
    },
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['send', 'bob', 'do', 'the', 'thing', '--wait', '--timeout', '10'], port);
  assert.strictEqual(code, 0);
  // Only the assistant reply printed — our echoed user message + old entries excluded
  assert.match(stdout, /\[assistant\] done it/);
  assert.doesNotMatch(stdout, /old1|old2|do the thing/);
  server.close();
});

test('send --wait: turnEnd for a different session is ignored (times out)', async () => {
  const { server } = sseStub({
    onEventsOpen: (state, seen) => {
      const iv = setInterval(() => {
        if (seen.some((s) => s.url === '/api/send')) {
          clearInterval(iv);
          // Only OTHER sessions end their turn — ours never does.
          state.events.write(`event: activity\ndata: ${JSON.stringify({ name: 'someoneelse', state: 'idle', turnEnd: true })}\n\n`);
        }
      }, 20);
    },
    transcript: () => [{ role: 'user', text: 'x' }],
  });
  const port = await listen(server);
  const { code, stderr } = await cli(['send', 'bob', 'hi', '--wait', '--timeout', '1'], port);
  assert.strictEqual(code, 1);
  assert.match(stderr, /no end-of-turn within 1s/);
  server.close();
});

test('send --wait: transcript flush lags turnEnd → retries, never prints a bare echoed user row', async () => {
  // Repro of Bogdan's live bug: the assistant entry is NOT yet persisted when
  // turnEnd fires; the refetch initially sees only our echoed user message.
  let calls = 0;
  const { server, seen } = sseStub({
    onEventsOpen: (state, seen) => {
      const iv = setInterval(() => {
        if (seen.some((s) => s.url === '/api/send')) { clearInterval(iv); state.events.write(`event: activity\ndata: ${JSON.stringify({ name: 'murmur', state: 'idle', turnEnd: true })}\n\n`); }
      }, 20);
    },
    transcript: () => {
      calls++;
      if (calls === 1) return []; // snapshot: empty
      if (calls === 2) return [{ role: 'user', text: '2+3' }]; // flush lag: only the echo
      return [{ role: 'user', text: '2+3' }, { role: 'assistant', text: '5' }]; // assistant landed
    },
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['send', 'murmur', '2+3', '--wait', '--timeout', '10'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /\[assistant\] 5/);
  assert.doesNotMatch(stdout, /\[user\] 2\+3/); // the echoed user row is never printed
  assert.ok(calls >= 3, 'refetched more than once after the flush lag');
  server.close();
});

test('send --wait --json: {ok,name,entries,timedOut} shape', async () => {
  let calls = 0;
  const { server } = sseStub({
    onEventsOpen: (state, seen) => {
      const iv = setInterval(() => {
        if (seen.some((s) => s.url === '/api/send')) { clearInterval(iv); state.events.write(`event: activity\ndata: ${JSON.stringify({ name: 'bob', state: 'idle', turnEnd: true })}\n\n`); }
      }, 20);
    },
    transcript: () => { calls++; return calls === 1 ? [] : [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }]; },
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['send', 'bob', 'q', '--wait', '--json', '--timeout', '10'], port);
  assert.strictEqual(code, 0);
  const j = JSON.parse(stdout);
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.name, 'bob');
  assert.strictEqual(j.timedOut, false);
  assert.deepStrictEqual(j.entries, [{ role: 'assistant', text: 'a' }]);
  server.close();
});

test('send without --wait: unchanged fire-and-forget', async () => {
  const { server, seen } = sseStub({});
  const port = await listen(server);
  const { code, stdout } = await cli(['send', 'bob', 'hi'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /fire-and-forget/);
  assert.deepStrictEqual(seen.map((s) => s.url), ['/api/send']); // no events feed opened
  server.close();
});
