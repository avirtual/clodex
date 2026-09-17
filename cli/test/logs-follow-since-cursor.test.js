'use strict';
// logs-follow-since-cursor.test.js — t959 P6: `logs -f --since <D>` derives its
// follow cursor from the UNFILTERED page.
//
// `--since` is a DISPLAY filter — it decides which of the tail's turns are
// printed. The follow cursor is a different question: where the stream resumes.
// Deriving the cursor from the filtered survivors conflates the two, and when
// the filter eats everything, `lastSeqOf([])` is -1, so the first refetch asks
// `since=0` and re-fetches the ENTIRE transcript — every turn `--since` was
// asked to hide, printed at once. A quiet seat plus `--since 5m` is the common
// case, not an edge one.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');
const { RESOURCES_DOC } = require('./fixtures/resources-doc');
const { serverTranscriptPage } = require('./fixtures/transcript-page');

const TOKEN = 'sekret';

// Every row is stamped OLD, so any `--since` in this file filters all of them
// out. The stamps are fixed instants, never `Date.now()` — a clock-relative
// fixture drifts into and out of its own window.
const OLD_TS = '2020-01-01T00:00:00.000Z';
const FUTURE = '2030-01-01T00:00:00.000Z';
const rows = (n, ts) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', text: `old${i}`, ts,
}));

function followStub(opts = {}) {
  const seen = [];
  const state = { events: null };
  let tIdx = 0;
  const server = http.createServer((req, res) => {
    if ((req.headers['authorization'] || '') !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('{}'); }
    req.resume();
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url });
      const p = req.url.split('?')[0];
      if (req.method === 'GET' && p === '/api/resources') {
        res.writeHead(200); return res.end(JSON.stringify(RESOURCES_DOC));
      }
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': connected\n\n');
        state.events = res;
        if (opts.onEventsOpen) opts.onEventsOpen(state, seen);
        return;
      }
      if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/transcript$/.test(p)) {
        const msgs = opts.transcript(tIdx++, seen);
        // `after` is DROPPED before the page is built. That is the whole subject:
        // client-side `filterAfter` exists because a node need not honour the
        // parameter — an older box, or a transcript callback that ignores it —
        // and it is exactly against such a node that the cursor derivation must
        // still hold. A stub that filters server-side hands back an already-empty
        // page, where the filtered and unfiltered sets are equal and the bug
        // cannot appear.
        const url = req.url.replace(/[?&]after=[^&]*/g, (m) => (m[0] === '?' ? '?' : ''));
        res.writeHead(200); return res.end(JSON.stringify(serverTranscriptPage(msgs, url)));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return { server, seen, state };
}

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function activity(res, name) { res.write(`event: activity\ndata: ${JSON.stringify({ name, state: 'idle', turnEnd: true })}\n\n`); }

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

const transcriptUrls = (seen) => seen.filter((s) => /\/transcript(\?|$)/.test(s.url)).map((s) => s.url);
const pairsOf = (url) => [...new URL(url, 'http://x').searchParams.entries()];

test('P6 logs -f --since <future>: the cursor comes from the unfiltered page, not the empty survivor set', async () => {
  const sig = fakeSignalTty();
  const OLD = rows(40, OLD_TS);
  const { server, seen } = followStub({
    onEventsOpen: (state) => {
      setTimeout(() => activity(state.events, 'bob'), 40);
      setTimeout(() => sig.signal(), 140);
    },
    transcript: (i) => (i <= 1 ? OLD : [...OLD, { role: 'assistant', text: 'brand new', ts: FUTURE }]),
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['logs', 'bob', '-f', '--since', FUTURE], port, { tty: sig.tty });
  try {
    assert.strictEqual(code, 0);
    const urls = transcriptUrls(seen);
    assert.ok(urls.length >= 3, 'ENTER: tail, resnapshot and at least one refetch happened');
    for (const u of urls.slice(1)) {
      assert.deepStrictEqual(pairsOf(u), [['since', '40'], ['limit', '500']],
        `the follow cursor must be lastSeq+1 of the REAL last row (seq 39), got ${u}`);
    }
    assert.ok(!stdout.includes('old0'),
      'and nothing the filter hid was resurrected — a since=0 refetch would print the whole transcript');
    assert.match(stdout, /brand new/, 'while a genuinely new turn still arrives');
  } finally { server.close(); }
});

test('P6 logs -f --since <past>: an unfiltering since is unchanged, cursor still lastSeq+1', async () => {
  const sig = fakeSignalTty();
  const OLD = rows(40, FUTURE);
  const { server, seen } = followStub({
    onEventsOpen: (state) => {
      setTimeout(() => activity(state.events, 'bob'), 40);
      setTimeout(() => sig.signal(), 140);
    },
    transcript: (i) => (i <= 1 ? OLD : [...OLD, { role: 'assistant', text: 'brand new', ts: FUTURE }]),
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['logs', 'bob', '-f', '--since', OLD_TS], port, { tty: sig.tty });
  assert.strictEqual(code, 0);
  try {
    assert.match(stdout, /old0/, 'ENTER: this since filtered nothing, so the tail printed');
    for (const u of transcriptUrls(seen).slice(1)) {
      assert.deepStrictEqual(pairsOf(u), [['since', '40'], ['limit', '500']],
        'the cursor is the same either way — the fix must not move the unfiltered case');
    }
  } finally { server.close(); }
});

test('P6 logs -f with no --since at all is untouched', async () => {
  const sig = fakeSignalTty();
  const OLD = rows(40, OLD_TS);
  const { server, seen } = followStub({
    onEventsOpen: (state) => {
      setTimeout(() => activity(state.events, 'bob'), 40);
      setTimeout(() => sig.signal(), 140);
    },
    transcript: (i) => (i <= 1 ? OLD : [...OLD, { role: 'assistant', text: 'brand new', ts: FUTURE }]),
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['logs', 'bob', '-f'], port, { tty: sig.tty });
  assert.strictEqual(code, 0);
  try {
    assert.strictEqual((stdout.match(/old39/g) || []).length, 1, 'the tail printed once, not re-printed');
    for (const u of transcriptUrls(seen).slice(1)) {
      assert.deepStrictEqual(pairsOf(u), [['since', '40'], ['limit', '500']]);
    }
  } finally { server.close(); }
});
