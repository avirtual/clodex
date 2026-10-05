'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { Readable } = require('node:stream');
const { mkTmpRoot } = require('./lib/tmp-roots');
const verb = require('../cli/bin/clodex.js');
const { materializeSeatVerb } = require('../bin-materialize');

const ROOT = path.join(__dirname, '..');

function sink() {
  const s = { buf: '', write: (t) => { s.buf += t; } };
  return s;
}

async function fakeSeat(answer) {
  const root = mkTmpRoot('verb-');
  const sockPath = path.join(root, 'i.sock');
  const got = [];
  const srv = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      const r = JSON.parse(buf.split('\n')[0]);
      got.push(r);
      c.end(JSON.stringify(answer(r)) + '\n');
    });
  });
  await new Promise((r) => srv.listen(sockPath, r));
  return { sockPath, got, close: () => new Promise((r) => srv.close(r)) };
}

async function run(seat, argv, { env = {}, stdin } = {}) {
  const out = sink();
  const err = sink();
  const code = await verb.main(argv, {
    env: { CLODEX_INTENT_SOCK: seat && seat.sockPath, CLODEX_INTENT_CRED: 'k1', CLODEX_SEAT: 'a', ...env },
    out, err, stdin,
  });
  return { code, out: out.buf, err: err.buf };
}

test('argv joins into one intent line and an open body gets [agent:end] appended', () => {
  assert.strictEqual(verb.buildIntentText(['[agent:dm', 'b]', 'hello', 'there']), '[agent:dm b] hello there\n[agent:end]');
  assert.strictEqual(verb.buildIntentText(['[agent:dm b] x\n[agent:end]']), '[agent:dm b] x\n[agent:end]');
  assert.strictEqual(verb.buildIntentText(['-'], '[agent:dm b] line1\nline2\n'), '[agent:dm b] line1\nline2\n[agent:end]');
  assert.strictEqual(verb.buildIntentText(['  ']), null);
});

test('the request carries the cred, the joined intent and the forwarded agent id', async () => {
  const seat = await fakeSeat(() => ({ ok: true, reply: '[agent:peers] b' }));
  try {
    const r = await run(seat, ['[agent:who]'], { env: { CODEX_THREAD_ID: 'th-1' } });
    assert.deepStrictEqual(r, { code: 0, out: '[agent:peers] b\n', err: '' });
    assert.deepStrictEqual(seat.got[0], { cred: 'k1', intent: '[agent:who]\n[agent:end]', agentId: 'th-1' });
    await run(seat, ['[agent:who]'], { env: { CLODEX_AGENT_ID: 'ag-2', CODEX_THREAD_ID: 'th-1' } });
    assert.strictEqual(seat.got[1].agentId, 'ag-2');
    await run(seat, ['[agent:who]']);
    assert.ok(!('agentId' in seat.got[2]), 'no id in env: none sent');
    assert.ok(!('ident' in seat.got[2]), 'no hook stamp in env: none sent');
    await run(seat, ['[agent:who]'], { env: { CLODEX_HOOK_IDENT: 'main.0123456789abcdef' } });
    assert.strictEqual(seat.got[3].ident, 'main.0123456789abcdef', 'the hook stamp rides as ident');
  } finally { await seat.close(); }
});

test('an @<nonce> stamp resolves to its run/<seat>/ident file, which is consumed on read', async () => {
  const seat = await fakeSeat(() => ({ ok: true, reply: 'ok' }));
  try {
    const dir = path.join(path.dirname(seat.sockPath), 'ident');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '0123456789abcdef');
    fs.writeFileSync(file, 'main.0123456789abcdef.fedcba9876543210', { mode: 0o600 });
    const r = await run(seat, ['[agent:who]'], { env: { CLODEX_HOOK_IDENT: '@0123456789abcdef' } });
    assert.deepStrictEqual(r, { code: 0, out: 'ok\n', err: '' });
    assert.strictEqual(seat.got[0].ident, 'main.0123456789abcdef.fedcba9876543210');
    assert.strictEqual(fs.existsSync(file), false, 'the stamp file is unlinked');
    const again = await run(seat, ['[agent:who]'], { env: { CLODEX_HOOK_IDENT: '@0123456789abcdef' } });
    assert.strictEqual(again.err, 'clodex: identity stamp missing (hook not installed?)\n');
    assert.ok(!('ident' in seat.got[1]), 'a consumed stamp sends no ident');
    for (const bad of ['@../i.sock', '@0123']) {
      const b = await run(seat, ['[agent:who]'], { env: { CLODEX_HOOK_IDENT: bad } });
      assert.strictEqual(b.err, 'clodex: identity stamp missing (hook not installed?)\n', bad);
    }
    assert.ok(seat.got.slice(1).every((g) => !('ident' in g)));
    assert.ok(fs.existsSync(seat.sockPath), 'a path-shaped nonce reads nothing outside ident/');
  } finally { await seat.close(); }
});

test('an empty @<nonce> stamp file is treated as missing: message, no ident sent, file unlinked', async () => {
  const seat = await fakeSeat(() => ({ ok: true, reply: 'ok' }));
  try {
    const dir = path.join(path.dirname(seat.sockPath), 'ident');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '0123456789abcdef');
    fs.writeFileSync(file, '  \n', { mode: 0o600 });
    const r = await run(seat, ['[agent:who]'], { env: { CLODEX_HOOK_IDENT: '@0123456789abcdef' } });
    assert.strictEqual(r.err, 'clodex: identity stamp missing (hook not installed?)\n');
    assert.ok(!('ident' in seat.got[0]), 'an empty stamp sends no ident');
    assert.strictEqual(fs.existsSync(file), false, 'the empty stamp file is unlinked');
  } finally { await seat.close(); }
});

test('a reply status of error exits 1 and refused exits 3, with the reply text printed unchanged', async () => {
  for (const [answer, code] of [
    [{ ok: true, status: 'error', reply: '[agent:browser] error: x' }, verb.EXIT.ERROR],
    [{ ok: true, status: 'refused', reply: '[agent:browser] error: [4] "Pay" looks consequential (payment) — re-issue with --confirm if the operator asked for it' }, verb.EXIT.DENIED],
    [{ ok: true, status: 'ok', reply: '[agent:browser] released x' }, verb.EXIT.OK],
  ]) {
    const seat = await fakeSeat(() => answer);
    try {
      const r = await run(seat, ['[agent:browser read x]']);
      assert.deepStrictEqual(r, { code, out: `${answer.reply}\n`, err: '' }, answer.status);
    } finally { await seat.close(); }
  }
  const seat = await fakeSeat(() => ({ ok: false, status: 'refused', error: 'a subagent cannot confirm a consequential action — ask the main agent' }));
  try {
    const r = await run(seat, ['[agent:browser click x 3 --confirm]']);
    assert.strictEqual(r.code, verb.EXIT.DENIED);
    assert.strictEqual(r.err, 'clodex: a subagent cannot confirm a consequential action — ask the main agent\n');
  } finally { await seat.close(); }
});

test('stdin mode reads a multi-line body when - is the only arg', async () => {
  const seat = await fakeSeat(() => ({ ok: true, reply: 'sent' }));
  try {
    const r = await run(seat, ['-'], { stdin: Readable.from(['[agent:dm b] one\n', 'two\n']) });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(seat.got[0].intent, '[agent:dm b] one\ntwo\n[agent:end]');
  } finally { await seat.close(); }
});

test('exit codes: usage 2, refused 3, no socket 4, timeout 5, other error 1', async () => {
  for (const [answer, code] of [
    [{ ok: false, error: 'unauthorized' }, 3],
    [{ ok: false, error: 'not available to a subagent: shout' }, 3],
    [{ ok: false, error: 'timeout' }, 5],
    [{ ok: false, error: 'busy' }, 1],
  ]) {
    const seat = await fakeSeat(() => answer);
    try {
      const r = await run(seat, ['[agent:shout] x']);
      assert.strictEqual(r.code, code, answer.error);
      assert.strictEqual(r.err, `clodex: ${answer.error}\n`);
      assert.strictEqual(r.out, '');
    } finally { await seat.close(); }
  }
  assert.strictEqual((await run(null, [])).code, 2);
  assert.strictEqual((await run(null, ['   '])).code, 2);
  assert.strictEqual((await run(null, ['[agent:who]'])).code, 4);
  const gone = path.join(mkTmpRoot('verb-gone-'), 'none.sock');
  assert.strictEqual((await run({ sockPath: gone }, ['[agent:who]'])).code, 4);
});

test('--help lists the subagent catalog', async () => {
  const r = await run(null, ['--help']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /timeout that covers it/);
  for (const v of ['[agent:dm', '[agent:who]', '[agent:name]', '[agent:task list]', '[agent:exec', '[agent:memory recall]', '[agent:memory list]']) {
    assert.ok(r.out.includes(v), v);
  }
});

test('the verb is materialized as an executable `clodex` in <root>/bin', () => {
  const root = mkTmpRoot('verb-bin-');
  const r = materializeSeatVerb({ root, srcDir: ROOT });
  assert.strictEqual(r.path, path.join(root, 'bin', 'clodex'));
  assert.strictEqual(fs.statSync(r.path).mode & 0o111, 0o111);
  assert.strictEqual(fs.readFileSync(r.path, 'utf8'), fs.readFileSync(path.join(ROOT, 'cli', 'bin', 'clodex.js'), 'utf8'));
  const src = fs.readFileSync(r.path, 'utf8');
  assert.deepStrictEqual([...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]), ['net', 'fs', 'path'], 'zero local requires: it runs flat from bin/');
});

test('reply shapes: a refusal is stderr `clodex: <reason>` exit 3; an error reply is stdout exit 1', async () => {
  for (const [answer, code, out, err] of [
    [{ ok: false, status: 'refused', error: 'a subagent cannot confirm a consequential action' }, 3, '', 'clodex: a subagent cannot confirm a consequential action\n'],
    [{ ok: true, status: 'error', reply: '[agent:browser] error: no such service' }, 1, '[agent:browser] error: no such service\n', ''],
  ]) {
    const seat = await fakeSeat(() => answer);
    try {
      const r = await run(seat, ['[agent:browser open wiki] https://x']);
      assert.deepStrictEqual([r.code, r.out, r.err], [code, out, err]);
    } finally { await seat.close(); }
  }
});

test('--help documents the streams, the exit codes and the URL-after-the-bracket browser form', async () => {
  const r = await run(null, ['--help']);
  assert.ok(r.out.includes("clodex '[agent:browser open wiki] https://en.wikipedia.org/wiki/Iceland'"), r.out);
  assert.match(r.out, /the URL follows the closing bracket/);
  assert.match(r.out, /stdout: the intent's reply\. stderr: this verb's own lines, each `clodex: <reason>`/);
  assert.match(r.out, /exit codes: 0 ok, 1 error \(the reply, or stderr `clodex: …`\), 2 usage,\n\s+3 refused \(stderr `clodex: …`\), 4 no socket, 5 timeout/);
});

test('the client outlives the largest server-side plugin wait by more than the socket slack', () => {
  const { PLUGIN_REPLY_WAIT_MAX_MS } = require('../intent-registry');
  const { INTENT_SOCKET_TIMEOUT_MS } = require('../intent-socket');
  assert.ok(verb.CLIENT_TIMEOUT_MS > PLUGIN_REPLY_WAIT_MAX_MS + INTENT_SOCKET_TIMEOUT_MS,
    `${verb.CLIENT_TIMEOUT_MS} vs ${PLUGIN_REPLY_WAIT_MAX_MS} + ${INTENT_SOCKET_TIMEOUT_MS}`);
});
