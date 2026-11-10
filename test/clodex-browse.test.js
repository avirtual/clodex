'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { mkTmpRoot } = require('./lib/tmp-roots');
const browse = require('../plugins/browser-pane/clodex-browse.js');

const ENV = { CLODEX_INTENT_SOCK: '/seat/run/a/intent.sock', CLODEX_INTENT_CRED: 'k1' };

function sink() {
  const s = { buf: '' };
  s.write = (d) => { s.buf += d; return true; };
  return s;
}

function fakeConnect(answer) {
  const calls = [];
  const connect = (sockPath) => {
    const sock = new EventEmitter();
    calls.push({ sockPath, payloads: [] });
    sock.write = (line) => {
      calls[calls.length - 1].payloads.push(JSON.parse(line));
      process.nextTick(() => { sock.emit('data', Buffer.from(JSON.stringify(answer) + '\n')); sock.emit('close'); });
      return true;
    };
    sock.destroy = () => {};
    process.nextTick(() => sock.emit('connect'));
    return sock;
  };
  return { connect, calls };
}

async function run(argv, { env = ENV, answer = { ok: true, status: 'ok', reply: '[agent:browser] opened' } } = {}) {
  const err = sink();
  const fake = fakeConnect(answer);
  const code = await browse.main(argv, { env, err, connect: fake.connect, timeoutMs: 1000 });
  return { code, err: err.buf, calls: fake.calls };
}

test('file: and javascript: URLs are refused before the socket: exit non-zero, the URL on stderr', async () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)']) {
    const r = await run([url]);
    assert.notStrictEqual(r.code, 0, url);
    assert.ok(r.err.split('\n').includes(url), r.err);
    assert.deepStrictEqual(r.calls, [], url);
  }
});

test('an accepted open sends exactly one browser open intent with the default service and exits 0', async () => {
  const r = await run(['https://github.com/login/device']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.err, '');
  assert.deepStrictEqual(r.calls, [{
    sockPath: '/seat/run/a/intent.sock',
    payloads: [{ cred: 'k1', intent: '[agent:browser open web --show] https://github.com/login/device\n[agent:end]' }],
  }]);
});

test('CLODEX_BROWSE_SERVICE names the profile the URL opens in', async () => {
  const r = await run(['https://www.npmjs.com/login?next=/x'], { env: { ...ENV, CLODEX_BROWSE_SERVICE: 'npm' } });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.calls.map((c) => c.payloads), [[{ cred: 'k1', intent: '[agent:browser open npm --show] https://www.npmjs.com/login?next=/x\n[agent:end]' }]]);
});

test('a refusal reply exits non-zero with the reason and the URL on stderr', async () => {
  const url = 'https://evil.example/';
  const r = await run([url], { answer: { ok: false, status: 'refused', error: 'evil.example is on the denylist' } });
  assert.strictEqual(r.code, browse.EXIT.REFUSED);
  assert.strictEqual(r.err, `clodex-browse: evil.example is on the denylist; open this URL yourself:\n${url}\n`);
  assert.strictEqual(r.calls.length, 1);
});

test('no browser grant (an error reply), no seat channel and an unreachable socket all exit non-zero with the URL on stderr', async () => {
  const url = 'https://example.com/a';
  const notGranted = await run([url], { answer: { ok: false, error: 'intent browser not enabled for this seat' } });
  assert.strictEqual(notGranted.code, browse.EXIT.ERROR);
  assert.ok(notGranted.err.endsWith(`\n${url}\n`), notGranted.err);
  const noChannel = await run([url], { env: {} });
  assert.strictEqual(noChannel.code, browse.EXIT.NO_SOCKET);
  assert.ok(noChannel.err.endsWith(`\n${url}\n`), noChannel.err);
  const err = sink();
  const dead = await browse.main([url], { env: { ...ENV, CLODEX_INTENT_SOCK: path.join(mkTmpRoot('browse-nosock-'), 'none.sock') }, err });
  assert.strictEqual(dead, browse.EXIT.NO_SOCKET);
  assert.ok(err.buf.endsWith(`\n${url}\n`), err.buf);
});

test('an ok reply whose status is error is not an accepted open', async () => {
  const r = await run(['https://example.com/'], { answer: { ok: true, status: 'error', reply: '[agent:browser] error: no such window' } });
  assert.strictEqual(r.code, browse.EXIT.ERROR);
  assert.strictEqual(r.err, 'clodex-browse: [agent:browser] error: no such window; open this URL yourself:\nhttps://example.com/\n');
});


test('browser-pane declares clodex-browse as its seatBin with the three opener env keys, and the CLI has no local requires', () => {
  const dir = path.join(__dirname, '..', 'plugins', 'browser-pane');
  const manifest = JSON.parse(require('node:fs').readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest.seatBin, { name: 'clodex-browse', src: 'clodex-browse.js', env: ['BROWSER', 'GH_BROWSER', 'npm_config_browser'] });
  const src = require('node:fs').readFileSync(path.join(dir, 'clodex-browse.js'), 'utf8');
  assert.deepStrictEqual([...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]), ['net']);
});
