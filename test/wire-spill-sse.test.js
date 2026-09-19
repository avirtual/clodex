'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { mkTmpRoot } = require('./lib/tmp-roots');
const { SpillTee } = require('../wire/spill');
const { UsageCollector, SSEFramer } = require('../wire/sse');

const BIG = 'z'.repeat(900);
const VERBS = ['task.add', 'task.respec', 'context.compact'];

let ROOT = null;
function root() {
  if (!ROOT) ROOT = mkTmpRoot('clodex-spillsse-');
  return ROOT;
}

function ev(type, data) {
  return Buffer.from(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`, 'utf8');
}

function td(index, text) {
  return ev('content_block_delta', {
    type: 'content_block_delta', index, delta: { type: 'text_delta', text },
  });
}

function drive(stream, cs, opts = {}) {
  const tee = new SpillTee({
    agent: opts.agent === undefined ? 'wirescope' : opts.agent,
    root: root(),
    verbs: VERBS,
    ...opts,
  });
  const out = [];
  for (let i = 0; i < stream.length; i += cs) out.push(tee.feed(stream.slice(i, i + cs)));
  out.push(tee.close());
  return { out: Buffer.concat(out), tee };
}

function textOf(blob, kind = 'text_delta', key = 'text') {
  let s = '';
  for (const e of blob.toString('utf8').split('\n\n')) {
    for (const ln of e.split('\n')) {
      if (!ln.startsWith('data:')) continue;
      let d;
      try { d = JSON.parse(ln.slice(5)); } catch { continue; }
      if (d.type === 'content_block_delta' && d.delta && d.delta.type === kind) s += d.delta[key] || '';
    }
  }
  return s;
}

const THINKING_STREAM = Buffer.concat([
  ev('message_start', { type: 'message_start' }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
  ev('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: `[agent:task add t1] ${BIG}\n[agent:end]\n` },
  }),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
  td(1, 'Here you go.\n[agent:task add t42] '),
  td(1, BIG.slice(0, 400)),
  td(1, BIG.slice(400)),
  td(1, '\n[agent:end]\nDone.\n'),
  ev('content_block_stop', { type: 'content_block_stop', index: 1 }),
  ev('message_stop', { type: 'message_stop' }),
]);

test('a thinking block carrying an intent is never touched; the text block beside it spills', () => {
  for (const cs of [1, 13, 997, THINKING_STREAM.length]) {
    const { out, tee } = drive(THINKING_STREAM, cs);
    assert.ok(textOf(out, 'thinking_delta', 'thinking').includes(BIG), `thinking intact @cs=${cs}`);
    assert.ok(textOf(out).includes('@spill:'), `text rewritten @cs=${cs}`);
    assert.ok(!textOf(out).includes(BIG), `body off the wire @cs=${cs}`);
    assert.equal(out.toString('utf8').match(/event: content_block_start/g).length, 2);
    assert.equal(out.toString('utf8').match(/event: content_block_stop/g).length, 2);
    assert.equal(out.toString('utf8').match(/event: message_stop/g).length, 1);
    assert.equal(tee.fired, 1, `one pointer @cs=${cs}`);
  }
});

test('the guard is the delta TYPE: a thinking_delta carrying a `text` key still passes untouched', () => {
  const sneaky = ev('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'x', text: `[agent:task add t] ${BIG}\n[agent:end]\n` },
  });
  const { out, tee } = drive(sneaky, sneaky.length);
  assert.deepEqual(out, sneaky, 'a rewritten thinking block would break its signature');
  assert.equal(tee.fired, 0);
});

test('a non-firing stream is byte-identical, not merely content-equal', () => {
  const prose = Buffer.concat([
    ev('message_start', { type: 'message_start' }),
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    td(0, 'A normal answer. '), td(0, 'With [1] a citation, '),
    td(0, 'an [agent] bracket, '), td(0, 'and `[agent:end]` inline.\n'),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_stop', { type: 'message_stop' }),
  ]);
  for (const cs of [1, 5, 64, 1e6]) {
    assert.deepEqual(drive(prose, cs).out, prose, `@cs=${cs}`);
  }
});

test('a real wire delta (compact separators, padded) is forwarded byte-identical', () => {
  const real = Buffer.from('event: content_block_delta\n'
    + 'data: {"type":"content_block_delta","index":1,'
    + '"delta":{"type":"text_delta","text":"4"}}               \n\n', 'utf8');
  const why = 'an unchanged delta must be forwarded as its ORIGINAL bytes: Anthropic pads events '
    + 'with trailing spaces, so a re-encode is a wire change on 100% of traffic';
  assert.deepEqual(drive(real, real.length).out, real, why);
  assert.deepEqual(drive(real, 7).out, real, why);
});

test('pings keep flowing while a body is held, in order, and usage bytes are untouched', () => {
  const ping = ev('ping', { type: 'ping' });
  const usage = ev('message_delta', {
    type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 },
  });
  const stream = Buffer.concat([
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    td(0, `[agent:task add t] ${BIG.slice(0, 400)}`),
    ping,
    td(0, BIG.slice(400)),
    ping,
    td(0, '\n[agent:end]\n'),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    usage,
    ev('message_stop', { type: 'message_stop' }),
  ]);
  const { out } = drive(stream, 13);
  const s = out.toString('utf8');
  assert.equal(s.match(/event: ping/g).length, 2, 'both pings forwarded');
  assert.ok(s.indexOf('event: ping') < s.indexOf('@spill:'), 'pings arrive before the pointer');
  assert.ok(s.includes(usage.toString('utf8')), 'usage event byte-identical');
  assert.ok(!s.includes(BIG));
});

test('content_block_stop flushes a held, unterminated body BEFORE the stop event', () => {
  const stream = Buffer.concat([
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    td(0, `[agent:task add t] ${BIG}`),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_stop', { type: 'message_stop' }),
  ]);
  const { out, tee } = drive(stream, 29);
  const s = out.toString('utf8');
  assert.ok(textOf(out).includes(BIG), 'the held original is emitted');
  assert.ok(!s.includes('@spill:'));
  assert.equal(tee.fired, 0);
  assert.ok(s.indexOf(BIG.slice(0, 40)) < s.indexOf('event: content_block_stop'),
    'flushed before the stop');
});

test('an unterminated trailing event survives close()', () => {
  const partial = Buffer.from('event: content_block_delta\ndata: {"type":"ping"', 'utf8');
  const { out } = drive(partial, 5);
  assert.deepEqual(out, partial);
});

test('a throwing filter latches, flushes what it held, and forwards raw from then on', () => {
  const stream = Buffer.concat([
    td(0, `[agent:task add t] ${BIG}`),
    td(0, '\n[agent:end]\n'),
    ev('message_stop', { type: 'message_stop' }),
  ]);
  const bails = [];
  const tee = new SpillTee({ agent: 'wirescope', root: root(), verbs: VERBS, onBail: (i) => bails.push(i) });
  tee.filter.feed = () => { throw new Error('injected filter failure'); };
  const out = Buffer.concat([tee.feed(stream), tee.close()]);
  assert.equal(bails[0].reason, 'error');
  assert.match(bails[0].error, /injected/);
  assert.equal(tee.latched, true);
  const after = ev('message_stop', { type: 'message_stop' });
  assert.deepEqual(tee.feed(after), after);
  assert.ok(out.toString('utf8').includes('message_stop'));
});

test('an observer fed the OUTPUT bills exactly as one fed the INPUT', () => {
  const withUsage = Buffer.concat([
    ev('message_start', {
      type: 'message_start',
      message: { id: 'msg_spill', usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
    }),
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    td(0, `[agent:task add t] ${BIG}\n[agent:end]\n`),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 },
    }),
    ev('message_stop', { type: 'message_stop' }),
  ]);
  const collect = (blob) => {
    const u = new UsageCollector();
    const framer = new SSEFramer((e, d) => u.onEvent(e, d));
    framer.feed(blob);
    return { start: u.usageStart, final: u.usageFinal, stop: u.stopReason, record: u.record };
  };
  const { out, tee } = drive(withUsage, 17);
  assert.equal(tee.fired, 1, 'the run under test actually spilled');
  assert.deepEqual(collect(out), collect(withUsage),
    'proxy.js feeds the observer the bytes the CLIENT got, which is only safe because no '
    + 'billing-bearing event is ever rewritten');
});

test('the spilled file equals the body the intent scanner would have produced', () => {
  const body = `first line of the spec\n\n  indented detail  \n${BIG}\nlast line`;
  const stream = Buffer.concat([
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    td(0, 'Here you go.\n[agent:task add t42 start] '),
    td(0, body.slice(0, 300)),
    td(0, body.slice(300)),
    td(0, '\n[agent:end]\nDone.\n'),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ]);
  const { out } = drive(stream, 43);
  const seen = textOf(out);
  const id = /@spill:([0-9a-f]{16})/.exec(seen)[1];
  assert.equal(fs.readFileSync(path.join(root(), 'spill', 'wirescope', `${id}.md`), 'utf8'), body);
  assert.equal(seen, `Here you go.\n[agent:task add t42 start] @spill:${id}\n[agent:end]\nDone.\n`,
    'the client sees the head line, the pointer, the terminator and the prose around them');
});

test('an invalid agent streams verbatim end to end', () => {
  const { out, tee } = drive(THINKING_STREAM, 64, { agent: '..' });
  assert.deepEqual(out, THINKING_STREAM);
  assert.equal(tee.fired, 0);
});
