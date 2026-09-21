'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { mkTmpRoot } = require('./lib/tmp-roots');
const { mk } = require('./lib/session-fixtures');
const { SpillTee, SPILL_FILLER } = require('../wire/spill');
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

function keptPath(id, r = root()) {
  return path.join(r, 'spill', 'wirescope', `${id}.md`);
}

function idOf(spills) {
  assert.equal(spills.length, 1, 'exactly one spill names the file — the record no longer does');
  return spills[0].id;
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
  const spills = [];
  const tee = new SpillTee({
    agent: opts.agent === undefined ? 'wirescope' : opts.agent,
    root: root(),
    verbs: VERBS,
    ...opts,
    onSpill: (i) => { spills.push(i); if (opts.onSpill) opts.onSpill(i); },
  });
  const out = [];
  for (let i = 0; i < stream.length; i += cs) out.push(tee.feed(stream.slice(i, i + cs)));
  out.push(tee.close());
  return { out: Buffer.concat(out), tee, spills };
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
    assert.equal(textOf(out), 'Here you go.\nDone.\n', `text rewritten: the block is gone whole @cs=${cs}`);
    assert.equal(out.toString('utf8').match(/event: content_block_start/g).length, 2);
    assert.equal(out.toString('utf8').match(/event: content_block_stop/g).length, 2);
    assert.equal(out.toString('utf8').match(/event: message_stop/g).length, 1);
    assert.equal(tee.fired, 1, `one spill @cs=${cs}`);
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
    const { out, tee, spills } = drive(DM_STREAM, cs, { verbs: [...VERBS, 'dm'] });
    const seen = textOf(out);
    const id = idOf(spills);
    assert.equal(seen, 'On it.\n', `@cs=${cs}: the dm block leaves whole; no receipt, no filler — prose survives`);
    assert.deepEqual(spills, [{ verb: 'dm', id, bytes: 900, head: 'dm bob' }], `@cs=${cs}`);
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
  assert.equal(textOf(out), SPILL_FILLER, 'the whole block was the reply, so the emptied block gets the filler');
  assert.ok(s.indexOf('event: ping') < s.indexOf('(sent)'), 'pings arrive before the filler');
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
  assert.equal(textOf(out), `[agent:task add t] ${BIG}`, 'the held original is emitted, and no filler pads a block that never spilled');
  assert.ok(!s.includes('(sent)'));
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
    assert.equal(seen, 'After.\n', `@cs=${cs}: the spill still happened and the prose after the body survives`);
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
    const { out, spills } = drive(stream, cs);
    const seen = textOf(out);
    const id = idOf(spills);
    const onDisk = fs.readFileSync(path.join(root(), 'spill', 'wirescope', `${id}.md`), 'utf8');
    assert.equal(onDisk, scannerBody(original),
      `@cs=${cs}: S-B substitutes this file for the body the UNSPILLED path would have carried, so `
      + 'a one-byte divergence from the repo\'s own delimiter silently dispatches a different spec');
    assert.equal(seen, 'Here you go.\nDone.\n',
      `@cs=${cs}: the client sees the prose around the block and nothing of the block — not its first line, `
      + 'not the head line, not the terminator');
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
    const { out, spills } = drive(stream, 43);
    assert.equal(textOf(out), SPILL_FILLER, `${label}: the block was the whole reply`);
    const id = idOf(spills);
    const onDisk = fs.readFileSync(path.join(root(), 'spill', 'wirescope', `${id}.md`), 'utf8');
    assert.equal(onDisk, scannerBody(original), label);
  }
});

test('an invalid agent streams verbatim end to end', () => {
  const { out, tee } = drive(THINKING_STREAM, 64, { agent: '..' });
  assert.deepEqual(out, THINKING_STREAM);
  assert.equal(tee.fired, 0);
});


test('proseSpill: the filler delta precedes content_block_stop, and the stop is byte-identical', () => {
  const stop = ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  const stream = Buffer.concat([
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    td(0, 'Acknowledged.\n'),
    td(0, BIG.slice(0, 400)),
    td(0, `${BIG.slice(400)}\n`),
    stop,
    ev('message_stop', { type: 'message_stop' }),
  ]);
  const { out, tee, spills } = drive(stream, 17, { proseSpill: true });
  const s = out.toString('utf8');

  assert.equal(tee.fired, 1);
  assert.ok(!s.includes(BIG), 'the prose is off the wire');
  assert.ok(s.indexOf('(sent)') < s.indexOf('event: content_block_stop'),
    'held text cannot outlive its block — the filler is emitted before the stop');
  assert.ok(s.includes(stop.toString('utf8')), 'the stop frame is byte-identical');
  assert.equal(textOf(out), '(sent)', 'and the block carries exactly the filler');
  assert.equal(fs.readFileSync(keptPath(idOf(spills)), 'utf8'), `Acknowledged.\n${BIG}\n`);
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
    const { out, tee, spills } = drive(TWO_FAT_BLOCKS, cs, { proseSpill: true });
    const s = out.toString('utf8');
    assert.equal(tee.fired, 1, `@cs=${cs}`);
    assert.equal(textOf(out), `${NARRATION}\n(sent)`,
      `@cs=${cs}: the first text block is narration and survives verbatim; the second is emptied and gets the filler`);
    assert.ok(!s.includes(BIG), `@cs=${cs}: the second is the sign-off and goes to disk`);
    const id = idOf(spills);
    assert.equal(fs.readFileSync(path.join(root(), 'spill', 'wirescope', `${id}.md`), 'utf8'),
      `${BIG}\n`, `@cs=${cs}: and the file holds exactly those 900 bytes`);
    assert.deepEqual(typesOf(out), [
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ], `@cs=${cs}: the filler delta lands INSIDE the last text block — the held stop frame and `
      + 'everything after it are released in their original order');
  }
});

test('proseSpill: a lone text block still spills, with the stop frames after the filler', () => {
  for (const cs of [1, 23, LONE_TEXT.length]) {
    const { out, tee, spills } = drive(LONE_TEXT, cs, { proseSpill: true });
    assert.equal(tee.fired, 1, `@cs=${cs}`);
    const id = idOf(spills);
    assert.equal(fs.readFileSync(keptPath(id), 'utf8'), `${BIG}\n`, `@cs=${cs}`);
    assert.equal(textOf(out), '(sent)', `@cs=${cs}`);
    assert.deepEqual(typesOf(out),
      ['content_block_start', 'content_block_delta', 'content_block_stop', 'message_stop'],
      `@cs=${cs}: holding the stop must not reorder or drop it`);
  }
});

test('proseSpill: a thinking block PRECEDES rather than follows, so the text after it spills', () => {
  for (const cs of [1, 23, THINK_THEN_TEXT.length]) {
    const { out, tee, spills } = drive(THINK_THEN_TEXT, cs, { proseSpill: true });
    assert.equal(tee.fired, 1,
      `@cs=${cs}: a non-text block flushes only a tail already standing, and there was none`);
    assert.equal(fs.readFileSync(keptPath(idOf(spills)), 'utf8'), `${BIG}\n`, `@cs=${cs}`);
    assert.equal(textOf(out), '(sent)', `@cs=${cs}`);
    assert.ok(out.toString('utf8').includes(td(1, '(sent)').toString('utf8')),
      `@cs=${cs}: the filler carries the TEXT block's index, not the thinking block's`);
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

test('proseSpill: a ping passes the held stop; message_delta stays behind the filler', () => {
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
    ], `@cs=${cs}: message_delta must follow the filler delta — it closes the message the `
      + 'filler is part of');
  }
  for (const cs of [1, 23, 997, pinged.length]) {
    const { out, tee } = drive(pinged, cs, { proseSpill: true });
    const s = out.toString('utf8');
    assert.equal(tee.fired, 1, `@cs=${cs}`);
    assert.deepEqual(typesOf(out), [
      'content_block_start', 'ping', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ], `@cs=${cs}: only the ping is let past the hold`);
    assert.ok(s.indexOf('event: ping') < s.indexOf('(sent)'), `@cs=${cs}`);
  }
});

test('proseSpill: a fire AT the stop is flushed there, not left behind the hold', () => {
  const freshRoot = mkTmpRoot('clodex-spill-');
  const spills = [];
  const tee = new SpillTee({
    agent: 'wirescope', root: freshRoot, verbs: VERBS, proseSpill: true, onSpill: (i) => spills.push(i),
  });
  const first = tee.feed(Buffer.concat([
    start(0, 'text'),
    td(0, `[agent:task add t] ${BIG}\n[agent:end]`),
    stopAt(0),
  ]));
  assert.equal(spills.length, 1, 'the terminator is the block\'s last unterminated line, so endBlock resolves it — '
    + 'and the stop branch flushes on that fire the way the delta branch does');
  assert.deepEqual(typesOf(first),
    ['content_block_start', 'content_block_delta', 'content_block_stop'],
    'the filler is forwarded at the stop, ahead of every later frame');
  assert.equal(textOf(first), '(sent)');
  assert.equal(tee.fired, 1);

  const second = tee.feed(Buffer.concat([start(1, 'tool_use'), stopAt(1)]));
  assert.ok(!second.toString('utf8').includes('(sent)'), 'no second filler at the next block: nothing spilled there');
  const rest = Buffer.concat([second, tee.feed(ev('message_stop', { type: 'message_stop' })), tee.close()]);
  assert.deepEqual(typesOf(rest),
    ['content_block_start', 'content_block_stop', 'message_stop']);
  assert.equal(tee.fired, 1);
  const dir = path.join(freshRoot, 'spill', 'wirescope');
  assert.deepEqual(fs.readdirSync(dir), [`${spills[0].id}.md`], 'exactly one file');
  assert.equal(fs.readFileSync(path.join(dir, `${spills[0].id}.md`), 'utf8'), BIG);
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

const ONLY_BLOCK = `[agent:task add t] ${BIG}\n[agent:end]\n`;

function textBlock(index, text, before = [], after = []) {
  return Buffer.concat([
    ...before,
    start(index, 'text'),
    td(index, text),
    stopAt(index),
    ...after,
    ev('message_stop', { type: 'message_stop' }),
  ]);
}

test('empty-record guard: a reply that is ONLY the spilled block gets exactly `(sent)` before its stop, in both modes', () => {
  assert.equal(SPILL_FILLER, '(sent)', 'the literal the mimic detector matches and the CLI records');
  const stream = textBlock(0, ONLY_BLOCK);
  for (const proseSpill of [false, true]) {
    for (const cs of [1, 17, 997, stream.length]) {
      const { out, tee } = drive(stream, cs, { proseSpill });
      assert.equal(tee.fired, 1, `proseSpill=${proseSpill} @cs=${cs}`);
      assert.equal(textOf(out), '(sent)',
        `proseSpill=${proseSpill} @cs=${cs}: Anthropic rejects a text block with no non-whitespace text on the NEXT `
        + 'request, and an assistant turn that is one long dispatch is the common shape');
      assert.deepEqual(typesOf(out),
        ['content_block_start', 'content_block_delta', 'content_block_stop', 'message_stop'],
        `proseSpill=${proseSpill} @cs=${cs}: one filler delta, inside the block, before its stop`);
      assert.ok(out.toString('utf8').includes(td(0, '(sent)').toString('utf8')),
        `proseSpill=${proseSpill} @cs=${cs}: the filler is a plain text_delta on the block's index`);
    }
  }
});

test('empty-record guard: any surviving non-whitespace prose suppresses the filler; whitespace alone does not', () => {
  for (const proseSpill of [false, true]) {
    const withProse = drive(textBlock(0, `On it.\n${ONLY_BLOCK}`), 13, { proseSpill });
    assert.equal(withProse.tee.fired, 1, `proseSpill=${proseSpill}`);
    assert.equal(textOf(withProse.out), 'On it.\n', `proseSpill=${proseSpill}: a reply with any other prose gets nothing inserted`);

    const wsOnly = drive(textBlock(0, `\n${ONLY_BLOCK}\n`), 13, { proseSpill });
    assert.equal(wsOnly.tee.fired, 1, `proseSpill=${proseSpill}`);
    assert.equal(textOf(wsOnly.out), '\n\n(sent)',
      `proseSpill=${proseSpill}: newlines around the block are forwarded as they were, and the filler still lands — whitespace-only is what the API rejects`);
  }
});

test('empty-record guard: a block that spilled nothing is never padded, and a filler never lands in a non-text block', () => {
  const short = textBlock(0, 'Fifty bytes of follow-up, well under the floor.\n');
  for (const proseSpill of [false, true]) {
    const { out, tee } = drive(short, 13, { proseSpill });
    assert.equal(tee.fired, 0);
    assert.ok(!out.toString('utf8').includes('(sent)'), `proseSpill=${proseSpill}: nothing spilled, nothing padded`);
  }
  const { out, tee } = drive(NARRATE_THEN_TOOL, 13, { proseSpill: true });
  assert.equal(tee.fired, 0);
  assert.deepEqual(out, NARRATE_THEN_TOOL, 'the tool_use block passes its stop with no delta of any kind');
});

test('empty-record guard: after a thinking block, the filler lands in the TEXT block and the thinking block is untouched', () => {
  const stream = textBlock(1, ONLY_BLOCK, [
    start(0, 'thinking'),
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it' } }),
    stopAt(0),
  ]);
  for (const proseSpill of [false, true]) {
    const { out, tee } = drive(stream, 29, { proseSpill });
    assert.equal(tee.fired, 1, `proseSpill=${proseSpill}`);
    assert.equal(textOf(out), '(sent)', `proseSpill=${proseSpill}`);
    assert.ok(out.toString('utf8').includes(td(1, '(sent)').toString('utf8')), `proseSpill=${proseSpill}: index 1, the text block`);
    assert.equal(textOf(out, 'thinking_delta', 'thinking'), 'weighing it', `proseSpill=${proseSpill}`);
  }
});
