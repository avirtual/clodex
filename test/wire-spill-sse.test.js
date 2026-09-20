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

const MARK = 'Clodex kept ';
const KEPT_RE = /Clodex kept (?:my text|it) at \S+\/([0-9a-f]{16})\.md\.\)/;

function idOf(s) {
  const m = KEPT_RE.exec(typeof s === 'string' ? s : s.toString('utf8'));
  return m ? m[1] : null;
}

function keptPath(id, r = root()) {
  return path.join(r, 'spill', 'wirescope', `${id}.md`);
}

function receipt(words, body, id, title) {
  const t = title === undefined ? '' : ` — "${title}"`;
  return `(I sent ${words}${t} in full, ${Buffer.byteLength(body, 'utf8')} B; `
    + `Clodex kept my text at ${keptPath(id)}.)\n`;
}

function proseReceipt(text, id, r = root()) {
  return `(I wrote ${Buffer.byteLength(text, 'utf8')} B of prose after my last intent; it reached the operator's log `
    + `and Clodex kept it at ${keptPath(id, r)}.)\n`;
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
    assert.ok(textOf(out).includes(MARK), `text rewritten @cs=${cs}`);
    assert.ok(!textOf(out).includes(BIG), `body off the wire @cs=${cs}`);
    assert.equal(out.toString('utf8').match(/event: content_block_start/g).length, 2);
    assert.equal(out.toString('utf8').match(/event: content_block_stop/g).length, 2);
    assert.equal(out.toString('utf8').match(/event: message_stop/g).length, 1);
    assert.equal(tee.fired, 1, `one receipt @cs=${cs}`);
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
    td(0, 'On it.\n[agent:remind in 5m] '),
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

const DM_STREAM = Buffer.concat([
  ev('message_start', { type: 'message_start' }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  td(0, 'On it.\n[agent:dm bob] '),
  td(0, BIG.slice(0, 400)),
  td(0, BIG.slice(400)),
  td(0, '\n[agent:end]\n'),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('message_stop', { type: 'message_stop' }),
]);

test('a dm body spills through the tee, and the same stream with dm unlisted is byte-identical', () => {
  for (const cs of [1, 43, 997, DM_STREAM.length]) {
    const { out, tee } = drive(DM_STREAM, cs, { verbs: [...VERBS, 'dm'] });
    const seen = textOf(out);
    const id = idOf(seen);
    assert.equal(seen, `On it.\n${receipt('dm bob', BIG, id)}`, `@cs=${cs}`);
    assert.equal(fs.readFileSync(path.join(root(), 'spill', 'wirescope', `${id}.md`), 'utf8'), BIG,
      `@cs=${cs}: the recipient's copy is on disk in full`);
    assert.equal(tee.fired, 1, `@cs=${cs}`);
  }
  assert.ok(!VERBS.includes('dm'), 'ENTER: the base fixture really omits dm');
  for (const cs of [1, 43, 997, DM_STREAM.length]) {
    const { out, tee } = drive(DM_STREAM, cs);
    assert.deepEqual(out, DM_STREAM, `@cs=${cs}: an unarmed seat's stream is untouched`);
    assert.equal(tee.fired, 0, `@cs=${cs}`);
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
  assert.ok(s.indexOf('event: ping') < s.indexOf(MARK), 'pings arrive before the receipt');
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
  assert.ok(!s.includes(MARK));
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
    assert.ok(seen.includes(MARK), `@cs=${cs}: the spill still happened`);
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
    'no billing-bearing event is ever rewritten, so a collector on either side of the spill agrees');
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
    const id = idOf(seen);
    const onDisk = fs.readFileSync(path.join(root(), 'spill', 'wirescope', `${id}.md`), 'utf8');
    assert.equal(onDisk, scannerBody(original),
      `@cs=${cs}: S-B substitutes this file for the body the UNSPILLED path would have carried, so `
      + 'a one-byte divergence from the repo\'s own delimiter silently dispatches a different spec');
    assert.equal(seen,
      `Here you go.\n${receipt('task add t42 start', scannerBody(original), id, 'first line of the spec')}Done.\n`,
      `@cs=${cs}: the client sees the receipt with the body's first line, and the prose around it; `
      + 'the head line and the terminator are gone');
    assert.deepEqual(SCANNER._extractIntents(seen), [],
      `@cs=${cs}: and the REWRITTEN text re-parses to NO intent — the transcript carries nothing `
      + 'the seat could copy as an emission');
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
    const id = idOf(seen);
    assert.ok(id, `${label}: spilled`);
    const onDisk = fs.readFileSync(path.join(root(), 'spill', 'wirescope', `${id}.md`), 'utf8');
    assert.equal(onDisk, scannerBody(original), label);
  }
});

test('an invalid agent streams verbatim end to end', () => {
  const { out, tee } = drive(THINKING_STREAM, 64, { agent: '..' });
  assert.deepEqual(out, THINKING_STREAM);
  assert.equal(tee.fired, 0);
});


test('proseSpill: the receipt delta precedes content_block_stop, and the stop is byte-identical', () => {
  const stop = ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  const stream = Buffer.concat([
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    td(0, 'Acknowledged.\n'),
    td(0, BIG.slice(0, 400)),
    td(0, `${BIG.slice(400)}\n`),
    stop,
    ev('message_stop', { type: 'message_stop' }),
  ]);
  const { out, tee } = drive(stream, 17, { proseSpill: true });
  const s = out.toString('utf8');

  assert.equal(tee.fired, 1);
  assert.ok(!s.includes(BIG), 'the prose is off the wire');
  assert.ok(s.indexOf(MARK) < s.indexOf('event: content_block_stop'),
    'held text cannot outlive its block — the receipt is emitted before the stop');
  assert.ok(s.includes(stop.toString('utf8')), 'the stop frame is byte-identical');
  assert.equal(textOf(out), proseReceipt(`Acknowledged.\n${BIG}\n`, idOf(s)),
    'and the block carries exactly the receipt line');
});

test('proseSpill: a thinking block is never touched', () => {
  const think = ev('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: BIG, text: BIG },
  });
  const stream = Buffer.concat([
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    think,
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ]);
  const { out, tee } = drive(stream, 23, { proseSpill: true });
  assert.ok(out.toString('utf8').includes(think.toString('utf8')),
    'a rewritten thinking block breaks its signature, so the delta type is the guard');
  assert.equal(tee.fired, 0);
});

const NARRATION = 'n'.repeat(900);

function typesOf(blob) {
  const out = [];
  for (const e of blob.toString('utf8').split('\n\n')) {
    const m = /^event: (\S+)/.exec(e);
    if (m) out.push(m[1]);
  }
  return out;
}

function start(index, type) {
  return ev('content_block_start', { type: 'content_block_start', index, content_block: { type } });
}
const stopAt = (index) => ev('content_block_stop', { type: 'content_block_stop', index });

const NARRATE_THEN_TOOL = Buffer.concat([
  ev('message_start', { type: 'message_start' }),
  start(0, 'text'),
  td(0, `${NARRATION}\n`),
  stopAt(0),
  start(1, 'tool_use'),
  stopAt(1),
  start(2, 'text'),
  td(2, 'Fifty bytes of follow-up, well under the floor.\n'),
  stopAt(2),
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  ev('message_stop', { type: 'message_stop' }),
]);

const TWO_FAT_BLOCKS = Buffer.concat([
  start(0, 'text'),
  td(0, `${NARRATION}\n`),
  stopAt(0),
  start(1, 'tool_use'),
  stopAt(1),
  start(2, 'text'),
  td(2, `${BIG}\n`),
  stopAt(2),
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  ev('message_stop', { type: 'message_stop' }),
]);

const LONE_TEXT = Buffer.concat([
  start(0, 'text'),
  td(0, `${BIG}\n`),
  stopAt(0),
  ev('message_stop', { type: 'message_stop' }),
]);

const THINK_THEN_TEXT = Buffer.concat([
  start(0, 'thinking'),
  ev('content_block_delta', {
    type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it' },
  }),
  stopAt(0),
  start(1, 'text'),
  td(1, `${BIG}\n`),
  stopAt(1),
  ev('message_stop', { type: 'message_stop' }),
]);

test('proseSpill: narration before a tool_use is forwarded whole, at every chunk size', () => {
  for (const cs of [1, 17, 997, NARRATE_THEN_TOOL.length]) {
    const { out, tee } = drive(NARRATE_THEN_TOOL, cs, { proseSpill: true });
    assert.deepEqual(out, NARRATE_THEN_TOOL,
      `@cs=${cs}: the narration is 900 bytes, well past the floor, so only the non-text `
      + 'content_block_start keeps it off the pointer path — the ruling says tool narration is '
      + 'never touched, and "end of response" means the response, not the block');
    assert.equal(tee.fired, 0, `@cs=${cs}: the 50-byte tail after the tool call is under the floor`);
  }
});

test('proseSpill: only the text AFTER the last non-text block is the tail', () => {
  for (const cs of [1, 17, 997, TWO_FAT_BLOCKS.length]) {
    const { out, tee } = drive(TWO_FAT_BLOCKS, cs, { proseSpill: true });
    const s = out.toString('utf8');
    assert.equal(tee.fired, 1, `@cs=${cs}`);
    assert.ok(textOf(out).startsWith(`${NARRATION}\n`),
      `@cs=${cs}: the first text block is narration and survives verbatim`);
    assert.ok(!s.includes(BIG), `@cs=${cs}: the second is the sign-off and goes to disk`);
    const id = idOf(s);
    assert.equal(fs.readFileSync(path.join(root(), 'spill', 'wirescope', `${id}.md`), 'utf8'),
      `${BIG}\n`, `@cs=${cs}: and the file holds exactly those 900 bytes`);
    assert.deepEqual(typesOf(out), [
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ], `@cs=${cs}: the receipt delta lands INSIDE the last text block — the held stop frame and `
      + 'everything after it are released in their original order');
  }
});

test('proseSpill: a lone text block still spills, with the stop frames after the receipt', () => {
  for (const cs of [1, 23, LONE_TEXT.length]) {
    const { out, tee } = drive(LONE_TEXT, cs, { proseSpill: true });
    assert.equal(tee.fired, 1, `@cs=${cs}`);
    const id = idOf(out);
    assert.equal(textOf(out), proseReceipt(fs.readFileSync(keptPath(id), 'utf8'), id), `@cs=${cs}`);
    assert.deepEqual(typesOf(out),
      ['content_block_start', 'content_block_delta', 'content_block_stop', 'message_stop'],
      `@cs=${cs}: holding the stop must not reorder or drop it`);
  }
});

test('proseSpill: a thinking block PRECEDES rather than follows, so the text after it spills', () => {
  for (const cs of [1, 23, THINK_THEN_TEXT.length]) {
    const { out, tee } = drive(THINK_THEN_TEXT, cs, { proseSpill: true });
    assert.equal(tee.fired, 1,
      `@cs=${cs}: a non-text block flushes only a tail already standing, and there was none`);
    const id = idOf(out);
    assert.equal(textOf(out), proseReceipt(fs.readFileSync(keptPath(id), 'utf8'), id), `@cs=${cs}`);
  }
});

test('proseSpill: a panic while the last stop frame is held forwards it verbatim', () => {
  const tee = new SpillTee({ agent: 'wirescope', root: root(), verbs: VERBS, proseSpill: true });
  const head = Buffer.concat([start(0, 'text'), td(0, `${BIG}\n`), stopAt(0)]);
  const first = tee.feed(head);
  assert.equal(first.toString('utf8'), start(0, 'text').toString('utf8'),
    'ENTER: the delta and the stop are both still held — nothing to panic about otherwise');

  tee.filter.close = () => { throw new Error('socket died mid-close'); };
  const out = Buffer.concat([first, tee.close()]);
  assert.equal(tee.latched, true);
  assert.ok(out.toString('utf8').includes(td(0, `${BIG}\n`).toString('utf8')),
    'the original delta frame is the only byte-faithful copy of the prose');
  assert.ok(out.toString('utf8').includes(stopAt(0).toString('utf8')),
    'and the held stop frame is released too: a block the client never sees closed hangs it');
  assert.deepEqual(typesOf(out),
    ['content_block_start', 'content_block_delta', 'content_block_stop']);
});

test('proseSpill OFF: every one of those four streams is byte-identical to upstream', () => {
  const cases = {
    'narration then tool_use': NARRATE_THEN_TOOL,
    'two fat text blocks': TWO_FAT_BLOCKS,
    'a lone text block': LONE_TEXT,
    'thinking then text': THINK_THEN_TEXT,
  };
  for (const [label, stream] of Object.entries(cases)) {
    for (const cs of [1, 17, 997, stream.length]) {
      assert.deepEqual(drive(stream, cs).out, stream,
        `${label} @cs=${cs}: the held-stop framing is gated on proseSpill, so the default path `
        + 'keeps the byte identity every older subject rests on');
    }
  }
});

const PING = ev('ping', { type: 'ping' });
const SHORT = 'Fifty bytes of follow-up, well under the floor.\n';

const PAUSE_AFTER_STOP = Buffer.concat([
  start(0, 'text'),
  td(0, SHORT),
  stopAt(0),
  PING,
  PING,
  start(1, 'tool_use'),
  stopAt(1),
  ev('message_stop', { type: 'message_stop' }),
]);

test('proseSpill: pings pass a held stop, so a pause after a block boundary is not silent', () => {
  assert.deepEqual(typesOf(PAUSE_AFTER_STOP), [
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'ping', 'ping', 'content_block_start', 'content_block_stop', 'message_stop',
  ], 'ENTER: upstream sends the stop BEFORE the pings, so passing them is a reorder');
  for (const cs of [1, 17, 997, PAUSE_AFTER_STOP.length]) {
    const { out } = drive(PAUSE_AFTER_STOP, cs, { proseSpill: true });
    const s = out.toString('utf8');
    assert.deepEqual(typesOf(out), [
      'content_block_start', 'ping', 'ping', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_stop', 'message_stop',
    ], `@cs=${cs}: a ping carries no block state, so it is legal ahead of the held stop — and `
      + 'holding it would send the client zero bytes for the whole upstream pause');
    assert.equal(s.split(PING.toString('utf8')).length - 1, 2,
      `@cs=${cs}: both pings forwarded, byte-identical to upstream`);
    assert.ok(s.indexOf('event: ping') < s.indexOf('event: content_block_stop'),
      `@cs=${cs}: ahead of the stop they were queued behind`);
  }
  for (const cs of [1, 17, 997, PAUSE_AFTER_STOP.length]) {
    assert.deepEqual(drive(PAUSE_AFTER_STOP, cs).out, PAUSE_AFTER_STOP,
      `@cs=${cs}: OFF, nothing is held at all, so the pings go out where upstream put them`);
  }
});

test('proseSpill: a ping passes the held stop; message_delta stays behind the receipt', () => {
  const usage = ev('message_delta', {
    type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 },
  });
  const tail = [stopAt(0), usage, ev('message_stop', { type: 'message_stop' })];
  const head = [start(0, 'text'), td(0, `${BIG}\n`)];
  const plain = Buffer.concat([...head, ...tail]);
  const pinged = Buffer.concat([...head, tail[0], PING, tail[1], tail[2]]);
  for (const cs of [1, 23, 997, plain.length]) {
    const { out, tee } = drive(plain, cs, { proseSpill: true });
    assert.equal(tee.fired, 1, `@cs=${cs}`);
    assert.deepEqual(typesOf(out), [
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ], `@cs=${cs}: message_delta must follow the receipt delta — it closes the message the `
      + 'receipt is part of');
  }
  for (const cs of [1, 23, 997, pinged.length]) {
    const { out, tee } = drive(pinged, cs, { proseSpill: true });
    const s = out.toString('utf8');
    assert.equal(tee.fired, 1, `@cs=${cs}`);
    assert.deepEqual(typesOf(out), [
      'content_block_start', 'ping', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ], `@cs=${cs}: only the ping is let past the hold`);
    assert.ok(s.indexOf('event: ping') < s.indexOf(MARK), `@cs=${cs}`);
  }
});

test('proseSpill: a fire AT the stop is flushed there, not left behind the hold', () => {
  const freshRoot = mkTmpRoot('clodex-spill-');
  const tee = new SpillTee({
    agent: 'wirescope', root: freshRoot, verbs: VERBS, proseSpill: true,
  });
  const first = tee.feed(Buffer.concat([
    start(0, 'text'),
    td(0, `[agent:task add t] ${BIG}\n[agent:end]`),
    stopAt(0),
  ]));
  const s = first.toString('utf8');
  const m = KEPT_RE.exec(s);
  assert.ok(m, 'the terminator is the block\'s last unterminated line, so endBlock resolves it — '
    + 'and the stop branch flushes on that fire the way the delta branch does');
  assert.deepEqual(typesOf(first),
    ['content_block_start', 'content_block_delta', 'content_block_stop'],
    'the receipt is forwarded at the stop, ahead of every later frame');
  assert.equal(tee.fired, 1);

  const second = tee.feed(Buffer.concat([start(1, 'tool_use'), stopAt(1)]));
  assert.ok(!second.toString('utf8').includes(MARK), 'no second receipt at the next block');
  const rest = Buffer.concat([second, tee.feed(ev('message_stop', { type: 'message_stop' })), tee.close()]);
  assert.deepEqual(typesOf(rest),
    ['content_block_start', 'content_block_stop', 'message_stop']);
  assert.equal(tee.fired, 1);
  const dir = path.join(freshRoot, 'spill', 'wirescope');
  assert.deepEqual(fs.readdirSync(dir), [`${m[1]}.md`],
    'exactly one file: a receipt stranded in heldOut would be dropped on a panic and orphan it');
  assert.equal(fs.readFileSync(path.join(dir, `${m[1]}.md`), 'utf8'), BIG);
});

test('proseSpill: _panic forwards the FILTER when it holds bytes older than the raw window', () => {
  const A = 'a'.repeat(900);
  const B = 'b'.repeat(50);
  const bails = [];
  const tee = new SpillTee({
    agent: 'wirescope', root: root(), verbs: VERBS, proseSpill: true, onBail: (i) => bails.push(i),
  });
  const first = tee.feed(Buffer.concat([start(0, 'text'), td(0, `${A}\n`), stopAt(0), start(1, 'text')]));
  assert.deepEqual(typesOf(first),
    ['content_block_start', 'content_block_stop', 'content_block_start'],
    'ENTER: the first block\'s delta frame is DROPPED at the text→text boundary, while its '
    + 'bytes live on in the filter tail — from here heldRaw is no longer the superset');

  let win = null;
  const realFlush = tee._flushHeld.bind(tee);
  tee._flushHeld = (out) => { if (!win) win = [tee.heldOut.length, tee.heldSrc.length]; return realFlush(out); };
  const realFeed = tee.filter.feed.bind(tee.filter);
  tee.filter.feed = (t) => { realFeed(t); throw new Error('injected after the filter consumed it'); };

  const out = Buffer.concat([first, tee.feed(td(1, `${B}\n`))]);
  assert.equal(bails[0].reason, 'error');
  assert.equal(tee.latched, true);
  assert.ok(win && win[0] > win[1],
    `ENTER: at the panic the filter held ${win && win[0]} bytes against a ${win && win[1]}-byte raw window`);
  assert.equal(textOf(out), `${A}\n${B}\n`,
    'bail() re-materialises both blocks\' prose, so the synthesized delta is the only copy that '
    + 'still carries the first block — forwarding heldRaw verbatim here deletes it');
  assert.equal(tee.fired, 0);
});
