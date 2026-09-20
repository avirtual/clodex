'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { mkTmpRoot } = require('./lib/tmp-roots');
const { SpillFilter } = require('../wire/spill');
const { parseIntent, looksLikeIntent } = require('../intent-scanner');
const { receiptOf } = require('../intent-spill');

const BIG = 'z'.repeat(900);
const SMALL = 'y'.repeat(50);
const VERBS = ['task.add', 'task.respec', 'context.compact', 'shout', 'dm', 'task.done'];
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
    onMimic: opts.onMimic,
    writeSpill: opts.writeSpill,
    proseSpill: opts.proseSpill,
  });
  let out = '';
  for (let i = 0; i < text.length; i += cs) out += f.feed(text.slice(i, i + cs));
  out += f.close();
  return { out, filter: f };
}

const MARK = 'Clodex kept ';

function keptPath(id, agent = 'wirescope') {
  return path.join(root(), 'spill', agent, `${id}.md`);
}

function diskOf(out, agent = 'wirescope') {
  const m = /Clodex kept (?:my text|it) at (\S+\/([0-9a-f]{16})\.md)\.\)/.exec(out);
  assert.ok(m, `a receipt names the file: ${JSON.stringify(out.slice(0, 200))}`);
  assert.equal(m[1], keptPath(m[2], agent), 'the receipt names the absolute path of the spill file');
  return { id: m[2], body: fs.readFileSync(m[1], 'utf8') };
}

function receipt(words, body, id, title) {
  const t = title === undefined ? '' : ` — "${title}"`;
  return `(I sent ${words}${t} in full, ${Buffer.byteLength(body, 'utf8')} B; `
    + `Clodex kept my text at ${keptPath(id)}.)\n`;
}

function proseReceipt(text, id) {
  return `(I wrote ${Buffer.byteLength(text, 'utf8')} B of prose after my last intent; it reached the operator's log `
    + `and Clodex kept it at ${keptPath(id)}.)\n`;
}

test('row 1-3: traffic that does not spill is byte-identical at every chunk size', () => {
  const cases = {
    'plain prose': 'Hello world.\nNo intents here.\n',
    'prose with brackets': 'See [1], [agent], [agentx:foo]\ndone\n',
    'no trailing newline': 'abc',
    'bare terminator': '[agent:end]\n',
    'unlisted verb (remind)': `[agent:remind in 5m] ${BIG}\n[agent:end]\n`,
    'below threshold': `[agent:task add t1] ${SMALL}\n[agent:end]\n`,
  };
  for (const [name, t] of Object.entries(cases)) {
    for (const cs of SIZES) assert.equal(run(t, { cs }).out, t, `${name} @cs=${cs}`);
  }
});

test('row 4: the spill fires, identically, at every chunk size', () => {
  const T = `before\n[agent:task add t42 start] ${BIG}\n[agent:end]\nafter\n`;
  const outs = SIZES.map((cs) => run(T, { cs }).out);
  assert.ok(outs.every((o) => o.includes(MARK)), 'fires at every chunk size');
  assert.equal(new Set(outs).size, 1, 'output independent of chunking');
  assert.ok(outs.every((o) => !o.includes(BIG)), 'body is off the wire');
  assert.ok(outs.every((o) => o.includes('(I sent task add t42 start in full, 900 B;')),
    'the head words survive in the receipt, modifiers included');
  assert.ok(outs.every((o) => o.startsWith('before\n') && o.endsWith('after\n')),
    'surrounding prose untouched');
  assert.ok(outs.every((o) => !o.includes('[agent:')), 'head line and terminator both gone from the transcript');
});

test('a terminator that ends the stream with no newline after it still spills', () => {
  const T = `before\n[agent:task add t42 start] ${BIG}\n[agent:end]`;
  const outs = SIZES.map((cs) => run(T, { cs }).out);
  assert.ok(outs.every((o) => o.includes('(I sent task add t42 start in full')), 'fires without the trailing newline');
  assert.ok(outs.every((o) => !o.includes(BIG)), 'body is off the wire');
  assert.ok(outs.every((o) => o.endsWith(')\n') && !o.includes('[agent:end]')),
    'the stream ends on the receipt; the terminator that closed a body no longer in the transcript is swallowed');
  assert.equal(new Set(outs).size, 1, 'output independent of chunking');
  const { body } = diskOf(outs[0]);
  assert.equal(body, BIG);
  const held = run(`[agent:task add t42 start] ${BIG}\n[agent:end]  x`).out;
  assert.ok(!held.includes(MARK), 'a non-terminator tail still passes through held');
});

test('row 5: the file is the body exactly, and the id is its sha', () => {
  const body = `line one\n\n  indented  \n${BIG}\nlast`;
  const { out } = run(`[agent:task add t7] ${body}\n[agent:end]\n`);
  const { id, body: disk } = diskOf(out);
  assert.equal(disk, body, 'no normalisation: blank lines and trailing spaces survive');
  assert.equal(id, crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').slice(0, 16));
  assert.match(id, /^[0-9a-f]{16}$/);
});

test('the receipt keeps the body\'s first line, so the transcript still says which spec it was', () => {
  const body = `S-E intent-spill: shout joins the spilled verbs\n${BIG}\nlast`;
  const T = `before\n[agent:task add t42 start] ${body}\n[agent:end]\nafter\n`;
  const outs = SIZES.map((cs) => run(T, { cs }).out);
  assert.equal(new Set(outs).size, 1, 'the title does not depend on chunking');
  const { id, body: disk } = diskOf(outs[0]);
  assert.equal(outs[0],
    `before\n${receipt('task add t42 start', body, id, 'S-E intent-spill: shout joins the spilled verbs')}after\n`);
  assert.equal(disk, body,
    'the FILE is still the whole body, title included, so the id is unchanged by the emission');
  assert.equal(id, crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').slice(0, 16),
    'content-addressed on the body, never on what the transcript shows');
  assert.ok(!outs[0].includes(BIG), 'and the rest of the body is still off the wire');
});

test('a single-line body emits an untitled receipt — a title equal to the body says nothing', () => {
  const one = 'q'.repeat(900);
  const { out } = run(`[agent:task add t] ${one}\n[agent:end]\n`);
  assert.equal(out, receipt('task add t', one, diskOf(out).id),
    'repeating an 80-char prefix of a body that has no structure costs context and tells the seat nothing new');
  assert.equal(diskOf(out).body, one);
});

test('a body whose first non-blank line comes after blanks titles from THAT line', () => {
  const held = `\n   the real first line   \n${BIG}`;
  const { out } = run(`[agent:task add t] \n${held}\n[agent:end]\n`);
  assert.ok(out.startsWith('(I sent task add t — "the real first line" in full'),
    `titleLine trims and skips blanks, exactly as a ticket title does: ${JSON.stringify(out.slice(0, 80))}`);
  assert.equal(diskOf(out).body, held,
    'and the file keeps the blank line the title skipped — the title is display, the file is the body');
});

test('a first line over 80 chars is cut at 77 with NO ellipsis, where ticketTitle would add one', () => {
  const first = 'w'.repeat(81);
  const { out } = run(`[agent:task add t] ${first}\n${BIG}\n[agent:end]\n`);
  const title = /^\(I sent task add t — "([^"]*)" in full/.exec(out)[1];
  assert.equal(title, 'w'.repeat(77));
  assert.equal(title.length, 77, 'ticketTitle\'s cut, minus its ellipsis: 18 of 19 fabricated pointers copied that ellipsis shape byte-for-byte');
  assert.ok(diskOf(out).body.startsWith(first), 'the file still holds the untruncated line');
});

test('the receipt is NOT an intent to the scanner, and receiptOf reads the SAME verb back from it', () => {
  const cases = [
    ['task add t42 start', `plain first line\n${BIG}`],
    ['task add t9', `a title with a ] bracket in it\n${BIG}`],
    ['task add t9', `a title with a " quote and a ] bracket in it\n${BIG}`],
    ['shout', `DEPLOY blocked: the cert expired\n${BIG}`],
    ['context compact', `pick up at t1015 part 2\n${BIG}`],
    ['dm bob urgent', `first line of the note\n${BIG}`],
  ];
  for (const [headArgs, body] of cases) {
    const { out } = run(`[agent:${headArgs}] ${body}\n[agent:end]\n`);
    const line = out.split('\n')[0];
    assert.equal(parseIntent(line), null, `${headArgs}: a receipt fires nothing when replayed`);
    assert.equal(looksLikeIntent(line), null, `${headArgs}: nor does it bounce as a near-miss`);
    const bare = parseIntent(`[agent:${headArgs}] x`);
    const rc = receiptOf(line);
    assert.ok(rc, `${headArgs}: the receipt grammar reads it back: ${line.slice(0, 120)}`);
    assert.equal(rc.type, bare.type, headArgs);
    assert.equal(rc.sub, bare.sub, headArgs);
    assert.equal(rc.head, headArgs, `${headArgs}: the head words are the intent's own, so recovery rebuilds the same line`);
    assert.equal(rc.path, keptPath(diskOf(out).id), headArgs);
  }
});

test('a 64 KB body leaves a first-person receipt under 200 B that carries no emittable shape', () => {
  const big = 'z'.repeat(65536);
  for (const head of ['dm bob', 'task add hand start', 'shout']) {
    const { out } = run(`[agent:${head}]\n${big}\n[agent:end]\n`);
    assert.ok(Buffer.byteLength(out, 'utf8') <= 200, `${head}: ${Buffer.byteLength(out, 'utf8')} B`);
    assert.ok(!out.includes('[agent:'), `${head}: no intent opener — the transcript line became a few-shot example once`);
    assert.ok(!out.includes('@spill:'), `${head}: no pointer token either`);
    assert.ok(!out.includes('…'), `${head}: no ellipsis — the shape 18 of 19 fabrications copied`);
    assert.ok(out.startsWith('(I '), `${head}: first person, the model's own after-the-fact note`);
    assert.equal(out, receipt(head, big, diskOf(out).id));
  }
});

test('the terminator is swallowed only for a spilled block; an under-floor body keeps it', () => {
  const small = `[agent:task add t] ${SMALL}\n[agent:end]`;
  const f = proseFilter();
  assert.equal(f.feed(small), '');
  assert.equal(f.endBlock(), small, 'endBlock: the unspilled body goes out whole, terminator included');
  const g = proseFilter();
  assert.equal(g.feed(small), '');
  assert.equal(g.close(), small, 'close: same');
  const h = proseFilter();
  assert.equal(h.feed(`${small}\n`), `${small}\n`, 'a newline-terminated terminator is re-emitted as received');
  const spilled = proseFilter();
  assert.equal(spilled.feed(`[agent:task add t] ${BIG}\n[agent:end]\n`).split('\n').length, 2,
    'the spilled block is ONE line: the receipt, with no terminator after it');
});

test('shout spills like a spec: an operator note is read in the inbox and can run long', () => {
  const body = `DEPLOY blocked on the signing cert\n${BIG}`;
  const { out } = run(`[agent:shout] ${body}\n[agent:end]\n`);
  assert.ok(out.includes(MARK), 'the verb is listed');
  assert.ok(!out.includes(BIG), 'the note is off the wire');
  assert.equal(diskOf(out).body, body);
  assert.ok(out.startsWith('(I sent shout — "DEPLOY blocked on the signing cert" in full'));
});

test('memory remember, remind and team role-add stay unlisted, so the seat keeps seeing what it wrote', () => {
  for (const head of ['memory remember', 'remind in 5m', 'team role-add hand']) {
    const T = `[agent:${head}] ${BIG}\n[agent:end]\n`;
    assert.equal(run(T).out, T, `${head} must stream verbatim`);
  }
});

test('a dm body spills: the receipt names the target and only the message leaves the transcript', () => {
  const seen = [];
  const T = `[agent:dm bob]\n${BIG}\n[agent:end]\n`;
  const { out, filter } = run(T, { onSpill: (i) => seen.push(i) });
  const { id, body } = diskOf(out);
  assert.equal(out, receipt('dm bob', BIG, id));
  assert.equal(body, BIG, 'the file holds the 900 bytes the recipient still gets in full');
  assert.equal(filter.fired, 1);
  assert.deepStrictEqual(seen, [{ verb: 'dm', id, bytes: 900 }],
    "the one-word key wins before `dm.<target>` is tried — m[2] of a dm head is a TARGET");
});

test('a dm head\'s TARGET and urgent flag ride the receipt, never the spilled body', () => {
  const seen = [];
  for (const head of ['dm clodex-hand-1029 urgent', 'dm bob@peer', 'dm bob urgent']) {
    seen.length = 0;
    const { out } = run(`[agent:${head}]\n${BIG}\n[agent:end]\n`, { onSpill: (i) => seen.push(i) });
    const { id, body } = diskOf(out);
    assert.equal(out, receipt(head, BIG, id),
      `${head}: head words verbatim — a lost target or flag misroutes a recovered message`);
    assert.equal(body, BIG, head);
    assert.deepStrictEqual(seen, [{ verb: 'dm', id, bytes: 900 }],
      `${head}: keyed as plain dm, not as dm.<second token>`);
  }
  const { out } = run(`[agent:dm clodex-hand-1029 urgent]\n${BIG}\n[agent:end]\n`);
  assert.ok(out.split('\n')[0].includes('urgent'),
    'ENTER: the flag really is on the head line under test, or the assertion above is vacuous');
});

test('a dm body under the floor streams verbatim, flag and all', () => {
  for (const head of ['dm bob', 'dm clodex-hand-1029 urgent']) {
    const T = `[agent:${head}]\n${'y'.repeat(200)}\n[agent:end]\n`;
    for (const cs of SIZES) assert.equal(run(T, { cs }).out, T, `${head} @cs=${cs}`);
  }
});

test('a task done report spills, keyed task.done — the two-word form still wins for task', () => {
  const seen = [];
  const { out, filter } = run(`[agent:task done t42]\n${BIG}\n[agent:end]\n`,
    { onSpill: (i) => seen.push(i) });
  const { id, body } = diskOf(out);
  assert.equal(out, receipt('task done t42', BIG, id));
  assert.equal(body, BIG);
  assert.equal(filter.fired, 1);
  assert.deepStrictEqual(seen, [{ verb: 'task.done', id, bytes: 900 }],
    '`task` alone is not in the set, so the fallback derives the two-word key');
  const add = run(`[agent:task add hand start]\n${BIG}\n[agent:end]\n`, { onSpill: (i) => seen.push(i) });
  assert.ok(add.out.startsWith('(I sent task add hand start in full'), 'task.add unchanged');
});

test('an unheld verb still goes out through foreignBody, not the new one-word key path', () => {
  assert.ok(!VERBS.includes('remind'),
    'ENTER: remind must be absent from the set, or this proves nothing about unheld verbs');
  const T = `[agent:remind in 5m] ${BIG}\n`;
  for (const cs of SIZES) assert.equal(run(T, { cs }).out, T, `@cs=${cs}`);
});

test('proseSpill on: an under-floor dm body and a 900-byte tail are two separate decisions', () => {
  const T = `[agent:dm bob] ${SMALL}\n[agent:end]\n${'p'.repeat(899)}\n`;
  const { out, filter } = run(T, { proseSpill: true });
  const { id, body } = diskOf(out);
  assert.equal(out, `[agent:dm bob] ${SMALL}\n[agent:end]\n${proseReceipt(`${'p'.repeat(899)}\n`, id)}`,
    'the held body streams as written because it is under the floor; the tail is what spills');
  assert.equal(body, `${'p'.repeat(899)}\n`);
  assert.equal(filter.fired, 1, 'one fire: the two mechanisms do not merge into one file');
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
    assert.ok(out.includes(BIG) && !out.includes(MARK), `agent ${JSON.stringify(bad)}`);
  }
  const badRoot = mkTmpRoot('clodex-spill-');
  fs.writeFileSync(path.join(badRoot, 'spill'), 'not a directory');
  const un = run(T, { root: badRoot });
  assert.ok(un.out.includes(BIG) && !un.out.includes(MARK), 'unwritable root');
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
  const unlisted = `[agent:remind in 5m] ${'q'.repeat(3000)}`;
  assert.equal(run(unlisted, { cs: 64, maxBytes: 500 }).out, unlisted,
    'a long line under an unlisted verb can never spill at all, so holding it back buys nothing');
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
  assert.ok(!r.out.includes(MARK), 'zero receipts');
  assert.equal(r.filter.latched, true,
    'resyncing after a bail is what split [agent:end] across two deltas into "[ag\\nent:end]"');
  assert.ok(run(`[agent:task add t] ${BIG}\n[agent:end]\n`).out.includes(MARK),
    'a fresh response gets a fresh filter, so the latch does not leak');
});

test('row 11: the threshold is strict `>`', () => {
  assert.ok(!run('[agent:task add t] abc\n[agent:end]\n', { minBytes: 3 }).out.includes(MARK));
  assert.ok(run('[agent:task add t] abcd\n[agent:end]\n', { minBytes: 3 }).out.includes(MARK));
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
  assert.ok(escOut.includes(MARK));
  assert.ok(diskOf(escOut).body.includes('\\[agent:dm x] hi'));

  const mid = `[agent:task add a] ${BIG}\nclose with \`[agent:task done t1]\`\n[agent:end]\n`;
  const midOut = run(mid).out;
  assert.ok(midOut.includes(MARK));
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
  assert.equal(g.feed('nt:remind in 5m] hi\n'), '[agent:remind in 5m] hi\n');
});


const PROSE = `${'p'.repeat(899)}\n`;

function runProse(text, opts = {}) {
  return run(text, { ...opts, proseSpill: true });
}

test('proseSpill off is the default: a 900-byte trailing tail streams verbatim', () => {
  assert.ok(Buffer.byteLength(PROSE, 'utf8') > 800,
    'ENTER: the fixture tail must exceed the 800 B floor, or the subject proves nothing');
  const T = `[agent:task add t1] ${SMALL}\n[agent:end]\n${PROSE}`;
  for (const cs of SIZES) assert.equal(run(T, { cs }).out, T, `@cs=${cs}`);
});

test('proseSpill on: trailing prose after a body becomes a prose receipt, the body untouched', () => {
  const T = `[agent:task add t1] ${SMALL}\n[agent:end]\n${PROSE}`;
  const outs = SIZES.map((cs) => runProse(T, { cs }).out);
  assert.equal(new Set(outs).size, 1, 'output independent of chunking');
  const out = outs[0];
  const id = diskOf(out).id;
  assert.equal(out, `[agent:task add t1] ${SMALL}\n[agent:end]\n${proseReceipt(PROSE, id)}`,
    'the under-floor intent body streams as written; only the tail is replaced');
  assert.equal(diskOf(out).body, PROSE, 'the file holds the tail byte-for-byte');
  const last = out.trimEnd().split('\n').pop();
  assert.ok(!last.includes('[agent:') && !last.includes('@spill:'), 'the prose receipt is not an emittable shape either');
});

test('proseSpill on: a reply with no intent at all is exactly the prose receipt', () => {
  const outs = SIZES.map((cs) => runProse(PROSE, { cs }).out);
  assert.equal(new Set(outs).size, 1);
  const out = outs[0];
  assert.equal(out, proseReceipt(PROSE, diskOf(out).id));
  assert.equal(diskOf(out).body, PROSE);
});

test('proseSpill on: prose BETWEEN two intents is never the candidate', () => {
  const T = `[agent:task add a] ${SMALL}\n[agent:end]\n${PROSE}[agent:task add b] ${SMALL}\n[agent:end]\n`;
  for (const cs of SIZES) {
    assert.equal(runProse(T, { cs }).out, T,
      `the head line that follows resets the tail, so it forwards as original @cs=${cs}`);
  }
});

test('proseSpill on: a tail under the floor streams verbatim', () => {
  const small = `${'q'.repeat(700)}\n`;
  assert.ok(Buffer.byteLength(small, 'utf8') < 800, 'ENTER: under the floor');
  const T = `[agent:task add t1] ${SMALL}\n[agent:end]\n${small}`;
  assert.equal(runProse(T).out, T);
});

test('proseSpill on: a writer that returns null forwards the original tail', () => {
  const r = runProse(PROSE, { writeSpill: () => null });
  assert.equal(r.out, PROSE);
  assert.equal(r.filter.fired, 0);
});

test('proseSpill on: a throwing writer forwards the original tail and never propagates', () => {
  const r = runProse(PROSE, { writeSpill: () => { throw new Error('injected'); } });
  assert.equal(r.out, PROSE);
  assert.equal(r.filter.fired, 0);
});

test("proseSpill on: onSpill carries verb 'prose' and the tail's byte count", () => {
  const seen = [];
  const r = runProse(PROSE, { onSpill: (i) => seen.push(i) });
  assert.equal(seen.length, 1);
  assert.deepStrictEqual(seen[0], {
    verb: 'prose', id: diskOf(r.out).id, bytes: Buffer.byteLength(PROSE, 'utf8'),
  });
  assert.equal(r.filter.fired, 1);
});

test('proseSpill on: an UNLISTED verb keeps its whole body, tail spill and all', () => {
  const T = `[agent:remind in 5m] ${PROSE}[agent:end]\n`;
  assert.ok(!VERBS.includes('remind'),
    'ENTER: the fixture verb must really be unlisted, or this subject proves nothing');
  assert.equal(runProse(T).out, T,
    'remind is not a spill verb, so the filter never holds it — unguarded, its body would fall '
    + 'into the tail and the reminder would fire carrying a pointer');
});

test('proseSpill on: a listed body still spills, and its own tail spills separately', () => {
  const T = `[agent:task add t] ${BIG}\n[agent:end]\n${PROSE}`;
  const { out, filter } = runProse(T);
  assert.equal(filter.fired, 2, 'the body and the tail are two fires');
  assert.ok(!out.includes(BIG) && !out.includes(PROSE.trim()), 'neither is on the wire');
  assert.ok(out.startsWith('(I sent task add t in full'), 'the body receipt names its head words');
  assert.ok(out.endsWith(proseReceipt(PROSE, /\/([0-9a-f]{16})\.md\.\)\n$/.exec(out)[1])),
    'and the reply ends on the prose receipt');
});

test('proseSpill on: a held, unterminated body flushes as the original with an empty tail', () => {
  const T = `[agent:task add t] head\n${BIG}\n`;
  const { out, filter } = runProse(T);
  assert.equal(out, T,
    'the terminator never arrives, so close() takes the holding branch and the tail is empty '
    + 'by construction — the original is re-emitted byte-for-byte');
  assert.equal(filter.fired, 0);
});

test('proseSpill on: an unterminated HEAD LINE is not swallowed as prose', () => {
  const T = `[agent:task add t] ${BIG}`;
  const { out, filter } = runProse(T);
  assert.equal(out, T,
    'no newline ever arrives, so holding is never set and the line sits in pending: it is an '
    + 'intent the operator still has to see, not a tail');
  assert.equal(filter.fired, 0);
});

test('proseSpill on: a bare terminator and an escaped intent are not prose', () => {
  const T = `[agent:end]\n\\[agent:task add x] example\n${'m'.repeat(899)}\n`;
  const { out } = runProse(T);
  assert.ok(out.startsWith('[agent:end]\n\\[agent:task add x] example\n'),
    'both lines forward where they were written');
  assert.ok(out.endsWith(proseReceipt(`${'m'.repeat(899)}\n`, diskOf(out).id)), 'only the prose after them spills');
});

test('proseSpill on: a bail mid-response reverts to byte-for-byte passthrough', () => {
  const T = `[agent:task add a] x\n[agent:task add b] y\n${PROSE}`;
  const { out } = runProse(T);
  assert.equal(out, T, 'the nested-intent bail latches, so nothing after it is held');
});

function proseFilter(opts = {}) {
  return new SpillFilter({
    agent: 'wirescope', root: root(), verbs: VERBS, proseSpill: true, ...opts,
  });
}

test('endBlock KEEPS the tail; only close() resolves it', () => {
  const f = proseFilter();
  assert.equal(f.feed(PROSE), '', 'the tail is held, as inside any one block');
  assert.equal(f.endBlock(), '',
    'a block boundary is not the end of the response: the tee cannot know at a stop frame '
    + 'whether another block follows, so the tail crosses it intact');
  assert.equal(f.feed(''), '');
  const out = f.close();
  assert.equal(out, proseReceipt(PROSE, diskOf(out).id), 'and the stream end is what resolves it');
  assert.equal(f.fired, 1);
  assert.equal(diskOf(out).body, PROSE, 'the file holds the tail from before the boundary');
});

test('a tail spanning two blocks spills as ONE file, in order', () => {
  const f = proseFilter();
  f.feed('first half of the sign-off\n');
  f.endBlock();
  f.feed(PROSE);
  const out = f.close();
  assert.equal(diskOf(out).body, `first half of the sign-off\n${PROSE}`,
    'the boundary is invisible to the tail — it is one run of prose to the response');
});

test('endBlock flushes a held, unterminated body as the original, exactly as close() does', () => {
  const f = proseFilter();
  const T = `[agent:task add t] head\n${BIG}\n`;
  assert.equal(f.feed(T), '');
  assert.equal(f.endBlock(), T,
    'a body the terminator never closed cannot outlive its block: the next block would carry it '
    + 'into a different index');
  assert.equal(f.fired, 0);
  assert.equal(f.close(), '', 'and nothing is left behind for the stream end');
});

test('endBlock resolves a held body whose terminator is the block\'s last unterminated line', () => {
  const f = proseFilter();
  assert.equal(f.feed(`[agent:task add t] ${BIG}\n[agent:end]`), '');
  const before = f.fired;
  const out = f.endBlock();
  assert.ok(out.startsWith('(I sent task add t in full'),
    'endBlock takes close()\'s terminator-in-pending branch, so a body the block ends on still '
    + 'spills rather than forwarding whole');
  assert.ok(!out.includes('[agent:end]') && out.endsWith(')\n'), 'and the terminator is swallowed with the body it closed');
  assert.equal(f.fired, before + 1,
    'the tee reads exactly this increment across endBlock() to decide whether a content_block_stop '
    + 'has to flush the receipt instead of parking it behind the held stop');
});

test('bail() forwards a held tail as the ORIGINAL, which is the only thing that does', () => {
  const f = proseFilter();
  assert.equal(f.feed(PROSE), '', 'ENTER: the 899-byte tail is really held, not streamed');
  const out = f.bail();
  assert.equal(out, PROSE,
    'bail clears proseSpill BEFORE close(), so close()\'s _resolveTail arm is skipped and the '
    + 'unconditional _flushTail is the only path that returns the tail. Drop it and SpillTee\'s '
    + 'frame-cap bail leaves heldOut short of heldSrc, _flushHeld synthesizes one delta from the '
    + 'short string, and the prose is silently deleted from the client stream');
  assert.equal(f.fired, 0, 'a bail never spills — nothing is ever written on the way out');
  assert.equal(f.latched, true);
});

const MIMIC = "(I sent dm bob in full, 900 B; Clodex kept my text at /Users/x/.clodex/spill/wirescope/0123456789abcdef.md.)";
const MIMIC_TAIL = "(I wrote 900 B of prose after my last intent; it reached the operator's log and Clodex kept it at /Users/x/.clodex/spill/wirescope/0123456789abcdef.md.)";

test('onMimic: a receipt-shaped line in the INPUT is model-authored and is reported, bytes untouched', () => {
  for (const [line, kind] of [[MIMIC, 'intent'], [MIMIC_TAIL, 'prose']]) {
    const seen = [];
    const T = `Sent.\n${line}\nmore.\n`;
    for (const cs of SIZES) {
      seen.length = 0;
      const r = run(T, { cs, onMimic: (i) => seen.push(i) });
      assert.equal(r.out, T, `${kind} @cs=${cs}: byte-identical`);
      assert.deepStrictEqual(seen, [{ kind }], `${kind} @cs=${cs}: exactly one report`);
      assert.equal(r.filter.fired, 0, `${kind} @cs=${cs}: nothing filed`);
    }
    seen.length = 0;
    const unterminated = run(`Sent.\n${line}`, { onMimic: (i) => seen.push(i) });
    assert.equal(unterminated.out, `Sent.\n${line}`);
    assert.deepStrictEqual(seen, [{ kind }], `${kind}: a receipt that ends the response without a newline is still seen at close()`);
  }
});

test("onMimic: the filter's own receipt is never reported — it never feeds itself", () => {
  const seen = [];
  const { out } = run(`[agent:dm bob]\n${BIG}\n[agent:end]\n`, { onMimic: (i) => seen.push(i) });
  assert.ok(out.startsWith('(I sent dm bob in full'), 'ENTER: this run really spilled');
  assert.deepStrictEqual(seen, []);
  const prose = runProse(PROSE, { onMimic: (i) => seen.push(i) });
  assert.ok(prose.out.startsWith('(I wrote '), 'ENTER: the tail really spilled');
  assert.deepStrictEqual(seen, []);
});
