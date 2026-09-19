'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { mkTmpRoot } = require('./lib/tmp-roots');
const { mk } = require('./lib/session-fixtures');
const { SpillTee } = require('../wire/spill');
const { UsageCollector, SSEFramer } = require('../wire/sse');

const SCANNER = mk({
  parseIntent: require('../intent-scanner').parseIntent,
  looksLikeIntent: require('../intent-scanner').looksLikeIntent,
  execBodyCap: 64 * 1024,
});

function scannerBody(text) {
  const intents = SCANNER._extractIntents(text);
  assert.equal(intents.length, 1, 'the original text parses to exactly one intent');
  return intents[0].body.replace(/^\n/, '');
}

const BIG = 'z'.repeat(900);
const VERBS = ['task.add', 'task.respec', 'context.compact'];

let ROOT = null;
function root() {
  if (!ROOT) ROOT = mkTmpRoot('clodex-spill-');
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

test('a non-firing intent split across deltas is re-emitted as the ORIGINAL frames', () => {
  const stream = Buffer.concat([
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    td(0, 'On it.\n[agent:dm bob] '),
    td(0, BIG.slice(0, 400)),
    td(0, BIG.slice(400)),
    td(0, '\n[agent:end]\ndone.\n'),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ]);
  for (const cs of [1, 43, 997, stream.length]) {
    assert.deepEqual(drive(stream, cs).out, stream,
      `@cs=${cs}: the filter withholds a partial line that could still become an opener, and `
      + 'synthesizing one delta for the held run would re-frame traffic that never spilled');
  }
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
  assert.ok(textOf(out).includes(BIG),
    'the filter threw BEFORE recording its hold, so bail() has nothing to re-materialise; the '
    + 'raw frames are the only byte-faithful copy and dropping them deletes assistant text');
  assert.equal(textOf(out), `[agent:task add t] ${BIG}\n[agent:end]\n`,
    'a panicking tee forwards the ORIGINAL text in full, not a truncation');
});

test('an onSpill listener that throws cannot cost the client its text', () => {
  const stream = Buffer.concat([
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    td(0, `[agent:task add t] ${BIG}`),
    td(0, '\n[agent:end]\nAfter.\n'),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_stop', { type: 'message_stop' }),
  ]);
  for (const cs of [1, 43, 1024, stream.length]) {
    const tee = new SpillTee({
      agent: 'wirescope',
      root: root(),
      verbs: VERBS,
      onSpill: () => { throw new Error('listener blew up'); },
    });
    const out = Buffer.concat([tee.feed(stream), tee.close()]);
    const seen = textOf(out);
    assert.ok(seen.includes('@spill:'), `@cs=${cs}: the spill still happened`);
    assert.ok(seen.includes('After.'), `@cs=${cs}: the prose after the body survives`);
    assert.equal(tee.fired, 1, `@cs=${cs}`);
    assert.equal(tee.latched, false,
      `@cs=${cs}: a throwing listener must not drive the tee into the panic path at all`);
  }
});

test('an SSE body that never terminates a frame is forwarded, not buffered forever', () => {
  const tee = new SpillTee({ agent: 'wirescope', root: root(), verbs: VERBS, maxBytes: 500 });
  const blob = Buffer.from(`event: content_block_delta\ndata: ${'q'.repeat(3000)}`, 'utf8');
  const out = Buffer.concat([tee.feed(blob), tee.close()]);
  assert.deepEqual(out, blob,
    'a 200 text/event-stream with no `\\n\\n` would otherwise buffer the whole response while '
    + 'the unfiltered path forwarded every byte of it');
  assert.equal(tee.latched, true);
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

test('the spilled file equals the body the REAL intent scanner would have produced', () => {
  const body = `first line of the spec\n\n  indented detail  \n${BIG}\nlast line`;
  const original = `Here you go.\n[agent:task add t42 start] ${body}\n[agent:end]\nDone.\n`;
  const stream = Buffer.concat([
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    td(0, 'Here you go.\n[agent:task add t42 start] '),
    td(0, body.slice(0, 300)),
    td(0, body.slice(300)),
    td(0, '\n[agent:end]\nDone.\n'),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ]);
  for (const cs of [1, 43, 1024, stream.length]) {
    const { out } = drive(stream, cs);
    const seen = textOf(out);
    const id = /@spill:([0-9a-f]{16})/.exec(seen)[1];
    const onDisk = fs.readFileSync(path.join(root(), 'spill', 'wirescope', `${id}.md`), 'utf8');
    assert.equal(onDisk, scannerBody(original),
      `@cs=${cs}: S-B substitutes this file for the body the UNSPILLED path would have carried, so `
      + 'a one-byte divergence from the repo\'s own delimiter silently dispatches a different spec');
    assert.equal(seen,
      `Here you go.\n[agent:task add t42 start] first line of the spec @spill:${id}\n[agent:end]\nDone.\n`,
      `@cs=${cs}: the client sees the head line, the body's first line, the pointer, the terminator and `
      + 'the prose around them');
    assert.equal(SCANNER._extractIntents(seen)[0].body.replace(/^\n/, ''),
      `first line of the spec @spill:${id}`,
      `@cs=${cs}: and the REWRITTEN text re-parses to one intent whose body is the pointer line — `
      + 'a title the scanner mangled would reach _handleIntent as a spec nobody wrote');
  }
});

test('scanner equivalence holds for the body shapes the delimiter treats specially', () => {
  const cases = [
    ['no rest on the head line', 'task add t1', `\n${BIG}\nlast`],
    ['blank lines inside the body', 'task add t2', `one\n\n\n${BIG}\ntwo`],
    ['trailing blank lines the scanner pops', 'task add t3', `one\n${BIG}\n\n  \n`],
    ['CRLF-free indented continuation', 'context compact', `  keep going\n${BIG}\n   deeper  `],
  ];
  for (const [label, headArgs, body] of cases) {
    const original = `[agent:${headArgs}] ${body}\n[agent:end]\n`;
    const stream = Buffer.concat([
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      td(0, original),
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ]);
    const { out } = drive(stream, 43);
    const seen = textOf(out);
    const m = /@spill:([0-9a-f]{16})/.exec(seen);
    assert.ok(m, `${label}: spilled`);
    const onDisk = fs.readFileSync(path.join(root(), 'spill', 'wirescope', `${m[1]}.md`), 'utf8');
    assert.equal(onDisk, scannerBody(original), label);
  }
});

test('an invalid agent streams verbatim end to end', () => {
  const { out, tee } = drive(THINKING_STREAM, 64, { agent: '..' });
  assert.deepEqual(out, THINKING_STREAM);
  assert.equal(tee.fired, 0);
});
