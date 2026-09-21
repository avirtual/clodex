'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { mkTmpRoot } = require('./lib/tmp-roots');
const { SpillFilter } = require('../wire/spill');
const { parseIntent } = require('../intent-scanner');
const { receiptOf, mimicKindOf, pointerOf, SPILL_FILLER, SPILL_VERBS, SPILL_MIN_BYTES } = require('../intent-spill');

const BIG = 'z'.repeat(900);
const SMALL = 'y'.repeat(50);
const VERBS = ['task.add', 'task.respec', 'task.reject', 'shout', 'dm', 'task.done'];
const SIZES = [1, 3, 7, 17, 64, 1e6];

let ROOT = null;
function root() {
  if (!ROOT) ROOT = mkTmpRoot('clodex-spill-');
  return ROOT;
}

function run(text, opts = {}) {
  const cs = opts.cs || 1;
  const spills = [];
  const f = new SpillFilter({
    agent: opts.agent === undefined ? 'wirescope' : opts.agent,
    root: opts.root || root(),
    verbs: opts.verbs || VERBS,
    minBytes: opts.minBytes,
    maxBytes: opts.maxBytes,
    onSpill: (i) => { spills.push(i); if (opts.onSpill) opts.onSpill(i); },
    onBail: opts.onBail,
    onMimic: opts.onMimic,
    writeSpill: opts.writeSpill,
    proseSpill: opts.proseSpill,
  });
  let out = '';
  for (let i = 0; i < text.length; i += cs) out += f.feed(text.slice(i, i + cs));
  out += f.close();
  return { out, filter: f, spills };
}

function keptPath(id, agent = 'wirescope') {
  return path.join(root(), 'spill', agent, `${id}.md`);
}

function diskOf(spills, agent = 'wirescope') {
  assert.ok(spills.length >= 1, 'the spill fired, so onSpill names the file — the record no longer does');
  const { id } = spills[spills.length - 1];
  assert.match(id, /^[0-9a-f]{16}$/);
  return { id, body: fs.readFileSync(keptPath(id, agent), 'utf8') };
}

function stub(head, spills, title = '') {
  const { id } = diskOf(spills);
  return `[agent:${head}] ${title}@spill:${id}\n[agent:end]\n`;
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
  const rs = SIZES.map((cs) => run(T, { cs }));
  const outs = rs.map((r) => r.out);
  assert.ok(rs.every((r) => r.spills.length === 1), 'fires at every chunk size');
  assert.equal(new Set(outs).size, 1, 'output independent of chunking');
  assert.ok(outs.every((o) => !o.includes(BIG)), 'body is off the wire');
  assert.equal(outs[0], `before\n${stub('task add t42 start', rs[0].spills)}after\n`,
    'head line byte-for-byte, modifiers included; the bare pointer stands in for the body; the terminator is KEPT after it');
  assert.deepStrictEqual(rs.map((r) => r.spills[0].head), SIZES.map(() => 'task add t42 start'),
    'the head words ride the onSpill payload instead, modifiers included');
});

test('a context compact/clear/reload handoff passes the PRODUCTION verb set untouched: no file, no stub, no spill event', () => {
  const dir = path.join(root(), 'spill', 'wirescope');
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  for (const head of ['context compact', 'context clear', 'context reload']) {
    const T = `before\n[agent:${head}] pick up at t1061 part 2\n${BIG}\n[agent:end]\nafter\n`;
    assert.ok(Buffer.byteLength(T, 'utf8') > SPILL_MIN_BYTES, `ENTER: ${head} body is over the floor, or a short body would pass this for free`);
    const control = run(T.replace(`[agent:${head}]`, '[agent:task add t1]'), { verbs: [...SPILL_VERBS] });
    assert.equal(control.spills.length, 1, `ENTER: the same body under task add spills through the same rig`);
    for (const cs of SIZES) {
      const r = run(T, { cs, verbs: [...SPILL_VERBS] });
      assert.equal(r.out, T, `${head} @cs=${cs}: byte-identical to the model's output`);
      assert.deepStrictEqual(r.spills, [], `${head} @cs=${cs}: no spill event`);
    }
  }
  assert.equal(fs.readdirSync(dir).length, before + 1, 'exactly the control wrote a file; the three handoffs wrote none');
});

test('a terminator that ends the stream with no newline after it still spills', () => {
  const T = `before\n[agent:task add t42 start] ${BIG}\n[agent:end]`;
  const rs = SIZES.map((cs) => run(T, { cs }));
  assert.ok(rs.every((r) => r.spills.length === 1), 'fires without the trailing newline');
  assert.ok(rs.every((r) => r.out === `before\n[agent:task add t42 start] @spill:${r.spills[0].id}\n[agent:end]`),
    'the stream still ends on the terminator, byte-exact');
  const { body } = diskOf(rs[0].spills);
  assert.equal(body, BIG);
  const held = run(`[agent:task add t42 start] ${BIG}\n[agent:end]  x`);
  assert.equal(held.spills.length, 0, 'a non-terminator tail still passes through held');
  assert.ok(held.out.includes(BIG));
});

test('row 5: the file is the body exactly, and the id is its sha', () => {
  const body = `line one\n\n  indented  \n${BIG}\nlast`;
  const { out, spills } = run(`[agent:task add t7] ${body}\n[agent:end]\n`);
  const { id, body: disk } = diskOf(spills);
  assert.equal(out, `[agent:task add t7] line one @spill:${id}\n[agent:end]\n`);
  assert.equal(disk, body, 'no normalisation: blank lines and trailing spaces survive');
  assert.equal(id, crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').slice(0, 16));
  assert.match(id, /^[0-9a-f]{16}$/);
});

test('the pointer line keeps the body\'s first line, so the transcript still says which spec it was', () => {
  const body = `S-E intent-spill: shout joins the spilled verbs\n${BIG}\nlast`;
  const T = `before\n[agent:task add t42 start] ${body}\n[agent:end]\nafter\n`;
  const rs = SIZES.map((cs) => run(T, { cs }));
  assert.equal(new Set(rs.map((r) => r.out)).size, 1, 'the record does not depend on chunking');
  const { id, body: disk } = diskOf(rs[0].spills);
  assert.equal(rs[0].out,
    `before\n[agent:task add t42 start] S-E intent-spill: shout joins the spilled verbs @spill:${id}\n`
    + '[agent:end]\nafter\n');
  assert.ok(!rs[0].out.includes(BIG), 'the rest of the body is off the wire');
  assert.equal(disk, body, 'the FILE is the whole body, title included, so the id is unchanged by the emission');
  assert.equal(id, crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').slice(0, 16),
    'content-addressed on the body, never on what the transcript shows');
});

test('single-line, blank-led and over-80-char first lines: bare pointer, title from the first non-blank line, 77 + ellipsis', () => {
  const one = 'q'.repeat(900);
  const single = run(`[agent:task add t] ${one}\n[agent:end]\n`);
  assert.equal(single.out, stub('task add t', single.spills),
    'a title equal to the body says nothing, so a single-line body emits the BARE pointer');
  assert.equal(diskOf(single.spills).body, one);

  const held = `\n   the real first line   \n${BIG}`;
  const blankLed = run(`[agent:task add t] \n${held}\n[agent:end]\n`);
  assert.equal(blankLed.out, stub('task add t', blankLed.spills, 'the real first line '),
    'titleLine trims and skips blanks, exactly as a ticket title does');
  assert.equal(diskOf(blankLed.spills).body, held,
    'the file keeps the blank line the title skipped — the title is display, the file is the body');

  const first = 'w'.repeat(81);
  const long = run(`[agent:task add t] ${first}\n${BIG}\n[agent:end]\n`);
  assert.equal(long.out, stub('task add t', long.spills, `${'w'.repeat(77)}… `),
    'the cap is on characters, and the ellipsis is one of them, as ticketTitle cuts one');
  assert.ok(diskOf(long.spills).body.startsWith(first), 'the file holds the untruncated line');
});

test('the stub re-parses as the SAME intent with a pointer body the resolver recognises; the head words ride onSpill', () => {
  const cases = [
    ['task add t42 start', `plain first line\n${BIG}`],
    ['task add t9', `a title with a ] bracket in it\n${BIG}`],
    ['task add t9', `a title with a " quote and a ] bracket in it\n${BIG}`],
    ['shout', `DEPLOY blocked: the cert expired\n${BIG}`],
    ['task reject t7', `pick up at t1015 part 2\n${BIG}`],
    ['dm bob urgent', `first line of the note\n${BIG}`],
  ];
  for (const [headArgs, body] of cases) {
    const { out, spills } = run(`before\n[agent:${headArgs}] ${body}\n[agent:end]\nafter\n`);
    assert.equal(spills.length, 1, headArgs);
    const line = out.split('\n')[1];
    const parsed = parseIntent(line);
    assert.ok(parsed, `${headArgs}: the titled head line still parses`);
    const bare = parseIntent(`[agent:${headArgs}] x`);
    assert.equal(parsed.type, bare.type, headArgs);
    assert.equal(parsed.sub, bare.sub, headArgs);
    assert.equal(pointerOf(parsed.body), spills[0].id,
      `${headArgs}: the scanner hands _handleIntent a body the resolver still recognises — `
      + 'a title parseIntent mangled would dispatch the pointer text as the spec');
    assert.equal(out.split('\n')[2], '[agent:end]', `${headArgs}: the terminator closes the stub for the jsonl scanner`);
    for (const l of out.split('\n')) assert.equal(receiptOf(l), null, `${headArgs}: no receipt-shaped line`);
    assert.equal(spills[0].head, headArgs, `${headArgs}: the head words are the intent's own, verbatim, on the payload`);
    assert.equal(spills[0].verb, VERBS.includes(bare.type) ? bare.type : `${bare.type}.${bare.sub}`, headArgs);
    assert.equal(diskOf(spills).body, body, headArgs);
  }
});

test('a 64 KB body leaves the same short stub as a 900-byte one', () => {
  const big = 'z'.repeat(65536);
  for (const head of ['dm bob', 'task add hand start', 'shout']) {
    const { out, spills } = run(`[agent:${head}]\n${big}\n[agent:end]\n`);
    assert.equal(out, stub(head, spills), head);
    assert.equal(diskOf(spills).body, big, head);
    assert.equal(spills[0].head, head);
  }
});

test('the terminator is KEPT after a stub, and after an under-floor body', () => {
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
  assert.equal(spilled.feed(`[agent:task add t] ${BIG}\n[agent:end]\n`), stub('task add t', spilled.spills),
    'the stub closes on the terminator so `_extractIntents` delimits the pointer body there');
  assert.equal(spilled.fired, 1);
});

test('shout spills like a spec: an operator note is read in the inbox and can run long', () => {
  const body = `DEPLOY blocked on the signing cert\n${BIG}`;
  const { out, spills } = run(`[agent:shout] ${body}\n[agent:end]\n`);
  assert.equal(spills.length, 1, 'the verb is listed');
  assert.equal(out, stub('shout', spills, 'DEPLOY blocked on the signing cert '), 'the note is off the wire; its first line titles the stub');
  assert.equal(diskOf(spills).body, body);
  assert.equal(spills[0].head, 'shout');
});

test('memory remember, remind and team role-add stay unlisted, so the seat keeps seeing what it wrote', () => {
  for (const head of ['memory remember', 'remind in 5m', 'team role-add hand']) {
    const T = `[agent:${head}] ${BIG}\n[agent:end]\n`;
    assert.equal(run(T).out, T, `${head} must stream verbatim`);
  }
});

test('a dm body spills: the stub keeps the target on its head line and the target rides onSpill', () => {
  const T = `[agent:dm bob]\n${BIG}\n[agent:end]\n`;
  const { out, filter, spills } = run(T);
  const { id, body } = diskOf(spills);
  assert.equal(out, `[agent:dm bob] @spill:${id}\n[agent:end]\n`);
  assert.equal(body, BIG, 'the file holds the 900 bytes the recipient still gets in full');
  assert.equal(filter.fired, 1);
  assert.deepStrictEqual(spills, [{ verb: 'dm', id, bytes: 900, head: 'dm bob' }],
    "the one-word key wins before `dm.<target>` is tried — m[2] of a dm head is a TARGET");
});

test('a dm head\'s TARGET and urgent flag ride the onSpill payload, never the spilled body and never the record', () => {
  for (const head of ['dm clodex-hand-1029 urgent', 'dm bob@peer', 'dm bob urgent']) {
    const { out, spills } = run(`[agent:${head}]\n${BIG}\n[agent:end]\n`);
    const { id, body } = diskOf(spills);
    assert.equal(out, `[agent:${head}] @spill:${id}\n[agent:end]\n`, head);
    assert.equal(body, BIG, head);
    assert.deepStrictEqual(spills, [{ verb: 'dm', id, bytes: 900, head }],
      `${head}: head words verbatim — a lost target or flag misroutes a recovered message — and keyed as plain dm, not dm.<second token>`);
  }
});

test('a dm body under the floor streams verbatim, flag and all', () => {
  for (const head of ['dm bob', 'dm clodex-hand-1029 urgent']) {
    const T = `[agent:${head}]\n${'y'.repeat(200)}\n[agent:end]\n`;
    for (const cs of SIZES) assert.equal(run(T, { cs }).out, T, `${head} @cs=${cs}`);
  }
});

test('a task done report spills, keyed task.done — the two-word form still wins for task', () => {
  const { out, filter, spills } = run(`[agent:task done t42]\n${BIG}\n[agent:end]\n`);
  const { id, body } = diskOf(spills);
  assert.equal(out, `[agent:task done t42] @spill:${id}\n[agent:end]\n`);
  assert.equal(body, BIG);
  assert.equal(filter.fired, 1);
  assert.deepStrictEqual(spills, [{ verb: 'task.done', id, bytes: 900, head: 'task done t42' }],
    '`task` alone is not in the set, so the fallback derives the two-word key');
  const add = run(`[agent:task add hand start]\n${BIG}\n[agent:end]\n`);
  assert.equal(add.out, stub('task add hand start', add.spills), 'task.add unchanged');
  assert.equal(add.spills[0].head, 'task add hand start', 'the head words keep the modifiers');
});

test('an unheld verb still goes out through foreignBody, not the new one-word key path', () => {
  assert.ok(!VERBS.includes('remind'),
    'ENTER: remind must be absent from the set, or this proves nothing about unheld verbs');
  const T = `[agent:remind in 5m] ${BIG}\n`;
  for (const cs of SIZES) assert.equal(run(T, { cs }).out, T, `@cs=${cs}`);
});

test('proseSpill on: an under-floor dm body and a 900-byte tail are two separate decisions', () => {
  const T = `[agent:dm bob] ${SMALL}\n[agent:end]\n${'p'.repeat(899)}\n`;
  const { out, filter, spills } = run(T, { proseSpill: true });
  const { id, body } = diskOf(spills);
  assert.equal(out, `[agent:dm bob] ${SMALL}\n[agent:end]\n@spill:${id}\n`,
    'the held body streams as written because it is under the floor; the tail is what spills, and a bare pointer stands in for it');
  assert.equal(body, `${'p'.repeat(899)}\n`);
  assert.equal(filter.fired, 1, 'one fire: the two mechanisms do not merge into one file');
});

test('row 6 (DEVIATION): the head-line rest is TRIMMED, as _extractIntents trims it', () => {
  for (const lead of ['   ', ' ', '\t']) {
    const { spills } = run(`[agent:task add t]${lead}${BIG}\n[agent:end]\n`);
    assert.equal(diskOf(spills).body, BIG, `lead=${JSON.stringify(lead)}`);
  }
  const { spills } = run(`[agent:task add t] ${BIG}   \n[agent:end]\n`);
  assert.equal(diskOf(spills).body, BIG, 'trailing whitespace on the head line goes too');
});

test('row 7: every write failure forwards the ORIGINAL body', () => {
  const T = `[agent:task add t42 start] ${BIG}\n[agent:end]\nafter\n`;
  for (const bad of ['..', '...', '.', '', 'a/b', 'x'.repeat(65), 'ok\n', '../x']) {
    const r = run(T, { agent: bad });
    assert.ok(r.out.includes(BIG) && r.spills.length === 0, `agent ${JSON.stringify(bad)}`);
  }
  const badRoot = mkTmpRoot('clodex-spill-');
  fs.writeFileSync(path.join(badRoot, 'spill'), 'not a directory');
  const un = run(T, { root: badRoot });
  assert.ok(un.out.includes(BIG) && un.spills.length === 0, 'unwritable root');
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
  assert.equal(diskOf(run(T).spills).body, BIG,
    'known and consumer-invisible: the sha input has no leading newline where _extractIntents '
    + 'would have produced one, and every consumer trims or strips it');
});

test('row 10: past the cap the filter LATCHES for the rest of the response', () => {
  const two = `[agent:task add t1] ${'q'.repeat(2500)}\n[agent:end]\nprose\n`
    + `[agent:task add t2] ${BIG}\n[agent:end]\n`;
  const r = run(two, { cs: 64, maxBytes: 2000 });
  assert.equal(r.out, two, 'whole response byte-identical');
  assert.equal(r.spills.length, 0, 'zero spills');
  assert.equal(r.filter.latched, true,
    'resyncing after a bail is what split [agent:end] across two deltas into "[ag\\nent:end]"');
  assert.equal(run(`[agent:task add t] ${BIG}\n[agent:end]\n`).spills.length, 1,
    'a fresh response gets a fresh filter, so the latch does not leak');
});

test('row 11: the threshold is strict `>`', () => {
  assert.equal(run('[agent:task add t] abc\n[agent:end]\n', { minBytes: 3 }).spills.length, 0);
  assert.equal(run('[agent:task add t] abcd\n[agent:end]\n', { minBytes: 3 }).spills.length, 1);
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
  const escRun = run(esc);
  assert.equal(escRun.out, stub('task add a', escRun.spills, `${'z'.repeat(77)}… `));
  assert.ok(diskOf(escRun.spills).body.includes('\\[agent:dm x] hi'));

  const mid = `[agent:task add a] ${BIG}\nclose with \`[agent:task done t1]\`\n[agent:end]\n`;
  const midRun = run(mid);
  assert.equal(midRun.out, stub('task add a', midRun.spills, `${'z'.repeat(77)}… `));
  assert.ok(diskOf(midRun.spills).body.includes('close with `[agent:task done t1]`'));
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

test('proseSpill on: trailing prose after a body is replaced by a bare pointer, the body untouched', () => {
  const T = `[agent:task add t1] ${SMALL}\n[agent:end]\n${PROSE}`;
  const rs = SIZES.map((cs) => runProse(T, { cs }));
  assert.equal(new Set(rs.map((r) => r.out)).size, 1, 'output independent of chunking');
  assert.equal(rs[0].out, `[agent:task add t1] ${SMALL}\n[agent:end]\n@spill:${rs[0].spills[0].id}\n`,
    'the under-floor intent body streams as written; the tail leaves and a bare `@spill:` line stands in for it');
  assert.equal(diskOf(rs[0].spills).body, PROSE, 'the file holds the tail byte-for-byte');
});

test('proseSpill on: a reply with no intent at all leaves the bare pointer as its whole record', () => {
  const rs = SIZES.map((cs) => runProse(PROSE, { cs }));
  assert.equal(new Set(rs.map((r) => r.out)).size, 1);
  assert.equal(rs[0].out, `@spill:${rs[0].spills[0].id}\n`, 'the block is never empty, so no filler is needed');
  assert.equal(diskOf(rs[0].spills).body, PROSE);
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

test("proseSpill on: onSpill carries verb 'prose', the tail's byte count and a null head", () => {
  const seen = [];
  const r = runProse(PROSE, { onSpill: (i) => seen.push(i) });
  assert.equal(seen.length, 1);
  assert.deepStrictEqual(seen[0], {
    verb: 'prose', id: diskOf(r.spills).id, bytes: Buffer.byteLength(PROSE, 'utf8'), head: null,
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
  const { out, filter, spills } = runProse(T);
  assert.equal(filter.fired, 2, 'the body and the tail are two fires');
  assert.equal(out, `[agent:task add t] @spill:${spills[0].id}\n[agent:end]\n@spill:${spills[1].id}\n`,
    'neither is on the wire; each leaves its own pointer');
  assert.deepStrictEqual(spills.map((i) => [i.verb, i.head]), [['task.add', 'task add t'], ['prose', null]]);
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
  const { out, spills } = runProse(T);
  assert.equal(out, `[agent:end]\n\\[agent:task add x] example\n@spill:${spills[0].id}\n`,
    'both lines forward where they were written; only the prose after them spills');
  assert.equal(diskOf(spills).body, `${'m'.repeat(899)}\n`);
});

test('proseSpill on: a bail mid-response reverts to byte-for-byte passthrough', () => {
  const T = `[agent:task add a] x\n[agent:task add b] y\n${PROSE}`;
  const { out } = runProse(T);
  assert.equal(out, T, 'the nested-intent bail latches, so nothing after it is held');
});

function proseFilter(opts = {}) {
  const spills = [];
  const f = new SpillFilter({
    agent: 'wirescope', root: root(), verbs: VERBS, proseSpill: true, onSpill: (i) => spills.push(i), ...opts,
  });
  f.spills = spills;
  return f;
}

test('endBlock KEEPS the tail; only close() resolves it', () => {
  const f = proseFilter();
  assert.equal(f.feed(PROSE), '', 'the tail is held, as inside any one block');
  assert.equal(f.endBlock(), '',
    'a block boundary is not the end of the response: the tee cannot know at a stop frame '
    + 'whether another block follows, so the tail crosses it intact');
  assert.equal(f.feed(''), '');
  assert.equal(f.close(), `@spill:${f.spills[0].id}\n`, 'and the stream end is what resolves it');
  assert.equal(f.fired, 1);
  assert.equal(diskOf(f.spills).body, PROSE, 'the file holds the tail from before the boundary');
});

test('a tail spanning two blocks spills as ONE file, in order', () => {
  const f = proseFilter();
  f.feed('first half of the sign-off\n');
  f.endBlock();
  f.feed(PROSE);
  assert.equal(f.close(), `@spill:${f.spills[0].id}\n`);
  assert.equal(diskOf(f.spills).body, `first half of the sign-off\n${PROSE}`,
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
  assert.equal(f.endBlock(), `[agent:task add t] @spill:${f.spills[0].id}\n[agent:end]`,
    'endBlock takes close()\'s terminator-in-pending branch, so a body the block ends on still '
    + 'spills rather than forwarding whole — and the unterminated terminator is re-emitted as received');
  assert.equal(f.fired, before + 1,
    'the tee reads exactly this increment across endBlock() to decide whether a content_block_stop '
    + 'has to flush there instead of parking behind the held stop');
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

test('onMimic: a receipt, filler or pointer line in the INPUT is model-authored and is reported, bytes untouched', () => {
  assert.equal(SPILL_FILLER, '[Runtime note: action text omitted from retained history.]',
    'the t1052 filler literal survives for the request editor\'s legacy cut and for this detector');
  for (const [line, kind] of [[MIMIC, 'intent'], [MIMIC_TAIL, 'prose'], [SPILL_FILLER, 'filler'], ['  [Runtime note: action text omitted from retained history.]  ', 'filler'],
    ['@spill:0123456789abcdef', 'pointer'], ['the spec title @spill:0123456789abcdef', 'pointer'], ['[agent:dm bob] @spill:0123456789abcdef', 'pointer'], ['[agent:remind in 5m] a title @spill:0123456789abcdef', 'pointer']]) {
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

test('onMimic: the filler with anything else on its line is prose, not the filler', () => {
  for (const line of ['[Runtime note: action text omitted from retained history.] the dm', 'I have [Runtime note: action text omitted from retained history.]', '[Runtime note: action text omitted from retained history.].', '[runtime note: action text omitted from retained history.]', '(sent)']) {
    const seen = [];
    const r = run(`${line}\n`, { onMimic: (i) => seen.push(i) });
    assert.equal(r.out, `${line}\n`);
    assert.deepStrictEqual(seen, [], JSON.stringify(line));
  }
});

test("onMimic: the filter never feeds itself — its own stub is not judged, so any pointer it SEES is model-typed", () => {
  const seen = [];
  const r = run(`[agent:dm bob]\n${BIG}\n[agent:end]\n`, { onMimic: (i) => seen.push(i) });
  assert.equal(r.spills.length, 1, 'ENTER: this run really spilled');
  assert.equal(r.out, `[agent:dm bob] @spill:${r.spills[0].id}\n[agent:end]\n`);
  assert.equal(mimicKindOf(r.out.split('\n')[0]), 'pointer', 'ENTER: the stub line IS the shape the detector reports');
  assert.deepStrictEqual(seen, []);
  const prose = runProse(PROSE, { onMimic: (i) => seen.push(i) });
  assert.equal(prose.spills.length, 1, 'ENTER: the tail really spilled');
  assert.deepStrictEqual(seen, []);
});

test('onMimic: a receipt-shaped line INSIDE a held body is that body\'s text — it spills whole and is NOT reported', () => {
  for (const cs of SIZES) {
    const seen = [];
    const body = `quoting my transcript:\n${MIMIC}\n${MIMIC_TAIL}\n${BIG}`;
    const r = run(`[agent:dm bob]\n${body}\n[agent:end]\n`, { cs, onMimic: (i) => seen.push(i) });
    assert.equal(r.spills.length, 1, `@cs=${cs}: ENTER: the dm really spilled`);
    assert.equal(diskOf(r.spills).body, body, `@cs=${cs}: the quoted lines are on disk with the rest of the body`);
    assert.deepStrictEqual(seen, [], `@cs=${cs}: a line the filter HOLDS is never judged — the tee delivered it`);
    seen.length = 0;
    const small = run(`[agent:dm bob]\n${MIMIC}\n[agent:end]\nafter.\n`, { cs, onMimic: (i) => seen.push(i) });
    assert.equal(small.out, `[agent:dm bob]\n${MIMIC}\n[agent:end]\nafter.\n`, `@cs=${cs}: an unspilled body is forwarded intact`);
    assert.deepStrictEqual(seen, [], `@cs=${cs}: and not reported either`);
  }
});

test('onMimic: an UNLISTED verb\'s body is not judged, but the line after its terminator is', () => {
  for (const proseSpill of [false, true]) {
    for (const cs of SIZES) {
      const seen = [];
      const T = `[agent:remind in 1m] continue\n${MIMIC}\n[agent:end]\n${MIMIC_TAIL}\n`;
      const r = run(T, { cs, proseSpill, onMimic: (i) => seen.push(i) });
      assert.equal(r.out, T, `proseSpill=${proseSpill} @cs=${cs}: bytes untouched`);
      assert.deepStrictEqual(seen, [{ kind: 'prose' }],
        `proseSpill=${proseSpill} @cs=${cs}: only the line the filter could not be holding is reported`);
    }
  }
});

test('onMimic: a latched filter still reports, and skips the fragment it latched on', () => {
  const seen = [];
  const f = new SpillFilter({ agent: 'wirescope', root: root(), verbs: VERBS, maxBytes: 100, onMimic: (i) => seen.push(i) });
  let out = f.feed(`[agent:dm bob]\n${'x'.repeat(120)}`);
  assert.equal(f.latched, true, 'ENTER: the cap latched it mid-line');
  out += f.feed(`${MIMIC}\n${MIMIC}\n`);
  out += f.close();
  assert.equal(out, `[agent:dm bob]\n${'x'.repeat(120)}${MIMIC}\n${MIMIC}\n`);
  assert.deepStrictEqual(seen, [{ kind: 'intent' }],
    'the first receipt is the tail of a line whose head passed unjudged; only the whole second line is reported');
});

test('receiptOf reads a path with whitespace in it — the root is configurable and the path is confined on read', () => {
  const p = '/Users/first last/.clodex/spill/wirescope/0123456789abcdef.md';
  const rc = receiptOf(`(I sent dm bob — "a title" in full, 900 B; Clodex kept my text at ${p}.)`);
  assert.ok(rc);
  assert.equal(rc.path, p);
  assert.equal(rc.head, 'dm bob');
  assert.equal(mimicKindOf(`(I wrote 900 B of prose after my last intent; it reached the operator's log and Clodex kept it at ${p}.)`), 'prose');
  assert.equal(mimicKindOf('[Runtime note: action text omitted from retained history.]'), 'filler');
  assert.equal(mimicKindOf('(sent) ok'), null);
  assert.equal(mimicKindOf('@spill:0123456789abcde'), null, 'fifteen hex digits is not a pointer');
  assert.equal(mimicKindOf('[agent:end]'), null);
  assert.equal(mimicKindOf('[agent:dm bob] see @spill:0123456789abcdef for the body'), null, 'a pointer mid-body is prose');
});
