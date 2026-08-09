// The basket ingestion script's pure parts. The embedding loop itself needs a
// daemon and is exercised for real by running the script; what is testable
// here — and what actually breaks — is the record shaping and the parsing that
// decides WHICH records get embedded at all.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { asRecord, readBasket, parseArgs } = require('../scripts/embed-basket');
const { keyOf } = require('../hint-embed');

function mkBasket(objs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-eb-'));
  const file = path.join(dir, 'operator.jsonl');
  fs.writeFileSync(file, objs.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n');
  return { dir, file };
}

test('embed-basket: the reply is embedded with the message', () => {
  // A question is routinely findable by words that appear only in the answer,
  // which is why the exchange is the unit on the lexical side too. If only the
  // operator half were embedded, "what did you tell me about X" could not match
  // the record where X appears solely in the reply.
  const rec = asRecord({ id: 'a', text: 'how does the helm chart find its values', reply: 'it reads values.yaml at render time' });
  assert.ok(rec.text.includes('values.yaml'), 'the reply must be part of the embedded text');
  assert.ok(rec.text.includes('helm chart'), 'and so must the operator half');
});

test('embed-basket: a record with no reply is still embedded', () => {
  const rec = asRecord({ id: 'b', text: 'never push without asking' });
  assert.strictEqual(rec.text, 'never push without asking');
  assert.ok(!/undefined|null/.test(rec.text), 'a missing reply must not leak into the text');
});

test('embed-basket: cwd rides as scope so confinement has something to read', () => {
  // Confinement is enforced by the retriever, but it can only confine what the
  // record carries. Dropping cwd here would make every basket hit unconfinable.
  const rec = asRecord({ id: 'c', text: 'the trading bot needs a new key', cwd: '/Users/x/crypto-trader' });
  assert.strictEqual(rec.scope, '/Users/x/crypto-trader');
});

test('embed-basket: the key changes when the reply changes', () => {
  // The key is content-addressed, and the reply is part of the content. A
  // record whose reply was later corrected must be re-embedded, or the store
  // serves a vector for text that no longer exists.
  const a = keyOf(asRecord({ id: 'd', text: 'same question', reply: 'first answer' }));
  const b = keyOf(asRecord({ id: 'd', text: 'same question', reply: 'corrected answer' }));
  assert.notStrictEqual(a, b);
  const same = keyOf(asRecord({ id: 'd', text: 'same question', reply: 'first answer' }));
  assert.strictEqual(a, same, 'and an unchanged record keeps its key, or every run re-embeds everything');
});

test('embed-basket: a truncated tail line does not lose the basket', () => {
  const { dir, file } = mkBasket([
    { id: 'a', text: 'first' },
    { id: 'b', text: 'second' },
    '{"id":"c","te',
  ]);
  const { records, bad } = readBasket(file);
  assert.strictEqual(records.length, 2, 'the intact records survive');
  assert.strictEqual(bad, 1, 'and the damage is REPORTED rather than silently absorbed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('embed-basket: a record with no text is skipped', () => {
  const { dir, file } = mkBasket([
    { id: 'a', text: 'real' },
    { id: 'b', reply: 'an answer to nothing' },
    { id: 'c', text: '' },
  ]);
  const { records } = readBasket(file);
  assert.deepStrictEqual(records.map((r) => r.id), ['a'],
    'embedding an empty string produces a vector that matches everything weakly');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the argv contract (F011) -------------------------------------------
//
// These guard a write, which is why they exist at all: parseArgs was
// unexported, so the only way to exercise it was to run the script, and the
// script's job is the six-minute embedding pass that --dry-run exists to
// suppress. That is precisely why nobody wrote this test, and precisely why the
// defect survived — the test that would catch it was the expensive one.
//
// The invariant under all of them is ONE sentence: the cap is Infinity or a
// positive integer, and is never NaN. `todo.length >= NaN` is false for every
// length, so a NaN cap does not cap loosely — it stops capping, silently, in the
// direction of doing more work rather than less.

test('embed-basket: --limit does not swallow the flag after it', () => {
  // The reproduced defect. `--limit --dry-run` bound --dry-run as the operand,
  // so the cap became NaN *and* the dry gate never armed: the command typed to
  // preview a bounded run performed an unbounded real one.
  assert.throws(() => parseArgs(['--limit', '--dry-run']), /--limit needs a value/);
  assert.throws(() => parseArgs(['--file', '--dry-run']), /--file needs a value/);
});

test('embed-basket: a --limit with no value at all is rejected', () => {
  // Same NaN by a different route — argv simply ends. No dashy token involved,
  // which is why rejecting dashy operands alone would not have closed this.
  assert.throws(() => parseArgs(['--limit']), /--limit needs a value/);
  assert.throws(() => parseArgs(['--dry-run', '--file']), /--file needs a value/);
});

test('embed-basket: a non-numeric --limit is rejected rather than becoming NaN', () => {
  // The third route to the identical outcome, and the one no argv parser in the
  // repo catches — cli/src/args.js:62 rejects the dashy token but would accept
  // `--limit abc` happily, because validating the VALUE is the flag's contract
  // and not the parser's job.
  for (const bad of ['abc', '', '5x', '1e3', '-5', '2.5']) {
    assert.throws(() => parseArgs(['--limit', bad]),
      /needs (a value|a positive integer)/,
      `--limit ${JSON.stringify(bad)} must not reach the cap`);
  }
  // 0 would mean "embed nothing", which --dry-run already says; admitting it
  // would give the script two spellings for one behaviour.
  assert.throws(() => parseArgs(['--limit', '0']), /positive integer/);
});

test('embed-basket: an unknown argument is refused, not ignored', () => {
  // `--dryrun` is the same plausible typo one character shorter, and it used to
  // perform a real run in silence.
  assert.throws(() => parseArgs(['--dryrun']), /unknown argument: --dryrun/);
  assert.throws(() => parseArgs(['-n']), /unknown argument: -n/);
  assert.throws(() => parseArgs(['--limit', '5', 'stray']), /unknown argument: stray/);
});

test('embed-basket: the valid forms still parse, and the cap defaults to no cap', () => {
  const d = parseArgs([]);
  assert.strictEqual(d.limit, Infinity, 'an unset cap must be Infinity, never NaN');
  assert.strictEqual(d.dry, false);
  assert.strictEqual(d.compact, false);
  assert.ok(d.file.endsWith('operator.jsonl'));

  const a = parseArgs(['--limit', '5', '--dry-run']);
  assert.strictEqual(a.limit, 5);
  assert.strictEqual(a.dry, true, 'the flag the defect ate must still arm the gate');

  const b = parseArgs(['--dry-run', '--limit', '5']);
  assert.deepStrictEqual([b.limit, b.dry], [5, true], 'order must not matter');

  const c = parseArgs(['--file', '/tmp/x.jsonl', '--compact']);
  assert.strictEqual(c.file, '/tmp/x.jsonl');
  assert.strictEqual(c.compact, true);
});

test('embed-basket: every rejection names the flag and prints the usage', () => {
  // A dev script's error is its whole help system; "needs a value" without the
  // shape is a second lookup for the operator who already mistyped once.
  for (const argv of [['--limit'], ['--limit', 'abc'], ['--nope']]) {
    let msg = null;
    try { parseArgs(argv); } catch (e) { msg = e.message; }
    assert.ok(msg !== null, `${argv.join(' ')} must throw`);
    assert.match(msg, /usage: embed-basket\.js \[--limit N\]/,
      `${argv.join(' ')} must print the usage line`);
  }
});
