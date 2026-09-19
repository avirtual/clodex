'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { mkTmpRoot } = require('./lib/tmp-roots');
const { SpillFilter } = require('../wire/spill');

const BIG = 'z'.repeat(900);
const SMALL = 'y'.repeat(50);
const VERBS = ['task.add', 'task.respec', 'context.compact'];
const SIZES = [1, 3, 7, 17, 64, 1e6];

let ROOT = null;
function root() {
  if (!ROOT) ROOT = mkTmpRoot('clodex-spill-');
  return ROOT;
}

function run(text, opts = {}) {
  const cs = opts.cs || 1;
  const f = new SpillFilter({
    agent: opts.agent === undefined ? 'wirescope' : opts.agent,
    root: opts.root || root(),
    verbs: VERBS,
    minBytes: opts.minBytes,
    maxBytes: opts.maxBytes,
    onSpill: opts.onSpill,
    onBail: opts.onBail,
    writeSpill: opts.writeSpill,
  });
  let out = '';
  for (let i = 0; i < text.length; i += cs) out += f.feed(text.slice(i, i + cs));
  out += f.close();
  return { out, filter: f };
}

function diskOf(out, agent = 'wirescope') {
  const id = out.split('@spill:')[1].split('\n')[0];
  return { id, body: fs.readFileSync(path.join(root(), 'spill', agent, `${id}.md`), 'utf8') };
}

test('row 1-3: traffic that does not spill is byte-identical at every chunk size', () => {
  const cases = {
    'plain prose': 'Hello world.\nNo intents here.\n',
    'prose with brackets': 'See [1], [agent], [agentx:foo]\ndone\n',
    'no trailing newline': 'abc',
    'bare terminator': '[agent:end]\n',
    'unlisted verb (dm)': `[agent:dm bob] ${BIG}\n[agent:end]\n`,
    'below threshold': `[agent:task add t1] ${SMALL}\n[agent:end]\n`,
  };
  for (const [name, t] of Object.entries(cases)) {
    for (const cs of SIZES) assert.equal(run(t, { cs }).out, t, `${name} @cs=${cs}`);
  }
});

test('row 4: the spill fires, identically, at every chunk size', () => {
  const T = `before\n[agent:task add t42 start] ${BIG}\n[agent:end]\nafter\n`;
  const outs = SIZES.map((cs) => run(T, { cs }).out);
  assert.ok(outs.every((o) => o.includes('@spill:')), 'fires at every chunk size');
  assert.equal(new Set(outs).size, 1, 'output independent of chunking');
  assert.ok(outs.every((o) => !o.includes(BIG)), 'body is off the wire');
  assert.ok(outs.every((o) => o.includes('[agent:task add t42 start] @spill:')),
    'head line byte-for-byte, modifiers included');
  assert.ok(outs.every((o) => o.startsWith('before\n') && o.endsWith('after\n')),
    'surrounding prose untouched');
  assert.ok(outs.every((o) => o.includes('\n[agent:end]\n')), 'terminator re-emitted as received');
});

test('row 5: the file is the body exactly, and the id is its sha', () => {
  const body = `line one\n\n  indented  \n${BIG}\nlast`;
  const { out } = run(`[agent:task add t7] ${body}\n[agent:end]\n`);
  const { id, body: disk } = diskOf(out);
  assert.equal(disk, body, 'no normalisation: blank lines and trailing spaces survive');
  assert.equal(id, crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').slice(0, 16));
  assert.match(id, /^[0-9a-f]{16}$/);
});

test('row 6: exactly one space after the `]` is skipped — the rest is body', () => {
  for (const [lead, expect] of [['   ', '  '], [' ', ''], ['\t', '\t']]) {
    const { out } = run(`[agent:task add t]${lead}${BIG}\n[agent:end]\n`);
    assert.equal(diskOf(out).body, expect + BIG, `lead=${JSON.stringify(lead)}`);
  }
});

test('row 7: every write failure forwards the ORIGINAL body', () => {
  const T = `[agent:task add t42 start] ${BIG}\n[agent:end]\nafter\n`;
  for (const bad of ['..', '...', '.', '', 'a/b', 'x'.repeat(65), 'ok\n', '../x']) {
    const { out } = run(T, { agent: bad });
    assert.ok(out.includes(BIG) && !out.includes('@spill'), `agent ${JSON.stringify(bad)}`);
  }
  const badRoot = mkTmpRoot('clodex-spill-');
  fs.writeFileSync(path.join(badRoot, 'spill'), 'not a directory');
  const un = run(T, { root: badRoot });
  assert.ok(un.out.includes(BIG) && !un.out.includes('@spill'), 'unwritable root');
  assert.ok(run(`[agent:task add t9] ${BIG}\n`).out.includes(BIG), 'no terminator before close');
});

test('row 8: the cap is enforced on HELD bytes, so a single-line body cannot spill past it', () => {
  const T = `before\n[agent:task add t42 start] ${BIG}\n[agent:end]\nafter\n`;
  for (const cs of [1, 7, 64, 1e6]) {
    assert.equal(run(T, { cs, maxBytes: 200 }).out, T,
      `single-line @cs=${cs}: a per-line cap never fires mid-line, so the oversized body spills anyway`);
  }
  const multi = `[agent:task add t] ${BIG}\nsecond line\nthird\n[agent:end]\nafter\n`;
  for (const cs of [1, 64, 1e6]) {
    assert.equal(run(multi, { cs, maxBytes: 200 }).out, multi, `multi-line @cs=${cs}`);
  }
});

test('row 9: a head line with nothing after the `]` is reconstructed byte-exactly', () => {
  const T = `[agent:task add a]\n${BIG}\n[agent:end]\n`;
  for (const cs of [1, 7, 64, 1e6]) {
    assert.equal(run(T, { cs, maxBytes: 200 }).out, T,
      `@cs=${cs}: spill.py emits head + " " + body here, dropping the source newline and adding `
      + 'a space — that byte-inexactness is deliberately not ported');
  }
  assert.equal(diskOf(run(T).out).body, BIG,
    'known and consumer-invisible: the sha input has no leading newline where _extractIntents '
    + 'would have produced one, and every consumer trims or strips it');
});

test('row 10: past the cap the filter LATCHES for the rest of the response', () => {
  const two = `[agent:task add t1] ${'q'.repeat(2500)}\n[agent:end]\nprose\n`
    + `[agent:task add t2] ${BIG}\n[agent:end]\n`;
  const r = run(two, { cs: 64, maxBytes: 2000 });
  assert.equal(r.out, two, 'whole response byte-identical');
  assert.ok(!r.out.includes('@spill'), 'zero pointers');
  assert.equal(r.filter.latched, true,
    'resyncing after a bail is what split [agent:end] across two deltas into "[ag\\nent:end]"');
  assert.ok(run(`[agent:task add t] ${BIG}\n[agent:end]\n`).out.includes('@spill:'),
    'a fresh response gets a fresh filter, so the latch does not leak');
});

test('row 11: the threshold is strict `>`', () => {
  assert.ok(!run('[agent:task add t] abc\n[agent:end]\n', { minBytes: 3 }).out.includes('@spill'));
  assert.ok(run('[agent:task add t] abcd\n[agent:end]\n', { minBytes: 3 }).out.includes('@spill'));
});

test('row 12: a nested intent line inside a held body BAILS rather than swallowing it', () => {
  const bails = [];
  const nested = `[agent:task add a] spec\n[agent:task add b] ${BIG}\n[agent:end]\n`;
  for (const cs of SIZES) {
    const r = run(nested, { cs, onBail: (i) => bails.push(i) });
    assert.equal(r.out, nested, `byte-identical @cs=${cs}`);
    assert.equal(r.filter.latched, true,
      'spill.py delimits on the terminator only, so a verbatim port would spill one body '
      + '"spec\\n[agent:task add b] ..." and the second ticket would vanish into the first spec');
  }
  assert.equal(bails[0].reason, 'nested-intent');
});

test('row 13: the bail follows cleanLine, so a decorated or emphasised intent also bails', () => {
  for (const dec of ['  [agent:dm x] hi', '• [agent:dm x] hi', '**[agent:dm x]**']) {
    const t = `[agent:task add a] ${BIG}\n${dec}\n[agent:end]\n`;
    assert.equal(run(t).out, t,
      `${JSON.stringify(dec)} IS an intent line to the scanner, which strips decorators, `
      + 'indentation and symmetric emphasis before it parses');
  }
});

test('row 14: a fenced example inside a held body bails — the documented cost', () => {
  const t = `[agent:task add a] ${BIG}\n\`\`\`\n[agent:dm x] example\n\`\`\`\n[agent:end]\n`;
  assert.equal(run(t).out, t,
    'over-broad on purpose: the filter cannot know fences without reimplementing fencedLines, '
    + 'and a bail costs the saving on one response, never a spec');
});

test('row 15-16: an escaped intent and a mid-line mention are body text, and still spill', () => {
  const esc = `[agent:task add a] ${BIG}\n\\[agent:dm x] hi\n[agent:end]\n`;
  const escOut = run(esc).out;
  assert.ok(escOut.includes('@spill:'));
  assert.ok(diskOf(escOut).body.includes('\\[agent:dm x] hi'));

  const mid = `[agent:task add a] ${BIG}\nclose with \`[agent:task done t1]\`\n[agent:end]\n`;
  const midOut = run(mid).out;
  assert.ok(midOut.includes('@spill:'));
  assert.ok(diskOf(midOut).body.includes('close with `[agent:task done t1]`'));
});

test('row 17: `[agent:end] trailing` is not the terminator, and bails', () => {
  const t = `[agent:task add a] ${BIG}\n[agent:end] trailing\n[agent:end]\n`;
  assert.equal(run(t).out, t);
});

test('row 18: a throwing writer forwards the original and never propagates', () => {
  const T = `before\n[agent:task add t] ${BIG}\n[agent:end]\nafter\n`;
  const r = run(T, { writeSpill: () => { throw new Error('injected write failure'); } });
  assert.equal(r.out, T);
  assert.equal(r.filter.fired, 0);
});

test('prose streams with no added latency: a partial line is held only while it could be an opener', () => {
  const f = new SpillFilter({ agent: 'wirescope', root: root(), verbs: VERBS });
  assert.equal(f.feed('Here is some prose'), 'Here is some prose');
  assert.equal(f.feed(' and more'), ' and more');
  const g = new SpillFilter({ agent: 'wirescope', root: root(), verbs: VERBS });
  assert.equal(g.feed('[age'), '', 'a possible opener is withheld');
  assert.equal(g.feed('nt:dm bob] hi\n'), '[agent:dm bob] hi\n');
});
