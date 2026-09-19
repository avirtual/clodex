'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { mkTmpRoot } = require('./lib/tmp-roots');
const { SpillFilter } = require('../wire/spill');
const { parseIntent } = require('../intent-scanner');
const { pointerOf } = require('../intent-spill');

const BIG = 'z'.repeat(900);
const SMALL = 'y'.repeat(50);
const VERBS = ['task.add', 'task.respec', 'context.compact', 'shout'];
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

test('a terminator that ends the stream with no newline after it still spills', () => {
  // A reply whose last line is `[agent:end]` ends exactly there — the model
  // emits no trailing newline — so the terminator is still in `pending` at
  // close(). Before this pin, close() re-emitted the whole held body verbatim:
  // the lead's 8.8 KB ticket spec arrived on the operator's screen and in the
  // hand's context unspilled (2026-09-20). The trailing-newline variant is row 4.
  const T = `before\n[agent:task add t42 start] ${BIG}\n[agent:end]`;
  const outs = SIZES.map((cs) => run(T, { cs }).out);
  assert.ok(outs.every((o) => o.includes('[agent:task add t42 start] @spill:')), 'fires without the trailing newline');
  assert.ok(outs.every((o) => !o.includes(BIG)), 'body is off the wire');
  assert.ok(outs.every((o) => o.endsWith('\n[agent:end]')), 'stream still ends on the terminator, byte-exact');
  assert.equal(new Set(outs).size, 1, 'output independent of chunking');
  const { body } = diskOf(outs[0]);
  assert.equal(body, BIG);
  // Whitespace after the terminator is not a terminator line: unchanged.
  const held = run(`[agent:task add t42 start] ${BIG}\n[agent:end]  x`).out;
  assert.ok(!held.includes('@spill:'), 'a non-terminator tail still passes through held');
});

test('row 5: the file is the body exactly, and the id is its sha', () => {
  const body = `line one\n\n  indented  \n${BIG}\nlast`;
  const { out } = run(`[agent:task add t7] ${body}\n[agent:end]\n`);
  const { id, body: disk } = diskOf(out);
  assert.equal(disk, body, 'no normalisation: blank lines and trailing spaces survive');
  assert.equal(id, crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').slice(0, 16));
  assert.match(id, /^[0-9a-f]{16}$/);
});

test('the pointer line keeps the body\'s first line, so the transcript still says which spec it was', () => {
  const body = `S-E intent-spill: shout joins the spilled verbs\n${BIG}\nlast`;
  const T = `before\n[agent:task add t42 start] ${body}\n[agent:end]\nafter\n`;
  const outs = SIZES.map((cs) => run(T, { cs }).out);
  assert.equal(new Set(outs).size, 1, 'the title does not depend on chunking');
  const { id, body: disk } = diskOf(outs[0]);
  assert.equal(outs[0],
    `before\n[agent:task add t42 start] S-E intent-spill: shout joins the spilled verbs @spill:${id}\n`
    + '[agent:end]\nafter\n');
  assert.equal(disk, body,
    'the FILE is still the whole body, title included, so the id is unchanged by the emission');
  assert.equal(id, crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').slice(0, 16),
    'content-addressed on the body, never on what the transcript shows');
  assert.ok(!outs[0].includes(BIG), 'and the rest of the body is still off the wire');
});

test('a single-line body emits the BARE pointer — a title equal to the body says nothing', () => {
  const one = 'q'.repeat(900);
  const { out } = run(`[agent:task add t] ${one}\n[agent:end]\n`);
  assert.equal(out, `[agent:task add t] @spill:${diskOf(out).id}\n[agent:end]\n`,
    'repeating an 80-char prefix of a body that has no structure costs context and tells the seat nothing new');
  assert.equal(diskOf(out).body, one);
});

test('a body whose first non-blank line comes after blanks titles from THAT line', () => {
  const held = `\n   the real first line   \n${BIG}`;
  const { out } = run(`[agent:task add t] \n${held}\n[agent:end]\n`);
  assert.ok(out.startsWith('[agent:task add t] the real first line @spill:'),
    `titleLine trims and skips blanks, exactly as a ticket title does: ${JSON.stringify(out.slice(0, 80))}`);
  assert.equal(diskOf(out).body, held,
    'and the file keeps the blank line the title skipped — the title is display, the file is the body');
});

test('a first line over 80 chars is cut at 77 with an ellipsis, as ticketTitle cuts one', () => {
  const first = 'w'.repeat(81);
  const { out } = run(`[agent:task add t] ${first}\n${BIG}\n[agent:end]\n`);
  const line = out.split('\n')[0];
  const title = line.slice('[agent:task add t] '.length, line.indexOf(' @spill:'));
  assert.equal(title, `${'w'.repeat(77)}…`);
  assert.equal(title.length, 78, 'the cap is on characters, and the ellipsis is one of them');
  assert.ok(diskOf(out).body.startsWith(first), 'the file still holds the untruncated line');
});

test('the emitted line parses as the SAME intent, which is what keeps the pointer resolvable', () => {
  const cases = [
    ['task add t42 start', `plain first line\n${BIG}`],
    ['task add t9', `a title with a ] bracket in it\n${BIG}`],
    ['task add t9', `a title with a [ bracket and [agent:dm x] in it\n${BIG}`],
    ['shout', `DEPLOY blocked: the cert expired\n${BIG}`],
    ['context compact', `pick up at t1015 part 2\n${BIG}`],
  ];
  for (const [headArgs, body] of cases) {
    const { out } = run(`[agent:${headArgs}] ${body}\n[agent:end]\n`);
    const line = out.split('\n')[0];
    const parsed = parseIntent(line);
    assert.ok(parsed, `${headArgs}: the titled head line still parses`);
    const bare = parseIntent(`[agent:${headArgs}] @spill:${diskOf(out).id}`);
    assert.equal(parsed.type, bare.type, headArgs);
    assert.equal(parsed.sub, bare.sub, headArgs);
    assert.equal(pointerOf(parsed.body), diskOf(out).id,
      `${headArgs}: the scanner hands _handleIntent a body the resolver still recognises — `
      + 'a title parseIntent mangled would dispatch the pointer text as the spec');
  }
});

test('shout spills like a spec: an operator note is read in the inbox and can run long', () => {
  const body = `DEPLOY blocked on the signing cert\n${BIG}`;
  const { out } = run(`[agent:shout] ${body}\n[agent:end]\n`);
  assert.ok(out.includes('@spill:'), 'the verb is listed');
  assert.ok(!out.includes(BIG), 'the note is off the wire');
  assert.equal(diskOf(out).body, body);
  assert.ok(out.startsWith('[agent:shout] DEPLOY blocked on the signing cert @spill:'));
});

test('memory remember and task done stay unlisted, so the seat keeps seeing what it wrote', () => {
  for (const head of ['memory remember', 'task done t42', 'dm bob']) {
    const T = `[agent:${head}] ${BIG}\n[agent:end]\n`;
    assert.equal(run(T).out, T, `${head} must stream verbatim`);
  }
});

test('row 6 (DEVIATION): the head-line rest is TRIMMED, as _extractIntents trims it', () => {
  for (const lead of ['   ', ' ', '\t']) {
    const { out } = run(`[agent:task add t]${lead}${BIG}\n[agent:end]\n`);
    assert.equal(diskOf(out).body, BIG, `lead=${JSON.stringify(lead)}`);
  }
  const { out } = run(`[agent:task add t] ${BIG}   \n[agent:end]\n`);
  assert.equal(diskOf(out).body, BIG, 'trailing whitespace on the head line goes too');
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

test('the cap also bounds an UNTERMINATED head line, before the hold ever starts', () => {
  const long = `[agent:task add t] ${'q'.repeat(3000)}`;
  for (const cs of [1, 64, 1e6]) {
    const bails = [];
    const r = run(long, { cs, maxBytes: 500, onBail: (i) => bails.push(i) });
    assert.equal(r.out, long,
      `@cs=${cs}: a ticket spec is very often ONE long line that never arrives complete, so a cap `
      + 'gated on `holding` bounds nothing and the client sees no text for the whole line');
    assert.equal(r.filter.latched, true, `@cs=${cs}: and the bail latches like every other`);
    assert.equal(bails.length, 1, `@cs=${cs}`);
    assert.equal(bails[0].reason, 'cap', `@cs=${cs}`);
  }
  const dm = `[agent:dm bob] ${'q'.repeat(3000)}`;
  assert.equal(run(dm, { cs: 64, maxBytes: 500 }).out, dm,
    'a long dm line can never spill at all, so holding it back buys nothing');
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
