'use strict';
// logs-follow.test.js — `logs NAME -f` end-to-end through main.run against a
// stub that plays the transcript subresource (tail + refetch) and /api/events (activity
// frames that trigger a delta refetch). Asserts: tail first, then only the new
// entries on each activity; no duplicate lines across a forced reconnect; NDJSON
// under --json; Ctrl-C (a fake signal) exits 0.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');
const sseGuard = require('../src/sse-guard');
const { RESOURCES_DOC, docWithout } = require('./fixtures/resources-doc');
const { serverTranscriptPage } = require('./fixtures/transcript-page');

const TOKEN = 'sekret';

// The transcript grows over the test; `script` is an array of message-arrays,
// one per successive transcript GET.
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
      if (req.method === 'GET' && p === '/api/resources') {
        res.writeHead(200); return res.end(JSON.stringify(opts.resources || RESOURCES_DOC));
      }
      if (req.method === 'GET' && p === '/api/peer/hello') {
        res.writeHead(200); return res.end(JSON.stringify({ ok: true, host: 'oldbox', version: '5.69.0', caps: ['transcript'] }));
      }
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': connected\n\n');
        state.events = res;
        return;
      }
      if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/transcript$/.test(p)) {
        // Each call returns the next scripted snapshot (last one sticks).
        const i = tIdx++;
        const msgs = opts.transcript ? opts.transcript(i, seen) : [];
        const page = opts.page ? opts.page(msgs, req.url) : serverTranscriptPage(msgs, req.url);
        if (opts.onServed) res.on('finish', () => opts.onServed(i, state));
        const status = opts.status ? opts.status(i) : 200;
        if (status !== 200) { res.writeHead(status); return res.end(JSON.stringify({ ok: false, error: 'boom' })); }
        res.writeHead(200); return res.end(JSON.stringify(page));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return { server, seen, state };
}

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
async function serve(t, stub) {
  t.after(() => { stub.server.closeAllConnections(); stub.server.close(); });
  return listen(stub.server);
}
function activity(res, name) { res.write(`event: activity\ndata: ${JSON.stringify({ name, state: 'idle', turnEnd: true })}\n\n`); }

// A signal seam so a test can deliver Ctrl-C deterministically.
function fakeSignalTty() {
  const sigL = new Set();
  return { tty: { onSignal: (fn) => { sigL.add(fn); return () => sigL.delete(fn); } }, signal: () => [...sigL].forEach((fn) => fn()) };
}

function parkedTimers() {
  const parked = new Set();
  return {
    parked,
    setTimeout(fn, ms) {
      if (ms > 0) { const h = { fn, ms }; parked.add(h); return h; }
      return { immediate: setImmediate(fn) };
    },
    clearTimeout(h) { if (!h) return; if (h.immediate) clearImmediate(h.immediate); parked.delete(h); },
  };
}

const FOLLOW = { timeout: 30000 };

function follow(argv, port, sig, stopWhen) {
  return cli(argv, port, {
    tty: sig.tty,
    followGuard: { backoff: [0, 0, 0], timers: parkedTimers() },
    onStdout: (out) => { if (stopWhen(out)) queueMicrotask(sig.signal); },
  });
}

async function cli(argv, port, extra = {}) {
  let stdout = '', stderr = '';
  const { onStdout, ...io } = extra;
  const code = await run([...argv, '--url', `http://127.0.0.1:${port}`, '--token', TOKEN], {
    stdout: (s) => { stdout += s; if (onStdout) onStdout(stdout); }, stderr: (s) => (stderr += s),
    env: {}, contextsFile: path.join(os.tmpdir(), 'nonexistent-clodexctl', 'contexts.json'),
    ...io,
  });
  return { code, stdout, stderr };
}

test('logs -f: prints the tail, then only the delta on an activity frame', FOLLOW, async (t) => {
  const sig = fakeSignalTty();
  const stub = followStub({
    onServed: (i, state) => { if (i === 1) activity(state.events, 'bob'); },
    transcript: (i) => {
      // 0: tail (logs), 1: onOpen resnapshot, 2+: refetch after activity
      if (i <= 1) return [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }];
      return [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }, { role: 'user', text: 'q2' }, { role: 'assistant', text: 'a2' }];
    },
  });
  const port = await serve(t, stub);
  const { code, stdout } = await follow(['logs', 'bob', '-f'], port, sig, (out) => /a2/.test(out));
  assert.strictEqual(code, 0);
  // Tail present exactly once; delta appended; no dup of the tail entries.
  assert.match(stdout, /\[assistant\] a1/);
  assert.match(stdout, /\[assistant\] a2/);
  assert.strictEqual((stdout.match(/a1/g) || []).length, 1, 'tail entry not duplicated');
  assert.ok(stdout.indexOf('a1') < stdout.indexOf('a2'), 'delta after tail');
});

test('logs -f --json: NDJSON, one object per entry (tail + delta), never a growing array', FOLLOW, async (t) => {
  const sig = fakeSignalTty();
  const stub = followStub({
    onServed: (i, state) => { if (i === 1) activity(state.events, 'bob'); },
    transcript: (i) => (i <= 1 ? [{ role: 'user', text: 'q1' }] : [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a2' }]),
  });
  const port = await serve(t, stub);
  const { code, stdout } = await follow(['logs', 'bob', '-f', '-o', 'json'], port, sig, (out) => /"a2"/.test(out));
  assert.strictEqual(code, 0);
  const lines = stdout.trim().split('\n').filter(Boolean);
  // Each line parses as its own object (NDJSON), not a single array.
  const objs = lines.map((l) => JSON.parse(l));
  assert.ok(objs.every((o) => o && typeof o === 'object' && !Array.isArray(o)));
  assert.deepStrictEqual(objs[0], { role: 'user', text: 'q1', seq: 0 });
  assert.ok(objs.some((o) => o.role === 'assistant' && o.text === 'a2'));
});

test('logs -f: no duplicate lines across a forced reconnect (re-snapshot silent)', FOLLOW, async (t) => {
  const sig = fakeSignalTty();
  const stub = followStub({
    onServed: (i, state) => {
      if (i === 1) state.events.end();
      if (i === 2) activity(state.events, 'bob');
    },
    transcript: (i) => {
      // Snapshot stays 2 entries across the reconnect; a new one appears only
      // after the post-reconnect activity. A reconnect that re-printed the tail
      // would duplicate a1.
      if (i <= 2) return [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }];
      return [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }, { role: 'assistant', text: 'a2' }];
    },
  });
  const port = await serve(t, stub);
  const { code, stdout } = await follow(['logs', 'bob', '-f'], port, sig, (out) => /a2/.test(out));
  assert.strictEqual(code, 0);
  assert.strictEqual((stdout.match(/a1/g) || []).length, 1, 'no dup across reconnect');
  assert.match(stdout, /a2/);
  assert.strictEqual(stub.seen.filter((s) => s.url === '/api/events').length, 2, 'the stream really did reconnect');
});

test('logs -f: Ctrl-C exits 0 (pager, not a failure)', FOLLOW, async (t) => {
  const sig = fakeSignalTty();
  const stub = followStub({
    onServed: (i) => { if (i === 1) sig.signal(); },
    transcript: () => [{ role: 'user', text: 'q1' }],
  });
  const port = await serve(t, stub);
  const { code } = await follow(['logs', 'bob', '-f'], port, sig, () => false);
  assert.strictEqual(code, 0);
});

const bulk = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `old${i}` }));
const transcriptUrls = (seen) => seen.filter((s) => /\/transcript(\?|$)/.test(s.url)).map((s) => s.url);
const pairsOf = (url) => [...new URL(url, 'http://x').searchParams.entries()];

test('logs -f: a 600-entry transcript still prints the new entry — the cursor is seq, not a count', FOLLOW, async (t) => {
  const sig = fakeSignalTty();
  const OLD = bulk(600);
  const stub = followStub({
    onServed: (i, state) => { if (i === 1) activity(state.events, 'bob'); },
    transcript: (i) => (i <= 1 ? OLD : [...OLD, { role: 'assistant', text: 'brand new' }]),
  });
  const port = await serve(t, stub);
  const { code, stdout } = await follow(['logs', 'bob', '-f'], port, sig, (out) => /brand new/.test(out));
  assert.strictEqual(code, 0);
  assert.match(stdout, /\[assistant\] brand new/);
  assert.strictEqual((stdout.match(/old599/g) || []).length, 1, 'the tail entry printed once, not re-printed by the refetch');
});

test('logs -f: the refetch asks for since=<lastSeq+1> of the page it last emitted', FOLLOW, async (t) => {
  const sig = fakeSignalTty();
  const OLD = bulk(600);
  const stub = followStub({
    onServed: (i, state) => { if (i === 1) activity(state.events, 'bob'); },
    transcript: (i) => (i <= 1 ? OLD : [...OLD, { role: 'assistant', text: 'brand new' }]),
  });
  const port = await serve(t, stub);
  const { code } = await follow(['logs', 'bob', '-f'], port, sig, (out) => /brand new/.test(out));
  assert.strictEqual(code, 0);
  const urls = transcriptUrls(stub.seen);
  assert.ok(urls.length >= 3, 'tail, resnapshot and at least one refetch');
  const refetch = urls[urls.length - 1];
  const pairs = pairsOf(refetch);
  assert.ok(pairs.length >= 1, 'the refetch URL parsed into at least one query pair');
  assert.deepStrictEqual(pairs, [['since', '600'], ['limit', '500']], 'the initial tail ended at seq 599');
});

test('logs -f: the reconnect re-snapshot asks with since too, and prints no duplicate', FOLLOW, async (t) => {
  const sig = fakeSignalTty();
  const OLD = bulk(600);
  const stub = followStub({
    onServed: (i, state) => {
      if (i === 1) state.events.end();
      if (i === 2) activity(state.events, 'bob');
    },
    transcript: (i) => (i <= 2 ? OLD : [...OLD, { role: 'assistant', text: 'after reconnect' }]),
  });
  const { seen } = stub;
  const port = await serve(t, stub);
  const { code, stdout } = await follow(['logs', 'bob', '-f'], port, sig, (out) => /after reconnect/.test(out));
  assert.strictEqual(code, 0);
  assert.match(stdout, /\[assistant\] after reconnect/);
  assert.strictEqual((stdout.match(/old599/g) || []).length, 1, 'no dup across reconnect');
  const eventsOpens = seen.filter((s) => s.url === '/api/events').length;
  assert.strictEqual(eventsOpens, 2, 'the stream really did reconnect');
  const resnapshots = seen
    .map((s, i) => (s.url === '/api/events' ? seen.slice(i + 1).find((r) => /\/transcript\?/.test(r.url)) : null))
    .filter(Boolean)
    .map((s) => s.url);
  assert.strictEqual(resnapshots.length, 2, 'the first open and the reconnect each re-snapshotted');
  for (const u of resnapshots) assert.deepStrictEqual(pairsOf(u), [['since', '600'], ['limit', '500']]);
});

test('logs -f: a restart that repoints the transcript re-anchors the cursor DOWN and keeps following', FOLLOW, async (t) => {
  const sig = fakeSignalTty();
  const OLD = bulk(600);
  const FRESH = [{ role: 'user', text: 'boot' }, { role: 'assistant', text: 'reborn' }, { role: 'user', text: 'again' }];
  let restarted = false;
  let probed = false;
  const stub = followStub({
    onServed: (i, state) => {
      if (i === 1) restarted = true;
      if (i === 1 || i === 2 || i === 4) activity(state.events, 'bob');
    },
    transcript: (i, seen) => {
      if (!restarted) return OLD;
      if (/limit=1(&|$)/.test(seen[seen.length - 1].url)) { probed = true; return FRESH; }
      return probed ? [...FRESH, { role: 'assistant', text: 'post restart reply' }] : FRESH;
    },
  });
  const port = await serve(t, stub);
  const { code, stdout } = await follow(['logs', 'bob', '-f'], port, sig, (out) => /post restart reply/.test(out));
  assert.strictEqual(code, 0);
  assert.match(stdout, /\[assistant\] post restart reply/, 'the reply on the replacement transcript printed');
  assert.doesNotMatch(stdout, /reborn/, 're-anchoring is silent — the replacement transcript is not re-printed');
  assert.strictEqual((stdout.match(/old599/g) || []).length, 1, 'the pre-restart tail printed once');
  const probes = transcriptUrls(stub.seen).filter((u) => /limit=1(&|$)/.test(u));
  assert.strictEqual(probes.length, 1, 'exactly one tail probe — the streak resets once the cursor re-anchors');
  assert.deepStrictEqual(pairsOf(probes[0]), [['limit', '1']], 'the probe asks for the real tail, with no since');
});

test('logs -f: a quiet activity frame on an unchanged transcript does not probe the tail', FOLLOW, async (t) => {
  const sig = fakeSignalTty();
  const OLD = bulk(600);
  const stub = followStub({
    onServed: (i, state) => { if (i === 1 || i === 2) activity(state.events, 'bob'); },
    transcript: (i) => (i <= 2 ? OLD : [...OLD, { role: 'assistant', text: 'next reply' }]),
  });
  const port = await serve(t, stub);
  const { code, stdout } = await follow(['logs', 'bob', '-f'], port, sig, (out) => /next reply/.test(out));
  assert.strictEqual(code, 0);
  assert.strictEqual((stdout.match(/old599/g) || []).length, 1, 'nothing new, nothing re-printed');
  const probes = transcriptUrls(stub.seen).filter((u) => /limit=1(&|$)/.test(u));
  assert.strictEqual(probes.length, 0, 'one empty page is under the streak threshold — no extra request');
});

function legacyStub(opts) {
  return followStub({ ...opts, page: (msgs) => ({ ok: true, messages: msgs.slice(-500) }) });
}

test('logs -f: a node serving no seq falls back to the count delta, not a full-tail re-print', FOLLOW, async (t) => {
  const sig = fakeSignalTty();
  const q1 = { role: 'user', text: 'q1' };
  const a1 = { role: 'assistant', text: 'a1' };
  const a2 = { role: 'assistant', text: 'a2' };
  const stub = legacyStub({
    onServed: (i, state) => { if (i >= 1 && i <= 3) activity(state.events, 'bob'); },
    transcript: (i) => (i <= 1 ? [q1, a1] : i <= 3 ? [q1, a1, a2] : [q1, a1, a2, { role: 'assistant', text: 'a3' }]),
  });
  const port = await serve(t, stub);
  const { code, stdout } = await follow(['logs', 'bob', '-f'], port, sig, (out) => /a3/.test(out));
  assert.strictEqual(code, 0);
  assert.strictEqual((stdout.match(/a1/g) || []).length, 1, 'the old entries are not re-printed on every frame');
  assert.strictEqual((stdout.match(/a2/g) || []).length, 1, 'the new entry printed exactly once');
});

test('logs -f: without the followGuard seam the follow reaches openGuarded with the shipped BACKOFF and STALE_MS', FOLLOW, async (t) => {
  const real = sseGuard.openGuarded;
  t.after(() => { sseGuard.openGuarded = real; });
  const calls = [];
  const sig = fakeSignalTty();
  sseGuard.openGuarded = (client, pathAndQuery, verb, opts) => {
    calls.push(opts);
    queueMicrotask(sig.signal);
    return { close() {} };
  };
  const stub = followStub({ transcript: () => [{ role: 'user', text: 'q1' }] });
  const port = await serve(t, stub);
  assert.strictEqual((await cli(['logs', 'bob', '-f'], port, { tty: sig.tty })).code, 0);
  const seam = { backoff: [0, 0, 0], timers: parkedTimers() };
  assert.strictEqual((await cli(['logs', 'bob', '-f'], port, { tty: sig.tty, followGuard: seam })).code, 0);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].backoff, sseGuard.BACKOFF);
  assert.strictEqual(calls[0].staleMs, sseGuard.STALE_MS);
  assert.strictEqual(calls[0].timers.setTimeout, setTimeout);
  assert.strictEqual(calls[1].backoff, seam.backoff);
  assert.strictEqual(calls[1].timers, seam.timers);
  assert.strictEqual(calls[1].staleMs, sseGuard.STALE_MS);
});

test('logs: a node whose sessions row carries no transcript subresource is the D.5 line, exit 1', async (t) => {
  const { server, seen } = followStub({ resources: docWithout('transcript'), transcript: () => [] });
  const port = await serve(t, { server });
  const { code, stderr } = await cli(['logs', 'bob'], port);
  assert.strictEqual(code, 1, 'D.5 says exit 1 (EXIT.SERVER)');
  assert.match(stderr, /does not serve sessions\/transcript get; run: clodexctl upgrade node/);
  assert.ok(!seen.some((s) => /\/transcript/.test(s.url)), 'the check ran BEFORE the first transcript request');
});

test('logs without -f: unchanged one-shot (no events feed opened)', async (t) => {
  const { server, seen } = followStub({ transcript: () => [{ role: 'assistant', text: 'hi' }] });
  const port = await serve(t, { server });
  const { code, stdout } = await cli(['logs', 'bob'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /\[assistant\] hi/);
  assert.ok(!seen.some((s) => s.url === '/api/events'), 'no follow stream for a plain logs');
  assert.strictEqual(seen.filter((s) => s.url === '/api/resources').length, 1, 'ONE capability check per invocation');
});

test('logs -f: a refetch that fails (500) is not an unhandled rejection — the follow stays up and a later activity frame still prints', FOLLOW, async (t) => {
  const rejections = [];
  const onRej = (r) => rejections.push(r);
  process.on('unhandledRejection', onRej);
  t.after(() => process.off('unhandledRejection', onRej));
  const sig = fakeSignalTty();
  const OLD = [{ role: 'user', text: 'q1' }];
  const stub = followStub({
    onServed: (i, state) => { if (i === 1 || i === 2) activity(state.events, 'bob'); },
    status: (i) => (i === 2 ? 500 : 200),
    transcript: (i) => (i <= 2 ? OLD : [...OLD, { role: 'assistant', text: 'after the failure' }]),
  });
  const port = await serve(t, stub);
  const { code, stdout } = await follow(['logs', 'bob', '-f'], port, sig, (out) => /after the failure/.test(out));
  assert.strictEqual(code, 0);
  assert.match(stdout, /\[assistant\] after the failure/);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(rejections.map((r) => String(r && r.message)), []);
});
