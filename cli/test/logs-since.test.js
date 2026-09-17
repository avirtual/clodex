'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');
const { RESOURCES_DOC, docWithoutResource } = require('./fixtures/resources-doc');
const { serverTranscriptPage } = require('./fixtures/transcript-page');

const TOKEN = 'sekret';
const NOW = Date.parse('2026-09-17T12:00:00.000Z');
const now = () => NOW;

const ROWS = [
  { role: 'user', text: 'old-q', ts: '2026-09-17T09:00:00.000Z' },
  { role: 'assistant', text: 'old-a', ts: '2026-09-17T10:00:00.000Z' },
  { role: 'assistant', text: 'no-stamp', ts: null },
  { role: 'user', text: 'new-q', ts: '2026-09-17T11:50:00.000Z' },
];

const NODE_LINES = [
  '2026-09-17T09:00:00.000Z  INFO  [app] booted',
  '2026-09-17T11:55:00.000Z  WARN  [peer] retried',
  'a continuation line carrying no instant',
];

function stub(opts = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if ((req.headers['authorization'] || '') !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('{}'); }
    seen.push(req.url);
    const p = req.url.split('?')[0];
    if (p === '/api/resources') { res.writeHead(200); return res.end(JSON.stringify(opts.resources || RESOURCES_DOC)); }
    if (p === '/api/peer/hello') {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, host: 'oldbox', version: '5.69.0', caps: ['transcript'] }));
    }
    if (/^\/api\/sessions\/[^/]+\/transcript$/.test(p)) {
      const page = opts.page ? opts.page(ROWS, req.url) : serverTranscriptPage(ROWS, req.url);
      res.writeHead(200); return res.end(JSON.stringify(page));
    }
    if (p === '/api/node/logs') {
      res.writeHead(200); return res.end(JSON.stringify({ ok: true, lines: opts.lines || NODE_LINES }));
    }
    res.writeHead(404); res.end('{}');
  });
  return { server, seen };
}

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

async function cli(argv, port, extra = {}) {
  let stdout = '', stderr = '';
  const code = await run([...argv, '--url', `http://127.0.0.1:${port}`, '--token', TOKEN], {
    stdout: (s) => (stdout += s), stderr: (s) => (stderr += s),
    env: {}, contextsFile: path.join(os.tmpdir(), 'nonexistent-clodexctl', 'contexts.json'),
    now,
    ...extra,
  });
  return { code, stdout, stderr };
}

function afterOf(seen) {
  const hit = seen.find((u) => u.includes('/transcript'));
  return new URL(hit, 'http://x').searchParams.get('after');
}

test('logs --since <duration>: resolves against the INJECTED clock and sends an absolute after=', async () => {
  const { server, seen } = stub();
  const port = await listen(server);
  try {
    const { code } = await cli(['logs', 'bob', '--since', '30m'], port);
    assert.strictEqual(code, 0);
    assert.strictEqual(afterOf(seen), '2026-09-17T11:30:00.000Z',
      'the wire carries an absolute instant — 30m before the injected now, never the literal "30m"');
  } finally { server.close(); }
});

test('logs --since: each duration unit, and an ISO instant passed through verbatim', async () => {
  for (const [form, want] of [
    ['45s', '2026-09-17T11:59:15.000Z'],
    ['90m', '2026-09-17T10:30:00.000Z'],
    ['2h', '2026-09-17T10:00:00.000Z'],
    ['1d', '2026-09-16T12:00:00.000Z'],
    ['2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z'],
  ]) {
    const { server, seen } = stub();
    const port = await listen(server);
    try {
      const { code } = await cli(['logs', 'bob', '--since', form], port);
      assert.strictEqual(code, 0, `--since ${form} must be accepted`);
      assert.strictEqual(afterOf(seen), want, `--since ${form}`);
    } finally { server.close(); }
  }
});

test('logs --since <garbage>: exit 2 naming the accepted forms, and NOTHING is fetched', async () => {
  for (const bad of ['bogus', '30x', '30', 'm', '-5m', '1h30m']) {
    const { server, seen } = stub();
    const port = await listen(server);
    try {
      const { code, stderr } = await cli(['logs', 'bob', '--since', bad], port);
      assert.strictEqual(code, 2, `--since ${bad} must be a USAGE error`);
      assert.match(stderr, /--since takes a duration \(30s\|10m\|2h\|7d\) or an ISO-8601 instant/);
      assert.ok(!seen.some((u) => u.includes('/transcript')),
        `--since ${bad} was refused BEFORE any request — a bad flag must not reach the node`);
    } finally { server.close(); }
  }
});

test('logs --since: the CLI re-filters the page, so an old node that ignores `after` still yields nothing older', async () => {
  const { server } = stub({ page: (rows) => ({ ok: true, messages: rows.map((m, i) => ({ ...m, seq: i })), cursor: 0, complete: true }) });
  const port = await listen(server);
  try {
    const { code, stdout } = await cli(['logs', 'bob', '--since', '30m'], port);
    assert.strictEqual(code, 0);
    assert.ok(!stdout.includes('old-q'), 'a row older than the instant is dropped client-side');
    assert.ok(!stdout.includes('old-a'), 'both older rows, not just the first');
    assert.ok(stdout.includes('new-q'), 'the newer row survives');
    assert.ok(stdout.includes('no-stamp'), 'a row with no ts is KEPT — a time filter must not swallow a merged bubble');
  } finally { server.close(); }
});

test('logs --since -o json: the re-filtered page is what json prints, not the raw body', async () => {
  const { server } = stub({ page: (rows) => ({ ok: true, messages: rows.map((m, i) => ({ ...m, seq: i })), cursor: 0, complete: true }) });
  const port = await listen(server);
  try {
    const { code, stdout } = await cli(['logs', 'bob', '--since', '30m', '-o', 'json'], port);
    assert.strictEqual(code, 0);
    const body = JSON.parse(stdout);
    assert.deepStrictEqual(body.messages.map((m) => m.text), ['no-stamp', 'new-q'],
      'json and the plain render agree about the window');
    assert.strictEqual(body.complete, true, 'the rest of the page envelope is passed through');
  } finally { server.close(); }
});

test('logs --timestamps: each row carries its verbatim ts, a null ts prints `-`', async () => {
  const { server } = stub();
  const port = await listen(server);
  try {
    const { code, stdout } = await cli(['logs', 'bob', '--timestamps'], port);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(stdout.trimEnd().split('\n\n'), [
      '2026-09-17T09:00:00.000Z [user] old-q',
      '2026-09-17T10:00:00.000Z [assistant] old-a',
      '- [assistant] no-stamp',
      '2026-09-17T11:50:00.000Z [user] new-q',
    ]);
  } finally { server.close(); }
});

test('logs without --timestamps: byte-identical to the pre-t958 render', async () => {
  const { server } = stub();
  const port = await listen(server);
  try {
    const { code, stdout } = await cli(['logs', 'bob'], port);
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout,
      '[user] old-q\n\n[assistant] old-a\n\n[assistant] no-stamp\n\n[user] new-q\n');
  } finally { server.close(); }
});

test('logs node: tails the node log, --tail rides the limit, lines print RAW', async () => {
  const { server, seen } = stub();
  const port = await listen(server);
  try {
    const { code, stdout } = await cli(['logs', 'node', '--tail', '2'], port);
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, `${NODE_LINES.join('\n')}\n`, 'the served lines print verbatim, one per line');
    assert.ok(seen.includes('/api/node/logs?limit=2'), 'the tail count reaches the node as limit');
    assert.ok(!seen.some((u) => u.includes('/transcript')), '`node` is a resource word, never a session name');
  } finally { server.close(); }
});

test('logs node: default limit 100, clamped at 500', async () => {
  for (const [argv, want] of [[[], 100], [['--tail', '9999'], 500]]) {
    const { server, seen } = stub();
    const port = await listen(server);
    try {
      const { code } = await cli(['logs', 'node', ...argv], port);
      assert.strictEqual(code, 0);
      assert.ok(seen.includes(`/api/node/logs?limit=${want}`), `expected limit=${want}, saw ${seen.join(' ')}`);
    } finally { server.close(); }
  }
});

test('logs node --since: filters by the line\'s LEADING instant, keeping a line that has none', async () => {
  const { server } = stub();
  const port = await listen(server);
  try {
    const { code, stdout } = await cli(['logs', 'node', '--since', '30m'], port);
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, '2026-09-17T11:55:00.000Z  WARN  [peer] retried\na continuation line carrying no instant\n',
      'the 09:00 line is older than 11:30 and goes; the stampless continuation line stays');
  } finally { server.close(); }
});

test('logs node -o json wraps the lines; --timestamps is inert (the lines already carry one)', async () => {
  const { server } = stub();
  const port = await listen(server);
  try {
    const j = await cli(['logs', 'node', '-o', 'json'], port);
    assert.strictEqual(j.code, 0);
    assert.deepStrictEqual(JSON.parse(j.stdout), { lines: NODE_LINES });
    const t = await cli(['logs', 'node', '--timestamps'], port);
    assert.strictEqual(t.stdout, `${NODE_LINES.join('\n')}\n`, '--timestamps changes nothing on node lines');
  } finally { server.close(); }
});

test('logs node -f: exit 2 — there is nothing to follow', async () => {
  const { server, seen } = stub();
  const port = await listen(server);
  try {
    const { code, stderr } = await cli(['logs', 'node', '-f'], port);
    assert.strictEqual(code, 2);
    assert.match(stderr, /logs node does not follow/);
    assert.ok(!seen.includes('/api/node/logs'), 'refused before the request');
  } finally { server.close(); }
});

test('logs node on an OLDER node: the upgrade line and exit 1, not a 404 crash', async () => {
  const { server, seen } = stub({ resources: docWithoutResource('node/logs') });
  const port = await listen(server);
  try {
    const { code, stderr } = await cli(['logs', 'node'], port);
    assert.strictEqual(code, 1, 'D.5 says exit 1 (EXIT.SERVER)');
    assert.match(stderr, /does not serve node\/logs get; run: clodexctl upgrade node/);
    assert.ok(!seen.includes('/api/node/logs'), 'the capability check ran BEFORE the first log request');
  } finally { server.close(); }
});

test('logs node takes no name', async () => {
  const { server } = stub();
  const port = await listen(server);
  try {
    const { code, stderr } = await cli(['logs', 'node', 'bob'], port);
    assert.strictEqual(code, 2);
    assert.match(stderr, /logs node: unexpected argument "bob"/);
  } finally { server.close(); }
});

test('grammar: only a LEADING `node` selects the node log; `logs bob` is untouched by the new branch', async () => {
  const { server, seen } = stub();
  const port = await listen(server);
  try {
    const trailing = await cli(['logs', 'bob', 'node'], port);
    assert.ok(!seen.includes('/api/node/logs'),
      'a trailing `node` never reaches the node-log route — the branch reads args[0], not any position');
    assert.strictEqual(trailing.code, 0,
      'it stays the pre-t958 session read (which has always ignored a trailing extra arg) rather than becoming an error this ticket did not ask for');

    const ok = await cli(['logs', 'bob'], port);
    assert.strictEqual(ok.code, 0);
    assert.ok(seen.some((u) => u.includes('/api/sessions/bob/transcript')), 'the ordinary session form still reads the transcript');
  } finally { server.close(); }
});

// t959 (f). `'logs node'` was in verbs.js's NAMELESS_RESOURCES, which is read
// only by takeResourceWord — and `logs` never routes through it: it is a
// SPECIAL_VERB whose own branch handles `node`, and the throw pinned by the
// test above is what enforces the no-name rule. An inert entry in a set that
// looks like the rule is worse than no entry: it is where the next reader goes
// to change the behaviour, and nothing there does anything.
test('t959 the no-name rule for `logs node` lives in logsNode, not in NAMELESS_RESOURCES', async () => {
  const V = require('../src/verbs');
  assert.ok(!('NAMELESS_RESOURCES' in V), 'ENTER: the set is module-private, so read it from source');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'verbs.js'), 'utf8');
  const m = src.match(/const NAMELESS_RESOURCES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'ENTER: the set is still declared');
  assert.ok(!m[1].includes("'logs node'"),
    '`logs node` never reaches takeResourceWord, so an entry here enforces nothing');
  assert.ok(m[1].includes("'restart node'"),
    "ENTER: `restart node` DOES route through takeResourceWord and must stay");

  // And the rule it looked like it carried is still enforced, by the throw.
  const { server } = stub();
  const port = await listen(server);
  try {
    const { code, stderr } = await cli(['logs', 'node', 'bob'], port);
    assert.strictEqual(code, 2);
    assert.match(stderr, /logs node: unexpected argument "bob"/);
  } finally { server.close(); }
});
